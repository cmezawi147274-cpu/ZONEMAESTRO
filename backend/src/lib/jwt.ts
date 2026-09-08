import jwt from "jsonwebtoken"
import { env } from "./env.js"
import type { Role } from "@prisma/client"

export interface AccessClaims {
  sub: string
  email: string
  role: Role
  organizationId: string | null
  locationId: string | null
  type: "access"
}

export interface RefreshClaims {
  sub: string
  type: "refresh"
}

export function signAccessToken(user: { id: string; email: string; role: Role; organizationId: string | null; locationId: string | null }) {
  const claims: AccessClaims = {
    sub: user.id,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
    locationId: user.locationId,
    type: "access",
  }
  return jwt.sign(claims, env.jwtAccessSecret, { expiresIn: env.jwtAccessTtlSec })
}

export function signRefreshToken(userId: string) {
  const claims: RefreshClaims = { sub: userId, type: "refresh" }
  return jwt.sign(claims, env.jwtRefreshSecret, { expiresIn: `${env.jwtRefreshTtlDays}d` })
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    return jwt.verify(token, env.jwtAccessSecret) as AccessClaims
  } catch {
    return null
  }
}

export function verifyRefreshToken(token: string): RefreshClaims | null {
  try {
    return jwt.verify(token, env.jwtRefreshSecret) as RefreshClaims
  } catch {
    return null
  }
}

export function accessTokenExpiresAtIso(): string {
  return new Date(Date.now() + env.jwtAccessTtlSec * 1000).toISOString()
}

export function refreshTokenExpiresAt(): Date {
  return new Date(Date.now() + env.jwtRefreshTtlDays * 24 * 60 * 60 * 1000)
}
