import type {
  Alert,
  ActivityEvent,
  LogEntry,
  MusicServer,
  Location,
  Organization,
  Playlist,
  RemoteCommand,
  Schedule,
  Track,
  TrackSyncState,
  User,
  Zone,
} from "@/lib/api/types"
import { nextId } from "@/lib/mock/ids"
import { GENRES } from "@/lib/constants"

const HOUR = 3600 * 1000
const DAY = 24 * HOUR

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString()
}

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length]
}

function rand(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min))
}

const COVER_COLORS = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
]

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export const organizations: Organization[] = [
  {
    id: nextId("org"),
    name: "Golden Fork Restaurant Group",
    slug: "golden-fork",
    contactName: "Maria Alvarez",
    contactEmail: "maria.alvarez@goldenfork.example",
    plan: "ENTERPRISE",
    locationCount: 0,
    serverCount: 0,
    createdAt: isoDaysAgo(410),
    status: "ACTIVE",
  },
  {
    id: nextId("org"),
    name: "Blue Wave Hospitality",
    slug: "blue-wave",
    contactName: "Daniel Osei",
    contactEmail: "daniel.osei@bluewave.example",
    plan: "PROFESSIONAL",
    locationCount: 0,
    serverCount: 0,
    createdAt: isoDaysAgo(280),
    status: "ACTIVE",
  },
  {
    id: nextId("org"),
    name: "Summit Coffee Co.",
    slug: "summit-coffee",
    contactName: "Priya Nair",
    contactEmail: "priya.nair@summitcoffee.example",
    plan: "STARTER",
    locationCount: 0,
    serverCount: 0,
    createdAt: isoDaysAgo(96),
    status: "ACTIVE",
  },
]

const [goldenFork, blueWave, summitCoffee] = organizations

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

// Coordinates match city-timezones' own dataset exactly (see
// src/lib/geo/locations.ts) so a seeded location's Country/City picker
// pre-selects correctly if it's ever re-opened for editing.
const AUSTIN = { latitude: 30.26694969, longitude: -97.74277836 }
const SAN_DIEGO = { latitude: 32.82002382, longitude: -117.1799899 }
const MIAMI = { latitude: 25.7876107, longitude: -80.22410608 }
const DENVER = { latitude: 39.73918805, longitude: -104.984016 }
const US = "United States of America"

export const locations: Location[] = [
  {
    id: nextId("loc"),
    organizationId: goldenFork.id,
    name: "Downtown Bistro",
    address: "482 Market St",
    city: "Austin",
    region: "TX",
    country: US,
    timezone: "America/Chicago",
    ...AUSTIN,
    serverCount: 0,
    zoneCount: 0,
    createdAt: isoDaysAgo(400),
  },
  {
    id: nextId("loc"),
    organizationId: goldenFork.id,
    name: "Harbor Grill",
    address: "12 Pier Ave",
    city: "San Diego",
    region: "CA",
    country: US,
    timezone: "America/Los_Angeles",
    ...SAN_DIEGO,
    serverCount: 0,
    zoneCount: 0,
    createdAt: isoDaysAgo(365),
  },
  {
    id: nextId("loc"),
    organizationId: goldenFork.id,
    name: "Airport Lounge T2",
    address: "Terminal 2, Gate C",
    city: "Austin",
    region: "TX",
    country: US,
    timezone: "America/Chicago",
    ...AUSTIN,
    serverCount: 0,
    zoneCount: 0,
    createdAt: isoDaysAgo(200),
  },
  {
    id: nextId("loc"),
    organizationId: blueWave.id,
    name: "Beachside Resort & Spa",
    address: "1 Ocean Dr",
    city: "Miami",
    region: "FL",
    country: US,
    timezone: "America/New_York",
    ...MIAMI,
    serverCount: 0,
    zoneCount: 0,
    createdAt: isoDaysAgo(270),
  },
  {
    id: nextId("loc"),
    organizationId: blueWave.id,
    name: "Marina Rooftop Bar",
    address: "88 Harbor Walk",
    city: "Miami",
    region: "FL",
    country: US,
    timezone: "America/New_York",
    ...MIAMI,
    serverCount: 0,
    zoneCount: 0,
    createdAt: isoDaysAgo(150),
  },
  {
    id: nextId("loc"),
    organizationId: summitCoffee.id,
    name: "Summit Coffee – Main St",
    address: "220 Main St",
    city: "Denver",
    region: "CO",
    country: US,
    timezone: "America/Denver",
    ...DENVER,
    serverCount: 0,
    zoneCount: 0,
    createdAt: isoDaysAgo(90),
  },
  {
    id: nextId("loc"),
    organizationId: summitCoffee.id,
    name: "Summit Coffee – Uptown",
    address: "77 Highland Ave",
    city: "Denver",
    region: "CO",
    country: US,
    timezone: "America/Denver",
    ...DENVER,
    serverCount: 0,
    zoneCount: 0,
    createdAt: isoDaysAgo(60),
  },
  {
    id: nextId("loc"),
    organizationId: summitCoffee.id,
    name: "Summit Coffee – Riverfront",
    address: "9 Confluence Way",
    city: "Denver",
    region: "CO",
    country: US,
    timezone: "America/Denver",
    ...DENVER,
    serverCount: 0,
    zoneCount: 0,
    createdAt: isoDaysAgo(21),
  },
]

// ---------------------------------------------------------------------------
// Music Servers (Windows) — one per location, except Riverfront (unpaired)
// ---------------------------------------------------------------------------

const ZONE_NAME_SETS: Record<string, string[]> = {
  default: ["Dining Area", "Bar", "Kitchen", "Outdoor Patio"],
  resort: ["Lobby", "Poolside", "Spa", "Beach Bar", "Ballroom"],
  rooftop: ["Main Deck", "VIP Lounge", "Bar"],
  cafe: ["Main Floor", "Patio"],
  airport: ["Gate Lounge"],
}

interface ServerSeedSpec {
  locationId: string
  status: MusicServer["status"]
  zoneSet: keyof typeof ZONE_NAME_SETS
  heartbeatMinsAgo: number | null
  version: string
}

const serverSpecs: ServerSeedSpec[] = [
  { locationId: locations[0].id, status: "ONLINE", zoneSet: "default", heartbeatMinsAgo: 1, version: "3.4.2" },
  { locationId: locations[1].id, status: "ONLINE", zoneSet: "default", heartbeatMinsAgo: 2, version: "3.4.2" },
  { locationId: locations[2].id, status: "WARNING", zoneSet: "airport", heartbeatMinsAgo: 4, version: "3.3.9" },
  { locationId: locations[3].id, status: "ONLINE", zoneSet: "resort", heartbeatMinsAgo: 1, version: "3.4.2" },
  { locationId: locations[4].id, status: "OFFLINE", zoneSet: "rooftop", heartbeatMinsAgo: 612, version: "3.2.1" },
  { locationId: locations[5].id, status: "ONLINE", zoneSet: "cafe", heartbeatMinsAgo: 3, version: "3.4.1" },
  { locationId: locations[6].id, status: "UPDATING", zoneSet: "cafe", heartbeatMinsAgo: 6, version: "3.4.0" },
  // locations[7] (Riverfront) intentionally has no server yet — pending pairing
]

export const servers: MusicServer[] = serverSpecs.map((spec) => {
  const location = locations.find((l) => l.id === spec.locationId)!
  const isOnline = spec.status === "ONLINE" || spec.status === "UPDATING"
  return {
    id: nextId("srv"),
    name: `${location.name} – MusicServer`,
    organizationId: location.organizationId,
    locationId: location.id,
    status: spec.status,
    version: spec.version,
    pairingCode: null,
    pairedAt: isoDaysAgo(rand(30, 300)),
    lastHeartbeatAt: spec.heartbeatMinsAgo === null ? null : isoMinutesAgo(spec.heartbeatMinsAgo),
    ipAddress: isOnline ? `192.168.${rand(1, 20)}.${rand(2, 250)}` : null,
    os: "Windows 11 Pro (64-bit)",
    usage: {
      cpuPercent: spec.status === "OFFLINE" ? 0 : rand(8, spec.status === "WARNING" ? 92 : 55),
      ramPercent: spec.status === "OFFLINE" ? 0 : rand(20, spec.status === "WARNING" ? 95 : 70),
      diskPercent: rand(30, 88),
      diskFreeGb: rand(40, 400),
      diskTotalGb: 512,
    },
    zoneCount: ZONE_NAME_SETS[spec.zoneSet].length,
    cachedTracks: rand(120, 480),
    cachedSizeGb: Number((rand(2, 18) + Math.random()).toFixed(1)),
    pendingSyncJobs: spec.status === "OFFLINE" ? rand(1, 5) : rand(0, 2),
    createdAt: isoDaysAgo(rand(30, 300)),
    autoBootEnabled: true,
    // Mock agents don't report a clock, so the demo portal honestly shows
    // "using portal location" rather than a fake green pill.
    reportedTimezone: null,
    reportedLocationAt: null,
  }
})

// Unpaired server placeholder location (Riverfront) — represented purely by
// the location having serverCount 0; a pairing code is generated on demand
// via servers.generatePairingCode().

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export const zones: Zone[] = servers.flatMap((server, idx) => {
  const spec = serverSpecs[idx]
  const names = ZONE_NAME_SETS[spec.zoneSet]
  return names.map((name, zIdx) => {
    const offline = server.status === "OFFLINE"
    const state = offline
      ? "OFFLINE"
      : (["PLAYING", "PLAYING", "PLAYING", "PAUSED", "STOPPED"] as const)[
          (idx + zIdx) % 5
        ]
    return {
      id: nextId("zone"),
      serverId: server.id,
      locationId: server.locationId,
      name,
      playbackState: state,
      currentPlaylistId: null, // linked after playlists are created
      currentTrackId: null,
      volume: offline ? 0 : rand(35, 85),
      muted: false,
      updatedAt: isoMinutesAgo(rand(0, 45)),
      prayerModeEnabled: true,
      pausedByPrayer: null,
      prePrayerSnapshot: null,
      commandSequence: 0,
      lastAppliedSequence: 0,
      lastOverrideAt: null,
      excludedTrackIds: [],
      equalizer: null,
    }
  })
})

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

const TRACK_SEED: Array<[string, string, string]> = [
  ["Golden Hour Groove", "The Amber Keys", "Sunset Sessions"],
  ["Morning Espresso", "Nora Vale", "Coffeehouse Vol. 1"],
  ["Downtown Stroll", "Milo & The Loft", "City Lights"],
  ["Velvet Bassline", "Sable Quartet", "Late Night Jazz"],
  ["Citrus Breeze", "The Palm Collective", "Poolside"],
  ["Neon Skyline", "Vantage Point", "Electric Dreams"],
  ["Slow Burn", "Ruth Calloway", "Smoke & Mirrors"],
  ["Sunday Kitchen", "The Copper Pans", "Brunch Radio"],
  ["Harbor Lights", "Coastal Drift", "Tidewater"],
  ["Paper Lanterns", "Yuki Ensemble", "Evening Garden"],
  ["Brass & Rye", "Old Fashioned Trio", "Bar Standards"],
  ["Terracotta", "Isla Moreno", "Warm Tones"],
  ["Blue Hour", "The Nightowls", "After Close"],
  ["Cinnamon Roll", "Sweet Static", "Bakery Beats"],
  ["Riverside Waltz", "Aria & Sons", "Acoustic Mornings"],
  ["Chrome Horizon", "Vantage Point", "Electric Dreams"],
  ["First Light", "Nora Vale", "Coffeehouse Vol. 1"],
  ["Patio Season", "The Palm Collective", "Poolside"],
  ["Low Tide", "Coastal Drift", "Tidewater"],
  ["Amber Room", "Sable Quartet", "Late Night Jazz"],
  ["Holiday Sparkle", "The Copper Pans", "Winter Menu"],
  ["Mulled Wine", "Isla Moreno", "Warm Tones"],
  ["Fireside", "Aria & Sons", "Acoustic Mornings"],
  ["Snow on Cedar", "Yuki Ensemble", "Evening Garden"],
  ["Runway Ready", "Vantage Point", "Electric Dreams"],
  ["Terminal 2", "Milo & The Loft", "City Lights"],
  ["Gate Change", "The Amber Keys", "Sunset Sessions"],
  ["Boarding Call", "Ruth Calloway", "Smoke & Mirrors"],
  ["Marina Sunset", "Coastal Drift", "Tidewater"],
  ["Rooftop Reverie", "Sable Quartet", "Late Night Jazz"],
  ["Highball", "Old Fashioned Trio", "Bar Standards"],
  ["Skyline Sip", "The Nightowls", "After Close"],
  ["Espresso Shot", "Sweet Static", "Bakery Beats"],
  ["Latte Art", "Nora Vale", "Coffeehouse Vol. 1"],
  ["Pour Over", "The Copper Pans", "Brunch Radio"],
  ["Third Wave", "Milo & The Loft", "City Lights"],
  ["Highland Ave", "Aria & Sons", "Acoustic Mornings"],
  ["Confluence", "Coastal Drift", "Tidewater"],
  ["Uptown Funk Room", "Vantage Point", "Electric Dreams"],
  ["Main St Motion", "The Amber Keys", "Sunset Sessions"],
  ["Denver Dusk", "Isla Moreno", "Warm Tones"],
  ["Poolside Splash", "The Palm Collective", "Poolside"],
  ["Cabana Chill", "Sable Quartet", "Late Night Jazz"],
  ["Spa Serenity", "Yuki Ensemble", "Evening Garden"],
  ["Ballroom Entrance", "Old Fashioned Trio", "Bar Standards"],
  ["Beach Bar Anthem", "Ruth Calloway", "Smoke & Mirrors"],
  ["Lobby Welcome", "Aria & Sons", "Acoustic Mornings"],
  ["Checkout Chime", "Nora Vale", "Coffeehouse Vol. 1"],
]

export const tracks: Track[] = TRACK_SEED.map(([title, artist, album], i) => ({
  id: nextId("trk"),
  title,
  artist,
  album,
  genre: pick(GENRES, i),
  durationSec: rand(150, 260),
  fileSizeMb: Number((rand(3, 9) + Math.random()).toFixed(1)),
  uploadedAt: isoDaysAgo(rand(1, 380)),
  uploadedBy: "maria.alvarez@goldenfork.example",
  coverColor: pick(COVER_COLORS, i),
  folderId: null,
}))

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

function trackSlice(start: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => tracks[(start + i) % tracks.length].id)
}

export const playlists: Playlist[] = [
  {
    id: nextId("pl"),
    name: "Breakfast Acoustic",
    description: "Soft acoustic mornings for early service.",
    trackIds: trackSlice(0, 8),
    organizationId: null,
    createdAt: isoDaysAgo(200),
    updatedAt: isoDaysAgo(4),
  },
  {
    id: nextId("pl"),
    name: "Lunch Upbeat",
    description: "Energetic but conversation-friendly midday mix.",
    trackIds: trackSlice(8, 10),
    organizationId: null,
    createdAt: isoDaysAgo(190),
    updatedAt: isoDaysAgo(12),
  },
  {
    id: nextId("pl"),
    name: "Dinner Lounge",
    description: "Warm jazz and lounge for the evening dining room.",
    trackIds: trackSlice(3, 9),
    organizationId: null,
    createdAt: isoDaysAgo(180),
    updatedAt: isoDaysAgo(2),
  },
  {
    id: nextId("pl"),
    name: "Bar Late Night",
    description: "After-hours bar rotation.",
    trackIds: trackSlice(28, 7),
    organizationId: null,
    createdAt: isoDaysAgo(150),
    updatedAt: isoDaysAgo(6),
  },
  {
    id: nextId("pl"),
    name: "Poolside Party",
    description: "Bright, breezy tracks for the pool deck.",
    trackIds: trackSlice(40, 8),
    organizationId: blueWave.id,
    createdAt: isoDaysAgo(120),
    updatedAt: isoDaysAgo(9),
  },
  {
    id: nextId("pl"),
    name: "Coffee Shop Acoustic",
    description: "Signature Summit Coffee ambience mix.",
    trackIds: trackSlice(32, 9),
    organizationId: summitCoffee.id,
    createdAt: isoDaysAgo(80),
    updatedAt: isoDaysAgo(1),
  },
  {
    id: nextId("pl"),
    name: "Holiday Mix",
    description: "Seasonal rotation, Nov–Jan.",
    trackIds: trackSlice(20, 4),
    organizationId: null,
    createdAt: isoDaysAgo(60),
    updatedAt: isoDaysAgo(20),
  },
  {
    id: nextId("pl"),
    name: "Airport Ambience",
    description: "Neutral, low-tempo background for terminal lounges.",
    trackIds: trackSlice(24, 5),
    organizationId: goldenFork.id,
    createdAt: isoDaysAgo(140),
    updatedAt: isoDaysAgo(15),
  },
]

// Wire up current playlist/track for zones that are playing/paused
zones.forEach((zone, i) => {
  if (zone.playbackState === "PLAYING" || zone.playbackState === "PAUSED") {
    const playlist = pick(playlists, i)
    zone.currentPlaylistId = playlist.id
    zone.currentTrackId = pick(playlist.trackIds, i)
  }
})

// ---------------------------------------------------------------------------
// Track sync state (per server)
// ---------------------------------------------------------------------------

export const trackSyncStates: TrackSyncState[] = servers.flatMap((server) => {
  return tracks.slice(0, rand(15, tracks.length)).map((track, i) => {
    const roll = (i + server.id.length) % 11
    let status: TrackSyncState["status"] = "CACHED_ON_SERVER"
    let progress = 100
    if (server.status === "OFFLINE") {
      status = roll < 8 ? "CACHED_ON_SERVER" : "QUEUED_FOR_SYNC"
      progress = status === "CACHED_ON_SERVER" ? 100 : 0
    } else if (roll === 0) {
      status = "SYNCING"
      progress = rand(10, 90)
    } else if (roll === 1) {
      status = "QUEUED_FOR_SYNC"
      progress = 0
    } else if (roll === 2) {
      status = "FAILED"
      progress = rand(0, 40)
    } else {
      status = "CACHED_ON_SERVER"
      progress = 100
    }
    return {
      trackId: track.id,
      serverId: server.id,
      status,
      progressPercent: progress,
      updatedAt: isoMinutesAgo(rand(0, 500)),
      errorMessage: status === "FAILED" ? "Checksum mismatch after download retry (3/3)." : null,
    }
  })
})

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

const diningZones = zones.filter((z) => /Dining|Main Floor|Gate Lounge|Lobby/i.test(z.name))
const barZones = zones.filter((z) => /Bar/i.test(z.name))

export const schedules: Schedule[] = [
  ...diningZones.slice(0, 4).map((zone, i) =>
    ({
      id: nextId("sch"),
      zoneId: zone.id,
      playlistId: playlists[0].id,
      name: "Breakfast",
      startTime: "07:00",
      endTime: "11:00",
      days: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const,
      priority: 1,
      enabled: true,
      createdAt: isoDaysAgo(100 - i),
    } satisfies Schedule)
  ),
  ...diningZones.slice(0, 4).map((zone, i) =>
    ({
      id: nextId("sch"),
      zoneId: zone.id,
      playlistId: playlists[1].id,
      name: "Lunch",
      startTime: "11:00",
      endTime: "17:00",
      days: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const,
      priority: 1,
      enabled: true,
      createdAt: isoDaysAgo(100 - i),
    } satisfies Schedule)
  ),
  ...diningZones.slice(0, 4).map((zone, i) =>
    ({
      id: nextId("sch"),
      zoneId: zone.id,
      playlistId: playlists[2].id,
      name: "Dinner",
      startTime: "17:00",
      endTime: "23:00",
      days: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const,
      priority: 1,
      enabled: true,
      createdAt: isoDaysAgo(100 - i),
    } satisfies Schedule)
  ),
  ...barZones.map((zone, i) =>
    ({
      id: nextId("sch"),
      zoneId: zone.id,
      playlistId: playlists[3].id,
      name: "Late Night",
      startTime: "22:00",
      endTime: "02:00",
      days: ["FRI", "SAT"] as const,
      priority: 2,
      enabled: i % 4 !== 0,
      createdAt: isoDaysAgo(50 - i),
    } satisfies Schedule)
  ),
]

// ---------------------------------------------------------------------------
// Remote command history
// ---------------------------------------------------------------------------

export const commands: RemoteCommand[] = [
  { server: servers[0], type: "SYNC_MUSIC", status: "SUCCESS", minsAgo: 40 },
  { server: servers[0], type: "PLAY", status: "SUCCESS", minsAgo: 20 },
  { server: servers[1], type: "SYNC_CONFIG", status: "SUCCESS", minsAgo: 65 },
  { server: servers[2], type: "RESTART_SERVICE", status: "EXECUTING", minsAgo: 2 },
  { server: servers[2], type: "SYNC_MUSIC", status: "FAILED", minsAgo: 130 },
  { server: servers[3], type: "SET_VOLUME", status: "SUCCESS", minsAgo: 15 },
  { server: servers[4], type: "SYNC_MUSIC", status: "TIMEOUT", minsAgo: 700 },
  { server: servers[4], type: "RESTART_SERVICE", status: "TIMEOUT", minsAgo: 640 },
  { server: servers[5], type: "SYNC_MUSIC", status: "SENT", minsAgo: 1 },
  { server: servers[6], type: "SYNC_CONFIG", status: "PENDING", minsAgo: 0 },
  { server: servers[0], type: "MUTE", status: "SUCCESS", minsAgo: 300 },
  { server: servers[1], type: "NEXT", status: "SUCCESS", minsAgo: 5 },
].map(({ server, type, status, minsAgo }) => {
  const issuedAt = isoMinutesAgo(minsAgo + 2)
  const sentAt = status === "PENDING" ? null : isoMinutesAgo(minsAgo + 1)
  const executingAt = ["EXECUTING", "SUCCESS", "FAILED", "TIMEOUT"].includes(status)
    ? isoMinutesAgo(minsAgo + 1)
    : null
  const completedAt = ["SUCCESS", "FAILED", "TIMEOUT"].includes(status) ? isoMinutesAgo(minsAgo) : null
  const zone = zones.find((z) => z.serverId === server.id) ?? null
  return {
    id: nextId("cmd"),
    serverId: server.id,
    zoneId: ["PLAY", "SET_VOLUME", "MUTE", "NEXT", "PREVIOUS", "PAUSE", "STOP"].includes(type)
      ? zone?.id ?? null
      : null,
    type: type as RemoteCommand["type"],
    status: status as RemoteCommand["status"],
    issuedBy: "maria.alvarez@goldenfork.example",
    issuedAt,
    sentAt,
    executingAt,
    completedAt,
    resultMessage:
      status === "SUCCESS"
        ? "Acknowledged by MusicServer agent."
        : status === "FAILED"
          ? "Agent reported an error executing the command."
          : status === "TIMEOUT"
            ? "No response received from server before timeout (60s)."
            : null,
    source: "USER",
    sequence: null,
  } satisfies RemoteCommand
})

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

const LOG_LINES: Array<[LogEntry["level"], string, string]> = [
  ["INFO", "Heartbeat sent to cloud gateway.", "agent.heartbeat"],
  ["INFO", "Zone 'Dining Area' started playback of Breakfast Acoustic.", "playback.engine"],
  ["INFO", "Sync job completed: 14 tracks cached (48.2 MB).", "sync.worker"],
  ["WARN", "Sync retry 2/3 for track trk_00031 (network timeout).", "sync.worker"],
  ["ERROR", "Audio output device 'Line Out 2' disconnected.", "audio.driver"],
  ["INFO", "Configuration synchronized (schedules: 6, zones: 4).", "sync.worker"],
  ["INFO", "Local cache pruned: 3 unused tracks removed (11.4 MB freed).", "cache.manager"],
  ["WARN", "CPU usage sustained above 85% for 5 minutes.", "agent.monitor"],
  ["INFO", "Remote command received: SYNC_MUSIC.", "agent.commands"],
  ["INFO", "Remote command executed successfully: SYNC_MUSIC.", "agent.commands"],
  ["ERROR", "Failed to reach cloud gateway (ETIMEDOUT). Falling back to offline mode.", "agent.network"],
  ["INFO", "Reconnected to cloud gateway after 8m32s offline.", "agent.network"],
  ["DEBUG", "Schedule evaluator tick: no changes due.", "scheduler"],
  ["INFO", "Service 'MusicServer.PlaybackEngine' restarted by remote command.", "service.control"],
]

export const logs: LogEntry[] = servers.flatMap((server) =>
  Array.from({ length: 8 }, (_, i) => {
    const [level, message, source] = pick(LOG_LINES, i + server.id.length)
    return {
      id: nextId("log"),
      serverId: server.id,
      level,
      message,
      source,
      timestamp: isoMinutesAgo(rand(0, 2000)),
    } satisfies LogEntry
  })
)

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const alerts: Alert[] = [
  {
    id: nextId("alrt"),
    severity: "critical",
    title: "Marina Rooftop Bar server offline",
    message: "No heartbeat received for over 10 hours. Playback continuing from local cache.",
    serverId: servers[4].id,
    locationId: servers[4].locationId,
    createdAt: isoMinutesAgo(612),
    acknowledged: false,
  },
  {
    id: nextId("alrt"),
    severity: "warning",
    title: "High CPU usage — Airport Lounge T2",
    message: "CPU sustained above 90% for 15 minutes.",
    serverId: servers[2].id,
    locationId: servers[2].locationId,
    createdAt: isoMinutesAgo(35),
    acknowledged: false,
  },
  {
    id: nextId("alrt"),
    severity: "warning",
    title: "Music sync failed",
    message: "3 tracks failed to sync to Airport Lounge T2 after 3 retries.",
    serverId: servers[2].id,
    locationId: servers[2].locationId,
    createdAt: isoMinutesAgo(130),
    acknowledged: false,
  },
  {
    id: nextId("alrt"),
    severity: "info",
    title: "MusicServer update available",
    message: "Version 3.4.2 is available for 2 servers currently on 3.3.x / 3.2.x.",
    createdAt: isoMinutesAgo(1400),
    acknowledged: true,
  },
  {
    id: nextId("alrt"),
    severity: "critical",
    title: "Disk space low — Beachside Resort & Spa",
    message: "Local cache disk usage above 85%.",
    serverId: servers[3].id,
    locationId: servers[3].locationId,
    createdAt: isoMinutesAgo(2100),
    acknowledged: true,
  },
]

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

export const activity: ActivityEvent[] = [
  { type: "HEARTBEAT_RECEIVED", message: "Downtown Bistro sent heartbeat.", serverId: servers[0].id, minsAgo: 1 },
  { type: "MUSIC_SYNC_COMPLETED", message: "Harbor Grill finished syncing 14 tracks.", serverId: servers[1].id, minsAgo: 8 },
  { type: "ZONE_STATUS_CHANGED", message: "Bar (Downtown Bistro) started playback.", serverId: servers[0].id, minsAgo: 12 },
  { type: "SERVER_DISCONNECTED", message: "Marina Rooftop Bar went offline.", serverId: servers[4].id, minsAgo: 612 },
  { type: "MUSIC_SYNC_FAILED", message: "3 tracks failed to sync to Airport Lounge T2.", serverId: servers[2].id, minsAgo: 130 },
  { type: "COMMAND_COMPLETED", message: "SET_VOLUME executed on Beachside Resort & Spa.", serverId: servers[3].id, minsAgo: 15 },
  { type: "SERVER_CONNECTED", message: "Summit Coffee – Main St reconnected.", serverId: servers[5].id, minsAgo: 180 },
  { type: "PLAYBACK_CHANGED", message: "Dining Area (Harbor Grill) switched to Lunch Upbeat.", serverId: servers[1].id, minsAgo: 45 },
  { type: "MUSIC_SYNC_STARTED", message: "Sync started for Summit Coffee – Uptown (updating firmware).", serverId: servers[6].id, minsAgo: 6 },
  { type: "ERROR", message: "Audio output device disconnected on Airport Lounge T2.", serverId: servers[2].id, minsAgo: 90 },
].map(({ type, message, serverId, minsAgo }) => ({
  id: nextId("act"),
  type: type as ActivityEvent["type"],
  message,
  serverId,
  zoneId: null,
  timestamp: isoMinutesAgo(minsAgo),
}))

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const users: User[] = [
  {
    id: nextId("usr"),
    name: "Alex Chen",
    email: "alex.chen@cmmp.example",
    role: "SUPER_ADMIN",
    organizationId: null,
    createdAt: isoDaysAgo(400),
    lastLoginAt: isoMinutesAgo(5),
  },
  {
    id: nextId("usr"),
    name: "Maria Alvarez",
    email: "maria.alvarez@goldenfork.example",
    role: "ORGANIZATION_ADMIN",
    organizationId: goldenFork.id,
    createdAt: isoDaysAgo(390),
    lastLoginAt: isoMinutesAgo(60),
  },
  {
    id: nextId("usr"),
    name: "Daniel Osei",
    email: "daniel.osei@bluewave.example",
    role: "ORGANIZATION_ADMIN",
    organizationId: blueWave.id,
    createdAt: isoDaysAgo(270),
    lastLoginAt: isoMinutesAgo(500),
  },
  {
    id: nextId("usr"),
    name: "Priya Nair",
    email: "priya.nair@summitcoffee.example",
    role: "ORGANIZATION_ADMIN",
    organizationId: summitCoffee.id,
    createdAt: isoDaysAgo(90),
    lastLoginAt: isoMinutesAgo(20),
  },
  {
    id: nextId("usr"),
    name: "Jordan Blake",
    email: "jordan.blake@goldenfork.example",
    role: "LOCATION_MANAGER",
    organizationId: goldenFork.id,
    createdAt: isoDaysAgo(200),
    lastLoginAt: isoMinutesAgo(1440),
  },
  {
    id: nextId("usr"),
    name: "Sam Reyes",
    email: "sam.reyes@cmmp.example",
    role: "VIEWER",
    organizationId: null,
    createdAt: isoDaysAgo(30),
    lastLoginAt: isoMinutesAgo(4000),
  },
]

// Backfill computed counts on organizations/locations
locations.forEach((loc) => {
  loc.serverCount = servers.filter((s) => s.locationId === loc.id).length
  loc.zoneCount = zones.filter((z) => z.locationId === loc.id).length
})
organizations.forEach((org) => {
  org.locationCount = locations.filter((l) => l.organizationId === org.id).length
  org.serverCount = servers.filter((s) => s.organizationId === org.id).length
})

/** Demo credentials surfaced on the login screen. Mock mode only. */
export const DEMO_CREDENTIALS = [
  { email: "alex.chen@cmmp.example", role: "SUPER_ADMIN" as const },
  { email: "maria.alvarez@goldenfork.example", role: "ORGANIZATION_ADMIN" as const },
  { email: "jordan.blake@goldenfork.example", role: "LOCATION_MANAGER" as const },
  { email: "sam.reyes@cmmp.example", role: "VIEWER" as const },
]
export const DEMO_PASSWORD = "cmmp-demo-2026"
