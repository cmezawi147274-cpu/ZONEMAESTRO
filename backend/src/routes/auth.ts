import type { FastifyInstance } from "fastify"
import bcrypt from "bcryptjs"
import crypto from "node:crypto"
import { prisma } from "../lib/db.js"
import { toUser } from "../lib/serialize.js"
import { signAccessToken, signRefreshToken, verifyRefreshToken, accessTokenExpiresAtIso, refreshTokenExpiresAt } from "../lib/jwt.js"
import { requireAuth, requireUser } from "../lib/auth-context.js"
import { HttpError } from "../lib/http-error.js"

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex")
}

// ---------------------------------------------------------------------------
// Login rate limiting — /auth/login had none at all: an attacker could try
// passwords against any known email as fast as the network allowed. This is
// a minimal in-memory sliding window keyed by client IP, not a full
// @fastify/rate-limit setup, because it needs no new dependency and no
// shared store for a single backend instance. It resets per-process, so it
// stops working the moment this backend runs as more than one replica
// (nothing here is shared across instances) — swap for @fastify/rate-limit
// with a Redis store, or a proxy-level limiter, before scaling horizontally.
// ---------------------------------------------------------------------------
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 10
const loginAttempts = new Map<string, { count: number; windowStart: number }>()

function checkLoginRateLimit(ip: string) {
  const now = Date.now()
  // Opportunistic sweep so long-idle IPs don't sit in memory forever — cheap
  // relative to how rarely this map should ever hold more than a handful of
  // entries in practice.
  if (loginAttempts.size > 10_000) {
    for (const [key, entry] of loginAttempts) {
      if (now - entry.windowStart > LOGIN_WINDOW_MS) loginAttempts.delete(key)
    }
  }
  const entry = loginAttempts.get(ip)
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now })
    return
  }
  entry.count++
  if (entry.count > LOGIN_MAX_ATTEMPTS) {
    throw new HttpError(429, "TOO_MANY_REQUESTS", "Too many login attempts from this address. Try again later.")
  }
}

async function issueSession(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  const accessToken = signAccessToken(user)
  const refreshToken = signRefreshToken(user.id)
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: refreshTokenExpiresAt(),
    },
  })
  return {
    user: toUser(user),
    tokens: { accessToken, refreshToken, expiresAt: accessTokenExpiresAtIso() },
  }
}

export default async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { email: string; password: string } }>("/auth/login", async (request, reply) => {
    checkLoginRateLimit(request.ip)
    const { email, password } = request.body ?? ({} as { email: string; password: string })
    if (!email || !password) throw new HttpError(400, "BAD_REQUEST", "Email and password are required.")

    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } })
    if (!user) throw new HttpError(401, "INVALID_CREDENTIALS", "Invalid email or password.")

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) throw new HttpError(401, "INVALID_CREDENTIALS", "Invalid email or password.")

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    const session = await issueSession(user.id)
    return reply.send(session)
  })

  app.post<{ Body: { refreshToken?: string } }>("/auth/refresh", async (request, reply) => {
    const { refreshToken } = request.body ?? {}
    if (!refreshToken) throw new HttpError(400, "BAD_REQUEST", "refreshToken is required.")

    const claims = verifyRefreshToken(refreshToken)
    if (!claims) throw new HttpError(401, "INVALID_TOKEN", "Invalid or expired refresh token.")

    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) } })
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new HttpError(401, "INVALID_TOKEN", "Invalid or expired refresh token.")
    }

    const user = await prisma.user.findUnique({ where: { id: claims.sub } })
    if (!user) throw new HttpError(401, "INVALID_TOKEN", "Invalid or expired refresh token.")

    // Rotate: revoke the used refresh token, issue a fresh pair.
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } })
    const accessToken = signAccessToken(user)
    const newRefreshToken = signRefreshToken(user.id)
    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: hashToken(newRefreshToken), expiresAt: refreshTokenExpiresAt() },
    })

    return reply.send({ accessToken, refreshToken: newRefreshToken, expiresAt: accessTokenExpiresAtIso() })
  })

  app.post("/auth/logout", { preHandler: requireAuth }, async (request, reply) => {
    const user = requireUser(request)
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    return reply.status(204).send()
  })

  app.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const authUser = requireUser(request)
    const user = await prisma.user.findUnique({ where: { id: authUser.id } })
    if (!user) throw new HttpError(404, "NOT_FOUND", "User not found.")
    return reply.send(toUser(user))
  })
}
