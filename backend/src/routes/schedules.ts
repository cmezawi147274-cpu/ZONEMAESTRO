import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toSchedule } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound, badRequest } from "../lib/http-error.js"
import { scopedZone, scopedServer, scopedPlaylist, allowedLocationIds } from "../lib/tenant.js"

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const
type DayOfWeek = (typeof DAYS)[number]

/** "HH:mm", 24-hour. Previously unvalidated: `request.body` went straight
 * into Prisma, so any string at all could be stored as a start/end time and
 * the agent-side schedule evaluator would silently never fire. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

function validTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !TIME_RE.test(value)) {
    throw badRequest(`${field} must be a 24-hour "HH:mm" time.`)
  }
  return value
}

function validDays(value: unknown): DayOfWeek[] {
  if (!Array.isArray(value) || value.length === 0) throw badRequest("At least one day is required.")
  const days = value.map((d) => String(d).toUpperCase())
  const bad = days.find((d) => !DAYS.includes(d as DayOfWeek))
  if (bad) throw badRequest(`"${bad}" is not a valid day. Use ${DAYS.join(", ")}.`)
  return Array.from(new Set(days)) as DayOfWeek[]
}

function validPriority(value: unknown): number {
  const n = Number(value ?? 1)
  if (!Number.isFinite(n) || n < 0 || n > 100) throw badRequest("priority must be between 0 and 100.")
  return Math.floor(n)
}

/**
 * A schedule slot names a playlist for a zone independent of whatever that
 * zone's `currentPlaylistId` happens to be right now — so without this, a
 * newly-scheduled playlist would never show up in the zone's own "assign
 * playlist" picker (that picker only lists PlaylistAssignment rows +
 * currentPlaylistId, per zones.ts GET /zones/:id/playlists). This creates
 * that assignment row if one doesn't already exist. It deliberately never
 * touches currentPlaylistId/live playback itself — creating a slot for
 * this afternoon must not interrupt whatever is playing right now.
 */
async function ensureZonePlaylistAssignment(zoneId: string, playlistId: string) {
  const existing = await prisma.playlistAssignment.findFirst({ where: { targetType: "ZONE", targetId: zoneId, playlistId } })
  if (!existing) {
    await prisma.playlistAssignment.create({ data: { targetType: "ZONE", targetId: zoneId, playlistId } })
  }
}

/** Zone ids this caller may see schedules for. Schedules reach an
 * organization only through Zone -> Location, so the filter has to be
 * expressed as a zone-id set. */
async function visibleZoneIds(scope: ReturnType<typeof tenantScope>): Promise<string[] | null> {
  if (scope.isSuperAdmin) return null // null = unrestricted
  if (scope.locationId) {
    const zones = await prisma.zone.findMany({ where: { locationId: scope.locationId }, select: { id: true } })
    return zones.map((z) => z.id)
  }
  if (!scope.organizationId) return []
  const locationIds = await allowedLocationIds(scope.organizationId)
  const zones = await prisma.zone.findMany({ where: { locationId: { in: locationIds } }, select: { id: true } })
  return zones.map((z) => z.id)
}

export default async function schedulesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get<{ Querystring: { zoneId?: string; serverId?: string } }>("/schedules", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "schedule:read")) throw forbidden()
    const scope = tenantScope(request)
    const { zoneId, serverId } = request.query

    const where: Record<string, unknown> = {}

    if (zoneId) {
      // 404s for a zone outside this tenant instead of returning its slots.
      await scopedZone(scope, zoneId)
      where.zoneId = zoneId
    } else if (serverId) {
      await scopedServer(scope, serverId)
      const zones = await prisma.zone.findMany({ where: { serverId }, select: { id: true } })
      where.zoneId = { in: zones.map((z) => z.id) }
    } else {
      const allowed = await visibleZoneIds(scope)
      if (allowed !== null) where.zoneId = { in: allowed }
    }

    const schedules = await prisma.schedule.findMany({ where, orderBy: { startTime: "asc" } })
    return reply.send(schedules.map(toSchedule))
  })

  app.post<{
    Body: { zoneId: string; playlistId: string; name: string; startTime: string; endTime: string; days: DayOfWeek[]; priority?: number; enabled?: boolean }
  }>("/schedules", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "schedule:write")) throw forbidden()
    const scope = tenantScope(request)
    const body = request.body ?? ({} as Record<string, unknown>)

    const name = typeof body.name === "string" ? body.name.trim() : ""
    if (!name) throw badRequest("A schedule name is required.")
    if (!body.zoneId) throw badRequest("zoneId is required.")
    if (!body.playlistId) throw badRequest("playlistId is required.")

    // Both parents must belong to this caller, or the slot could schedule
    // another organization's playlist onto another organization's zone.
    const zone = await scopedZone(scope, body.zoneId)
    const playlist = await scopedPlaylist(scope, body.playlistId)

    const schedule = await prisma.schedule.create({
      data: {
        zoneId: zone.id,
        playlistId: playlist.id,
        name,
        startTime: validTime(body.startTime, "startTime"),
        endTime: validTime(body.endTime, "endTime"),
        days: validDays(body.days),
        priority: validPriority(body.priority),
        enabled: body.enabled !== false,
      },
    })
    await ensureZonePlaylistAssignment(schedule.zoneId, schedule.playlistId)
    return reply.status(201).send(toSchedule(schedule))
  })

  app.patch<{
    Params: { id: string }
    Body: Partial<{ name: string; startTime: string; endTime: string; days: DayOfWeek[]; priority: number; enabled: boolean; playlistId: string }>
  }>("/schedules/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "schedule:write")) throw forbidden()
    const scope = tenantScope(request)

    const existing = await prisma.schedule.findUnique({ where: { id: request.params.id } })
    if (!existing) throw notFound("Schedule")
    await scopedZone(scope, existing.zoneId)

    // Explicit field list — the body must not be able to move this slot to
    // another zone, which is what spreading it into Prisma allowed before.
    const body = request.body ?? {}
    const data: Record<string, unknown> = {}
    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (!name) throw badRequest("A schedule name is required.")
      data.name = name
    }
    if (body.startTime !== undefined) data.startTime = validTime(body.startTime, "startTime")
    if (body.endTime !== undefined) data.endTime = validTime(body.endTime, "endTime")
    if (body.days !== undefined) data.days = validDays(body.days)
    if (body.priority !== undefined) data.priority = validPriority(body.priority)
    if (body.enabled !== undefined) data.enabled = Boolean(body.enabled)
    if (body.playlistId !== undefined) {
      const playlist = await scopedPlaylist(scope, body.playlistId)
      data.playlistId = playlist.id
    }

    const schedule = await prisma.schedule.update({ where: { id: existing.id }, data })
    if (body.playlistId) await ensureZonePlaylistAssignment(schedule.zoneId, schedule.playlistId)
    return reply.send(toSchedule(schedule))
  })

  app.delete<{ Params: { id: string } }>("/schedules/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "schedule:write")) throw forbidden()
    const existing = await prisma.schedule.findUnique({ where: { id: request.params.id } })
    if (!existing) throw notFound("Schedule")
    await scopedZone(tenantScope(request), existing.zoneId)
    await prisma.schedule.delete({ where: { id: existing.id } })
    return reply.status(204).send()
  })
}
