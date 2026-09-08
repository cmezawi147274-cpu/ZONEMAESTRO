import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toZone, toPlaylist } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope, type TenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound, badRequest } from "../lib/http-error.js"
import { queuePlaylistTracksForServer } from "../lib/zone-effects.js"
import { pushToAgent } from "../lib/agent-registry.js"
import { pushActivity } from "../lib/activity.js"

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

  // --------------------------------------------------------------------
  // Playlists "assigned" to this zone (Task 2 — a picker must never dump
  // the whole library). That's the union of: playlists explicitly
  // assigned to this zone (PlaylistAssignment, targetType ZONE) and the
  // zone's own currentPlaylistId — a zone assigned the old way, straight
  // through POST /zones/:id/playlist, never gets an assignment row at all.
  // --------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/zones/:id/playlists", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "zone:read")) throw forbidden()
    const zone = await scopedZone(tenantScope(request), request.params.id)
    const assignments = await prisma.playlistAssignment.findMany({ where: { targetType: "ZONE", targetId: zone.id } })
    const ids = new Set(assignments.map((a) => a.playlistId))
    if (zone.currentPlaylistId) ids.add(zone.currentPlaylistId)
    if (ids.size === 0) return reply.send([])
    const playlists = await prisma.playlist.findMany({ where: { id: { in: Array.from(ids) } }, orderBy: { name: "asc" } })
    const items = await Promise.all(
      playlists.map(async (p) => {
        const tracks = await prisma.playlistTrack.findMany({ where: { playlistId: p.id }, orderBy: { position: "asc" } })
        return toPlaylist(p, tracks.map((t) => t.trackId))
      })
    )
    return reply.send(items)
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

  // --------------------------------------------------------------------
  // Per-zone equalizer (master on/off, 10 band gains, preset id, and the
  // Bass Boost / Loudness / Virtualizer modules). Same permission tier as
  // transport/volume (zone:control) since this is an audio-output control,
  // not a library-management one like zone:assign. Plain cloud config, not
  // a RemoteCommand: unlike PLAY/SET_VOLUME there is no physical device to
  // wait on an ack from — see the `equalizer` field comment on the Zone
  // model. Validated by hand here, matching the rest of this file (no zod
  // in this backend).
  // --------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: unknown }>("/zones/:id/equalizer", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "zone:control")) throw forbidden()
    const zone = await scopedZone(tenantScope(request), request.params.id)

    const body = request.body as Record<string, unknown> | null
    if (!body || typeof body !== "object") throw badRequest("Invalid equalizer settings.")

    const isModule = (v: unknown): v is { on: boolean; amount: number } =>
      !!v &&
      typeof v === "object" &&
      typeof (v as { on?: unknown }).on === "boolean" &&
      typeof (v as { amount?: unknown }).amount === "number" &&
      Number.isFinite((v as { amount: number }).amount)

    const bands = body.bands
    if (
      typeof body.enabled !== "boolean" ||
      typeof body.presetId !== "string" ||
      !Array.isArray(bands) ||
      bands.length !== 10 ||
      !bands.every((g) => typeof g === "number" && Number.isFinite(g)) ||
      !isModule(body.bassBoost) ||
      !isModule(body.loudness) ||
      !isModule(body.virtualizer)
    ) {
      throw badRequest("Invalid equalizer settings.")
    }

    const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
    const equalizer = {
      enabled: body.enabled,
      presetId: body.presetId,
      bands: (bands as number[]).map((g) => clamp(g, -12, 12)),
      bassBoost: { on: (body.bassBoost as { on: boolean }).on, amount: clamp((body.bassBoost as { amount: number }).amount, 0, 100) },
      loudness: { on: (body.loudness as { on: boolean }).on, amount: clamp((body.loudness as { amount: number }).amount, 0, 100) },
      virtualizer: { on: (body.virtualizer as { on: boolean }).on, amount: clamp((body.virtualizer as { amount: number }).amount, 0, 100) },
    }

    const updated = await prisma.zone.update({ where: { id: zone.id }, data: { equalizer } })
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

  // --------------------------------------------------------------------
  // Cloud -> local zone delete (Task 1). Same pattern as DELETE
  // /servers/:id: the cloud row is removed immediately (no ack wait — this
  // is not "Forget Server", nothing shuts down). If the zone has ever
  // reported a localZoneId, a SYNC_CONFIG command carries the deletion to
  // the Windows agent rather than adding a new CommandType — see
  // agent-bridge/lib/agent.js SERVER_HANDLERS.SYNC_CONFIG.
  // --------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>("/zones/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "zone:assign")) throw forbidden()
    const zone = await scopedZone(tenantScope(request), request.params.id)
    await prisma.zone.delete({ where: { id: zone.id } })

    if (zone.localZoneId) {
      const command = await prisma.remoteCommand.create({
        data: {
          serverId: zone.serverId,
          type: "SYNC_CONFIG",
          payload: { deleteLocalZoneId: zone.localZoneId },
          status: "PENDING",
          source: user.role === "SUPER_ADMIN" ? "SUPER_ADMIN" : "USER",
          issuedById: user.id,
        },
      })
      // Nudge a connected agent the same way every other server-level
      // command does; the next commands/pending poll picks it up regardless.
      pushToAgent(zone.serverId, "ReceiveCommand", [
        { commandId: command.id, type: "SYNC_CONFIG", zoneId: null, payload: command.payload, sequence: null },
      ])
    }

    await pushActivity({
      type: "ZONE_STATUS_CHANGED",
      message: `${zone.name} was deleted by ${user.email}${zone.localZoneId ? " — the Windows Music Server will remove it on its next sync." : "."}`,
      serverId: zone.serverId,
      zoneId: zone.id,
    })

    return reply.status(204).send()
  })
}
