import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toPrayerConfig } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, badRequest } from "../lib/http-error.js"
import { PRAYER_NAMES } from "../lib/constants.js"
import { resolvePrayerLocation } from "../lib/prayer-location.js"
import { getTodayTimings } from "../lib/prayer-times.js"
import { isValidTimeZone } from "../lib/geo.js"
import { calendarDateKey } from "../lib/timezone-math.js"

async function resolveOrgId(scope: { isSuperAdmin: boolean; organizationId: string | null }): Promise<string | null> {
  if (scope.organizationId) return scope.organizationId
  if (!scope.isSuperAdmin) return null
  const first = await prisma.organization.findFirst({ orderBy: { createdAt: "asc" } })
  return first?.id ?? null
}

function defaultPrayers() {
  return Object.fromEntries(PRAYER_NAMES.map((name) => [name, { enabled: true, offsetMinutes: 0, pauseDurationMinutes: 10 }]))
}

async function getOrCreateConfig(organizationId: string) {
  const existing = await prisma.prayerConfig.findUnique({ where: { organizationId } })
  if (existing) return existing
  return prisma.prayerConfig.create({
    data: { organizationId, enabled: false, calculationMethodId: 3, prayers: defaultPrayers() },
  })
}

/**
 * The location a linked config actually calculates against. Location rows
 * carry no coordinates of their own, so these come from the venue PC's
 * reported GPS or from looking the venue's city up in the same dataset the
 * portal's picker uses — see lib/prayer-location.ts. It previously
 * returned latitude 0, longitude 0 here, which quietly calculated every
 * linked venue's prayer times for a point in the Atlantic.
 */
async function resolveLinkedLocation(config: Parameters<typeof resolvePrayerLocation>[0]) {
  const resolved = await resolvePrayerLocation(config)
  if (!resolved || resolved.city == null || resolved.country == null) return null
  return {
    country: resolved.country,
    city: resolved.city,
    region: resolved.region,
    timezone: resolved.timezone,
    latitude: resolved.latitude,
    longitude: resolved.longitude,
  }
}

export default async function prayerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get("/prayer/config", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "prayer:read")) throw forbidden()
    const scope = tenantScope(request)
    const orgId = await resolveOrgId(scope)
    if (!orgId) {
      return reply.send({
        enabled: false,
        location: null,
        linkedLocationId: null,
        calculationMethodId: 3,
        prayers: defaultPrayers(),
        updatedAt: new Date().toISOString(),
      })
    }
    const config = await getOrCreateConfig(orgId)
    // A linked config's location is resolved live (venue GPS/timezone, else
    // its city) rather than trusting the coordinates saved on the config,
    // which may predate the link.
    const linked = config.linkedLocationId ? await resolveLinkedLocation(config) : null
    return reply.send(toPrayerConfig(config, linked))
  })

  // --------------------------------------------------------------------
  // Today's prayer times, computed in the cloud against the venue's own
  // clock and coordinates. The browser must never call AlAdhan itself in a
  // real deployment (src/lib/api/prayer.ts) — this is the single place the
  // portal and the scheduler both read, so what an admin sees is exactly
  // what will pause a zone.
  //
  // The optional query overrides exist for one reason: the Prayer settings
  // form previews times for a location the admin has picked but not saved
  // yet. Those coordinates come from the same Country → City picker, so
  // they are real — nothing here ever invents a point.
  // --------------------------------------------------------------------
  app.get<{ Querystring: { latitude?: string; longitude?: string; timezone?: string; method?: string } }>(
    "/prayer/times/today",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "prayer:read")) throw forbidden()
      const scope = tenantScope(request)
      const orgId = await resolveOrgId(scope)
      if (!orgId) throw badRequest("No organization to calculate prayer times for.")
      const config = await getOrCreateConfig(orgId)

      // The venue is always resolved, even when the caller passes overrides:
      // the Prayer form echoes the saved location back on every request, and
      // treating that as a "custom preview" would report the venue's own
      // clock as a portal-picked one and turn the pill amber for a venue
      // that is in fact reporting correctly.
      const resolved = await resolvePrayerLocation(config)

      const latitude = Number(request.query.latitude)
      const longitude = Number(request.query.longitude)
      const overrideTimezone = request.query.timezone
      const overrideProvided =
        Number.isFinite(latitude) && Number.isFinite(longitude) && isValidTimeZone(overrideTimezone)
      const overrideMatchesVenue =
        overrideProvided &&
        resolved != null &&
        resolved.timezone === overrideTimezone &&
        Math.abs(resolved.latitude - latitude) < 0.01 &&
        Math.abs(resolved.longitude - longitude) < 0.01
      // Only a genuinely different pick counts as a preview of an unsaved
      // location.
      const usingOverride = overrideProvided && !overrideMatchesVenue

      const location = usingOverride
        ? {
            latitude,
            longitude,
            timezone: overrideTimezone!,
            city: config.city,
            country: config.country,
            timezoneSource: "config" as const,
            coordinatesSource: "config" as const,
            serverName: undefined,
          }
        : resolved

      if (!location) {
        throw badRequest(
          "This organization has no usable prayer location yet — pick a country and city in Prayer Mode, or link it to a venue whose city is known."
        )
      }

      const methodOverride = Number(request.query.method)
      const calculationMethodId = Number.isFinite(methodOverride) ? methodOverride : config.calculationMethodId

      const result = await getTodayTimings(location, calculationMethodId)
      if (!result) {
        throw badRequest("Prayer times are unavailable right now — the AlAdhan API could not be reached.")
      }

      return reply.send({
        date: calendarDateKey(result.date),
        timezone: location.timezone,
        calculationMethodId,
        times: result.timings,
        location: {
          city: location.city,
          country: location.country,
          latitude: location.latitude,
          longitude: location.longitude,
          source: location.coordinatesSource,
        },
        // What the portal's venue-location pill renders. VENUE only when the
        // venue PC itself supplied the clock these times were computed on.
        venue: {
          state: location.timezoneSource === "heartbeat" ? "VENUE" : "PORTAL",
          timezone: location.timezone,
          city: location.city,
          country: location.country,
          timezoneSource: location.timezoneSource,
          coordinatesSource: location.coordinatesSource,
          serverName: location.serverName ?? null,
        },
      })
    }
  )

  app.put<{
    Body: {
      enabled: boolean
      location: { country: string; city: string; region?: string; latitude: number; longitude: number; timezone: string } | null
      linkedLocationId: string | null
      calculationMethodId: number
      prayers: Record<string, { enabled: boolean; offsetMinutes: number; pauseDurationMinutes: number }>
    }
  }>("/prayer/config", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "prayer:manage")) throw forbidden()
    const scope = tenantScope(request)
    const orgId = await resolveOrgId(scope)
    if (!orgId) throw badRequest("No organization to configure Prayer Mode for.")

    const { enabled, location, linkedLocationId, calculationMethodId, prayers } = request.body
    const config = await prisma.prayerConfig.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        enabled,
        linkedLocationId,
        country: location?.country ?? null,
        city: location?.city ?? null,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        timezone: location?.timezone ?? null,
        calculationMethodId,
        prayers,
      },
      update: {
        enabled,
        linkedLocationId,
        country: location?.country ?? null,
        city: location?.city ?? null,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        timezone: location?.timezone ?? null,
        calculationMethodId,
        prayers,
      },
    })
    return reply.send(toPrayerConfig(config))
  })
}
