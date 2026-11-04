import type { FastifyInstance } from "fastify"
import type { Prisma } from "@prisma/client"
import { prisma } from "../lib/db.js"
import { requireAuth, requireUser, tenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, badRequest } from "../lib/http-error.js"
import { scopedServer } from "../lib/tenant.js"
import { PRAYER_NAMES } from "../lib/constants.js"
import { effectivePrayers } from "../lib/prayer-scheduler.js"
import { defaultPrayers, resolveOrgId } from "./prayer.js"

const OFFSET_MINUTES = { min: -30, max: 60 }
const PAUSE_MINUTES = { min: 1, max: 60 }

function parsePrayers(body: unknown): Prisma.InputJsonObject {
  const prayers = (body as { prayers?: unknown } | null)?.prayers
  if (!prayers || typeof prayers !== "object" || Array.isArray(prayers)) throw badRequest("prayers is required.")
  const keys = Object.keys(prayers)
  if (keys.length !== PRAYER_NAMES.length || !PRAYER_NAMES.every((p) => keys.includes(p))) {
    throw badRequest(`prayers must have exactly ${PRAYER_NAMES.join(", ")}.`)
  }
  const inRange = (v: unknown, r: { min: number; max: number }) => Number.isInteger(v) && (v as number) >= r.min && (v as number) <= r.max
  const out: Record<string, Prisma.InputJsonObject> = {}
  for (const name of PRAYER_NAMES) {
    const s = (prayers as Record<string, unknown>)[name] as Record<string, unknown> | null
    if (!s || typeof s !== "object" || Object.keys(s).length !== 3) throw badRequest(`${name}: expected enabled, offsetMinutes, pauseDurationMinutes.`)
    if (typeof s.enabled !== "boolean") throw badRequest(`${name}: enabled must be true or false.`)
    if (!inRange(s.offsetMinutes, OFFSET_MINUTES)) {
      throw badRequest(`${name}: offset must be a whole number of minutes from ${OFFSET_MINUTES.min} to ${OFFSET_MINUTES.max}.`)
    }
    if (!inRange(s.pauseDurationMinutes, PAUSE_MINUTES)) {
      throw badRequest(`${name}: pause must be a whole number of minutes from ${PAUSE_MINUTES.min} to ${PAUSE_MINUTES.max}.`)
    }
    out[name] = { enabled: s.enabled, offsetMinutes: s.offsetMinutes as number, pauseDurationMinutes: s.pauseDurationMinutes as number }
  }
  return out
}

async function organizationPrayers(organizationId: string) {
  const config = await prisma.prayerConfig.findUnique({ where: { organizationId } })
  return effectivePrayers(config?.prayers ?? defaultPrayers())
}

async function serverPrayer(server: { id: string; organizationId: string }) {
  const [own, organization] = await Promise.all([
    prisma.serverPrayerOverride.findUnique({ where: { serverId: server.id } }),
    organizationPrayers(server.organizationId),
  ])
  return {
    custom: !!own,
    prayers: own ? effectivePrayers(own.prayers) : organization,
    organizationPrayers: organization,
    updatedAt: own?.updatedAt.toISOString() ?? null,
  }
}

export default async function serverPrayerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get<{ Params: { id: string } }>("/servers/:id/prayer", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "prayer:read")) throw forbidden()
    const server = await scopedServer(tenantScope(request), request.params.id)
    return reply.send(await serverPrayer(server))
  })

  app.put<{ Params: { id: string } }>("/servers/:id/prayer", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "prayer:manage")) throw forbidden()
    const server = await scopedServer(tenantScope(request), request.params.id)
    const prayers = parsePrayers(request.body)
    await prisma.serverPrayerOverride.upsert({
      where: { serverId: server.id },
      create: { serverId: server.id, prayers },
      update: { prayers },
    })
    return reply.send(await serverPrayer(server))
  })

  app.delete<{ Params: { id: string } }>("/servers/:id/prayer", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "prayer:manage")) throw forbidden()
    const server = await scopedServer(tenantScope(request), request.params.id)
    await prisma.serverPrayerOverride.deleteMany({ where: { serverId: server.id } })
    return reply.status(204).send()
  })

  app.get("/prayer/server-overrides", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "prayer:read")) throw forbidden()
    const scope = tenantScope(request)
    const orgId = await resolveOrgId(scope)
    if (!orgId) return reply.send([])
    const servers = await prisma.musicServer.findMany({
      where: { organizationId: orgId, prayerOverride: { isNot: null }, ...(scope.locationId ? { locationId: scope.locationId } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    })
    return reply.send(servers)
  })
}
