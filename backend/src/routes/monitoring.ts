import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toAlert, toLogEntry } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound } from "../lib/http-error.js"
import type { LogLevel } from "@prisma/client"

export default async function monitoringRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get<{ Querystring: { limit?: string } }>("/monitoring/activity", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "logs:read")) throw forbidden()
    const scope = tenantScope(request)
    const limit = Number(request.query.limit ?? 50)
    if (scope.isSuperAdmin) {
      const events = await prisma.activityEvent.findMany({ orderBy: { timestamp: "desc" }, take: limit })
      return reply.send(events.map((e) => ({ ...e, timestamp: e.timestamp.toISOString() })))
    }
    if (!scope.organizationId) return reply.send([])
    const servers = await prisma.musicServer.findMany({ where: { organizationId: scope.organizationId }, select: { id: true } })
    const serverIds = new Set(servers.map((s) => s.id))
    const events = await prisma.activityEvent.findMany({
      where: { serverId: { in: Array.from(serverIds) } },
      orderBy: { timestamp: "desc" },
      take: limit,
    })
    return reply.send(events.map((e) => ({ ...e, timestamp: e.timestamp.toISOString() })))
  })

  app.get("/monitoring/alerts", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "logs:read")) throw forbidden()
    const scope = tenantScope(request)
    let where: Record<string, unknown> = {}
    if (!scope.isSuperAdmin) {
      if (!scope.organizationId) return reply.send([])
      const [servers, locations] = await Promise.all([
        prisma.musicServer.findMany({ where: { organizationId: scope.organizationId }, select: { id: true } }),
        prisma.location.findMany({ where: { organizationId: scope.organizationId }, select: { id: true } }),
      ])
      where = {
        OR: [
          { serverId: { in: servers.map((s) => s.id) } },
          { locationId: { in: locations.map((l) => l.id) } },
        ],
      }
    }
    const alerts = await prisma.alert.findMany({ where, orderBy: { createdAt: "desc" } })
    return reply.send(alerts.map(toAlert))
  })

  app.post<{ Params: { id: string } }>("/monitoring/alerts/:id/acknowledge", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "logs:read")) throw forbidden()
    const scope = tenantScope(request)
    const alert = await prisma.alert.findUnique({ where: { id: request.params.id } })
    if (!alert) throw notFound("Alert")
    if (!scope.isSuperAdmin) {
      if (!scope.organizationId) throw notFound("Alert")
      const [server, location] = await Promise.all([
        alert.serverId ? prisma.musicServer.findUnique({ where: { id: alert.serverId }, select: { organizationId: true } }) : null,
        alert.locationId ? prisma.location.findUnique({ where: { id: alert.locationId }, select: { organizationId: true } }) : null,
      ])
      const orgId = server?.organizationId ?? location?.organizationId
      if (orgId !== scope.organizationId) throw notFound("Alert")
    }
    const updated = await prisma.alert.update({ where: { id: alert.id }, data: { acknowledged: true } })
    return reply.send(toAlert(updated))
  })

  app.get<{ Querystring: { serverId?: string; level?: LogLevel; limit?: string } }>("/monitoring/logs", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "logs:read")) throw forbidden()
    const scope = tenantScope(request)
    const { serverId, level, limit } = request.query
    let where: Record<string, unknown> = {}
    if (!scope.isSuperAdmin) {
      if (!scope.organizationId) return reply.send([])
      const servers = await prisma.musicServer.findMany({ where: { organizationId: scope.organizationId }, select: { id: true } })
      where.serverId = { in: servers.map((s) => s.id) }
    }
    if (serverId) where.serverId = serverId
    if (level) where.level = level
    const logs = await prisma.logEntry.findMany({ where, orderBy: { timestamp: "desc" }, take: Number(limit ?? 200) })
    return reply.send(logs.map(toLogEntry))
  })
}
