import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toTrackSyncState } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound, badRequest } from "../lib/http-error.js"
import { pushActivity } from "../lib/activity.js"
import { scopedServer, scopedServerIds, scopedTrackIds, allowedLocationIds } from "../lib/tenant.js"

/** Ceiling on one queue request. Without it a single call could fan out to
 * an unbounded number of (track x server) rows in one transaction. */
const MAX_PAIRS = 5000

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
    const scope = tenantScope(request)

    const where: Record<string, unknown> = {}
    if (request.query.serverId) {
      // 404s rather than reporting another organization's sync state.
      await scopedServer(scope, request.query.serverId)
      where.serverId = request.query.serverId
    } else if (!scope.isSuperAdmin) {
      // A bare GET /sync used to return every tenant's rows.
      const own = await prisma.musicServer.findMany({
        where: scope.locationId
          ? { locationId: scope.locationId }
          : { locationId: { in: scope.organizationId ? await allowedLocationIds(scope.organizationId) : [] } },
        select: { id: true },
      })
      where.serverId = { in: own.map((s) => s.id) }
    }

    const states = await prisma.trackSyncState.findMany({ where, orderBy: { updatedAt: "desc" }, take: 1000 })
    return reply.send(states.map(toTrackSyncState))
  })

  app.post<{ Body: { trackIds: string[]; serverIds: string[] } }>("/sync/queue", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "sync:trigger")) throw forbidden()
    const scope = tenantScope(request)
    const { trackIds, serverIds } = request.body ?? ({} as { trackIds: string[]; serverIds: string[] })

    if (!Array.isArray(trackIds) || trackIds.length === 0) throw badRequest("trackIds is required.")
    if (!Array.isArray(serverIds) || serverIds.length === 0) throw badRequest("serverIds is required.")
    if (trackIds.length * serverIds.length > MAX_PAIRS) {
      throw badRequest(`Too many track/server combinations in one request (max ${MAX_PAIRS}).`)
    }

    // The whole point of this route's rewrite: every id is validated against
    // the caller's own tenant before anything is queued. Previously
    // `serverIds` was taken at face value, so any authenticated user could
    // push audio onto another organization's venue hardware, and any track
    // id — including another tenant's — could be named as the payload.
    const servers = await scopedServerIds(scope, serverIds)
    const tracks = await scopedTrackIds(scope, trackIds)

    const created: ReturnType<typeof toTrackSyncState>[] = []

    for (const serverId of servers) {
      // One batched transaction per server instead of a sequential upsert
      // per (track, server) pair — 500 tracks x 10 servers was 5,000
      // round-trips before, each awaited in a nested loop.
      await prisma.$transaction([
        prisma.trackSyncState.deleteMany({ where: { serverId, trackId: { in: tracks } } }),
        prisma.trackSyncState.createMany({
          data: tracks.map((trackId) => ({ trackId, serverId, status: "QUEUED_FOR_SYNC" as const, progressPercent: 0 })),
          skipDuplicates: true,
        }),
      ])
      const states = await prisma.trackSyncState.findMany({ where: { serverId, trackId: { in: tracks } } })
      created.push(...states.map(toTrackSyncState))

      await queueSyncCommand(serverId, tracks, user.id)
      const server = await prisma.musicServer.findUnique({ where: { id: serverId }, select: { name: true } })
      await pushActivity({
        type: "MUSIC_SYNC_STARTED",
        message: `${tracks.length} track(s) queued for sync to ${server?.name ?? "server"}.`,
        serverId,
      })
    }

    return reply.status(201).send(created)
  })

  app.post<{ Body: { trackId: string; serverId: string } }>("/sync/retry", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "sync:trigger")) throw forbidden()
    const scope = tenantScope(request)
    const { trackId, serverId } = request.body ?? ({} as { trackId: string; serverId: string })
    if (!trackId || !serverId) throw badRequest("trackId and serverId are required.")

    await scopedServer(scope, serverId)
    await scopedTrackIds(scope, [trackId])

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
