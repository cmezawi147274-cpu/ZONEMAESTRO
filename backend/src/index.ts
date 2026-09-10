import Fastify from "fastify"
import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import fastifyStatic from "@fastify/static"
import { env, publicApiUrlProblem } from "./lib/env.js"
import { HttpError } from "./lib/http-error.js"
import { initRealtime } from "./realtime.js"

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
import { startAgentHeartbeatSweep, startUnpairedRetentionSweep } from "./lib/agent-sweep.js"
import { startPrayerScheduler } from "./lib/prayer-scheduler.js"

const app = Fastify({ logger: true })

// `origin: true` (reflect whatever Origin the caller sends) combined with
// credentials:true means any website can make a credentialed cross-origin
// request and have the browser accept the response — the portal only ever
// needs its own origin(s), from env.corsAllowedOrigins (CORS_ALLOWED_ORIGINS
// in .env; see .env.example for the production value). A request with no
// Origin header at all (curl, the Windows agent's own fetch calls) is
// unaffected either way — CORS is a browser-enforced check, not a server
// perimeter, so this only tightens what a browser will accept.
await app.register(cors, {
  origin: env.corsAllowedOrigins,
  credentials: true,
})
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } })
await app.register(fastifyStatic, { root: env.musicStorageDir, prefix: "/media/music/", decorateReply: false })

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof HttpError) {
    return reply.status(error.status).send({ status: error.status, code: error.code, message: error.message })
  }
  // Fastify validation errors etc.
  const status = (error as { statusCode?: number }).statusCode ?? 500
  app.log.error(error)
  const message = error instanceof Error ? error.message : "Internal server error."
  return reply.status(status).send({ status, code: "INTERNAL_ERROR", message: status < 500 ? message : "Internal server error." })
})

// QA review Option 6: `commit` is baked in at image build time (see
// Dockerfile's GIT_COMMIT build arg) — the one place "is production
// actually running my fix" is answerable by looking, instead of manually
// diffing `git log` against `docker inspect`'s build timestamp.
app.get("/health", async () => ({ ok: true, commit: process.env.GIT_COMMIT ?? "unknown" }))

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
startAgentHeartbeatSweep()
startUnpairedRetentionSweep()
// Prayer Mode executes here, not in a browser tab: pauses must keep
// happening with the portal closed. See lib/prayer-scheduler.ts.
startPrayerScheduler()
app.log.info(`CMMP backend listening on 0.0.0.0:${env.port}, realtime namespace /realtime, agent API at ${env.agentApiPrefix}`)

const publicUrlIssue = publicApiUrlProblem()
if (publicUrlIssue) {
  app.log.error("=".repeat(72))
  app.log.error(`CONFIGURATION PROBLEM: ${publicUrlIssue}`)
  app.log.error(`Fix: set PUBLIC_API_URL in .env to this server's real public address`)
  app.log.error(`     (for example http://<this-server-ip>:${env.port}) then recreate this container.`)
  app.log.error("=".repeat(72))
}
