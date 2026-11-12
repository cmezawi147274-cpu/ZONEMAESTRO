import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { toOrganization } from "../lib/serialize.js"
import { requireAuth, requireUser, tenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { badRequest, forbidden, notFound } from "../lib/http-error.js"
import { pushActivity } from "../lib/activity.js"
import { audit } from "../lib/audit.js"

async function withCounts(org: { id: string }) {
  const [locationCount, serverCount] = await Promise.all([
    prisma.location.count({ where: { organizationId: org.id } }),
    prisma.musicServer.count({ where: { organizationId: org.id } }),
  ])
  return { locationCount, serverCount }
}

export default async function organizationsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get("/organizations", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "org:read")) throw forbidden()
    const scope = tenantScope(request)
    const orgs = await prisma.organization.findMany({
      where: scope.isSuperAdmin ? {} : scope.organizationId ? { id: scope.organizationId } : { id: "__none__" },
      orderBy: { name: "asc" },
    })
    const items = await Promise.all(
      orgs.map(async (o) => {
        const { locationCount, serverCount } = await withCounts(o)
        return toOrganization(o, locationCount, serverCount)
      })
    )
    return reply.send(items)
  })

  app.get<{ Params: { id: string } }>("/organizations/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "org:read")) throw forbidden()
    const scope = tenantScope(request)
    if (!scope.isSuperAdmin && request.params.id !== scope.organizationId) throw forbidden()
    const org = await prisma.organization.findUnique({ where: { id: request.params.id } })
    if (!org) throw notFound("Organization")
    const { locationCount, serverCount } = await withCounts(org)
    return reply.send(toOrganization(org, locationCount, serverCount))
  })

  app.post<{ Body: { name: string; contactName: string; contactEmail: string; plan: "STARTER" | "PROFESSIONAL" | "ENTERPRISE" } }>(
    "/organizations",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "org:write")) throw forbidden()
      const { name, contactName, contactEmail, plan } = request.body
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
      const org = await prisma.organization.create({
        data: { name, contactName, contactEmail, plan, slug },
      })
      await pushActivity({ type: "SERVER_CONNECTED", message: `Organization "${org.name}" created.` })
      return reply.status(201).send(toOrganization(org, 0, 0))
    }
  )

  app.patch<{ Params: { id: string }; Body: Partial<{ name: string; contactName: string; contactEmail: string; plan: string; status: string }> }>(
    "/organizations/:id",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "org:write")) throw forbidden()
      const { name, contactName, contactEmail, plan, status } = request.body
      const org = await prisma.organization.update({
        where: { id: request.params.id },
        data: { name, contactName, contactEmail, plan, status } as never,
      })
      const { locationCount, serverCount } = await withCounts(org)
      return reply.send(toOrganization(org, locationCount, serverCount))
    }
  )

  app.delete<{ Params: { id: string } }>("/organizations/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "org:write")) throw forbidden()
    const org = await prisma.organization.findUnique({ where: { id: request.params.id } })
    if (!org) throw notFound("Organization")
    const userCount = await prisma.user.count({ where: { organizationId: org.id, role: { not: "SUPER_ADMIN" } } })
    if (userCount > 0) throw badRequest(`This organization still has ${userCount} user${userCount === 1 ? "" : "s"}. Move or delete them on the Users page first.`)
    const servers = await prisma.musicServer.findMany({ where: { organizationId: org.id }, select: { id: true } })
    await prisma.$transaction([
      prisma.organization.delete({ where: { id: org.id } }),
      prisma.deletedServerTombstone.createMany({ data: servers.map((s) => ({ id: s.id })), skipDuplicates: true }),
    ])
    await audit(request, { action: "organization.delete", targetType: "Organization", targetId: request.params.id, summary: `Deleted organization ${request.params.id} and everything under it.` })
    return reply.status(204).send()
  })
}
