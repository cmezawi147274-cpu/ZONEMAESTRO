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
