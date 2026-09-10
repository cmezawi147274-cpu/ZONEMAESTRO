import { prisma } from "./db.js"
import { env } from "./env.js"
import { pushActivity } from "./activity.js"
import { forgetAgent, isAgentConnected } from "./agent-registry.js"
import fs from "node:fs"
import path from "node:path"

/** Periodic check: any MusicServer we believe is ONLINE/WARNING but whose
 * agent hasn't heartbeated (REST) or held an open MusicServerHub socket
 * within the stale window gets flipped to OFFLINE and broadcasts
 * SERVER_DISCONNECTED — the Windows agent never has to tell us it's going
 * away (it usually can't: network drop, power loss, restaurant PC turned
 * off at close). */
export function startAgentHeartbeatSweep() {
  const intervalMs = Math.max(5, env.agentHeartbeatIntervalSeconds) * 1000
  const timer = setInterval(async () => {
    try {
      const stale = await prisma.musicServer.findMany({ where: { status: { in: ["ONLINE", "WARNING"] } } })
      for (const server of stale) {
        if (isAgentConnected(server.id)) continue
        await prisma.musicServer.update({ where: { id: server.id }, data: { status: "OFFLINE" } })
        forgetAgent(server.id)
        await pushActivity({ type: "SERVER_DISCONNECTED", message: `${server.name} disconnected.`, serverId: server.id })
      }
    } catch {
      // best-effort — never let a sweep failure take down the process
    }
  }, intervalMs)
  timer.unref()
  return timer
}

/** Once every 5 minutes — pairing codes/expiry don't need heartbeat-grade
 * cadence, and a findMany on every heartbeat tick would be wasted work. */
const UNPAIRED_RETENTION_SWEEP_MS = 5 * 60 * 1000

/**
 * A MusicServer row that was created (POST /servers, "Register Server")
 * but never actually paired: status UNKNOWN, no agentTokenHash.
 *
 * Its pairing code expiring does NOT make the row junk — that's exactly
 * the "registered in the office, engineer visits later" case, and an
 * expired code is recoverable with POST /servers/:id/pairing-code as long
 * as the row still exists. Only a row whose code has been expired for
 * longer than `env.agentUnpairedRetentionDays` (deliberately independent
 * of the code TTL itself — see lib/env.ts) is treated as abandoned.
 *
 * Deliberately narrow: a row that WAS paired at least once and later got
 * released back to UNKNOWN by another device re-pairing (see
 * routes/agent.ts POST /pairing/complete `previousServerId` handling) has
 * pairingExpiresAt cleared to null at its own pairing time — `lt: cutoff`
 * against null never matches, so that row is untouched here.
 */
export function startUnpairedRetentionSweep() {
  const timer = setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - env.agentUnpairedRetentionDays * 24 * 60 * 60 * 1000)
      const abandoned = await prisma.musicServer.findMany({
        where: { status: "UNKNOWN", agentTokenHash: null, pairingExpiresAt: { lt: cutoff } },
        select: { id: true, name: true },
      })
      for (const server of abandoned) {
        await prisma.musicServer.delete({ where: { id: server.id } })
        await pushActivity({
          type: "SERVER_DISCONNECTED",
          message: `${server.name} removed automatically — never paired, and its pairing code has been expired for over ${env.agentUnpairedRetentionDays} day(s).`,
          serverId: null,
        })
      }
    } catch {
      // best-effort — never let a sweep failure take down the process
    }
  }, UNPAIRED_RETENTION_SWEEP_MS)
  timer.unref()
  return timer
}

/**
 * Nightly retention sweep.
 *
 * Nothing in this system ever deleted from the append-only tables, so
 * `ActivityEvent` (already 14,491 rows), `RemoteCommand` (330), `LogEntry`,
 * `Alert` and `RefreshToken` grew forever — unbounded storage cost, and
 * steadily slower queries on exactly the tables the dashboard reads on every
 * page load.
 *
 * Deliberately conservative: only rows past their retention window, only
 * acknowledged alerts, and only refresh tokens that are already dead
 * (expired or revoked) so an active session is never signed out by a sweep.
 */
const RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

export function startRetentionSweep() {
  const run = async () => {
    try {
      const activityDays = Number(process.env.RETENTION_ACTIVITY_DAYS ?? 90)
      const commandDays = Number(process.env.RETENTION_COMMAND_DAYS ?? 90)
      const logDays = Number(process.env.RETENTION_LOG_DAYS ?? 30)
      const alertDays = Number(process.env.RETENTION_ALERT_DAYS ?? 90)
      // Audit entries outlive everything else here on purpose: they are the
      // record an incident or a customer dispute is investigated from, so the
      // window is generous and set separately rather than sharing the
      // operational-log one.
      const auditDays = Number(process.env.RETENTION_AUDIT_DAYS ?? 400)

      const [activity, commands, logs, alerts, tokens, audits] = await Promise.all([
        prisma.activityEvent.deleteMany({ where: { timestamp: { lt: daysAgo(activityDays) } } }),
        prisma.remoteCommand.deleteMany({
          where: {
            issuedAt: { lt: daysAgo(commandDays) },
            status: { in: ["SUCCESS", "FAILED", "TIMEOUT"] },
          },
        }),
        prisma.logEntry.deleteMany({ where: { timestamp: { lt: daysAgo(logDays) } } }),
        prisma.alert.deleteMany({ where: { acknowledged: true, createdAt: { lt: daysAgo(alertDays) } } }),
        prisma.refreshToken.deleteMany({
          where: {
            OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: daysAgo(7) } }],
          },
        }),
        prisma.auditLog.deleteMany({ where: { at: { lt: daysAgo(auditDays) } } }),
      ])

      const total = activity.count + commands.count + logs.count + alerts.count + tokens.count + audits.count
      if (total > 0) {
        console.info(
          `[retention] removed ${total} rows (activity=${activity.count} commands=${commands.count} logs=${logs.count} alerts=${alerts.count} refreshTokens=${tokens.count} audit=${audits.count})`
        )
      }
    } catch {
      // best-effort — never let a sweep failure take down the process
    }
  }
  // Run once shortly after boot so a long-running instance isn't the only
  // thing that ever prunes, then on a slow cadence.
  const kickoff = setTimeout(run, 60_000)
  kickoff.unref()
  const timer = setInterval(run, RETENTION_SWEEP_MS)
  timer.unref()
  return timer
}


/**
 * Reconciles the music volume against the Track table.
 *
 * DELETE /music/:id unlinks the audio with `.catch(() => {})`, so any failure
 * — a permissions blip, a file already gone, a container restart mid-request
 * — silently leaves the bytes on disk forever while the row disappears. That
 * had already accumulated 18 orphans against 38 tracks here: a slow storage
 * leak with no upper bound, on the one volume that also holds licensed audio.
 *
 * Deliberately cautious, because deleting a customer's audio by mistake is
 * far worse than keeping a stray file:
 *   - only files with no Track row at all,
 *   - only files older than a grace window, so an upload still being written
 *     (the row is created after the bytes land, see routes/music.ts) is never
 *     mistaken for an orphan,
 *   - and it refuses to run at all if the Track table reads as empty, which
 *     is what a database outage looks like from here and would otherwise
 *     delete the entire library.
 */
const ORPHAN_SWEEP_MS = 24 * 60 * 60 * 1000

export function startOrphanMediaSweep() {
  const run = async () => {
    try {
      const graceHours = Number(process.env.ORPHAN_MEDIA_GRACE_HOURS ?? 24)
      const dir = env.musicStorageDir
      if (!fs.existsSync(dir)) return

      const rows = await prisma.track.findMany({ select: { storageKey: true } })
      if (rows.length === 0) {
        console.warn("[orphan-sweep] Track table is empty — refusing to sweep (this is what a DB outage looks like)")
        return
      }
      const known = new Set(rows.map((r) => r.storageKey))
      const cutoff = Date.now() - graceHours * 60 * 60 * 1000

      let removed = 0
      let bytes = 0
      for (const name of await fs.promises.readdir(dir)) {
        if (known.has(name)) continue
        const full = path.join(dir, name)
        const stat = await fs.promises.stat(full).catch(() => null)
        if (!stat || !stat.isFile()) continue
        if (stat.mtimeMs > cutoff) continue
        await fs.promises.unlink(full)
        removed++
        bytes += stat.size
      }
      if (removed > 0) {
        console.info(`[orphan-sweep] removed ${removed} orphaned media file(s), ${(bytes / 1048576).toFixed(1)} MB reclaimed`)
      }
    } catch (err) {
      console.warn("[orphan-sweep] failed:", err)
    }
  }
  const kickoff = setTimeout(run, 5 * 60 * 1000)
  kickoff.unref()
  const timer = setInterval(run, ORPHAN_SWEEP_MS)
  timer.unref()
  return timer
}
