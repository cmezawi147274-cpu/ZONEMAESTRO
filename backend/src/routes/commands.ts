import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toRemoteCommand } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope, type TenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound, badRequest } from "../lib/http-error.js"
import { pushActivity } from "../lib/activity.js"
import { applyZoneCommandEffect } from "../lib/zone-effects.js"
import { isAgentConnected, pushToAgent, waitForAck } from "../lib/agent-registry.js"
import { env } from "../lib/env.js"
import type { CommandType, CommandSource } from "@prisma/client"
import type { Prisma } from "@prisma/client"

// Exported so routes/agent.ts can tell a server-level command (Forget,
// Restart Playback, Sync, Auto Boot) apart from routine zone transport when
// deciding whether a FAILED ack is worth a persistent Alert — see the
// POST /server/commands/ack handler there.
export const ZONE_TRANSPORT_TYPES = new Set<CommandType>(["PLAY", "PAUSE", "STOP", "NEXT", "PREVIOUS", "SET_VOLUME", "MUTE", "UNMUTE"])

/** Servers this caller may address: their own venue (VIEWER), otherwise
 * their organization. Super admins are unrestricted (null = no filter). */
async function allowedServerIds(scope: TenantScope): Promise<string[] | null> {
  if (scope.isSuperAdmin) return null
  if (scope.locationId) {
    const servers = await prisma.musicServer.findMany({ where: { locationId: scope.locationId }, select: { id: true } })
    return servers.map((s) => s.id)
  }
  if (!scope.organizationId) return []
  const servers = await prisma.musicServer.findMany({ where: { organizationId: scope.organizationId }, select: { id: true } })
  return servers.map((s) => s.id)
}

async function displayNameFor(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  return user?.name ?? user?.email ?? userId
}

export default async function commandsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get<{ Querystring: { serverId?: string } }>("/commands", async (request, reply) => {
    const scope = tenantScope(request)
    let where: Record<string, unknown> = {}
    const allowed = await allowedServerIds(scope)
    if (allowed) where.serverId = { in: allowed }
    if (request.query.serverId && (!allowed || allowed.includes(request.query.serverId))) where.serverId = request.query.serverId
    const commands = await prisma.remoteCommand.findMany({ where, orderBy: { issuedAt: "desc" }, take: 200 })
    const items = await Promise.all(commands.map(async (c) => toRemoteCommand(c, await displayNameFor(c.issuedById))))
    return reply.send(items)
  })

  app.get<{ Params: { id: string } }>("/commands/:id", async (request, reply) => {
    const scope = tenantScope(request)
    const command = await prisma.remoteCommand.findUnique({ where: { id: request.params.id } })
    if (!command) throw notFound("Command")
    const allowed = await allowedServerIds(scope)
    if (allowed && !allowed.includes(command.serverId)) throw notFound("Command")
    return reply.send(toRemoteCommand(command, await displayNameFor(command.issuedById)))
  })

  app.post<{ Body: { serverId: string; zoneId?: string | null; type: CommandType; payload?: Record<string, unknown>; source?: CommandSource } }>(
    "/commands",
    async (request, reply) => {
      const user = requireUser(request)
      const { serverId, zoneId, type, payload } = request.body
      // Transport is the only thing a playback-only role may issue; every
      // other command type (sync, restart, reboot) needs server:command.
      // FORGET_SERVER is the exception in the other direction: it shuts the
      // venue player down and wipes its pairing, so it takes the same
      // SUPER_ADMIN-only permission the portal's "Forget Server" button is
      // gated on. Without this, any role holding server:command could reach
      // it through the generic Send Command dialog.
      if (ZONE_TRANSPORT_TYPES.has(type)) {
        if (!can(user.role, "zone:control")) throw forbidden()
      } else if (type === "FORGET_SERVER") {
        if (!can(user.role, "server:forget")) throw forbidden()
      } else if (!can(user.role, "server:command")) {
        throw forbidden()
      }

      // Scope before anything is written: an id from another organization
      // (or another venue, for a location-bound role) is not addressable,
      // even to record a failure against it.
      const scope = tenantScope(request)
      const allowedServers = await allowedServerIds(scope)
      if (allowedServers && !allowedServers.includes(serverId)) throw notFound("Server")
      if (zoneId) {
        const target = await prisma.zone.findUnique({ where: { id: zoneId } })
        if (!target || target.serverId !== serverId) throw notFound("Zone")
        if (scope.locationId && target.locationId !== scope.locationId) throw notFound("Zone")
      }

      // The only client-supplied source ever trusted is "SCHEDULE" (Prayer
      // scheduler). Everything else is derived from the acting session.
      const source: CommandSource = request.body.source === "SCHEDULE" ? "SCHEDULE" : user.role === "SUPER_ADMIN" ? "SUPER_ADMIN" : "USER"
      const server = await prisma.musicServer.findUnique({ where: { id: serverId } })
      const now = new Date()

      if (ZONE_TRANSPORT_TYPES.has(type)) {
        // Real Windows agent required and reachable — never faked. "Offline"
        // means: no server row, no agent token ever issued (never paired),
        // or no recent heartbeat / open MusicServerHub socket (see
        // ../lib/agent-registry.ts).
        if (!server || !server.agentTokenHash || !isAgentConnected(serverId)) {
          const failed = await prisma.remoteCommand.create({
            data: {
              serverId,
              zoneId: zoneId ?? null,
              type,
              payload: (payload ?? undefined) as Prisma.InputJsonValue | undefined,
              status: "FAILED",
              source,
              issuedById: user.id,
              sentAt: null,
              completedAt: now,
              resultMessage: `${server?.name ?? "Server"} is offline.`,
            },
          })
          throw badRequest(failed.resultMessage!)
        }

        let sequence: number | null = null
        if (zoneId) {
          const bumped = await prisma.zone.update({ where: { id: zoneId }, data: { commandSequence: { increment: 1 } } })
          sequence = bumped.commandSequence
        }

        const command = await prisma.remoteCommand.create({
          data: {
            serverId,
            zoneId: zoneId ?? null,
            type,
            payload: (payload ?? undefined) as Prisma.InputJsonValue | undefined,
            status: "SENT",
            source,
            sequence,
            issuedById: user.id,
            sentAt: now,
          },
        })

        // Nudge an already-connected agent over MusicServerHub; it (and
        // every other agent, connected or not) can still pick this up via
        // the next GET /api/server/commands/pending poll — this only
        // shaves latency.
        pushToAgent(serverId, "ReceiveCommand", [{ commandId: command.id, type, zoneId: zoneId ?? null, payload: payload ?? null, sequence }])

        const ack = await waitForAck(command.id, env.agentCommandAckTimeoutMs)
        if (!ack) {
          const timedOut = await prisma.remoteCommand.update({
            where: { id: command.id },
            data: { status: "TIMEOUT", completedAt: new Date(), resultMessage: `No response from ${server.name} within ${env.agentCommandAckTimeoutMs}ms.` },
          })
          throw badRequest(timedOut.resultMessage!)
        }

        // POST /api/server/commands/ack already persisted the final status
        // (and, via its own zoneState, the zone's real playback state) —
        // re-read it. If the agent's ack carried no zoneState, fall back to
        // the optimistic effect so the portal still reflects the command.
        const acked = await prisma.remoteCommand.findUniqueOrThrow({ where: { id: command.id } })
        if (acked.status === "SUCCESS" && zoneId) {
          const zone = await prisma.zone.findUnique({ where: { id: zoneId } })
          if (zone && zone.lastAppliedSequence !== sequence) await applyZoneCommandEffect(zoneId, type, payload, sequence, source)
        }
        if (acked.status !== "SUCCESS") {
          throw badRequest(acked.resultMessage ?? `${type.replaceAll("_", " ")} failed on ${server.name}.`)
        }

        await pushActivity({
          type: "COMMAND_COMPLETED",
          message: `${type.replaceAll("_", " ")} applied for ${server.name}.`,
          serverId,
          zoneId,
        })
        return reply.status(201).send(toRemoteCommand(acked, await displayNameFor(user.id)))
      }

      // Async lifecycle for SYNC_MUSIC / SYNC_CONFIG / RESTART_SERVICE /
      // REBOOT_SERVER: stays PENDING until session 2's agent adapter picks
      // it up. Never faked as SUCCESS here.
      const command = await prisma.remoteCommand.create({
        data: {
          serverId,
          zoneId: zoneId ?? null,
          type,
          payload: (payload ?? undefined) as Prisma.InputJsonValue | undefined,
          status: "PENDING",
          source,
          issuedById: user.id,
        },
      })
      // Nudge a connected agent the same way zone transport does, so a
      // server-level action (restart, auto boot, forget, sync) isn't stuck
      // PENDING until the agent's next poll. Delivery still rests on that
      // poll — this only shaves latency, and no ack is awaited here.
      pushToAgent(serverId, "ReceiveCommand", [
        { commandId: command.id, type, zoneId: null, payload: payload ?? null, sequence: null },
      ])
      return reply.status(201).send(toRemoteCommand(command, await displayNameFor(user.id)))
    }
  )
}
