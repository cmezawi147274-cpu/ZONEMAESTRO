import type { FastifyReply, FastifyRequest } from "fastify"
import type { Role } from "@prisma/client"
import { verifyAccessToken } from "./jwt.js"
import { unauthorized } from "./http-error.js"

export interface AuthUser {
  id: string
  email: string
  role: Role
  organizationId: string | null
  locationId: string | null
}

export interface TenantScope {
  isSuperAdmin: boolean
  organizationId: string | null
  /** Set for roles bound to a single venue (VIEWER). When present it narrows
   * the org scope further: reads and commands may only touch this location. */
  locationId: string | null
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser
  }
}

/** Fastify preHandler: requires a valid `Authorization: Bearer <token>`
 * header, populates `request.authUser`. Mirrors src/lib/auth/session.ts'
 * getTenantScope() derivation, but server-side and from a verified JWT —
 * never trusted from the request body. */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply) {
  const header = request.headers.authorization
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null
  if (!token) throw unauthorized()
  const claims = verifyAccessToken(token)
  if (!claims) throw unauthorized("Invalid or expired access token.")
  request.authUser = {
    id: claims.sub,
    email: claims.email,
    role: claims.role,
    organizationId: claims.organizationId,
    locationId: claims.locationId ?? null,
  }
}

export function tenantScope(request: FastifyRequest): TenantScope {
  const user = request.authUser
  if (!user) return { isSuperAdmin: false, organizationId: null, locationId: null }
  return {
    isSuperAdmin: user.role === "SUPER_ADMIN",
    organizationId: user.organizationId,
    locationId: user.role === "VIEWER" ? user.locationId : null,
  }
}

export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.authUser) throw unauthorized()
  return request.authUser
}
