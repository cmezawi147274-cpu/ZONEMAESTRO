import type { FastifyInstance } from "fastify"
import bcrypt from "bcryptjs"
import crypto from "node:crypto"
import { prisma } from "../lib/db.js"
import { toUser } from "../lib/serialize.js"
import { signAccessToken, signRefreshToken, verifyRefreshToken, accessTokenExpiresAtIso, refreshTokenExpiresAt } from "../lib/jwt.js"
import { requireAuth, requireUser } from "../lib/auth-context.js"
import { HttpError } from "../lib/http-error.js"
import { env } from "../lib/env.js"
import { audit } from "../lib/audit.js"

/** A bcrypt hash of a value nobody knows, compared against when the email
 * doesn't exist. Without it this route returned in microseconds for an
 * unknown address and in ~100ms for a known one, which is enough to
 * enumerate valid accounts. */
const DUMMY_HASH = bcrypt.hashSync("cmmp-timing-equalizer", 10)

/** Tight limit on the credential endpoints — the global ceiling is far too
 * generous to stop password guessing against an admin portal. */
const authRateLimit = {
  config: { rateLimit: { max: env.authRateLimitPerMinute, timeWindow: "1 minute" } },
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex")
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
  app.post<{ Body: { email: string; password: string } }>("/auth/login", authRateLimit, async (request, reply) => {
    const { email, password } = request.body ?? ({} as { email: string; password: string })
    if (!email || !password) throw new HttpError(400, "BAD_REQUEST", "Email and password are required.")

    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } })

    // Always spend the same work whether or not the account exists, then
    // fail with one indistinguishable message.
    const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH)
    if (!user || !valid) {
      // Failed attempts are the ones an investigation actually needs.
      await audit(request, {
        action: "auth.login_failed", targetType: "User", targetId: user?.id ?? null,
        summary: `Failed sign-in for ${email.trim().toLowerCase()}.`,
        actorEmailOverride: email.trim().toLowerCase(),
      })
      throw new HttpError(401, "INVALID_CREDENTIALS", "Invalid email or password.")
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    const session = await issueSession(user.id)
    request.authUser = { id: user.id, email: user.email, role: user.role, organizationId: user.organizationId, locationId: user.locationId }
    await audit(request, { action: "auth.login", targetType: "User", targetId: user.id, summary: `${user.email} signed in.` })
    return reply.send(session)
  })

  app.post<{ Body: { refreshToken?: string } }>("/auth/refresh", authRateLimit, async (request, reply) => {
    const { refreshToken } = request.body ?? {}
    if (!refreshToken) throw new HttpError(400, "BAD_REQUEST", "refreshToken is required.")

    const claims = verifyRefreshToken(refreshToken)
    if (!claims) throw new HttpError(401, "INVALID_TOKEN", "Invalid or expired refresh token.")

    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) } })
    if (!stored || stored.expiresAt < new Date()) {
      throw new HttpError(401, "INVALID_TOKEN", "Invalid or expired refresh token.")
    }

    // Reuse detection. A refresh token is single-use: presenting one that
    // was already rotated away means either a replay or that the token was
    // stolen and the thief got there first. Either way the whole family is
    // compromised, so every live token for that user is revoked and they
    // must sign in again — previously this just 401'd and left the attacker's
    // freshly-issued token working.
    if (stored.revokedAt) {
      await prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      request.log.warn({ userId: stored.userId }, "Refresh token reuse detected — all sessions revoked.")
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
    await audit(request, { action: "auth.logout", targetType: "User", targetId: user.id, summary: `${user.email} signed out of all sessions.` })
    return reply.status(204).send()
  })

  app.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const authUser = requireUser(request)
    const user = await prisma.user.findUnique({ where: { id: authUser.id } })
    if (!user) throw new HttpError(404, "NOT_FOUND", "User not found.")
    return reply.send(toUser(user))
  })
}
