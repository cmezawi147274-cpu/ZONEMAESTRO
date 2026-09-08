import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toSchedule } from "../lib/serialize.js"
import { requireAuth, requireUser } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden } from "../lib/http-error.js"
type DayOfWeek = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN"

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
    const { zoneId, serverId } = request.query
    let where: Record<string, unknown> = {}
    if (zoneId) where.zoneId = zoneId
    if (serverId) {
      const zones = await prisma.zone.findMany({ where: { serverId }, select: { id: true } })
      where.zoneId = { in: zones.map((z) => z.id) }
    }
    const schedules = await prisma.schedule.findMany({ where, orderBy: { startTime: "asc" } })
    return reply.send(schedules.map(toSchedule))
  })

  app.post<{ Body: { zoneId: string; playlistId: string; name: string; startTime: string; endTime: string; days: DayOfWeek[]; priority: number; enabled: boolean } }>(
    "/schedules",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "schedule:write")) throw forbidden()
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
      const schedule = await prisma.schedule.update({ where: { id: request.params.id }, data: request.body })
      if (request.body.playlistId) await ensureZonePlaylistAssignment(schedule.zoneId, schedule.playlistId)
      return reply.send(toSchedule(schedule))
    }
  )

  app.delete<{ Params: { id: string } }>("/schedules/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "schedule:write")) throw forbidden()
    await prisma.schedule.delete({ where: { id: request.params.id } })
    return reply.status(204).send()
  })
}
