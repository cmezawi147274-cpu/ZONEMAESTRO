import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toSchedule } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope, type TenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound } from "../lib/http-error.js"
type DayOfWeek = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN"

/** Every zone id this caller may reach, mirroring zones.ts's own scoping
 * (a location-bound caller sees only their venue; anyone else, their whole
 * organization). Used to scope /schedules the same way GET /zones already
 * scopes zones themselves — schedules had no tenant check at all before
 * this, so any authenticated schedule:read/write role could read, edit or
 * delete another organization's schedules by id. */
async function allowedZoneIds(scope: TenantScope): Promise<string[] | null> {
  if (scope.isSuperAdmin) return null
  if (scope.locationId) {
    const zones = await prisma.zone.findMany({ where: { locationId: scope.locationId }, select: { id: true } })
    return zones.map((z) => z.id)
  }
  if (!scope.organizationId) return []
  const locations = await prisma.location.findMany({ where: { organizationId: scope.organizationId }, select: { id: true } })
  const zones = await prisma.zone.findMany({ where: { locationId: { in: locations.map((l) => l.id) } }, select: { id: true } })
  return zones.map((z) => z.id)
}

/** Loads a schedule the caller is entitled to, 404ing otherwise. */
async function scopedSchedule(scope: TenantScope, scheduleId: string) {
  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } })
  if (!schedule) throw notFound("Schedule")
  const allowed = await allowedZoneIds(scope)
  if (allowed && !allowed.includes(schedule.zoneId)) throw notFound("Schedule")
  return schedule
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

export default async function schedulesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get<{ Querystring: { zoneId?: string; serverId?: string } }>("/schedules", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "schedule:read")) throw forbidden()
    const scope = tenantScope(request)
    const { zoneId, serverId } = request.query
    let where: Record<string, unknown> = {}
    const allowed = await allowedZoneIds(scope)
    if (allowed) where.zoneId = { in: allowed }
    if (zoneId && (!allowed || allowed.includes(zoneId))) where.zoneId = zoneId
    if (serverId) {
      const zones = await prisma.zone.findMany({ where: { serverId }, select: { id: true } })
      const zoneIds = allowed ? zones.map((z) => z.id).filter((id) => allowed.includes(id)) : zones.map((z) => z.id)
      where.zoneId = { in: zoneIds }
    }
    const schedules = await prisma.schedule.findMany({ where, orderBy: { startTime: "asc" } })
    return reply.send(schedules.map(toSchedule))
  })

  app.post<{ Body: { zoneId: string; playlistId: string; name: string; startTime: string; endTime: string; days: DayOfWeek[]; priority: number; enabled: boolean } }>(
    "/schedules",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "schedule:write")) throw forbidden()
      const scope = tenantScope(request)
      const allowed = await allowedZoneIds(scope)
      if (allowed && !allowed.includes(request.body.zoneId)) throw notFound("Zone")
      const schedule = await prisma.schedule.create({ data: request.body })
      await ensureZonePlaylistAssignment(schedule.zoneId, schedule.playlistId)
      return reply.status(201).send(toSchedule(schedule))
    }
  )

  app.patch<{ Params: { id: string }; Body: Partial<{ name: string; startTime: string; endTime: string; days: DayOfWeek[]; priority: number; enabled: boolean; playlistId: string }> }>(
    "/schedules/:id",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "schedule:write")) throw forbidden()
      const target = await scopedSchedule(tenantScope(request), request.params.id)
      const schedule = await prisma.schedule.update({ where: { id: target.id }, data: request.body })
      if (request.body.playlistId) await ensureZonePlaylistAssignment(schedule.zoneId, schedule.playlistId)
      return reply.send(toSchedule(schedule))
    }
  )

  app.delete<{ Params: { id: string } }>("/schedules/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "schedule:write")) throw forbidden()
    const target = await scopedSchedule(tenantScope(request), request.params.id)
    await prisma.schedule.delete({ where: { id: target.id } })
    return reply.status(204).send()
  })
}
