import type { FastifyInstance } from "fastify"
import fs from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { parseFile } from "music-metadata"
import { prisma } from "../lib/db.js"
import { toTrack, toTrackSyncState, toMusicFolder } from "../lib/serialize.js"
import { requireAuth, requireUser } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound, badRequest } from "../lib/http-error.js"
import { env } from "../lib/env.js"

async function displayNameFor(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  return user?.name ?? user?.email ?? userId
}

export default async function musicRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  // Folder routes are registered before the /music/:id catch-all so
  // "folders" isn't parsed as a track id.
  app.get("/music/folders", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:read")) throw forbidden()
    const folders = await prisma.musicFolder.findMany({ orderBy: { createdAt: "asc" } })
    return reply.send(folders.map(toMusicFolder))
  })

  app.post<{ Body: { name: string } }>("/music/folders", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:upload")) throw forbidden()
    const name = request.body?.name?.trim()
    if (!name) throw badRequest("A folder name is required.")
    const folder = await prisma.musicFolder.create({ data: { name } })
    return reply.status(201).send(toMusicFolder(folder))
  })

  app.patch<{ Params: { id: string }; Body: { name: string } }>("/music/folders/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:upload")) throw forbidden()
    const name = request.body?.name?.trim()
    if (!name) throw badRequest("A folder name is required.")
    const folder = await prisma.musicFolder.update({ where: { id: request.params.id }, data: { name } })
    return reply.send(toMusicFolder(folder))
  })

  app.delete<{ Params: { id: string } }>("/music/folders/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:upload")) throw forbidden()
    // Tracks in this folder are never deleted — the FK just falls back to
    // null (Prisma schema: Track.folder onDelete: SetNull) and they show up
    // as "Unfiled" again.
    await prisma.musicFolder.delete({ where: { id: request.params.id } })
    return reply.status(204).send()
  })

  app.get<{ Querystring: { search?: string; genre?: string } }>("/music", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:read")) throw forbidden()
    const { search, genre } = request.query
    const where: Record<string, unknown> = {}
    if (genre && genre !== "all") where.genre = genre
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { artist: { contains: search, mode: "insensitive" } },
        { album: { contains: search, mode: "insensitive" } },
      ]
    }
    const tracks = await prisma.track.findMany({ where, orderBy: { uploadedAt: "desc" } })
    const items = await Promise.all(tracks.map(async (t) => toTrack(t, await displayNameFor(t.uploadedById))))
    return reply.send(items)
  })

  // Sync status must be registered before the /music/:id catch-all so
  // "sync-status" isn't parsed as a track id.
  app.get<{ Querystring: { serverId?: string; trackId?: string } }>("/music/sync-status", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:read")) throw forbidden()
    const { serverId, trackId } = request.query
    if (!serverId && !trackId) throw badRequest("serverId or trackId is required.")
    const where: Record<string, unknown> = {}
    if (serverId) where.serverId = serverId
    if (trackId) where.trackId = trackId
    const states = await prisma.trackSyncState.findMany({ where })
    return reply.send(states.map(toTrackSyncState))
  })

  app.post("/music/upload", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:upload")) throw forbidden()

    const parts = request.parts()
    let filePart: { filename: string; originalName: string; filePath: string; size: number } | null = null
    const fields: Record<string, string> = {}

    fs.mkdirSync(env.musicStorageDir, { recursive: true })

    for await (const part of parts) {
      if (part.type === "file") {
        const storageKey = `${Date.now()}-${part.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`
        const destPath = path.join(env.musicStorageDir, storageKey)
        await pipeline(part.file, fs.createWriteStream(destPath))
        const stat = fs.statSync(destPath)
        filePart = { filename: storageKey, originalName: part.filename, filePath: destPath, size: stat.size }
      } else {
        fields[part.fieldname] = String(part.value)
      }
    }

    if (!filePart) throw badRequest("A file is required.")

    // Read the real tags and duration off the uploaded file. Everything
    // downstream depends on the duration being true — playlist run-times,
    // the schedule editor, and the zone position readouts the Windows
    // agents report against — so it is never guessed.
    const tags = await parseFile(filePart.filePath).catch(() => null)
    const common = tags?.common
    const duration = tags?.format?.duration

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
        folderId: fields.folderId || null,
      },
    })
    return reply.status(201).send(toTrack(track, await displayNameFor(user.id)))
  })

  app.get<{ Params: { id: string } }>("/music/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:read")) throw forbidden()
    const track = await prisma.track.findUnique({ where: { id: request.params.id } })
    if (!track) throw notFound("Track")
    return reply.send(toTrack(track, await displayNameFor(track.uploadedById)))
  })

  app.patch<{
    Params: { id: string }
    Body: Partial<{ title: string; artist: string; album: string; genre: string; folderId: string | null }>
  }>(
    "/music/:id",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "music:upload")) throw forbidden()
      const track = await prisma.track.update({ where: { id: request.params.id }, data: request.body })
      return reply.send(toTrack(track, await displayNameFor(track.uploadedById)))
    }
  )

  app.delete<{ Params: { id: string } }>("/music/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "music:delete")) throw forbidden()
    const track = await prisma.track.findUnique({ where: { id: request.params.id } })
    if (track) {
      const filePath = path.join(env.musicStorageDir, track.storageKey)
      fs.promises.unlink(filePath).catch(() => {})
    }
    await prisma.track.delete({ where: { id: request.params.id } })
    return reply.status(204).send()
  })
}
