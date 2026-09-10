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
  /** How long a signed /media/music/ URL stays valid (see lib/media-url.ts).
   * Generous by default: a venue on a slow link can take hours to work
   * through a sync queue, and a dead link there looks like a sync failure. */
  mediaUrlTtlSeconds: Number(process.env.MEDIA_URL_TTL_SECONDS ?? 24 * 60 * 60),
  /** Requests per minute per IP, applied globally. Login and agent pairing
   * get their own tighter limits at their routes. */
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600),
  authRateLimitPerMinute: Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE ?? 10),

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
  agentPairingCodeTtlMinutes: Number(process.env.SERVER_PAIRING_CODE_TTL_MINUTES ?? 60),
  // How long an UNPAIRED server row (status UNKNOWN, no agentTokenHash)
  // survives past its code's own expiry before the sweep deletes it —
  // deliberately independent of agentPairingCodeTtlMinutes above. An
  // expired code just means POST /servers/:id/pairing-code needs pressing
  // again; it does not mean the venue registration itself is junk. See
  // lib/agent-sweep.ts startExpiredPairingSweep().
  agentUnpairedRetentionDays: Number(process.env.SERVER_UNPAIRED_RETENTION_DAYS ?? 7),
  // A server with no heartbeat for this many seconds is swept to OFFLINE.
  agentHeartbeatIntervalSeconds: Number(process.env.SERVER_HEARTBEAT_INTERVAL_SECONDS ?? 15),
  agentOfflineAfterMissedBeats: Number(process.env.SERVER_OFFLINE_AFTER_MISSED_BEATS ?? 3),
  // How long a zone transport command (PLAY/PAUSE/.../MUTE) waits for the
  // agent's ack before the portal request fails.
  agentCommandAckTimeoutMs: Number(process.env.AGENT_COMMAND_ACK_TIMEOUT_MS ?? 3000),
  // "Forget Server" waits far longer than a transport command: the agent has
  // to stop the Windows service, kill the playback processes, turn auto-start
  // off and wipe its local pairing before it can ack. The cloud row is only
  // deleted once that ack lands (see routes/servers.ts).
  agentForgetAckTimeoutMs: Number(process.env.AGENT_FORGET_ACK_TIMEOUT_MS ?? 30000),
}

/**
 * Secrets that ship as placeholders in the tracked `.env.example`. A
 * deployment that never replaced them is signing tokens with a value
 * published in the git repository, so anyone who can read the repo can mint
 * a SUPER_ADMIN token. This was live in production and is why boot now
 * fails closed rather than warning.
 */
const PUBLISHED_PLACEHOLDERS = [
  "replace-with-a-long-random-value",
  "replace-with-a-different-long-random-value",
  "change-me-before-deploying",
  "cmmp-mock-mode-development-secret-do-not-use-in-prod",
]

/**
 * Throws unless every secret has actually been set to something private.
 * Called at boot before the server listens — a refusal to start is far
 * cheaper than an undetected authentication bypass.
 */
export function assertSecretsAreNotPlaceholders(): void {
  const offenders: string[] = []
  const check = (name: string, value: string, minLength = 24) => {
    if (PUBLISHED_PLACEHOLDERS.includes(value)) offenders.push(`${name} is the placeholder value from .env.example`)
    else if (value.length < minLength) offenders.push(`${name} is only ${value.length} characters (minimum ${minLength})`)
  }
  check("JWT_ACCESS_SECRET", env.jwtAccessSecret)
  check("JWT_REFRESH_SECRET", env.jwtRefreshSecret)
  if (env.jwtAccessSecret === env.jwtRefreshSecret) {
    offenders.push("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values")
  }
  for (const placeholder of PUBLISHED_PLACEHOLDERS) {
    if (env.databaseUrl.includes(placeholder)) {
      offenders.push("DATABASE_URL still contains the placeholder password from .env.example")
      break
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      [
        "Refusing to start with placeholder secrets:",
        ...offenders.map((o) => `  - ${o}`),
        "",
        "Generate real values (openssl rand -base64 48) and set them in .env,",
        "then recreate the container. These placeholders are published in the",
        "git-tracked .env.example, so leaving them in place means anyone who",
        "can read the repository can forge a SUPER_ADMIN token.",
      ].join("\n")
    )
  }
}

/** PUBLIC_API_URL failing is silent everywhere else: agents are handed a
 * music URL built from it, so a placeholder value makes them download
 * whatever answers that hostname. Checked at boot instead. */
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
