import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toTrackSyncState } from "../lib/serialize.js"
import { requireAuth, requireUser } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound } from "../lib/http-error.js"
import { pushActivity } from "../lib/activity.js"

async function queueSyncCommand(serverId: string, trackIds: string[], issuedById: string) {
  return prisma.remoteCommand.create({
    data: { serverId, type: "SYNC_MUSIC", payload: { trackIds }, status: "PENDING", source: "USER", issuedById },
  })
}

export default async function syncRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get<{ Querystring: { serverId?: string } }>("/sync", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "sync:trigger")) throw forbidden()
    const where = request.query.serverId ? { serverId: request.query.serverId } : {}
    const states = await prisma.trackSyncState.findMany({ where, orderBy: { updatedAt: "desc" } })
    return reply.send(states.map(toTrackSyncState))
  })

  app.post<{ Body: { trackIds: string[]; serverIds: string[] } }>("/sync/queue", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "sync:trigger")) throw forbidden()
    const { trackIds, serverIds } = request.body
    const created: Awaited<ReturnType<typeof toTrackSyncState>>[] = []

    for (const serverId of serverIds) {
      for (const trackId of trackIds) {
        const state = await prisma.trackSyncState.upsert({
          where: { trackId_serverId: { trackId, serverId } },
          create: { trackId, serverId, status: "QUEUED_FOR_SYNC", progressPercent: 0 },
          update: { status: "QUEUED_FOR_SYNC", progressPercent: 0, errorMessage: null },
        })
        created.push(toTrackSyncState(state))
      }
      await queueSyncCommand(serverId, trackIds, user.id)
      const server = await prisma.musicServer.findUnique({ where: { id: serverId } })
      await pushActivity({
        type: "MUSIC_SYNC_STARTED",
        message: `${trackIds.length} track(s) queued for sync to ${server?.name ?? "server"}.`,
        serverId,
      })
    }
    return reply.status(201).send(created)
  })

  app.post<{ Body: { trackId: string; serverId: string } }>("/sync/retry", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "sync:trigger")) throw forbidden()
    const { trackId, serverId } = request.body
    const existing = await prisma.trackSyncState.findUnique({ where: { trackId_serverId: { trackId, serverId } } })
    if (!existing) throw notFound("Sync state")
    const state = await prisma.trackSyncState.update({
      where: { trackId_serverId: { trackId, serverId } },
      data: { status: "QUEUED_FOR_SYNC", progressPercent: 0, errorMessage: null },
    })
    await queueSyncCommand(serverId, [trackId], user.id)
    return reply.send(toTrackSyncState(state))
  })
}
