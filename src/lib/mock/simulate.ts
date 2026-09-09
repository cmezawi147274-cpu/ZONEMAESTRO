"use client"

import { store } from "@/lib/mock/store"
import { mockBus } from "@/lib/realtime/bus"
import { applyZoneCommandEffect, nextPlayableTrack } from "@/lib/mock/zone-effects"
import type { RealtimeEvent } from "@/lib/realtime/types"

function rand(min: number, max: number) {
  return Math.round(min + Math.random() * (max - min))
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

function emit(event: Omit<RealtimeEvent, "timestamp">) {
  mockBus.emit({ ...event, timestamp: new Date().toISOString() })
}

let started = false
let timer: ReturnType<typeof setInterval> | null = null

/**
 * Drives the mock backend forward in time so the dashboard, monitoring feed
 * and command tracker feel alive without a real backend: heartbeats jitter,
 * commands progress through their lifecycle, sync jobs advance, and zones
 * occasionally change track. Idempotent — safe to call from multiple
 * mounted components.
 */
export function startMockSimulation() {
  if (started) return
  started = true

  timer = setInterval(() => {
    tickHeartbeats()
    tickCommands()
    tickSync()
    tickPlayback()
  }, 4000)
}

export function stopMockSimulation() {
  if (timer) clearInterval(timer)
  timer = null
  started = false
}

function tickHeartbeats() {
  const onlineServers = store.servers.filter((s) => s.status === "ONLINE" || s.status === "UPDATING")
  if (onlineServers.length === 0) return
  const server = onlineServers[rand(0, onlineServers.length - 1)]
  server.lastHeartbeatAt = new Date().toISOString()
  server.usage.cpuPercent = clamp(server.usage.cpuPercent + rand(-8, 8), 4, 97)
  server.usage.ramPercent = clamp(server.usage.ramPercent + rand(-5, 5), 10, 96)
  emit({ type: "HEARTBEAT_RECEIVED", serverId: server.id, data: { usage: server.usage } })
}

/** A command whose target server is OFFLINE is left exactly where it is —
 * never progressed — so it neither falsely succeeds nor silently vanishes.
 * As soon as the server reconnects (status flips back to ONLINE/UPDATING),
 * it becomes eligible again on the very next tick: reconciliation on
 * reconnect falls out of this filter for free, with no separate "replay
 * queue" needed. Super Admin commands still update the UI immediately
 * regardless (see src/lib/api/commands.ts) — this only governs when the
 * *simulated agent* gets to confirm. */
function tickCommands() {
  const inFlight = store.commands.find((c) => {
    if (c.status !== "PENDING" && c.status !== "SENT" && c.status !== "EXECUTING") return false
    const server = store.servers.find((s) => s.id === c.serverId)
    return server?.status === "ONLINE" || server?.status === "UPDATING"
  })
  if (!inFlight) return
  const now = new Date().toISOString()
  if (inFlight.status === "PENDING") {
    inFlight.status = "SENT"
    inFlight.sentAt = now
  } else if (inFlight.status === "SENT") {
    inFlight.status = "EXECUTING"
    inFlight.executingAt = now
  } else if (inFlight.status === "EXECUTING") {
    const failed = Math.random() < 0.08
    inFlight.status = failed ? "FAILED" : "SUCCESS"
    inFlight.completedAt = now
    inFlight.resultMessage = failed
      ? "Agent reported an error executing the command."
      : "Acknowledged by MusicServer agent."
    // Applying the effect here is what makes it real for ordinary
    // USER/SCHEDULE commands. For SUPER_ADMIN commands this re-applies the
    // same state the optimistic path already set — a harmless no-op that
    // simply confirms what the UI already showed (see zone-effects.ts).
    if (!failed) {
      applyZoneCommandEffect(inFlight)
      if (inFlight.type === "SET_AUTO_BOOT" && typeof inFlight.payload?.enabled === "boolean") {
        const server = store.servers.find((s) => s.id === inFlight.serverId)
        if (server) server.autoBootEnabled = inFlight.payload.enabled
      }
    }
    emit({ type: "COMMAND_COMPLETED", serverId: inFlight.serverId, data: { command: inFlight } })
    store.pushActivity({
      type: "COMMAND_COMPLETED",
      message: `${inFlight.type.replaceAll("_", " ")} ${failed ? "failed" : "completed"} on ${
        store.servers.find((s) => s.id === inFlight.serverId)?.name ?? "server"
      }.`,
      serverId: inFlight.serverId,
      zoneId: inFlight.zoneId,
    })
  }
}

function tickSync() {
  const syncing = store.trackSyncStates.find((t) => t.status === "SYNCING")
  if (syncing) {
    syncing.progressPercent = clamp(syncing.progressPercent + rand(15, 35), 0, 100)
    syncing.updatedAt = new Date().toISOString()
    if (syncing.progressPercent >= 100) {
      syncing.status = "CACHED_ON_SERVER"
      const server = store.servers.find((s) => s.id === syncing.serverId)
      if (server) server.pendingSyncJobs = Math.max(0, server.pendingSyncJobs - 1)
      emit({ type: "MUSIC_SYNC_COMPLETED", serverId: syncing.serverId, data: { trackId: syncing.trackId } })
      store.pushActivity({
        type: "MUSIC_SYNC_COMPLETED",
        message: `${server?.name ?? "Server"} finished syncing "${
          store.tracks.find((t) => t.id === syncing.trackId)?.title ?? "a track"
        }".`,
        serverId: syncing.serverId,
      })
    }
    return
  }
  const queued = store.trackSyncStates.find((t) => t.status === "QUEUED_FOR_SYNC")
  if (queued && Math.random() < 0.5) {
    queued.status = "SYNCING"
    queued.progressPercent = 5
    queued.updatedAt = new Date().toISOString()
    emit({ type: "MUSIC_SYNC_STARTED", serverId: queued.serverId, data: { trackId: queued.trackId } })
  }
}

function tickPlayback() {
  const playing = store.zones.filter((z) => z.playbackState === "PLAYING" && z.currentPlaylistId)
  if (playing.length === 0) return
  const zone = playing[rand(0, playing.length - 1)]
  const playlist = store.playlists.find((p) => p.id === zone.currentPlaylistId)
  if (!playlist) return
  const nextTrackId = nextPlayableTrack(playlist.trackIds, zone.currentTrackId, zone.excludedTrackIds, 1)
  if (!nextTrackId) return
  zone.currentTrackId = nextTrackId
  zone.updatedAt = new Date().toISOString()
  emit({ type: "PLAYBACK_CHANGED", serverId: zone.serverId, zoneId: zone.id, data: { trackId: nextTrackId } })
}
