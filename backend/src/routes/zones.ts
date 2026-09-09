import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toZone } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope, type TenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound, badRequest } from "../lib/http-error.js"
import { queuePlaylistTracksForServer } from "../lib/zone-effects.js"

async function allowedLocationIds(organizationId: string) {
  const locs = await prisma.location.findMany({ where: { organizationId }, select: { id: true } })
  return new Set(locs.map((l) => l.id))
}

/**
 * Loads a zone the caller is actually entitled to. A location-bound caller
 * (VIEWER) may only reach zones at their own location; any other non-super
 * role is limited to their organization. Anything else 404s rather than
 * leaking that the id exists.
 */
async function scopedZone(scope: TenantScope, zoneId: string) {
  const zone = await prisma.zone.findUnique({ where: { id: zoneId } })
  if (!zone) throw notFound("Zone")
  if (scope.isSuperAdmin) return zone
  if (scope.locationId) {
    if (zone.locationId !== scope.locationId) throw notFound("Zone")
    return zone
  }
  const loc = await prisma.location.findUnique({ where: { id: zone.locationId } })
  if (!loc || loc.organizationId !== scope.organizationId) throw notFound("Zone")
  return zone
}

export default async function zonesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get<{ Querystring: { serverId?: string; locationId?: string } }>("/zones", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "zone:read")) throw forbidden()
    const scope = tenantScope(request)
    const { serverId, locationId } = request.query
    let where: Record<string, unknown> = {}
    if (!scope.isSuperAdmin) {
      if (scope.locationId) {
        where.locationId = scope.locationId
      } else {
        if (!scope.organizationId) return reply.send([])
        where.locationId = { in: Array.from(await allowedLocationIds(scope.organizationId)) }
      }
    }
    if (serverId) where.serverId = serverId
    if (locationId && !scope.locationId) where.locationId = locationId
    const zones = await prisma.zone.findMany({ where, orderBy: { name: "asc" } })
    return reply.send(zones.map(toZone))
  })

  app.get<{ Params: { id: string } }>("/zones/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "zone:read")) throw forbidden()
    const zone = await scopedZone(tenantScope(request), request.params.id)
    return reply.send(toZone(zone))
  })

  app.patch<{ Params: { id: string }; Body: { prayerModeEnabled?: boolean } }>("/zones/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "prayer:read")) throw forbidden()
    const target = await scopedZone(tenantScope(request), request.params.id)
    const zone = await prisma.zone.update({
      where: { id: target.id },
      data: { prayerModeEnabled: request.body.prayerModeEnabled },
    })
    return reply.send(toZone(zone))
  })

  app.post<{ Params: { id: string }; Body: { playlistId: string } }>("/zones/:id/playlist", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "zone:assign")) throw forbidden()
    const zone = await scopedZone(tenantScope(request), request.params.id)
    const server = await prisma.musicServer.findUnique({ where: { id: zone.serverId } })
    if (!server || server.status === "OFFLINE" || server.status === "UNKNOWN") {
      throw badRequest(`${server?.name ?? "Server"} is offline — playlist not assigned.`)
    }
    const playlist = await prisma.playlist.findUnique({
      where: { id: request.body.playlistId },
      include: { tracks: { orderBy: { position: "asc" } } },
    })
    const excludedTrackIds = zone.currentPlaylistId !== request.body.playlistId ? [] : zone.excludedTrackIds
    const firstTrack = playlist?.tracks.find((t) => !excludedTrackIds.includes(t.trackId))?.trackId ?? null
    const updated = await prisma.zone.update({
      where: { id: zone.id },
      data: { currentPlaylistId: request.body.playlistId, currentTrackId: firstTrack, excludedTrackIds },
    })
    await queuePlaylistTracksForServer(request.body.playlistId, zone.serverId)
    return reply.send(toZone(updated))
  })

  app.post<{ Params: { id: string; trackId: string } }>("/zones/:id/tracks/:trackId/remove", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "zone:assign")) throw forbidden()
    const zone = await scopedZone(tenantScope(request), request.params.id)
    const excludedTrackIds = zone.excludedTrackIds.includes(request.params.trackId)
      ? zone.excludedTrackIds
      : [...zone.excludedTrackIds, request.params.trackId]
    let currentTrackId = zone.currentTrackId
    if (currentTrackId === request.params.trackId) {
      const playlist = zone.currentPlaylistId
        ? await prisma.playlist.findUnique({ where: { id: zone.currentPlaylistId }, include: { tracks: { orderBy: { position: "asc" } } } })
        : null
      currentTrackId = playlist?.tracks.find((t) => !excludedTrackIds.includes(t.trackId))?.trackId ?? null
    }
    const updated = await prisma.zone.update({ where: { id: zone.id }, data: { excludedTrackIds, currentTrackId } })
    return reply.send(toZone(updated))
  })

  app.post<{ Params: { id: string; trackId: string } }>("/zones/:id/tracks/:trackId/restore", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "zone:assign")) throw forbidden()
    const zone = await scopedZone(tenantScope(request), request.params.id)
    const excludedTrackIds = zone.excludedTrackIds.filter((id) => id !== request.params.trackId)
    const updated = await prisma.zone.update({ where: { id: zone.id }, data: { excludedTrackIds } })
    return reply.send(toZone(updated))
  })
}
