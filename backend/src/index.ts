import Fastify from "fastify"
import crypto from "node:crypto"
import cors from "@fastify/cors"
import helmet from "@fastify/helmet"
import rateLimit from "@fastify/rate-limit"
import multipart from "@fastify/multipart"
import fastifyStatic from "@fastify/static"
import { env, publicApiUrlProblem, assertSecretsAreNotPlaceholders } from "./lib/env.js"
import { HttpError } from "./lib/http-error.js"
import { initRealtime } from "./realtime.js"
import { SIGNED_PREFIX, verifyMediaRequest } from "./lib/media-url.js"

import authRoutes from "./routes/auth.js"
import organizationsRoutes from "./routes/organizations.js"
import locationsRoutes from "./routes/locations.js"
import serversRoutes from "./routes/servers.js"
import zonesRoutes from "./routes/zones.js"
import equalizerPresetsRoutes from "./routes/equalizer-presets.js"
import commandsRoutes from "./routes/commands.js"
import musicRoutes from "./routes/music.js"
import playlistsRoutes from "./routes/playlists.js"
import schedulesRoutes from "./routes/schedules.js"
import syncRoutes from "./routes/sync.js"
import usersRoutes from "./routes/users.js"
import dashboardRoutes from "./routes/dashboard.js"
import monitoringRoutes from "./routes/monitoring.js"
import prayerRoutes from "./routes/prayer.js"
import agentRoutes from "./routes/agent.js"
import { attachMusicServerHub } from "./agent/signalrHub.js"
import { startAgentHeartbeatSweep, startUnpairedRetentionSweep, startRetentionSweep, startOrphanMediaSweep } from "./lib/agent-sweep.js"
import { startPrayerScheduler } from "./lib/prayer-scheduler.js"
import { prisma } from "./lib/db.js"

// Fail closed before anything listens: a deployment still using the
// placeholders published in the git-tracked .env.example is signing tokens
// with a value anyone who can read the repo already has.
assertSecretsAreNotPlaceholders()

const app = Fastify({
  logger: {
    // `logger: true` logged every request at info with no redaction. At the
    // agent poll rates this system runs (~50 req/min/venue) that is millions
    // of lines a day into an unbounded json-file driver — the disk fills and
    // the host goes down. Warn-level keeps errors while dropping the 2xx
    // firehose; set LOG_LEVEL=info to get it back for debugging.
    level: process.env.LOG_LEVEL ?? "warn",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers['set-cookie']",
        "*.password",
        "*.passwordHash",
        "*.accessToken",
        "*.refreshToken",
        "*.agentToken",
      ],
      censor: "[redacted]",
    },
  },
})

// Security headers. `contentSecurityPolicy` is off because this process
// serves JSON and audio, never HTML — the portal is a separate origin with
// its own policy, and a CSP here would only apply to error pages.
await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: false })

// The allowlist has existed in lib/env.ts and .env.example since the
// beginning; it was simply never passed here, leaving `origin: true`, which
// reflects any origin and — with credentials — lets any website call this
// API with a user's session.
await app.register(cors, {
  origin: env.corsAllowedOrigins,
  credentials: true,
})

// Global ceiling. Auth and pairing get their own tighter limits at their
// routes.
//
// Keyed per *agent* rather than per IP on the agent surface. A venue
// legitimately makes ~50 requests a minute (heartbeat, command poll, two
// sync loops), so a plain per-IP budget silently caps how many venues can
// sit behind one public address — around a dozen at the default, after
// which real venues start receiving 429s and appear to go offline. That is
// a scaling cliff nobody would think to look for.
//
// Agent requests already carry a long-lived opaque token bound to exactly
// one MusicServer row (lib/agent-auth.ts), so the token is a far better
// identity than the IP: each venue gets its own budget, a single misbehaving
// agent is still contained, and an attacker without a valid token cannot
// reach this path at all — they fall through to the IP-keyed branch. The
// token is hashed rather than used raw so a credential never becomes a
// rate-limiter map key.
const agentPrefix = env.agentApiPrefix.replace(/\/$/, "")
await app.register(rateLimit, {
  global: true,
  max: env.rateLimitPerMinute,
  timeWindow: "1 minute",
  allowList: () => false,
  keyGenerator: (request) => {
    const ip = (request.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? request.ip
    const path = request.raw.url?.split("?")[0] ?? ""
    if (path.startsWith(`${agentPrefix}/server/`)) {
      const header = request.headers.authorization
      const token = header?.startsWith("Bearer ") ? header.slice(7) : null
      if (token) return `agent:${crypto.createHash("sha256").update(token).digest("hex")}`
    }
    return ip
  },
  // Carries BOTH keys deliberately: `statusCode` is what Fastify's error
  // handler below reads to pick the response status, `status` is what the
  // portal's ApiError shape (src/lib/api/types.ts) reads. Returning only
  // `status` made every rate-limited request come back as a 500.
  errorResponseBuilder: () => ({
    statusCode: 429,
    status: 429,
    code: "RATE_LIMITED",
    message: "Too many requests. Please slow down and try again shortly.",
  }),
})

await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } })

// `/media/music/` is no longer an open directory. Every request must carry
// an unexpired HMAC signature covering the exact storage key (see
// lib/media-url.ts); agents are handed signed URLs during track sync. This
// also refuses any key containing a path separator, which closes the
// path-traversal advisory against the static handler.
app.addHook("onRequest", async (request, reply) => {
  const path = request.raw.url?.split("?")[0] ?? ""
  if (!path.startsWith(SIGNED_PREFIX)) return
  const check = verifyMediaRequest(path, request.query as Record<string, unknown>)
  if (!check.ok) {
    return reply.status(check.status).send({ status: check.status, code: "FORBIDDEN", message: check.message })
  }
})

await app.register(fastifyStatic, { root: env.musicStorageDir, prefix: SIGNED_PREFIX, decorateReply: false })

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof HttpError) {
    return reply.status(error.status).send({ status: error.status, code: error.code, message: error.message })
  }
  // Fastify validation errors, rate-limit rejections, etc.
  const raw = error as { statusCode?: number; code?: string; message?: string }
  const status = raw.statusCode ?? 500
  // Only 5xx is genuinely our fault; logging every 4xx at error level put
  // client mistakes (a bad password, a rate-limited poll) in the same bucket
  // as real faults.
  if (status >= 500) app.log.error(error)

  // Preserve a caller-meaningful code when the error carries one — a
  // rate-limit rejection reported itself as INTERNAL_ERROR before this,
  // which told the portal nothing about why it was refused. Fastify's own
  // FST_ERR_* internals stay hidden behind the generic code.
  const carried = typeof raw.code === "string" && !raw.code.startsWith("FST_") ? raw.code : null
  const code = carried ?? (status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST")
  const message = status < 500 ? (raw.message ?? "Request failed.") : "Internal server error."
  return reply.status(status).send({ status, code, message })
})

// Liveness: is the process up. Deliberately cheap and dependency-free —
// `commit` is baked in at image build time (see Dockerfile's GIT_COMMIT
// build arg) so "is production actually running my fix" is answerable by
// looking, instead of manually diffing `git log` against `docker inspect`.
app.get("/health", async () => ({ ok: true, commit: process.env.GIT_COMMIT ?? "unknown" }))

// Readiness: can this instance actually serve. /health returned ok while
// Postgres was down, so the container reported healthy when every request
// was failing. Point orchestrator readiness probes here, not at /health.
app.get("/ready", async (_request, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    return { ok: true, commit: process.env.GIT_COMMIT ?? "unknown" }
  } catch {
    return reply.status(503).send({ status: 503, code: "NOT_READY", message: "Database is unavailable." })
  }
})

await app.register(
  async (api) => {
    await api.register(authRoutes)
    await api.register(organizationsRoutes)
    await api.register(locationsRoutes)
    await api.register(serversRoutes)
    await api.register(zonesRoutes)
    await api.register(equalizerPresetsRoutes)
    await api.register(commandsRoutes)
    await api.register(musicRoutes)
    await api.register(playlistsRoutes)
    await api.register(schedulesRoutes)
    await api.register(syncRoutes)
    await api.register(usersRoutes)
    await api.register(dashboardRoutes)
    await api.register(monitoringRoutes)
    await api.register(prayerRoutes)
  },
  { prefix: "/api" }
)

// Windows MusicServer agent surface — registered at the app root (not
// nested under the `/api` plugin above) because it builds its own full
// paths from `env.agentApiPrefix` (default "/api", matching the paths
// observed on the compiled agent's own local API — see routes/agent.ts).
// Browsers never call these; the portal stays on the routes registered
// above.
await app.register(agentRoutes)

await app.listen({ port: env.port, host: "0.0.0.0" })
initRealtime(app.server)
attachMusicServerHub(app.server)
const sweeps = [startAgentHeartbeatSweep(), startUnpairedRetentionSweep(), startRetentionSweep(), startOrphanMediaSweep()]
// Prayer Mode executes here, not in a browser tab: pauses must keep
// happening with the portal closed. See lib/prayer-scheduler.ts.
sweeps.push(startPrayerScheduler())
app.log.info(`CMMP backend listening on 0.0.0.0:${env.port}, realtime namespace /realtime, agent API at ${env.agentApiPrefix}`)

/**
 * Graceful shutdown. There was none: `docker compose up -d` sends SIGTERM
 * and the process died mid-request, so every deploy could drop an in-flight
 * command write or truncate an upload. Fastify stops accepting connections,
 * drains what is open, then Prisma closes its pool.
 */
let shuttingDown = false
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info(`${signal} received — draining connections.`)
    // Hard ceiling so a stuck connection can't block the deploy forever.
    const forceExit = setTimeout(() => {
      app.log.error("Shutdown timed out after 15s — exiting.")
      process.exit(1)
    }, 15000)
    forceExit.unref()
    try {
      for (const timer of sweeps) clearInterval(timer)
      await app.close()
      await prisma.$disconnect()
      app.log.info("Shutdown complete.")
      process.exit(0)
    } catch (err) {
      app.log.error(err, "Error during shutdown.")
      process.exit(1)
    }
  })
}

const publicUrlIssue = publicApiUrlProblem()
if (publicUrlIssue) {
  app.log.error("=".repeat(72))
  app.log.error(`CONFIGURATION PROBLEM: ${publicUrlIssue}`)
  app.log.error(`Fix: set PUBLIC_API_URL in .env to this server's real public address`)
  app.log.error(`     (for example http://<this-server-ip>:${env.port}) then recreate this container.`)
  app.log.error("=".repeat(72))
}
