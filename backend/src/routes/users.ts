import type { FastifyInstance } from "fastify"
import bcrypt from "bcryptjs"
import crypto from "node:crypto"
import { prisma } from "../lib/db.js"
import { toUser } from "../lib/serialize.js"
import { requireAuth, requireUser, type AuthUser } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { badRequest, forbidden, notFound } from "../lib/http-error.js"
import type { Role } from "@prisma/client"

/** Seniority, so a creator can never mint a peer or a superior. */
const RANK: Record<Role, number> = { SUPER_ADMIN: 3, ORGANIZATION_ADMIN: 2, LOCATION_MANAGER: 1, VIEWER: 0 }

/** Roles that are bound to exactly one venue — a location is mandatory and
 * its organization, not anything the client sent, decides organizationId. */
const LOCATION_BOUND: Role[] = ["VIEWER", "LOCATION_MANAGER"]

interface UserBody {
  name: string
  email: string
  role: Role
  organizationId: string | null
  locationId: string | null
}

/** Which existing users this caller is allowed to see or act on. */
function visibilityWhere(actor: AuthUser) {
  if (actor.role === "SUPER_ADMIN") return {}
  if (actor.role === "ORGANIZATION_ADMIN") {
    if (!actor.organizationId) return { id: actor.id }
    return { organizationId: actor.organizationId }
  }
  // LOCATION_MANAGER: only their own venue's users (plus themselves).
  if (!actor.locationId) return { id: actor.id }
  return { OR: [{ locationId: actor.locationId }, { id: actor.id }] }
}

/**
 * Resolves the (organizationId, locationId) pair a new/updated user must
 * carry, from the caller's own scope plus the requested role. The location's
 * organization always wins over a client-sent organizationId.
 */
async function resolveScope(actor: AuthUser, role: Role, body: Partial<UserBody>) {
  if (role === "SUPER_ADMIN") return { organizationId: null, locationId: null }

  if (LOCATION_BOUND.includes(role)) {
    const locationId = body.locationId ?? null
    if (!locationId) throw badRequest(`A location is required for ${role === "VIEWER" ? "a Viewer" : "a Location Manager"}.`)
    const location = await prisma.location.findUnique({ where: { id: locationId } })
    if (!location) throw notFound("Location")
    if (actor.role === "LOCATION_MANAGER" && location.id !== actor.locationId) throw forbidden()
    if (actor.role === "ORGANIZATION_ADMIN" && location.organizationId !== actor.organizationId) throw forbidden()
    return { organizationId: location.organizationId, locationId: location.id }
  }

  // ORGANIZATION_ADMIN: an org, and optionally a location inside it.
  const organizationId = actor.role === "SUPER_ADMIN" ? body.organizationId ?? null : actor.organizationId
  if (!organizationId) throw badRequest("An organization is required for this role.")
  const organization = await prisma.organization.findUnique({ where: { id: organizationId } })
  if (!organization) throw notFound("Organization")
  let locationId: string | null = null
  if (body.locationId) {
    const location = await prisma.location.findUnique({ where: { id: body.locationId } })
    if (!location) throw notFound("Location")
    if (location.organizationId !== organizationId) throw forbidden()
    locationId = location.id
  }
  return { organizationId, locationId }
}

export default async function usersRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get("/users", async (request, reply) => {
    const actor = requireUser(request)
    if (!can(actor.role, "users:manage")) throw forbidden()
    const users = await prisma.user.findMany({ where: visibilityWhere(actor), orderBy: { name: "asc" } })
    return reply.send(users.map(toUser))
  })

  app.post<{ Body: UserBody }>("/users/invite", async (request, reply) => {
    const actor = requireUser(request)
    if (!can(actor.role, "users:manage")) throw forbidden()

    const { name, email, role } = request.body ?? ({} as UserBody)
    if (!name || !email || !role) throw badRequest("Name, email and role are required.")
    if (!(role in RANK)) throw badRequest("Unknown role.")
    // A Location Manager may only create Viewers; an Org Admin may not mint
    // another Org Admin. Only SUPER_ADMIN may create a peer.
    if (actor.role !== "SUPER_ADMIN" && RANK[role] >= RANK[actor.role]) throw forbidden()

    const scope = await resolveScope(actor, role, request.body)
    const normalizedEmail = email.trim().toLowerCase()
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } })
    if (existing) throw badRequest("A user with that email already exists.")

    // No email delivery in this session — a random temp password is set so
    // the record exists; a real invite flow would email a reset link.
    const tempPassword = crypto.randomBytes(12).toString("hex")
    const passwordHash = await bcrypt.hash(tempPassword, 10)
    const created = await prisma.user.create({
      data: { name, email: normalizedEmail, role, ...scope, passwordHash },
    })
    return reply.status(201).send(toUser(created))
  })

  app.patch<{ Params: { id: string }; Body: Partial<UserBody> }>("/users/:id", async (request, reply) => {
    const actor = requireUser(request)
    if (!can(actor.role, "users:manage")) throw forbidden()
    const target = await prisma.user.findFirst({ where: { AND: [{ id: request.params.id }, visibilityWhere(actor)] } })
    if (!target) throw notFound("User")
    if (actor.role !== "SUPER_ADMIN" && RANK[target.role] >= RANK[actor.role]) throw forbidden()

    const role = request.body.role ?? target.role
    if (actor.role !== "SUPER_ADMIN" && RANK[role] >= RANK[actor.role]) throw forbidden()
    const scope = await resolveScope(actor, role, {
      organizationId: request.body.organizationId ?? target.organizationId,
      locationId: request.body.locationId ?? target.locationId,
    })

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: {
        ...(request.body.name !== undefined ? { name: request.body.name } : {}),
        ...(request.body.email !== undefined ? { email: request.body.email.trim().toLowerCase() } : {}),
        role,
        ...scope,
      },
    })
    return reply.send(toUser(updated))
  })

  app.delete<{ Params: { id: string } }>("/users/:id", async (request, reply) => {
    const actor = requireUser(request)
    if (!can(actor.role, "users:manage")) throw forbidden()
    const target = await prisma.user.findFirst({ where: { AND: [{ id: request.params.id }, visibilityWhere(actor)] } })
    if (!target) throw notFound("User")
    if (actor.role !== "SUPER_ADMIN" && RANK[target.role] >= RANK[actor.role]) throw forbidden()
    await prisma.user.delete({ where: { id: target.id } })
    return reply.status(204).send()
  })
}
