import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toLocation } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound } from "../lib/http-error.js"

async function withCounts(loc: { id: string }) {
  const [serverCount, zoneCount] = await Promise.all([
    prisma.musicServer.count({ where: { locationId: loc.id } }),
    prisma.zone.count({ where: { locationId: loc.id } }),
  ])
  return { serverCount, zoneCount }
}

export default async function locationsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get<{ Querystring: { organizationId?: string } }>("/locations", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "location:read")) throw forbidden()
    const scope = tenantScope(request)
    const organizationId = request.query.organizationId
    let where: Record<string, unknown> = {}
    if (scope.isSuperAdmin) {
      if (organizationId) where = { organizationId }
    } else {
      if (!scope.organizationId) return reply.send([])
      where = { organizationId: scope.organizationId }
    }
    const locations = await prisma.location.findMany({ where, orderBy: { name: "asc" } })
    const items = await Promise.all(
      locations.map(async (l) => {
        const { serverCount, zoneCount } = await withCounts(l)
        return toLocation(l, serverCount, zoneCount)
      })
    )
    return reply.send(items)
  })

  app.get<{ Params: { id: string } }>("/locations/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "location:read")) throw forbidden()
    const scope = tenantScope(request)
    const loc = await prisma.location.findUnique({ where: { id: request.params.id } })
    if (!loc) throw notFound("Location")
    if (!scope.isSuperAdmin && loc.organizationId !== scope.organizationId) throw notFound("Location")
    const { serverCount, zoneCount } = await withCounts(loc)
    return reply.send(toLocation(loc, serverCount, zoneCount))
  })

  interface LocationBody {
    organizationId: string
    name: string
    address: string
    city: string
    region: string
    country: string
    timezone: string
    latitude?: number | null
    longitude?: number | null
  }

  app.post<{ Body: LocationBody }>("/locations", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "location:write")) throw forbidden()
    const { organizationId, name, address, city, region, country, timezone } = request.body
    const scope = tenantScope(request)
    if (!scope.isSuperAdmin && organizationId !== scope.organizationId) throw forbidden()
    const loc = await prisma.location.create({
      data: { organizationId, name, address, city, region, country, timezone },
    })
    return reply.status(201).send(toLocation(loc, 0, 0))
  })

  app.patch<{ Params: { id: string }; Body: Partial<LocationBody> }>("/locations/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "location:write")) throw forbidden()
    const scope = tenantScope(request)
    const existing = await prisma.location.findUnique({ where: { id: request.params.id } })
    if (!existing) throw notFound("Location")
    if (!scope.isSuperAdmin && existing.organizationId !== scope.organizationId) throw notFound("Location")
    const { latitude: _lat, longitude: _lng, organizationId: _org, ...rest } = request.body
    const loc = await prisma.location.update({ where: { id: existing.id }, data: rest })
    const { serverCount, zoneCount } = await withCounts(loc)
    return reply.send(toLocation(loc, serverCount, zoneCount))
  })

  app.delete<{ Params: { id: string } }>("/locations/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "location:write")) throw forbidden()
    const scope = tenantScope(request)
    const existing = await prisma.location.findUnique({ where: { id: request.params.id } })
    if (!existing) throw notFound("Location")
    if (!scope.isSuperAdmin && existing.organizationId !== scope.organizationId) throw notFound("Location")
    await prisma.location.delete({ where: { id: existing.id } })
    return reply.status(204).send()
  })
}
