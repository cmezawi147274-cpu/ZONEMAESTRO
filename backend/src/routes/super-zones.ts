import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { requireAuth, requireUser, tenantScope, type AuthUser } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound, badRequest } from "../lib/http-error.js"
import { scopedServer } from "../lib/tenant.js"
import { pushToAgent } from "../lib/agent-registry.js"
import type { Prisma } from "@prisma/client"

type GroupZone = { id: string; name: string; leaderZoneId: string | null; superZoneCopyVolume: boolean }

function groupOf(leader: GroupZone, zones: GroupZone[]) {
  return {
    leaderZoneId: leader.id,
    leaderName: leader.name,
    followerZoneIds: zones.filter((z) => z.leaderZoneId === leader.id).map((z) => z.id),
    copyVolume: leader.superZoneCopyVolume,
  }
}

function parseGroup(body: unknown): { followerZoneIds: string[]; copyVolume: boolean } {
  const { followerZoneIds, copyVolume } = (body ?? {}) as { followerZoneIds?: unknown; copyVolume?: unknown }
  if (!Array.isArray(followerZoneIds) || !followerZoneIds.every((id) => typeof id === "string")) {
    throw badRequest("followerZoneIds must be a list of zone ids.")
  }
  if (typeof copyVolume !== "boolean") throw badRequest("copyVolume must be true or false.")
  return { followerZoneIds: Array.from(new Set(followerZoneIds as string[])), copyVolume }
}

/** The venue re-fetches its schedules and zone playlists on SYNC_CONFIG, so a
 * link or unlink takes effect now rather than on its next periodic sync. */
async function queueSyncConfig(serverId: string, user: AuthUser) {
  const command = await prisma.remoteCommand.create({
    data: {
      serverId,
      type: "SYNC_CONFIG",
      status: "PENDING",
      source: user.role === "SUPER_ADMIN" ? "SUPER_ADMIN" : "USER",
      issuedById: user.id,
    },
  })
  pushToAgent(serverId, "ReceiveCommand", [{ commandId: command.id, type: "SYNC_CONFIG", zoneId: null, payload: null, sequence: null }])
  return command
}

/** A newly linked follower is handed slots the venue has never seen for it,
 * which it force-starts whatever its leader is doing. Queued after the
 * SYNC_CONFIG (the venue runs commands in issuedAt order), this puts the
 * follower back in its leader's state and holds those slots. One paused for
 * its own prayer carries that prayer, so agent 2026.11.4+ keeps it silent
 * until the prayer ends; older builds ignore the payload. */
async function queueHold(serverId: string, zoneId: string, type: "PAUSE" | "STOP", user: AuthUser, after: Date, prayer: string | null) {
  const { commandSequence: sequence } = await prisma.zone.update({ where: { id: zoneId }, data: { commandSequence: { increment: 1 } } })
  const payload = prayer ? { prayer } : null
  const command = await prisma.remoteCommand.create({
    data: {
      serverId,
      zoneId,
      type,
      ...(payload ? { payload } : {}),
      status: "PENDING",
      source: user.role === "SUPER_ADMIN" ? "SUPER_ADMIN" : "USER",
      sequence,
      issuedById: user.id,
      issuedAt: new Date(after.getTime() + 1),
    },
  })
  pushToAgent(serverId, "ReceiveCommand", [{ commandId: command.id, type, zoneId, payload, sequence }])
}

/** Serializes Super Zones changes per server, so two saves at once cannot
 * both pass the one-level checks against the same snapshot. */
async function lockServerGroups(tx: Prisma.TransactionClient, serverId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('cmmp:super-zones'), hashtext(${serverId}))::text`
}

export default async function superZonesRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get<{ Params: { id: string } }>("/servers/:id/super-zones", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "zone:read")) throw forbidden()
    const server = await scopedServer(tenantScope(request), request.params.id)
    const zones = await prisma.zone.findMany({
      where: { serverId: server.id },
      select: { id: true, name: true, leaderZoneId: true, superZoneCopyVolume: true },
      orderBy: { name: "asc" },
    })
    const groups = zones.filter((z) => zones.some((f) => f.leaderZoneId === z.id)).map((leader) => groupOf(leader, zones))
    return reply.send({ groups })
  })

  app.put<{ Params: { id: string; leaderZoneId: string } }>("/servers/:id/super-zones/:leaderZoneId", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "zone:assign")) throw forbidden()
    const scope = tenantScope(request)
    const server = await scopedServer(scope, request.params.id)
    const { followerZoneIds, copyVolume } = parseGroup(request.body)

    const { group, leaderState, added } = await prisma.$transaction(async (tx) => {
      await lockServerGroups(tx, server.id)
      const zones = await tx.zone.findMany({
        where: { serverId: server.id, ...(scope.locationId ? { locationId: scope.locationId } : {}) },
        select: { id: true, name: true, leaderZoneId: true, superZoneCopyVolume: true, playbackState: true, pausedByPrayer: true },
        orderBy: { name: "asc" },
      })
      const byId = new Map(zones.map((z) => [z.id, z]))
      const leader = byId.get(request.params.leaderZoneId)
      if (!leader) throw notFound("Zone")
      if (leader.leaderZoneId) {
        throw badRequest(`${leader.name} follows ${byId.get(leader.leaderZoneId)?.name ?? "another zone"}, so it cannot be a super zone.`)
      }
      for (const id of followerZoneIds) {
        const follower = byId.get(id)
        if (id === leader.id) throw badRequest("A super zone cannot follow itself.")
        if (!follower) throw badRequest("Followers must be zones on this Music Server.")
        if (follower.leaderZoneId && follower.leaderZoneId !== leader.id) {
          throw badRequest(`${follower.name} already follows ${byId.get(follower.leaderZoneId)?.name ?? "another zone"}.`)
        }
        if (zones.some((z) => z.leaderZoneId === follower.id)) {
          throw badRequest(`${follower.name} is a super zone, so it cannot follow another zone.`)
        }
      }

      await tx.zone.updateMany({
        where: { serverId: server.id, leaderZoneId: leader.id, id: { notIn: followerZoneIds } },
        data: { leaderZoneId: null },
      })
      if (followerZoneIds.length > 0) {
        await tx.zone.updateMany({ where: { serverId: server.id, id: { in: followerZoneIds } }, data: { leaderZoneId: leader.id } })
      }
      const keepVolume = followerZoneIds.length > 0 && copyVolume
      await tx.zone.update({ where: { id: leader.id }, data: { superZoneCopyVolume: keepVolume } })
      const followers = zones.filter((z) => followerZoneIds.includes(z.id))
      return {
        group: { leaderZoneId: leader.id, leaderName: leader.name, followerZoneIds: followers.map((z) => z.id), copyVolume: keepVolume },
        leaderState: leader.playbackState,
        added: followers.filter((z) => z.leaderZoneId !== leader.id),
      }
    })

    const sync = await queueSyncConfig(server.id, user)
    for (const follower of added) {
      const hold = leaderState === "PAUSED" ? "PAUSE" : leaderState !== "PLAYING" ? "STOP" : follower.pausedByPrayer ? "PAUSE" : null
      if (hold) await queueHold(server.id, follower.id, hold, user, sync.issuedAt, follower.pausedByPrayer)
    }
    return reply.send(group)
  })

  app.delete<{ Params: { id: string; leaderZoneId: string } }>("/servers/:id/super-zones/:leaderZoneId", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "zone:assign")) throw forbidden()
    const scope = tenantScope(request)
    const server = await scopedServer(scope, request.params.id)
    const leader = await prisma.zone.findUnique({ where: { id: request.params.leaderZoneId } })
    if (!leader || leader.serverId !== server.id || (scope.locationId && leader.locationId !== scope.locationId)) throw notFound("Zone")
    const freed = await prisma.$transaction(async (tx) => {
      await lockServerGroups(tx, server.id)
      const { count } = await tx.zone.updateMany({ where: { serverId: server.id, leaderZoneId: leader.id }, data: { leaderZoneId: null } })
      await tx.zone.update({ where: { id: leader.id }, data: { superZoneCopyVolume: false } })
      return count
    })
    if (freed > 0) await queueSyncConfig(server.id, user)
    return reply.status(204).send()
  })
}
