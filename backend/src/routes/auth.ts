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
