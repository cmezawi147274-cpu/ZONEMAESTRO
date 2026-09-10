import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toMusicServer, toLogEntry } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound, badRequest } from "../lib/http-error.js"
import { generatePairingCode, hashPairingCode, pairingExpiry } from "../lib/pairing.js"
import { isAgentConnected, pushToAgent, waitForAck, forgetAgent } from "../lib/agent-registry.js"
import { pushActivity } from "../lib/activity.js"
import { env } from "../lib/env.js"

/** Loads a server the caller is actually entitled to, 404ing (never 403 —
 * this must not confirm the id exists) for anything outside their tenant
 * scope. Mirrors zones.ts scopedZone / commands.ts allowedServerIds, which
 * every other single-server route here should have been using already. */
async function scopedServer(scope: ReturnType<typeof tenantScope>, serverId: string) {
  const server = await prisma.musicServer.findUnique({ where: { id: serverId } })
  if (!server) throw notFound("Server")
  if (!scope.isSuperAdmin && server.organizationId !== scope.organizationId) throw notFound("Server")
  if (scope.locationId && server.locationId !== scope.locationId) throw notFound("Server")
  return server
}

async function withExtras(server: { id: string }) {
  const [zoneCount, pendingSyncJobs] = await Promise.all([
    prisma.zone.count({ where: { serverId: server.id } }),
    prisma.trackSyncState.count({ where: { serverId: server.id, status: { in: ["QUEUED_FOR_SYNC", "SYNCING"] } } }),
  ])
  return { zoneCount, pendingSyncJobs }
}

export default async function serversRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get<{ Querystring: { organizationId?: string; locationId?: string } }>("/servers", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "server:read")) throw forbidden()
    const scope = tenantScope(request)
    const { organizationId, locationId } = request.query
    let where: Record<string, unknown> = {}
    if (scope.isSuperAdmin) {
      if (organizationId) where.organizationId = organizationId
    } else if (scope.locationId) {
      where.locationId = scope.locationId
    } else {
      if (!scope.organizationId) return reply.send([])
      where.organizationId = scope.organizationId
    }
    if (locationId && !scope.locationId) where.locationId = locationId
    const servers = await prisma.musicServer.findMany({ where, orderBy: { name: "asc" } })
    const items = await Promise.all(
      servers.map(async (s) => {
        const { zoneCount, pendingSyncJobs } = await withExtras(s)
        return toMusicServer(s, zoneCount, pendingSyncJobs)
      })
    )
    return reply.send(items)
  })

  app.get<{ Params: { id: string } }>("/servers/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "server:read")) throw forbidden()
    const scope = tenantScope(request)
    const server = await prisma.musicServer.findUnique({ where: { id: request.params.id } })
    if (!server) throw notFound("Server")
    if (!scope.isSuperAdmin && server.organizationId !== scope.organizationId) throw notFound("Server")
    if (scope.locationId && server.locationId !== scope.locationId) throw notFound("Server")
    const { zoneCount, pendingSyncJobs } = await withExtras(server)
    return reply.send(toMusicServer(server, zoneCount, pendingSyncJobs))
  })

  app.post<{ Body: { name: string; organizationId: string; locationId: string } }>("/servers", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "server:write")) throw forbidden()
    const { name, locationId } = request.body
    // The location owns the organization — never take an org straight from
    // the body, or an Org Admin could plant a server in another tenant.
    const location = await prisma.location.findUnique({ where: { id: locationId } })
    if (!location) throw notFound("Location")
    const scope = tenantScope(request)
    if (!scope.isSuperAdmin && location.organizationId !== scope.organizationId) throw forbidden()
    const organizationId = location.organizationId
    const pairingCode = generatePairingCode()
    const server = await prisma.musicServer.create({
      data: {
        name,
        organizationId,
        locationId,
        status: "UNKNOWN",
        pairingCode,
        pairingCodeHash: hashPairingCode(pairingCode),
        pairingExpiresAt: pairingExpiry(),
      },
    })
    return reply.status(201).send(toMusicServer(server, 0, 0))
  })

  app.post<{ Params: { id: string } }>("/servers/:id/pairing-code", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "server:pair")) throw forbidden()
    const target = await scopedServer(tenantScope(request), request.params.id)
    const pairingCode = generatePairingCode()
    const server = await prisma.musicServer.update({
      where: { id: target.id },
      data: { pairingCode, pairingCodeHash: hashPairingCode(pairingCode), pairingExpiresAt: pairingExpiry() },
    })
    const { zoneCount, pendingSyncJobs } = await withExtras(server)
    return reply.send(toMusicServer(server, zoneCount, pendingSyncJobs))
  })

  app.delete<{ Params: { id: string } }>("/servers/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "server:write")) throw forbidden()
    const target = await scopedServer(tenantScope(request), request.params.id)
    await prisma.musicServer.delete({ where: { id: target.id } })
    return reply.status(204).send()
  })

  // --------------------------------------------------------------------
  // "Forget Server" — SUPER_ADMIN only, and deliberately *not* the same
  // thing as DELETE /servers/:id above (which is a cloud-side unpair and
  // leaves the Windows machine running). This shuts the venue player down,
  // wipes its local pairing/cache, and only then removes the cloud row.
  //
  // The row is never deleted optimistically. Two paths, both ending in a
  // deleted row *or* an untouched one — never a half-forgotten server:
  //   A) agent reachable -> queue FORGET_SERVER, wait for its ack. SUCCESS
  //      deletes the row; a timeout or FAILED leaves everything in place so
  //      the operator can retry against a machine that is still running.
  //   B) agent offline, or never paired -> nothing to reach, so skip the
  //      wait and delete the row, reporting that the Windows box was not
  //      contacted and may still have a player process running.
  // --------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/servers/:id/forget", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "server:forget")) throw forbidden()
    // "server:forget" is SUPER_ADMIN-only today (see lib/rbac.ts), who is
    // legitimately cross-tenant — but scope this explicitly anyway rather
    // than relying on that RBAC assignment never changing.
    const server = await scopedServer(tenantScope(request), request.params.id)

    const paired = Boolean(server.agentTokenHash)
    const reachable = paired && isAgentConnected(server.id)

    if (reachable) {
      const command = await prisma.remoteCommand.create({
        data: {
          serverId: server.id,
          type: "FORGET_SERVER",
          status: "PENDING",
          source: user.role === "SUPER_ADMIN" ? "SUPER_ADMIN" : "USER",
          issuedById: user.id,
        },
      })
      // Same delivery contract as every other server-level command: the push
      // only shaves latency, the agent's own poll of
      // GET /api/server/commands/pending stays authoritative.
      pushToAgent(server.id, "ReceiveCommand", [
        { commandId: command.id, type: "FORGET_SERVER", zoneId: null, payload: null, sequence: null },
      ])

      const ack = await waitForAck(command.id, env.agentForgetAckTimeoutMs)
      if (!ack || ack.status !== "SUCCESS") {
        // Leave the row (and the command's own audit trail) exactly as they
        // are — the machine may still be playing, and a deleted row would
        // strand it with no way to reach it again.
        if (!ack) {
          await prisma.remoteCommand.update({
            where: { id: command.id },
            data: {
              status: "TIMEOUT",
              completedAt: new Date(),
              resultMessage: `No response from ${server.name} within ${env.agentForgetAckTimeoutMs}ms.`,
            },
          })
        }
        throw badRequest(
          ack?.resultMessage ??
            `${server.name} did not confirm the shutdown within ${Math.round(env.agentForgetAckTimeoutMs / 1000)}s — nothing was removed. Check the machine and try again.`
        )
      }
    }

    // Cascades to zones, commands, logs and sync state; alerts fall back to
    // a null serverId — exactly what DELETE /servers/:id already relies on.
    await prisma.musicServer.delete({ where: { id: server.id } })
    forgetAgent(server.id)
    await pushActivity({
      type: "SERVER_DISCONNECTED",
      message: reachable
        ? `${server.name} was forgotten by ${user.email} — the venue player was shut down and its pairing wiped.`
        : `${server.name} was forgotten by ${user.email} — removed from the portal without reaching the Windows machine.`,
      serverId: null,
    })

    return reply.send({
      deleted: true,
      agentReached: reachable,
      message: reachable
        ? `${server.name} was shut down, wiped and removed from the portal.`
        : paired
          ? `${server.name} was removed from the portal, but it is offline — the Windows machine could not be reached, so a player process may still be running there.`
          : `${server.name} was removed from the portal. It had never been paired, so there was nothing to shut down.`,
    })
  })

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/servers/:id/logs", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "logs:read")) throw forbidden()
    const target = await scopedServer(tenantScope(request), request.params.id)
    const limit = Number(request.query.limit ?? 100)
    const logs = await prisma.logEntry.findMany({
      where: { serverId: target.id },
      orderBy: { timestamp: "desc" },
      take: limit,
    })
    return reply.send(logs.map(toLogEntry))
  })
}
