/**
 * Domain-wide enums and constants shared across the API layer, mock adapter,
 * and UI. Kept framework-agnostic so the same values line up with whatever
 * the real Windows MusicServer fleet reports.
 */

export const ROLES = [
  "SUPER_ADMIN",
  "ORGANIZATION_ADMIN",
  "LOCATION_MANAGER",
  "VIEWER",
] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: "Super Admin",
  ORGANIZATION_ADMIN: "Organization Admin",
  LOCATION_MANAGER: "Location Manager",
  VIEWER: "Viewer",
}

/** Windows MusicServer connection status, as reported via heartbeat. */
export const SERVER_STATUSES = [
  "ONLINE",
  "OFFLINE",
  "WARNING",
  "UPDATING",
  "UNKNOWN",
] as const
export type ServerStatus = (typeof SERVER_STATUSES)[number]

/** Cloud -> local music synchronization lifecycle. */
export const SYNC_STATUSES = [
  "AVAILABLE_IN_CLOUD",
  "QUEUED_FOR_SYNC",
  "SYNCING",
  "CACHED_ON_SERVER",
  "FAILED",
] as const
export type SyncStatus = (typeof SYNC_STATUSES)[number]

export const SYNC_STATUS_LABELS: Record<SyncStatus, string> = {
  AVAILABLE_IN_CLOUD: "Available in Cloud",
  QUEUED_FOR_SYNC: "Queued for Sync",
  SYNCING: "Syncing",
  CACHED_ON_SERVER: "Cached on Server",
  FAILED: "Failed",
}

/** Async remote-command lifecycle. A command is never SUCCESS until the
 * Windows MusicServer confirms execution back to the cloud. */
export const COMMAND_STATUSES = [
  "PENDING",
  "SENT",
  "EXECUTING",
  "SUCCESS",
  "FAILED",
  "TIMEOUT",
] as const
export type CommandStatus = (typeof COMMAND_STATUSES)[number]

export const COMMAND_TYPES = [
  "SYNC_MUSIC",
  "SYNC_CONFIG",
  "RESTART_SERVICE",
  "PLAY",
  "PAUSE",
  "STOP",
  "NEXT",
  "PREVIOUS",
  "SET_VOLUME",
  "MUTE",
  "UNMUTE",
  "REBOOT_SERVER",
  "SET_AUTO_BOOT",
  "FORGET_SERVER",
] as const
export type CommandType = (typeof COMMAND_TYPES)[number]

export const ZONE_PLAYBACK_STATES = [
  "PLAYING",
  "PAUSED",
  "STOPPED",
  "OFFLINE",
] as const
export type ZonePlaybackState = (typeof ZONE_PLAYBACK_STATES)[number]

export const DAYS_OF_WEEK = [
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
  "SUN",
] as const
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number]

export const REALTIME_EVENT_TYPES = [
  "SERVER_CONNECTED",
  "SERVER_DISCONNECTED",
  "HEARTBEAT_RECEIVED",
  "ZONE_STATUS_CHANGED",
  "PLAYBACK_CHANGED",
  "MUSIC_SYNC_STARTED",
  "MUSIC_SYNC_COMPLETED",
  "MUSIC_SYNC_FAILED",
  "COMMAND_COMPLETED",
  "PRAYER_STARTED",
  "PRAYER_ENDED",
  "SUPER_ADMIN_OVERRIDE",
  "ERROR",
] as const
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number]

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number]

/** Who/what originated a remote command — determines priority handling.
 * SUPER_ADMIN commands are applied optimistically and always override an
 * automatic SCHEDULE action (e.g. Prayer Mode). */
export const COMMAND_SOURCES = ["USER", "SUPER_ADMIN", "SCHEDULE"] as const
export type CommandSource = (typeof COMMAND_SOURCES)[number]

/** The five daily prayers Prayer Mode can pause music for. Sunrise is
 * intentionally excluded — it must never pause music. */
export const PRAYER_NAMES = ["FAJR", "DHUHR", "ASR", "MAGHRIB", "ISHA"] as const
export type PrayerName = (typeof PRAYER_NAMES)[number]

export const PRAYER_LABELS: Record<PrayerName, string> = {
  FAJR: "Fajr",
  DHUHR: "Dhuhr",
  ASR: "Asr",
  MAGHRIB: "Maghrib",
  ISHA: "Isha",
}

/** Maps our prayer keys to the field names AlAdhan's API returns in
 * `data.timings`. Also documents the fields we deliberately ignore
 * (Sunrise, Sunset, Imsak, Midnight, …). */
export const ALADHAN_TIMING_KEYS: Record<PrayerName, string> = {
  FAJR: "Fajr",
  DHUHR: "Dhuhr",
  ASR: "Asr",
  MAGHRIB: "Maghrib",
  ISHA: "Isha",
}

/** AlAdhan `method` parameter values — a fixed protocol enum defined by the
 * API itself (https://aladhan.com/prayer-times-api), not a dataset. */
export const CALCULATION_METHODS = [
  { id: 3, name: "Muslim World League" },
  { id: 2, name: "Islamic Society of North America (ISNA)" },
  { id: 5, name: "Egyptian General Authority of Survey" },
  { id: 4, name: "Umm Al-Qura University, Makkah" },
  { id: 1, name: "University of Islamic Sciences, Karachi" },
  { id: 7, name: "Institute of Geophysics, University of Tehran" },
  { id: 0, name: "Shia Ithna-Ashari (Jafari)" },
  { id: 8, name: "Gulf Region" },
  { id: 9, name: "Kuwait" },
  { id: 10, name: "Qatar" },
  { id: 11, name: "Majlis Ugama Islam Singapura, Singapore" },
  { id: 12, name: "Union Organization Islamic de France" },
  { id: 13, name: "Diyanet İşleri Başkanlığı, Turkey" },
  { id: 14, name: "Spiritual Administration of Muslims of Russia" },
  { id: 15, name: "Moonsighting Committee Worldwide" },
] as const
export type CalculationMethodId = (typeof CALCULATION_METHODS)[number]["id"]

export const GENRES = [
  "Pop",
  "Jazz",
  "Lounge",
  "Rock",
  "Acoustic",
  "Electronic",
  "Classical",
  "Hip-Hop",
  "Ambient",
  "Holiday",
  "Country",
  "R&B",
] as const
