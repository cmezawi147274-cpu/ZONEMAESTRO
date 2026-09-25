import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toPlaylist, toPlaylistAssignment } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope, type TenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound } from "../lib/http-error.js"
import { queuePlaylistTracksForServer } from "../lib/zone-effects.js"
import { audit } from "../lib/audit.js"
import { scopedPlaylist, scopedAssignmentTarget, canMutateOwned } from "../lib/tenant.js"
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

/**
 * The `organizationId` a new playlist must carry. Mirrors `routes/users.ts`
 * `resolveScope`: a SUPER_ADMIN is the operator and may deliberately target
 * any organization (or the shared catalogue) via the create dialog's org
 * picker, so their requested value is honored once the org is confirmed to
 * exist. Everyone else's is forced to their own organization regardless of
 * what the body claims — never taken from the request body for them, which
 * is the mass-assignment hole `users.ts` already avoids.
 */
async function resolvePlaylistOrgId(scope: TenantScope, requested: string | null | undefined): Promise<string | null> {
  if (!scope.isSuperAdmin) return scope.organizationId
  const orgId = requested ?? null
  if (orgId) {
    const org = await prisma.organization.findUnique({ where: { id: orgId } })
    if (!org) throw notFound("Organization")
  }
  return orgId
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

  app.post<{ Body: { name: string; description: string; organizationId?: string | null; trackIds?: string[] } }>(
    "/playlists",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "playlist:write")) throw forbidden()
      const scope = tenantScope(request)
      const { name, description, organizationId, trackIds = [] } = request.body
      const ownerOrgId = await resolvePlaylistOrgId(scope, organizationId)
      const playlist = await prisma.playlist.create({ data: { name, description, organizationId: ownerOrgId } })
      if (trackIds.length) await replaceTrackIds(playlist.id, trackIds)
      return reply.status(201).send(toPlaylist(playlist, trackIds))
    }
  )

  app.post<{ Params: { id: string } }>("/playlists/:id/duplicate", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "playlist:write")) throw forbidden()
    const scope = tenantScope(request)
    const source = await scopedPlaylist(scope, request.params.id)
    const trackIds = await withTrackIds(source.id)
    const copy = await prisma.playlist.create({
      data: { name: `${source.name} (Copy)`, description: source.description, organizationId: source.organizationId },
    })
    if (trackIds.length) await replaceTrackIds(copy.id, trackIds)
    return reply.status(201).send(toPlaylist(copy, trackIds))
  })

  app.patch<{ Params: { id: string }; Body: Partial<{ name: string; description: string; trackIds: string[] }> }>(
    "/playlists/:id",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "playlist:write")) throw forbidden()
      const scope = tenantScope(request)
      const existing = await scopedPlaylist(scope, request.params.id)
      if (!canMutateOwned(scope, existing.organizationId)) throw notFound("Playlist")
      const { trackIds, ...rest } = request.body
      const playlist = await prisma.playlist.update({ where: { id: existing.id }, data: rest })
      if (trackIds) await replaceTrackIds(playlist.id, trackIds)
      return reply.send(toPlaylist(playlist, trackIds ?? (await withTrackIds(playlist.id))))
    }
  )

  app.post<{ Params: { id: string }; Body: { trackId: string } }>("/playlists/:id/tracks", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "playlist:write")) throw forbidden()
    const scope = tenantScope(request)
    const existingPlaylist = await scopedPlaylist(scope, request.params.id)
    if (!canMutateOwned(scope, existingPlaylist.organizationId)) throw notFound("Playlist")
    const existing = await withTrackIds(existingPlaylist.id)
    if (!existing.includes(request.body.trackId)) {
      await prisma.playlistTrack.create({
        data: { playlistId: existingPlaylist.id, trackId: request.body.trackId, position: existing.length },
      })
    }
    const playlist = await prisma.playlist.update({ where: { id: existingPlaylist.id }, data: { updatedAt: new Date() } })
    return reply.send(toPlaylist(playlist, await withTrackIds(playlist.id)))
  })

  app.delete<{ Params: { id: string; trackId: string } }>("/playlists/:id/tracks/:trackId", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "playlist:write")) throw forbidden()
    const scope = tenantScope(request)
    const existingPlaylist = await scopedPlaylist(scope, request.params.id)
    if (!canMutateOwned(scope, existingPlaylist.organizationId)) throw notFound("Playlist")
    await prisma.playlistTrack.deleteMany({ where: { playlistId: existingPlaylist.id, trackId: request.params.trackId } })
    const playlist = await prisma.playlist.update({ where: { id: existingPlaylist.id }, data: { updatedAt: new Date() } })
    return reply.send(toPlaylist(playlist, await withTrackIds(playlist.id)))
  })

  app.delete<{ Params: { id: string } }>("/playlists/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "playlist:write")) throw forbidden()
    const scope = tenantScope(request)
    const existing = await scopedPlaylist(scope, request.params.id)
    if (!canMutateOwned(scope, existing.organizationId)) throw notFound("Playlist")
    await prisma.playlist.delete({ where: { id: existing.id } })
    await audit(request, { action: "playlist.delete", targetType: "Playlist", targetId: existing.id, summary: `Deleted playlist ${existing.id}.` })
    return reply.status(204).send()
  })

  app.post<{ Params: { id: string }; Body: { targetType: PlaylistTargetType; targetId: string } }>(
    "/playlists/:id/assign",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "playlist:write")) throw forbidden()
      const scope = tenantScope(request)
      const { targetType, targetId } = request.body
      const playlist = await scopedPlaylist(scope, request.params.id)
      await scopedAssignmentTarget(scope, targetType, targetId)

      const existingAssignment = await prisma.playlistAssignment.findFirst({
        where: { playlistId: playlist.id, targetType, targetId },
      })
      const assignment =
        existingAssignment ??
        (await prisma.playlistAssignment.create({
          data: { playlistId: playlist.id, targetType, targetId },
        }))

      if (targetType === "ZONE") {
        const trackIds = await withTrackIds(playlist.id)
        const zone = await prisma.zone.update({
          where: { id: targetId },
          data: { currentPlaylistId: playlist.id, currentTrackId: trackIds[0] ?? null },
        })
        await queuePlaylistTracksForServer(playlist.id, zone.serverId)
      }
      return reply.status(existingAssignment ? 200 : 201).send(toPlaylistAssignment(assignment))
    }
  )
}
