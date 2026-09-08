import { prisma } from "./db.js"
import { emitEvent } from "../realtime.js"
import type { CommandType, CommandSource } from "@prisma/client"

/**
 * Queues a playlist's tracks for caching on one server. Assigning a
 * playlist to a zone is otherwise inert until someone separately hits
 * "queue for sync": the agent only ever downloads tracks the backend
 * reports as QUEUED_FOR_SYNC (routes/agent.ts POST /server/tracks/sync),
 * so an assigned-but-uncached playlist left the zone silently playing
 * whatever it had queued before. Tracks already cached (or in flight) on
 * that server are left alone.
 */
export async function queuePlaylistTracksForServer(playlistId: string | null, serverId: string) {
  if (!playlistId) return
  const tracks = await prisma.playlistTrack.findMany({ where: { playlistId }, select: { trackId: true } })
  for (const { trackId } of tracks) {
    const existing = await prisma.trackSyncState.findUnique({ where: { trackId_serverId: { trackId, serverId } } })
    if (existing && (existing.status === "CACHED_ON_SERVER" || existing.status === "SYNCING")) continue
    await prisma.trackSyncState.upsert({
      where: { trackId_serverId: { trackId, serverId } },
      create: { trackId, serverId, status: "QUEUED_FOR_SYNC", progressPercent: 0 },
      update: { status: "QUEUED_FOR_SYNC", progressPercent: 0, errorMessage: null },
    })
  }
}

function nextPlayableTrack(trackIds: string[], currentTrackId: string | null, excludedTrackIds: string[], direction: 1 | -1) {
  const playable = trackIds.filter((id) => !excludedTrackIds.includes(id))
  if (playable.length === 0) return null
  const idx = playable.indexOf(currentTrackId ?? "")
  const nextIdx = idx === -1 ? 0 : (idx + direction + playable.length) % playable.length
  return playable[nextIdx]
}

/** Optimistically applies a zone transport command's expected effect
 * locally (PLAY -> playbackState PLAYING, SET_VOLUME -> volume, ...).
 * Used as the CMMP-side state update once the agent has ack'd SUCCESS. If
 * the agent's ack carries its own authoritative `zoneState` (see
 * routes/agent.ts), that's applied instead/in addition — this covers the
 * common case where it doesn't. */
export async function applyZoneCommandEffect(
  zoneId: string,
  type: CommandType,
  payload: Record<string, unknown> | undefined,
  sequence: number | null,
  source: CommandSource
) {
  const zone = await prisma.zone.findUnique({ where: { id: zoneId } })
  if (!zone) return

  if (sequence != null && sequence < zone.lastAppliedSequence) return // stale/out-of-order, drop

  const data: Record<string, unknown> = {}
  if (sequence != null) data.lastAppliedSequence = sequence
  if (source === "SUPER_ADMIN") {
    data.pausedByPrayer = null
    data.prePrayerPlaybackState = null
    data.prePrayerPlaylistId = null
    data.prePrayerTrackId = null
    data.lastOverrideAt = new Date()
  }

  switch (type) {
    case "PLAY":
      data.playbackState = "PLAYING"
      break
    case "PAUSE":
      data.playbackState = "PAUSED"
      break
    case "STOP":
      data.playbackState = "STOPPED"
      break
    case "SET_VOLUME":
      if (typeof payload?.volume === "number") data.volume = payload.volume
      break
    case "MUTE":
      data.muted = true
      break
    case "UNMUTE":
      data.muted = false
      break
    case "NEXT":
    case "PREVIOUS": {
      if (zone.currentPlaylistId) {
        const playlist = await prisma.playlist.findUnique({
          where: { id: zone.currentPlaylistId },
          include: { tracks: { orderBy: { position: "asc" } } },
        })
        if (playlist) {
          const trackIds = playlist.tracks.map((t) => t.trackId)
          data.currentTrackId = nextPlayableTrack(trackIds, zone.currentTrackId, zone.excludedTrackIds, type === "NEXT" ? 1 : -1)
        }
      }
      break
    }
    default:
      return
  }

  const updated = await prisma.zone.update({ where: { id: zoneId }, data })
  emitEvent({ type: "ZONE_STATUS_CHANGED", serverId: zone.serverId, zoneId: zone.id, data: { zoneId: updated.id, source } })
}
