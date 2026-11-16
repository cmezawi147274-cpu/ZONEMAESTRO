import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { requireAuth, requireUser } from "../lib/auth-context.js"
import { badRequest } from "../lib/http-error.js"

const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/

export default async function pushRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.post<{ Body: { token?: unknown; platform?: unknown } }>("/push/devices", async (request, reply) => {
    const user = requireUser(request)
    const { token, platform } = request.body ?? {}
    if (typeof token !== "string" || !TOKEN_RE.test(token)) throw badRequest("Invalid push token.")
    if (platform !== "ios" && platform !== "android") throw badRequest("Invalid platform.")
    await prisma.pushDevice.upsert({
      where: { token },
      create: { token, platform, userId: user.id },
      update: { platform, userId: user.id, lastSeenAt: new Date() },
    })
    return reply.status(204).send()
  })
}
