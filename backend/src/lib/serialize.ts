/**
 * Maps Prisma models (backend/prisma/schema.prisma) onto the exact JSON
 * shapes src/lib/api/types.ts expects. This is the one seam where field
 * name / shape mismatches get reconciled — the frontend is never touched.
 */
import type {
  User as DbUser,
  Organization as DbOrganization,
  Location as DbLocation,
  MusicServer as DbMusicServer,
  Zone as DbZone,
  Track as DbTrack,
  MusicFolder as DbMusicFolder,
  TrackSyncState as DbTrackSyncState,
  Playlist as DbPlaylist,
  PlaylistAssignment as DbPlaylistAssignment,
  Schedule as DbSchedule,
  RemoteCommand as DbRemoteCommand,
  LogEntry as DbLogEntry,
  Alert as DbAlert,
  PrayerConfig as DbPrayerConfig,
} from "@prisma/client"

export function toUser(u: DbUser) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    organizationId: u.organizationId,
    locationId: u.locationId,
    avatarUrl: null,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
  }
}

export function toOrganization(o: DbOrganization, locationCount: number, serverCount: number) {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    contactName: o.contactName,
    contactEmail: o.contactEmail,
    plan: o.plan,
    locationCount,
    serverCount,
    createdAt: o.createdAt.toISOString(),
    status: o.status,
  }
}

export function toLocation(l: DbLocation, serverCount: number, zoneCount: number) {
  return {
    id: l.id,
    organizationId: l.organizationId,
    name: l.name,
    address: l.address,
    city: l.city,
    region: l.region,
    country: l.country,
    timezone: l.timezone,
    latitude: null as number | null,
    longitude: null as number | null,
    serverCount,
    zoneCount,
    createdAt: l.createdAt.toISOString(),
  }
}

export function toMusicServer(s: DbMusicServer, zoneCount: number, pendingSyncJobs: number) {
  return {
    id: s.id,
    name: s.name,
    organizationId: s.organizationId,
    locationId: s.locationId,
    status: s.status,
    version: s.version ?? "—",
    pairingCode: s.pairingCode,
    pairedAt: s.pairedAt ? s.pairedAt.toISOString() : null,
    lastHeartbeatAt: s.lastHeartbeatAt ? s.lastHeartbeatAt.toISOString() : null,
    ipAddress: s.ipAddress,
    os: s.os ?? "Windows (pending)",
    usage: {
      cpuPercent: s.cpuPercent,
      ramPercent: s.ramPercent,
      diskPercent: s.diskPercent,
      diskFreeGb: s.diskFreeGb,
      diskTotalGb: s.diskTotalGb,
    },
    zoneCount,
    cachedTracks: s.cachedTracks,
    cachedSizeGb: s.cachedSizeGb,
    pendingSyncJobs,
    createdAt: s.createdAt.toISOString(),
  }
}

export function toZone(z: DbZone) {
  const prePrayerSnapshot =
    z.prePrayerPlaybackState != null
      ? {
          playbackState: z.prePrayerPlaybackState,
          currentPlaylistId: z.prePrayerPlaylistId,
          currentTrackId: z.prePrayerTrackId,
        }
      : null
  return {
    id: z.id,
    serverId: z.serverId,
    locationId: z.locationId,
    name: z.name,
    playbackState: z.playbackState,
    currentPlaylistId: z.currentPlaylistId,
    currentTrackId: z.currentTrackId,
    volume: z.volume,
    muted: z.muted,
    updatedAt: z.updatedAt.toISOString(),
    prayerModeEnabled: z.prayerModeEnabled,
    pausedByPrayer: z.pausedByPrayer,
    prePrayerSnapshot,
    commandSequence: z.commandSequence,
    lastAppliedSequence: z.lastAppliedSequence,
    lastOverrideAt: z.lastOverrideAt ? z.lastOverrideAt.toISOString() : null,
    excludedTrackIds: z.excludedTrackIds,
  }
}

export function toTrack(t: DbTrack, uploadedByName: string) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    genre: t.genre,
    durationSec: t.durationSec,
    fileSizeMb: t.fileSizeMb,
    uploadedAt: t.uploadedAt.toISOString(),
    uploadedBy: uploadedByName,
    coverColor: coverColorForId(t.id),
    folderId: t.folderId,
  }
}

export function toMusicFolder(f: DbMusicFolder) {
  return {
    id: f.id,
    name: f.name,
    createdAt: f.createdAt.toISOString(),
  }
}

const COVER_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"]

/** Deterministic cover color derived from a hash of the track id, per the
 * session-2 spec ("coverColor from a hash of id"). */
export function coverColorForId(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  }
  return COVER_COLORS[hash % COVER_COLORS.length]
}

export function toTrackSyncState(s: DbTrackSyncState) {
  return {
    trackId: s.trackId,
    serverId: s.serverId,
    status: s.status,
    progressPercent: s.progressPercent,
    updatedAt: s.updatedAt.toISOString(),
    errorMessage: s.errorMessage,
  }
}

export function toPlaylist(p: DbPlaylist, trackIds: string[]) {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? "",
    trackIds,
    organizationId: p.organizationId,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }
}

export function toPlaylistAssignment(a: DbPlaylistAssignment) {
  return {
    id: a.id,
    playlistId: a.playlistId,
    targetType: a.targetType,
    targetId: a.targetId,
    assignedAt: a.assignedAt.toISOString(),
  }
}

export function toSchedule(s: DbSchedule) {
  return {
    id: s.id,
    zoneId: s.zoneId,
    playlistId: s.playlistId,
    name: s.name,
    startTime: s.startTime,
    endTime: s.endTime,
    days: s.days,
    priority: s.priority,
    enabled: s.enabled,
    createdAt: s.createdAt.toISOString(),
  }
}

export function toRemoteCommand(c: DbRemoteCommand, issuedByDisplay: string) {
  return {
    id: c.id,
    serverId: c.serverId,
    zoneId: c.zoneId,
    type: c.type,
    payload: (c.payload as Record<string, unknown> | null) ?? undefined,
    status: c.status,
    issuedBy: issuedByDisplay,
    issuedAt: c.issuedAt.toISOString(),
    sentAt: c.sentAt ? c.sentAt.toISOString() : null,
    executingAt: c.executingAt ? c.executingAt.toISOString() : null,
    completedAt: c.completedAt ? c.completedAt.toISOString() : null,
    resultMessage: c.resultMessage,
    source: c.source,
    sequence: c.sequence,
  }
}

export function toLogEntry(l: DbLogEntry) {
  return {
    id: l.id,
    serverId: l.serverId,
    level: l.level,
    message: l.message,
    source: l.source,
    timestamp: l.timestamp.toISOString(),
  }
}

export function toAlert(a: DbAlert) {
  return {
    id: a.id,
    severity: a.severity,
    title: a.title,
    message: a.message,
    serverId: a.serverId,
    locationId: a.locationId,
    createdAt: a.createdAt.toISOString(),
    acknowledged: a.acknowledged,
  }
}

export function toPrayerConfig(
  c: DbPrayerConfig,
  linkedLocation?: { country: string; city: string; region?: string; latitude: number; longitude: number; timezone: string } | null
) {
  const location =
    linkedLocation ??
    (c.city && c.country && c.latitude != null && c.longitude != null && c.timezone
      ? { country: c.country, city: c.city, latitude: c.latitude, longitude: c.longitude, timezone: c.timezone }
      : null)
  return {
    enabled: c.enabled,
    location,
    linkedLocationId: c.linkedLocationId,
    calculationMethodId: c.calculationMethodId,
    prayers: c.prayers,
    updatedAt: c.updatedAt.toISOString(),
  }
}
