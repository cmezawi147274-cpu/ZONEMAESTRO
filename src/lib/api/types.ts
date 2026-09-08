/**
 * Domain types shared by every module in src/lib/api/*.
 *
 * These mirror the shape the REAL backend / Windows MusicServer fleet is
 * expected to speak (see README "API Contract"). The mock adapter
 * (src/lib/mock/db.ts) implements this exact shape so swapping
 * NEXT_PUBLIC_USE_MOCK_API=false for a real API base URL requires no UI
 * changes.
 */
import type {
  CommandStatus,
  CommandType,
  CommandSource,
  DayOfWeek,
  PrayerName,
  Role,
  ServerStatus,
  SyncStatus,
  ZonePlaybackState,
  AlertSeverity,
  RealtimeEventType,
} from "@/lib/constants"

export interface User {
  id: string
  name: string
  email: string
  role: Role
  organizationId: string | null
  /** The single venue a scoped user is bound to (VIEWER, LOCATION_MANAGER).
   * Null for organization-wide and platform-wide roles. */
  locationId?: string | null
  avatarUrl?: string | null
  createdAt: string
  lastLoginAt?: string | null
}

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: string
}

export interface Session {
  user: User
  tokens: AuthTokens
}

export interface Organization {
  id: string
  name: string
  slug: string
  contactName: string
  contactEmail: string
  plan: "STARTER" | "PROFESSIONAL" | "ENTERPRISE"
  locationCount: number
  serverCount: number
  createdAt: string
  status: "ACTIVE" | "SUSPENDED"
}

export interface Location {
  id: string
  organizationId: string
  name: string
  address: string
  city: string
  region: string
  country: string
  /** IANA timezone id, e.g. "America/Chicago" — resolved via the same
   * Country → City picker Prayer Mode uses (src/lib/geo/locations.ts), so
   * it's never hand-typed. Displayed with `formatTimezoneLabel`. */
  timezone: string
  /** Internal only — resolved alongside `timezone` when the location's
   * city was picked; never shown raw in the UI. Null for locations created
   * before this existed, until re-saved through the picker. */
  latitude: number | null
  longitude: number | null
  serverCount: number
  zoneCount: number
  createdAt: string
}

export interface ResourceUsage {
  cpuPercent: number
  ramPercent: number
  diskPercent: number
  diskFreeGb: number
  diskTotalGb: number
}

export interface MusicServer {
  id: string
  name: string
  organizationId: string
  locationId: string
  status: ServerStatus
  version: string
  pairingCode: string | null
  pairedAt: string | null
  lastHeartbeatAt: string | null
  ipAddress: string | null
  os: string
  usage: ResourceUsage
  zoneCount: number
  cachedTracks: number
  cachedSizeGb: number
  pendingSyncJobs: number
  createdAt: string
  /** Whether the Windows MusicServer should auto-start on boot. Defaults to
   * true after SETUP; toggled via the SET_AUTO_BOOT command. */
  autoBootEnabled: boolean
  /** The venue PC's own IANA timezone, as its last heartbeat reported it.
   * Null on an agent too old to send one — the Location's timezone is then
   * used for prayer calculation instead. */
  reportedTimezone: string | null
  /** When a usable timezone last arrived on a heartbeat. Null means this
   * venue has never reported its clock. */
  reportedLocationAt: string | null
}

/** Snapshot of a zone's playback captured right before an automatic
 * interruption (currently: Prayer Mode), so it can be restored afterward —
 * but only if nothing else (e.g. a Super Admin override) has taken over. */
export interface ZonePlaybackSnapshot {
  playbackState: ZonePlaybackState
  currentPlaylistId: string | null
  currentTrackId: string | null
}

export interface Zone {
  id: string
  serverId: string
  locationId: string
  name: string
  playbackState: ZonePlaybackState
  currentPlaylistId: string | null
  currentTrackId: string | null
  volume: number
  muted: boolean
  updatedAt: string
  /** Whether this zone participates in Prayer Mode. Defaults to true;
   * independent of the global Prayer Mode on/off switch. */
  prayerModeEnabled: boolean
  /** Set while this zone is paused by an in-progress prayer; cleared on
   * PRAYER_END or as soon as a Super Admin override touches the zone (which
   * cancels the automatic resume — the override wins). Null otherwise. */
  pausedByPrayer: PrayerName | null
  /** State captured immediately before the current prayer pause, restored
   * at PRAYER_END. Null when not currently paused for prayer. */
  prePrayerSnapshot: ZonePlaybackSnapshot | null
  /** Monotonic counter incremented every time a command is issued for this
   * zone. Lets stale/out-of-order command effects be detected and dropped
   * (see src/lib/mock/simulate.ts and src/hooks/use-zones.ts). */
  commandSequence: number
  /** The `commandSequence` value of the last command actually applied to
   * this zone's playback state. A confirmed command whose own sequence is
   * behind this is a stale straggler and is discarded. */
  lastAppliedSequence: number
  /** Timestamp of the most recent Super Admin override — informational,
   * shown in the UI so operators can see a zone was manually overridden. */
  lastOverrideAt: string | null
  /** Track ids removed from this zone's view of its current playlist. The
   * shared Playlist record (and every other zone/location using it) is
   * untouched — this is purely a per-zone exclusion list, reset whenever a
   * different playlist is assigned. See src/lib/api/zones.ts
   * `effectiveTrackIds` / `removeTrackFromZone`. */
  excludedTrackIds: string[]
}

export interface Track {
  id: string
  title: string
  artist: string
  album: string
  genre: string
  durationSec: number
  fileSizeMb: number
  uploadedAt: string
  uploadedBy: string
  coverColor: string
  /** Folder this track is grouped under in the cloud library, or null for
   * "Unfiled" (never assigned, or its folder was deleted). */
  folderId: string | null
}

/** A user-defined grouping of Tracks in the cloud music library
 * (src/app/(portal)/music/page.tsx). Deleting a folder never deletes its
 * tracks — they fall back to "Unfiled". */
export interface MusicFolder {
  id: string
  name: string
  createdAt: string
}

export interface TrackSyncState {
  trackId: string
  serverId: string
  status: SyncStatus
  progressPercent: number
  updatedAt: string
  errorMessage?: string | null
}

export interface Playlist {
  id: string
  name: string
  description: string
  trackIds: string[]
  organizationId: string | null
  createdAt: string
  updatedAt: string
}

export interface PlaylistAssignment {
  id: string
  playlistId: string
  targetType: "ORGANIZATION" | "LOCATION" | "SERVER" | "ZONE"
  targetId: string
  assignedAt: string
}

export interface Schedule {
  id: string
  zoneId: string
  playlistId: string
  name: string
  startTime: string // "HH:mm"
  endTime: string // "HH:mm"
  days: DayOfWeek[]
  priority: number
  enabled: boolean
  createdAt: string
}

export interface RemoteCommand {
  id: string
  serverId: string
  zoneId: string | null
  type: CommandType
  payload?: Record<string, unknown>
  status: CommandStatus
  issuedBy: string
  issuedAt: string
  sentAt?: string | null
  executingAt?: string | null
  completedAt?: string | null
  resultMessage?: string | null
  /** Who/what issued this command. Defaults to "USER". SUPER_ADMIN commands
   * are applied optimistically and take priority over SCHEDULE (e.g. Prayer
   * Mode) actions. See src/lib/auth/rbac.ts `zone:override`. */
  source: CommandSource
  /** The zone's commandSequence at the moment this command was issued —
   * used to discard a command's effect if a newer one already superseded it
   * (e.g. the local server was slow to confirm an older command). */
  sequence: number | null
}

export interface LogEntry {
  id: string
  serverId: string
  level: "INFO" | "WARN" | "ERROR" | "DEBUG"
  message: string
  source: string
  timestamp: string
}

export interface Alert {
  id: string
  severity: AlertSeverity
  title: string
  message: string
  serverId?: string | null
  locationId?: string | null
  createdAt: string
  acknowledged: boolean
}

export interface ActivityEvent {
  id: string
  type: RealtimeEventType
  message: string
  serverId?: string | null
  zoneId?: string | null
  timestamp: string
}

export interface DashboardStats {
  totalOrganizations: number
  totalLocations: number
  serversOnline: number
  serversOffline: number
  serversWarning: number
  activeZones: number
  playingZones: number
  syncJobsInProgress: number
  syncJobsFailed: number
  openAlerts: number
}

export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface ApiError {
  status: number
  code: string
  message: string
}

// ---------------------------------------------------------------------------
// Shared worldwide location picking (Country → City → GMT timezone)
// ---------------------------------------------------------------------------

/** A resolved worldwide location. Latitude/longitude and the IANA timezone
 * are internal technical data only — never shown directly in the UI, only
 * used for calculations (e.g. the prayer-times API) and to compute/display
 * a human GMT offset label (see src/lib/geo/locations.ts). Shared by
 * Locations (src/components/locations/*) and Prayer Mode, so both features
 * pick from the exact same worldwide dataset. */
export interface GeoLocation {
  country: string
  city: string
  /** State/province, when the dataset has one — used to prefill a
   * Location's `region` field. Not used by Prayer Mode. */
  region?: string
  latitude: number
  longitude: number
  /** IANA timezone identifier, e.g. "Asia/Dubai". Internal only. */
  timezone: string
}

/** @deprecated kept as an alias — use `GeoLocation`. Every Prayer Mode
 * location is a GeoLocation; the name predates the Locations feature
 * sharing the same picker. */
export type PrayerLocation = GeoLocation

// ---------------------------------------------------------------------------
// Prayer Mode
// ---------------------------------------------------------------------------

export interface PrayerSettings {
  enabled: boolean
  /** Minutes to shift the calculated time by; can be negative. */
  offsetMinutes: number
  /** How long music stays paused for this prayer, in minutes. */
  pauseDurationMinutes: number
}

export interface PrayerConfig {
  /** Global Prayer Mode on/off. When off, no zone is ever auto-paused,
   * regardless of individual zone participation flags. */
  enabled: boolean
  /** The location prayer times are calculated for. When `linkedLocationId`
   * is set, this is a derived snapshot kept in sync with that Location
   * (see src/lib/api/locations.ts) — editing the Location updates this
   * automatically. When null, this is a manually-picked "custom" location
   * independent of any Location record. */
  location: PrayerLocation | null
  /** Id of the Location this configuration is synced to, or null for a
   * manually-picked custom location. The single source of truth for that
   * location's city/timezone is then the Location record itself — the
   * admin never enters it twice. */
  linkedLocationId: string | null
  calculationMethodId: number
  prayers: Record<PrayerName, PrayerSettings>
  updatedAt: string
}

/** Today's calculated prayer clock times, "HH:mm" in the configured
 * timezone, for display only (already offset-adjusted). */
export type PrayerTimesToday = Record<PrayerName, string>

/** GET /prayer/times/today — prayer times computed in the cloud against
 * the venue's own coordinates and clock (backend/src/routes/prayer.ts).
 * `location.source` says where the coordinates came from: a GPS fix the
 * Windows agent reported, a lookup of the venue's city, or the manually
 * picked location saved on the config. */
export interface PrayerTimesTodayResponse {
  /** Venue-local calendar date the times are for, "YYYY-MM-DD". */
  date: string
  /** IANA zone the times are expressed in — the venue's, never the cloud's. */
  timezone: string
  calculationMethodId: number
  times: PrayerTimesToday
  location: {
    city: string | null
    country: string | null
    latitude: number
    longitude: number
    source: "agent-gps" | "location-city" | "config"
  }
  /** Drives the venue-location pill. `state` is VENUE only when the venue
   * PC's own heartbeat supplied the clock these times were computed on —
   * coordinates coming from a city lookup does not downgrade it. */
  venue: {
    state: "VENUE" | "PORTAL"
    timezone: string
    city: string | null
    country: string | null
    timezoneSource: "heartbeat" | "location" | "config"
    coordinatesSource: "agent-gps" | "location-city" | "config"
    /** Name of the Music Server whose heartbeat supplied the clock. */
    serverName: string | null
  }
}

export interface PrayerScheduleEvent {
  prayer: PrayerName
  /** ISO instant (UTC) the pause begins, offset already applied. */
  startAt: string
  /** ISO instant (UTC) the pause ends (startAt + pauseDurationMinutes). */
  endAt: string
}
