import type { WebSocket } from "ws"
import { env } from "./env.js"

/**
 * In-memory tracking of which Windows MusicServer agents are actually
 * reachable right now, and a rendezvous point for the "wait up to 3s for
 * an ack" behavior zone transport commands (PLAY/PAUSE/STOP/NEXT/
 * PREVIOUS/SET_VOLUME/MUTE/UNMUTE) require. Deliberately process-local:
 * a multi-instance deployment would need this in Redis/Postgres LISTEN, but
 * a single backend instance is the deployment target here.
 */

const lastSeen = new Map<string, number>()
const hubSockets = new Map<string, Set<WebSocket>>()

interface PendingAck {
  resolve: (v: { status: string; resultMessage: string | null }) => void
  timer: NodeJS.Timeout
}
const ackWaiters = new Map<string, PendingAck>()

export function markAgentSeen(serverId: string) {
  lastSeen.set(serverId, Date.now())
}

export function lastSeenAt(serverId: string): number | undefined {
  return lastSeen.get(serverId)
}

/** True if the agent has heartbeated (REST) or held an open MusicServerHub
 * socket within the configured staleness window. This — not just "server
 * row status" — is what zone-command dispatch checks before enqueuing. */
export function isAgentConnected(serverId: string): boolean {
  const seen = lastSeen.get(serverId)
  if (!seen) return false
  const staleMs = env.agentHeartbeatIntervalSeconds * env.agentOfflineAfterMissedBeats * 1000
  return Date.now() - seen <= staleMs
}

export function forgetAgent(serverId: string) {
  lastSeen.delete(serverId)
}

/**
 * zoneId -> when this zone's volume was last written by a genuine command
 * result (an ack's zoneState, or the optimistic fallback when the ack
 * carried none) rather than by a routine heartbeat's zones/sync report.
 *
 * Exists because POST /server/zones/sync unconditionally overwrites
 * Zone.volume with whatever the agent's own next heartbeat reports — and
 * heartbeats run independently of commands. If a SET_VOLUME doesn't
 * durably stick on the Windows side by the time the *next* heartbeat
 * samples it (or that heartbeat's request was already in flight, sampled
 * before the command even ran), the correct value a user just set gets
 * silently reverted within one heartbeat interval, which reads as "the
 * slider snaps back". A short write-wins window after a real command
 * result means a routine heartbeat can't undo it — this is a mitigation
 * for a local write that may not be durable, not a second source of
 * truth: once the window lapses, the agent's own reports are trusted
 * again exactly as before. Deliberately process-local, same as the rest
 * of this module.
 */
const recentVolumeWrites = new Map<string, number>()

export function markZoneVolumeWritten(zoneId: string) {
  recentVolumeWrites.set(zoneId, Date.now())
}

/** Covers at least one full heartbeat interval past the write, so a
 * heartbeat request already in flight when the command executed — sampled
 * before it, arriving after — can't win the race either. */
export function isZoneVolumeWriteFresh(zoneId: string): boolean {
  const at = recentVolumeWrites.get(zoneId)
  if (!at) return false
  const graceMs = (env.agentHeartbeatIntervalSeconds + 5) * 1000
  return Date.now() - at <= graceMs
}

export function registerHubSocket(serverId: string, ws: WebSocket) {
  if (!hubSockets.has(serverId)) hubSockets.set(serverId, new Set())
  hubSockets.get(serverId)!.add(ws)
  markAgentSeen(serverId)
  ws.on("close", () => hubSockets.get(serverId)?.delete(ws))
}

export function hasOpenHubSocket(serverId: string): boolean {
  const set = hubSockets.get(serverId)
  if (!set) return false
  for (const ws of set) if (ws.readyState === ws.OPEN) return true
  return false
}

/** Best-effort push over MusicServerHub — a queued command wakes an
 * already-connected agent immediately instead of it waiting out its next
 * poll of GET /api/server/commands/pending. Returns false if no socket is
 * open for this server (the REST poll path still delivers the command). */
export function pushToAgent(serverId: string, target: string, args: unknown[]): boolean {
  const set = hubSockets.get(serverId)
  if (!set || set.size === 0) return false
  const frame = JSON.stringify({ type: 1, target, arguments: args }) + ""
  let sent = false
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      ws.send(frame)
      sent = true
    }
  }
  return sent
}

/** Resolves once POST /api/server/commands/ack reports this command, or
 * `null` if `timeoutMs` elapses first. */
export function waitForAck(commandId: string, timeoutMs: number): Promise<{ status: string; resultMessage: string | null } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ackWaiters.delete(commandId)
      resolve(null)
    }, timeoutMs)
    ackWaiters.set(commandId, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      timer,
    })
  })
}

export function resolveAck(commandId: string, status: string, resultMessage: string | null) {
  const waiter = ackWaiters.get(commandId)
  if (!waiter) return
  ackWaiters.delete(commandId)
  waiter.resolve({ status, resultMessage })
}
