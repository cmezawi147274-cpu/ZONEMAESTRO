import { store } from "@/lib/mock/store"
import { mockBus } from "@/lib/realtime/bus"
import type { RemoteCommand, ZonePlaybackSnapshot } from "@/lib/api/types"

/** Advances to the next (or previous) track in `trackIds`, skipping any id
 * in `excludedTrackIds` — a zone-local removal must never be landed on by
 * Next/Previous or the mock playback simulator. Shared by
 * `applyZoneCommandEffect` (NEXT/PREVIOUS) and src/lib/mock/simulate.ts
 * `tickPlayback`, so both agree on what "next track" means for a zone. */
export function nextPlayableTrack(
  trackIds: string[],
  currentTrackId: string | null,
  excludedTrackIds: string[],
  direction: 1 | -1
): string | null {
  const playable = trackIds.filter((id) => !excludedTrackIds.includes(id))
  if (playable.length === 0) return null
  const idx = playable.indexOf(currentTrackId ?? "")
  const nextIdx = idx === -1 ? 0 : (idx + direction + playable.length) % playable.length
  return playable[nextIdx]
}

/**
 * The single place a confirmed (or, for Super Admin, optimistically
 * pre-applied — see src/lib/api/commands.ts) command actually mutates zone
 * playback state. Shared by:
 *  - src/lib/mock/simulate.ts, once the mock command lifecycle reaches
 *    EXECUTING -> SUCCESS for ordinary USER/SCHEDULE commands, and
 *  - src/lib/api/commands.ts, immediately for SUPER_ADMIN commands, which
 *    must never wait for that lifecycle to update playback state.
 *
 * Applying the same command twice (optimistic now, "confirmed" again later)
 * is intentionally idempotent — it just sets the same state again.
 *
 * Stale/out-of-order protection: every command captures the zone's
 * `commandSequence` at send time. A command whose `sequence` is behind the
 * zone's `lastAppliedSequence` is a straggler from before a newer command
 * (e.g. a slow-to-confirm auto action overtaken by a Super Admin override)
 * and is silently dropped rather than clobbering the newer state.
 */
export function applyZoneCommandEffect(command: RemoteCommand): void {
  if (!command.zoneId) return
  const zone = store.zones.find((z) => z.id === command.zoneId)
  if (!zone) return

  if (command.sequence != null && command.sequence < zone.lastAppliedSequence) {
    store.pushLog({
      serverId: command.serverId,
      level: "WARN",
      message: `Discarded stale ${command.type} command for zone ${zone.name} (sequence ${command.sequence} < ${zone.lastAppliedSequence}).`,
      source: "command.reconcile",
    })
    return
  }
  if (command.sequence != null) zone.lastAppliedSequence = command.sequence

  if (command.source === "SUPER_ADMIN") {
    // An explicit Super Admin action always wins over an in-progress
    // automatic pause and cancels its scheduled auto-resume — the override
    // sticks until someone (or something) else changes it.
    zone.pausedByPrayer = null
    zone.prePrayerSnapshot = null
    zone.lastOverrideAt = new Date().toISOString()
  }

  switch (command.type) {
    case "PLAY": {
      const restore = command.payload?.restore as ZonePlaybackSnapshot | undefined
      if (restore) {
        zone.currentPlaylistId = restore.currentPlaylistId
        zone.currentTrackId = restore.currentTrackId
      }
      zone.playbackState = "PLAYING"
      break
    }
    case "PAUSE":
      zone.playbackState = "PAUSED"
      break
    case "STOP":
      zone.playbackState = "STOPPED"
      break
    case "SET_VOLUME":
      if (typeof command.payload?.volume === "number") zone.volume = command.payload.volume
      break
    case "MUTE":
      zone.muted = true
      break
    case "UNMUTE":
      zone.muted = false
      break
    case "NEXT":
    case "PREVIOUS": {
      const playlist = store.playlists.find((p) => p.id === zone.currentPlaylistId)
      if (playlist) {
        const delta = command.type === "NEXT" ? 1 : -1
        zone.currentTrackId = nextPlayableTrack(playlist.trackIds, zone.currentTrackId, zone.excludedTrackIds, delta)
      }
      break
    }
    default:
      return
  }

  zone.updatedAt = new Date().toISOString()
  mockBus.emit({
    type: "ZONE_STATUS_CHANGED",
    serverId: zone.serverId,
    zoneId: zone.id,
    data: { zone, source: command.source },
    timestamp: new Date().toISOString(),
  })
}
