import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toMusicServer, toLogEntry } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound } from "../lib/http-error.js"
import { generatePairingCode, hashPairingCode, pairingExpiry } from "../lib/pairing.js"

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
    const pairingCode = generatePairingCode()
    const server = await prisma.musicServer.update({
      where: { id: request.params.id },
      data: { pairingCode, pairingCodeHash: hashPairingCode(pairingCode), pairingExpiresAt: pairingExpiry() },
    })
    const { zoneCount, pendingSyncJobs } = await withExtras(server)
    return reply.send(toMusicServer(server, zoneCount, pendingSyncJobs))
  })

  app.delete<{ Params: { id: string } }>("/servers/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "server:write")) throw forbidden()
    await prisma.musicServer.delete({ where: { id: request.params.id } })
    return reply.status(204).send()
  })

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/servers/:id/logs", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "logs:read")) throw forbidden()
    const limit = Number(request.query.limit ?? 100)
    const logs = await prisma.logEntry.findMany({
      where: { serverId: request.params.id },
      orderBy: { timestamp: "desc" },
      take: limit,
    })
    return reply.send(logs.map(toLogEntry))
  })
}
