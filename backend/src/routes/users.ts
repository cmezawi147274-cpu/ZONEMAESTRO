import type { FastifyInstance } from "fastify"
import bcrypt from "bcryptjs"
import crypto from "node:crypto"
import { prisma } from "../lib/db.js"
import { toUser } from "../lib/serialize.js"
import { requireAuth, requireUser, type AuthUser } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { badRequest, forbidden, notFound } from "../lib/http-error.js"
import { audit } from "../lib/audit.js"
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
  /** Set by a SUPER_ADMIN creating an account that must be able to sign in
   * immediately. Never echoed back — `toUser` carries no credential
   * fields. Absent for every other actor, who keep the invite-only flow. */
  password?: string
}

/** Matches the client-side rule in
 * src/components/users/invite-user-dialog.tsx. */
const MIN_PASSWORD_LENGTH = 8

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

    // A SUPER_ADMIN sets the credential directly, so the account can sign in
    // the moment it exists. Every other actor keeps the invite-only flow: a
    // random temp password nobody is told, standing in for the reset link a
    // real invite would email. A password sent by a non-SUPER_ADMIN is
    // ignored rather than honored — it must not become a way to mint a
    // login for someone else's account.
    const requestedPassword = typeof request.body?.password === "string" ? request.body.password : undefined
    let passwordHash: string
    if (actor.role === "SUPER_ADMIN") {
      if (!requestedPassword || requestedPassword.length < MIN_PASSWORD_LENGTH) {
        throw badRequest(`A password of at least ${MIN_PASSWORD_LENGTH} characters is required.`)
      }
      passwordHash = await bcrypt.hash(requestedPassword, 10)
    } else {
      passwordHash = await bcrypt.hash(crypto.randomBytes(12).toString("hex"), 10)
    }
    const created = await prisma.user.create({
      data: { name, email: normalizedEmail, role, ...scope, passwordHash },
    })
    await audit(request, { action: "user.create", targetType: "User", targetId: created.id, summary: `Created ${created.email} as ${created.role}.`, metadata: { role: created.role, organizationId: created.organizationId, locationId: created.locationId } })
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
    await audit(request, { action: "user.update", targetType: "User", targetId: updated.id, summary: `Updated ${updated.email}.`, metadata: { before: { role: target.role, organizationId: target.organizationId, locationId: target.locationId }, after: { role: updated.role, organizationId: updated.organizationId, locationId: updated.locationId } } })
    return reply.send(toUser(updated))
  })

  /**
   * Set a user's password.
   *
   * Closes the hole that made onboarding impossible: `POST /users/invite`
   * hashes `crypto.randomBytes(12)` as the new account's password and there
   * is no mailer anywhere in this system, so nobody — including the invitee —
   * ever learned what it was. Every invited account was unusable.
   *
   * Two callers are allowed:
   *  - anyone changing *their own* password, which requires proving the
   *    current one;
   *  - a manager acting on a user already inside their own visibility scope
   *    and strictly below them in rank, who may set it without the old one
   *    (that is the "reset it for them" path a helpdesk needs).
   *
   * Every live session for the target is revoked either way — a password
   * change that leaves stolen refresh tokens working is not a password
   * change.
   */
  app.post<{ Params: { id: string }; Body: { currentPassword?: string; newPassword?: string } }>(
    "/users/:id/password",
    async (request, reply) => {
      const actor = requireUser(request)
      const { currentPassword, newPassword } = request.body ?? {}
      if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
        throw badRequest(`A password of at least ${MIN_PASSWORD_LENGTH} characters is required.`)
      }

      const isSelf = actor.id === request.params.id
      let target
      if (isSelf) {
        target = await prisma.user.findUnique({ where: { id: actor.id } })
        if (!target) throw notFound("User")
        if (!currentPassword) throw badRequest("Your current password is required.")
        const ok = await bcrypt.compare(currentPassword, target.passwordHash)
        if (!ok) throw badRequest("Your current password is incorrect.")
      } else {
        if (!can(actor.role, "users:manage")) throw forbidden()
        target = await prisma.user.findFirst({ where: { AND: [{ id: request.params.id }, visibilityWhere(actor)] } })
        if (!target) throw notFound("User")
        // Same seniority rule the rest of this file enforces: never act on a
        // peer or a superior.
        if (actor.role !== "SUPER_ADMIN" && RANK[target.role] >= RANK[actor.role]) throw forbidden()
      }

      await prisma.user.update({
        where: { id: target.id },
        data: { passwordHash: await bcrypt.hash(newPassword, 10) },
      })
      await prisma.refreshToken.updateMany({
        where: { userId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      await audit(request, { action: "user.password_set", targetType: "User", targetId: target.id, summary: isSelf ? `${target.email} changed their own password.` : `Password reset for ${target.email}.`, metadata: { self: isSelf } })
      return reply.status(204).send()
    }
  )

  app.delete<{ Params: { id: string } }>("/users/:id", async (request, reply) => {
    const actor = requireUser(request)
    if (!can(actor.role, "users:manage")) throw forbidden()
    const target = await prisma.user.findFirst({ where: { AND: [{ id: request.params.id }, visibilityWhere(actor)] } })
    if (!target) throw notFound("User")
    if (actor.role !== "SUPER_ADMIN" && RANK[target.role] >= RANK[actor.role]) throw forbidden()
    await prisma.user.delete({ where: { id: target.id } })
    await audit(request, { action: "user.delete", targetType: "User", targetId: target.id, summary: `Deleted ${target.email} (${target.role}).`, metadata: { role: target.role, organizationId: target.organizationId } })
    return reply.status(204).send()
  })
}
