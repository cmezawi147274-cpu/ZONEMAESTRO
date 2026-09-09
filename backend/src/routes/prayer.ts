import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toPrayerConfig } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, badRequest } from "../lib/http-error.js"
import { PRAYER_NAMES } from "../lib/constants.js"

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

async function resolveLinkedLocation(linkedLocationId: string | null) {
  if (!linkedLocationId) return null
  const loc = await prisma.location.findUnique({ where: { id: linkedLocationId } })
  if (!loc) return null
  // Location has no stored lat/lng in the frozen schema (see
  // src/lib/api/types.ts Location.latitude/longitude, resolved client-side
  // only) — fall back to the config's own saved coordinates for calc.
  return { country: loc.country, city: loc.city, region: loc.region, timezone: loc.timezone, latitude: 0, longitude: 0 }
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
    const linked = config.linkedLocationId ? await resolveLinkedLocation(config.linkedLocationId) : null
    const location =
      linked && config.latitude != null && config.longitude != null
        ? { ...linked, latitude: config.latitude, longitude: config.longitude }
        : linked
    return reply.send(toPrayerConfig(config, location))
  })

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
