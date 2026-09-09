import "dotenv/config"
import path from "node:path"

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined) throw new Error(`Missing required env var ${name}`)
  return v
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  jwtAccessSecret: required("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET"),
  jwtAccessTtlSec: Number(process.env.JWT_ACCESS_TOKEN_TTL_SEC ?? 900),
  jwtRefreshTtlDays: Number(process.env.JWT_REFRESH_TOKEN_TTL_DAYS ?? 30),
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  musicStorageDir: path.resolve(process.cwd(), process.env.MUSIC_STORAGE_DIR ?? "./data/music"),

  // ----------------------------------------------------------------------
  // Windows MusicServer agent surface. This backend IS the cloud (Linux);
  // the compiled win-x64 MusicServer.Api service is a client of it, never
  // the other way around — see backend/README.md and the top-level
  // README's "Backend & Windows MusicServer integration" section.
  // ----------------------------------------------------------------------
  // Public base URL this backend is reachable at (what a technician sets
  // as `Cloud.ApiBaseUrl` in the Windows service's appsettings.json).
  publicApiUrl: process.env.PUBLIC_API_URL ?? `http://localhost:${Number(process.env.PORT ?? 4000)}`,
  // Master switch: if false, every /api/pairing/* and /api/server/* route
  // rejects with 503 instead of accepting agent traffic.
  musicServerAgentAllowed: (process.env.MUSIC_SERVER_AGENT_ALLOWED ?? "true") !== "false",
  // Path prefix the agent-facing routes are mounted under. Defaults to the
  // exact paths the compiled MusicServer.Api agent was observed calling
  // (POST /api/pairing/complete, POST /api/server/heartbeat, ...) so a
  // stock agent install works with zero configuration; override only if
  // fronting this behind a path-rewriting proxy.
  agentApiPrefix: process.env.AGENT_API_PREFIX ?? "/api",
  agentPairingCodeTtlMinutes: Number(process.env.SERVER_PAIRING_CODE_TTL_MINUTES ?? 15),
  // A server with no heartbeat for this many seconds is swept to OFFLINE.
  agentHeartbeatIntervalSeconds: Number(process.env.SERVER_HEARTBEAT_INTERVAL_SECONDS ?? 15),
  agentOfflineAfterMissedBeats: Number(process.env.SERVER_OFFLINE_AFTER_MISSED_BEATS ?? 3),
  // How long a zone transport command (PLAY/PAUSE/.../MUTE) waits for the
  // agent's ack before the portal request fails.
  agentCommandAckTimeoutMs: Number(process.env.AGENT_COMMAND_ACK_TIMEOUT_MS ?? 3000),
}

/**
 * PUBLIC_API_URL is the one setting whose being wrong produces no error
 * anywhere: every venue's agent is handed a music download URL built from
 * it, so a placeholder or localhost value means agents fetch whatever
 * answers that hostname — a parked domain returns an HTML page with status
 * 200, which lands in the venue's library as an unplayable "track". The
 * symptom shows up days later as "the music won't play", far from the
 * cause. Checked at boot so it is caught on deploy instead.
 */
export function publicApiUrlProblem(): string | null {
  const u = env.publicApiUrl
  if (/your-domain|example\.com|changeme|yourdomain/i.test(u)) {
    return `PUBLIC_API_URL is still a placeholder (${u}). Music downloads will fail on every venue.`
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(u)) {
    return `PUBLIC_API_URL points at ${u} — that resolves to the agent's own PC, not this server. Music downloads will fail on every venue.`
  }
  return null
}
