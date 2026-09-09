import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toPlaylist, toPlaylistAssignment } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound } from "../lib/http-error.js"
import { queuePlaylistTracksForServer } from "../lib/zone-effects.js"
import type { PlaylistTargetType } from "@prisma/client"

async function withTrackIds(playlistId: string): Promise<string[]> {
  const rows = await prisma.playlistTrack.findMany({ where: { playlistId }, orderBy: { position: "asc" } })
  return rows.map((r) => r.trackId)
}

async function replaceTrackIds(playlistId: string, trackIds: string[]) {
  await prisma.$transaction([
    prisma.playlistTrack.deleteMany({ where: { playlistId } }),
    prisma.playlistTrack.createMany({
      data: trackIds.map((trackId, position) => ({ playlistId, trackId, position })),
    }),
  ])
}

export default async function playlistsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get<{ Querystring: { organizationId?: string } }>("/playlists", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "playlist:read")) throw forbidden()
    const scope = tenantScope(request)
    const { organizationId } = request.query
    let where: Record<string, unknown> = {}
    if (scope.isSuperAdmin) {
      if (organizationId) where = { OR: [{ organizationId }, { organizationId: null }] }
    } else {
      where = { OR: [{ organizationId: scope.organizationId }, { organizationId: null }] }
    }
    const playlists = await prisma.playlist.findMany({ where, orderBy: { name: "asc" } })
    const items = await Promise.all(playlists.map(async (p) => toPlaylist(p, await withTrackIds(p.id))))
    return reply.send(items)
  })

  app.get<{ Params: { id: string } }>("/playlists/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "playlist:read")) throw forbidden()
    const scope = tenantScope(request)
    const playlist = await prisma.playlist.findUnique({ where: { id: request.params.id } })
    if (!playlist) throw notFound("Playlist")
    if (!scope.isSuperAdmin && playlist.organizationId !== null && playlist.organizationId !== scope.organizationId) {
      throw notFound("Playlist")
    }
    return reply.send(toPlaylist(playlist, await withTrackIds(playlist.id)))
  })

  app.post<{ Body: { name: string; description: string; organizationId: string | null; trackIds?: string[] } }>(
    "/playlists",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "playlist:write")) throw forbidden()
      const { name, description, organizationId, trackIds = [] } = request.body
      const playlist = await prisma.playlist.create({ data: { name, description, organizationId } })
      if (trackIds.length) await replaceTrackIds(playlist.id, trackIds)
      return reply.status(201).send(toPlaylist(playlist, trackIds))
    }
  )

  app.post<{ Params: { id: string } }>("/playlists/:id/duplicate", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "playlist:write")) throw forbidden()
    const source = await prisma.playlist.findUnique({ where: { id: request.params.id } })
    if (!source) throw notFound("Playlist")
    const trackIds = await withTrackIds(source.id)
    const copy = await prisma.playlist.create({
      data: { name: `${source.name} (Copy)`, description: source.description, organizationId: source.organizationId },
    })
    if (trackIds.length) await replaceTrackIds(copy.id, trackIds)
    return reply.status(201).send(toPlaylist(copy, trackIds))
  })

  app.patch<{ Params: { id: string }; Body: Partial<{ name: string; description: string; organizationId: string | null; trackIds: string[] }> }>(
    "/playlists/:id",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "playlist:write")) throw forbidden()
      const { trackIds, ...rest } = request.body
      const playlist = await prisma.playlist.update({ where: { id: request.params.id }, data: rest })
      if (trackIds) await replaceTrackIds(playlist.id, trackIds)
      return reply.send(toPlaylist(playlist, trackIds ?? (await withTrackIds(playlist.id))))
    }
  )

  app.post<{ Params: { id: string }; Body: { trackId: string } }>("/playlists/:id/tracks", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "playlist:write")) throw forbidden()
    const existing = await withTrackIds(request.params.id)
    if (!existing.includes(request.body.trackId)) {
      await prisma.playlistTrack.create({
        data: { playlistId: request.params.id, trackId: request.body.trackId, position: existing.length },
      })
    }
    const playlist = await prisma.playlist.update({ where: { id: request.params.id }, data: { updatedAt: new Date() } })
    return reply.send(toPlaylist(playlist, await withTrackIds(playlist.id)))
  })

  app.delete<{ Params: { id: string; trackId: string } }>("/playlists/:id/tracks/:trackId", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "playlist:write")) throw forbidden()
    await prisma.playlistTrack.deleteMany({ where: { playlistId: request.params.id, trackId: request.params.trackId } })
    const playlist = await prisma.playlist.update({ where: { id: request.params.id }, data: { updatedAt: new Date() } })
    return reply.send(toPlaylist(playlist, await withTrackIds(playlist.id)))
  })

  app.delete<{ Params: { id: string } }>("/playlists/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "playlist:write")) throw forbidden()
    await prisma.playlist.delete({ where: { id: request.params.id } })
    return reply.status(204).send()
  })

  app.post<{ Params: { id: string }; Body: { targetType: PlaylistTargetType; targetId: string } }>(
    "/playlists/:id/assign",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "playlist:write")) throw forbidden()
      const { targetType, targetId } = request.body
      const assignment = await prisma.playlistAssignment.create({
        data: { playlistId: request.params.id, targetType, targetId },
      })
      if (targetType === "ZONE") {
        const trackIds = await withTrackIds(request.params.id)
        const zone = await prisma.zone.update({
          where: { id: targetId },
          data: { currentPlaylistId: request.params.id, currentTrackId: trackIds[0] ?? null },
        })
        await queuePlaylistTracksForServer(request.params.id, zone.serverId)
      }
      return reply.status(201).send(toPlaylistAssignment(assignment))
    }
  )
}
