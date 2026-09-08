import { prisma } from "./db.js"
import { env } from "./env.js"
import { pushActivity } from "./activity.js"
import { forgetAgent, isAgentConnected } from "./agent-registry.js"

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
