import type { FastifyInstance } from "fastify"
import fs from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { parseFile } from "music-metadata"
import { prisma } from "../lib/db.js"
import { toTrack, toTrackSyncState, toMusicFolder } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound, badRequest } from "../lib/http-error.js"
import { env } from "../lib/env.js"
import { libraryReadWhere, canMutateOwned, owningOrganizationId, scopedServer, assertVisibleTrackIds } from "../lib/tenant.js"
import { audit } from "../lib/audit.js"

/**
 * Audio formats the library accepts.
 *
 * WAV is a first-class member of this list, not an afterthought: venues
 * upload uncompressed masters, and `music-metadata` reads a WAV's fmt/data
 * chunks for real duration exactly as it reads an MP3's frames, so every
 * downstream consumer (playlist run-times, the schedule editor, the agent's
 * `extensionFor` in agent-bridge/lib/agent.js) already treats it identically.
 *
 * The list exists because `POST /music/upload` previously accepted *any*
 * file up to 200 MB with no type check at all, wrote it under the music
 * volume and served it back over /media/music/. An allowlist keeps that
 * surface to audio.
 */
const ALLOWED_AUDIO = new Map<string, string>([
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".flac", "audio/flac"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
])

const ALLOWED_EXT_LIST = Array.from(ALLOWED_AUDIO.keys()).join(", ")

/** Page size when the caller doesn't ask for one. Every list route here was
 * previously unbounded — a growing library meant an ever-larger response and
 * an ever-longer query, with no ceiling. */
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function pageSize(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_LIMIT)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.floor(n))
}

/** Display name for an uploader, resolved from a batch of tracks in one
 * query. Replaces the previous per-track `user.findUnique`, which made
 * `GET /music` cost one query per row (5,001 queries for a 5,000-track
 * library) on top of returning every row. */
async function uploaderNames(userIds: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(userIds))
  if (unique.length === 0) return new Map()
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, email: true },
  })
  return new Map(users.map((u) => [u.id, u.name ?? u.email ?? u.id]))
}

export default async function musicRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  // Folder routes are registered before the /music/:id catch-all so
  // "folders" isn't parsed as a track id.
  app.get("/music/folders", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:library")) throw forbidden()
    const folders = await prisma.musicFolder.findMany({
      where: libraryReadWhere(tenantScope(request)),
      orderBy: { createdAt: "asc" },
    })
    return reply.send(folders.map(toMusicFolder))
  })

  app.post<{ Body: { name: string } }>("/music/folders", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:upload")) throw forbidden()
    const name = request.body?.name?.trim()
    if (!name) throw badRequest("A folder name is required.")
    // Ownership comes from the caller's own scope, never from the body.
    const folder = await prisma.musicFolder.create({
      data: { name, organizationId: owningOrganizationId(tenantScope(request)) },
    })
    return reply.status(201).send(toMusicFolder(folder))
  })

  app.patch<{ Params: { id: string }; Body: { name: string } }>("/music/folders/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:upload")) throw forbidden()
    const name = request.body?.name?.trim()
    if (!name) throw badRequest("A folder name is required.")
    const existing = await prisma.musicFolder.findUnique({ where: { id: request.params.id } })
    if (!existing) throw notFound("Folder")
    if (!canMutateOwned(tenantScope(request), existing.organizationId)) throw notFound("Folder")
    const folder = await prisma.musicFolder.update({ where: { id: existing.id }, data: { name } })
    return reply.send(toMusicFolder(folder))
  })

  app.delete<{ Params: { id: string } }>("/music/folders/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:upload")) throw forbidden()
    const existing = await prisma.musicFolder.findUnique({ where: { id: request.params.id } })
    if (!existing) throw notFound("Folder")
    if (!canMutateOwned(tenantScope(request), existing.organizationId)) throw notFound("Folder")
    // Tracks in this folder are never deleted — the FK just falls back to
    // null (Prisma schema: Track.folder onDelete: SetNull) and they show up
    // as "Unfiled" again.
    await prisma.musicFolder.delete({ where: { id: existing.id } })
    await audit(request, { action: "folder.delete", targetType: "MusicFolder", targetId: existing.id, summary: `Deleted folder "${existing.name}".` })
    return reply.status(204).send()
  })

  app.get<{ Querystring: { search?: string; genre?: string; limit?: string; cursor?: string; ids?: string } }>(
    "/music",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "music:read")) throw forbidden()
      const { search, genre, limit, cursor, ids } = request.query
      // Without the full catalogue, only an exact ids list of songs this caller can already see.
      if (!can(user.role, "music:library")) {
        if (!ids || search || genre || limit || cursor) throw forbidden()
        await assertVisibleTrackIds(tenantScope(request), ids.split(",").map((x) => x.trim()).filter(Boolean).slice(0, MAX_LIMIT))
      }
      const filters: Record<string, unknown>[] = [libraryReadWhere(tenantScope(request))]
      // Resolve an explicit set of ids. Callers that hold track ids — a
      // playlist's contents, a zone's current track, a sync queue — need
      // exactly those rows, not "whatever fell inside the first page".
      // Without this they fetched the whole library and joined client-side,
      // which silently dropped every track past DEFAULT_LIMIT: a 188-track
      // library rendered playlists of older uploads as completely empty.
      // Still tenant-scoped by libraryReadWhere above, and still capped.
      if (ids) {
        const wanted = ids.split(",").map((x) => x.trim()).filter(Boolean).slice(0, MAX_LIMIT)
        filters.push({ id: { in: wanted } })
      }
      if (genre && genre !== "all") filters.push({ genre })
      if (search) {
        filters.push({
          OR: [
            { title: { contains: search, mode: "insensitive" } },
            { artist: { contains: search, mode: "insensitive" } },
            { album: { contains: search, mode: "insensitive" } },
          ],
        })
      }
      const take = pageSize(limit)
      const tracks = await prisma.track.findMany({
        where: { AND: filters },
        orderBy: { uploadedAt: "desc" },
        take,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      })
      const names = await uploaderNames(tracks.map((t) => t.uploadedById))
      return reply.send(tracks.map((t) => toTrack(t, names.get(t.uploadedById) ?? t.uploadedById)))
    }
  )

  // Sync status must be registered before the /music/:id catch-all so
  // "sync-status" isn't parsed as a track id.
  app.get<{ Querystring: { serverId?: string; trackId?: string } }>("/music/sync-status", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:read")) throw forbidden()
    const scope = tenantScope(request)
    const { serverId, trackId } = request.query
    if (!serverId && !trackId) throw badRequest("serverId or trackId is required.")
    const where: Record<string, unknown> = {}
    if (serverId) {
      // Throws 404 for a server outside this tenant rather than reporting
      // another organization's sync state.
      await scopedServer(scope, serverId)
      where.serverId = serverId
    } else {
      // Without a serverId the query is still confined to this tenant's own
      // servers, so a bare trackId can't enumerate the whole fleet.
      const own = await prisma.musicServer.findMany({
        where: scope.isSuperAdmin
          ? {}
          : scope.locationId
            ? { locationId: scope.locationId }
            : { organizationId: scope.organizationId ?? " " },
        select: { id: true },
      })
      where.serverId = { in: own.map((s) => s.id) }
    }
    if (trackId) where.trackId = trackId
    const states = await prisma.trackSyncState.findMany({ where })
    return reply.send(states.map(toTrackSyncState))
  })

  app.post("/music/upload", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:upload")) throw forbidden()
    const scope = tenantScope(request)

    const parts = request.parts()
    let filePart: { filename: string; originalName: string; filePath: string; size: number } | null = null
    const fields: Record<string, string> = {}

    fs.mkdirSync(env.musicStorageDir, { recursive: true })

    for await (const part of parts) {
      if (part.type === "file") {
        // Reject on extension before writing anything to disk. `part.file`
        // still has to be drained or the multipart stream stalls.
        const ext = path.extname(part.filename).toLowerCase()
        if (!ALLOWED_AUDIO.has(ext)) {
          part.file.resume()
          throw badRequest(`"${part.filename}" is not a supported audio file. Accepted formats: ${ALLOWED_EXT_LIST}.`)
        }
        const storageKey = `${Date.now()}-${part.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`
        const destPath = path.join(env.musicStorageDir, storageKey)
        await pipeline(part.file, fs.createWriteStream(destPath))
        // @fastify/multipart truncates at the configured fileSize limit
        // rather than throwing, which would otherwise store a silently
        // corrupt half-file and report success.
        if (part.file.truncated) {
          await fs.promises.unlink(destPath).catch(() => {})
          throw badRequest(`"${part.filename}" is larger than the 200 MB upload limit.`)
        }
        const stat = fs.statSync(destPath)
        filePart = { filename: storageKey, originalName: part.filename, filePath: destPath, size: stat.size }
      } else {
        fields[part.fieldname] = String(part.value)
      }
    }

    if (!filePart) throw badRequest("A file is required.")

    // A folder may only be chosen if this caller can actually reach it —
    // otherwise the body could file an upload into another tenant's folder.
    let folderId: string | null = null
    if (fields.folderId) {
      const folder = await prisma.musicFolder.findUnique({ where: { id: fields.folderId } })
      if (!folder) throw notFound("Folder")
      if (!canMutateOwned(scope, folder.organizationId)) throw notFound("Folder")
      folderId = folder.id
    }

    // Read the real tags and duration off the uploaded file. Everything
    // downstream depends on the duration being true — playlist run-times,
    // the schedule editor, and the zone position readouts the Windows
    // agents report against — so it is never guessed.
    const tags = await parseFile(filePart.filePath).catch(() => null)

    // Content check, not just a filename check: if music-metadata cannot
    // read a container out of the bytes, this is not audio whatever it was
    // named, so it does not get to stay on the music volume.
    if (!tags?.format?.container) {
      await fs.promises.unlink(filePart.filePath).catch(() => {})
      throw badRequest(`"${filePart.originalName}" could not be read as audio. Accepted formats: ${ALLOWED_EXT_LIST}.`)
    }

    const common = tags.common
    const duration = tags.format.duration

    const track = await prisma.track.create({
      data: {
        title: fields.title || common?.title || path.parse(filePart.originalName).name,
        artist: fields.artist || common?.artist || "Unknown",
        album: fields.album || common?.album || "Unknown",
        genre: fields.genre || common?.genre?.[0] || "Pop",
        durationSec: duration && Number.isFinite(duration) ? Math.round(duration) : 0,
        fileSizeMb: Number((filePart.size / (1024 * 1024)).toFixed(1)),
        storageKey: filePart.filename,
        uploadedById: user.id,
        folderId,
        organizationId: owningOrganizationId(scope),
      },
    })
    const names = await uploaderNames([user.id])
    return reply.status(201).send(toTrack(track, names.get(user.id) ?? user.email))
  })

  app.get<{ Params: { id: string } }>("/music/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:library")) throw forbidden()
    const track = await prisma.track.findFirst({
      where: { AND: [{ id: request.params.id }, libraryReadWhere(tenantScope(request))] },
    })
    if (!track) throw notFound("Track")
    const names = await uploaderNames([track.uploadedById])
    return reply.send(toTrack(track, names.get(track.uploadedById) ?? track.uploadedById))
  })

  app.patch<{
    Params: { id: string }
    Body: Partial<{ title: string; artist: string; album: string; genre: string; folderId: string | null }>
  }>("/music/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:upload")) throw forbidden()
    const scope = tenantScope(request)
    const existing = await prisma.track.findUnique({ where: { id: request.params.id } })
    if (!existing) throw notFound("Track")
    if (!canMutateOwned(scope, existing.organizationId)) throw notFound("Track")

    // Explicit field list rather than spreading `request.body` straight into
    // Prisma — the body must not be able to reassign organizationId,
    // uploadedById or storageKey.
    const body = request.body ?? {}
    const data: Record<string, unknown> = {}
    if (body.title !== undefined) data.title = body.title
    if (body.artist !== undefined) data.artist = body.artist
    if (body.album !== undefined) data.album = body.album
    if (body.genre !== undefined) data.genre = body.genre
    if (body.folderId !== undefined) {
      if (body.folderId === null) {
        data.folderId = null
      } else {
        const folder = await prisma.musicFolder.findUnique({ where: { id: body.folderId } })
        if (!folder) throw notFound("Folder")
        if (!canMutateOwned(scope, folder.organizationId)) throw notFound("Folder")
        data.folderId = folder.id
      }
    }

    const track = await prisma.track.update({ where: { id: existing.id }, data })
    const names = await uploaderNames([track.uploadedById])
    return reply.send(toTrack(track, names.get(track.uploadedById) ?? track.uploadedById))
  })

  app.delete<{ Params: { id: string } }>("/music/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:delete")) throw forbidden()
    const track = await prisma.track.findUnique({ where: { id: request.params.id } })
    if (!track) throw notFound("Track")
    if (!canMutateOwned(tenantScope(request), track.organizationId)) throw notFound("Track")

    // A failed unlink used to be swallowed entirely, so the row vanished and
    // the bytes stayed forever. Still non-fatal — the delete must succeed
    // even if the file is already gone — but it is now visible, and
    // startOrphanMediaSweep() reclaims whatever slips through.
    const filePath = path.join(env.musicStorageDir, track.storageKey)
    await fs.promises.unlink(filePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") {
        request.log.warn({ err, storageKey: track.storageKey }, "could not delete audio file; orphan sweep will reclaim it")
      }
    })
    await prisma.track.delete({ where: { id: track.id } })
    await audit(request, { action: "track.delete", targetType: "Track", targetId: track.id, summary: `Deleted track "${track.title}" by ${track.artist}.`, metadata: { storageKey: track.storageKey, organizationId: track.organizationId } })
    return reply.status(204).send()
  })
}
