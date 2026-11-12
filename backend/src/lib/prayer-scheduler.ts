import { prisma } from "./db.js"
import { pushActivity } from "./activity.js"
import { pushToAgent } from "./agent-registry.js"
import { resolveCityCoordinates } from "./geo.js"
import { getTimingsForDate } from "./prayer-times.js"
import { addDays, calendarDateKey, todayInTimeZone, zonedTimeToUtc } from "./timezone-math.js"
import { PRAYER_NAMES, type PrayerName } from "./constants.js"
import { agentVersionStatus } from "./version.js"
import { notePrayerWindow } from "./zone-watchdog.js"
import type { Location, Prisma, PrayerConfig, Zone } from "@prisma/client"

/**
 * Cloud-side Prayer Mode execution: pauses participating zones when a
 * prayer starts and resumes them `pauseDurationMinutes` later.
 *
 * This is the half that actually runs in a real deployment. The browser
 * scheduler (src/lib/prayer/scheduler.ts) only drives mock mode — a portal
 * tab being closed must never stop a venue's prayer pauses.
 *
 * Design notes:
 *  - Everything is evaluated per zone Location, with the same city lookup
 *    and AlAdhan times the zone cards show (lib/geo.ts, the backend half of
 *    src/lib/geo/locations.ts). The cloud host's timezone is never used.
 *  - A tick only acts inside a prayer's pause window. A prayer whose window
 *    already closed is marked fired without acting, so a backend restart
 *    late in the day never replays the day's prayers.
 *  - Idempotence survives restarts through the database, not just the
 *    in-memory `fired` set: a start only pauses zones that are PLAYING (an
 *    already-paused zone is not re-paused), and an end only resumes zones
 *    still carrying `pausedByPrayer`, which is cleared as they resume.
 *  - Commands are ordinary SCHEDULE-sourced zone transport commands
 *    (PAUSE/PLAY) — the same ones the portal issues — left PENDING for the
 *    agent to pick up. No new command types, no direct playback writes.
 */

const TICK_MS = 30_000

/** How far a prayer time may move, in real time, from one day to the next. */
const TIMES_DRIFT_MS = 10 * 60_000
const DAY_MS = 86_400_000

type PauseState = "open" | "ended" | "closed"

/** RemoteCommand.issuedById has no FK to User, and routes/commands.ts
 * resolves an unknown id to itself for display — so scheduler-issued
 * commands are attributed honestly instead of borrowing a real admin. */
const SCHEDULER_ISSUER = "prayer-scheduler"

/** `${organizationId}:${dateKey}:${locationId}:${prayer}:start|end`, with
 * `:srv:${serverId}` before the last part for a server's own settings. */
const fired = new Set<string>()

/** Servers with their own settings when an organization pause started, by
 * its start key — so one switched back to the organization mid-window is
 * still paused for the rest of that window. */
const ownAtStart = new Map<string, Set<string>>()

/** Locations already warned about, so an unknown city logs once, not every tick. */
const warnedLocations = new Set<string>()

/** The first venue installer whose Super Zones followers play their super
 * zone's exact song. Only from there on is a follower that waits silently
 * for its leader's next song part of a prayer; older builds get exactly
 * what they always did. */
const EXACT_SYNC_VERSION = "2026.11.4"
const exactSync = (zone: { server?: { version: string | null } | null }) =>
  agentVersionStatus(zone.server?.version, EXACT_SYNC_VERSION) === "current"

interface PrayerSettings {
  enabled: boolean
  offsetMinutes: number
  pauseDurationMinutes: number
}

interface Group {
  where: Prisma.ZoneWhereInput
  prayers: Prisma.JsonValue
  server: { id: string; name: string } | null
}

function settingsFor(prayers: Prisma.JsonValue, prayer: PrayerName): PrayerSettings | null {
  const all = prayers as Record<string, unknown> | null
  const raw = all && typeof all === "object" ? (all[prayer] as Record<string, unknown> | undefined) : undefined
  if (!raw) return null
  return {
    enabled: raw.enabled !== false,
    offsetMinutes: typeof raw.offsetMinutes === "number" ? raw.offsetMinutes : 0,
    pauseDurationMinutes: typeof raw.pauseDurationMinutes === "number" ? raw.pauseDurationMinutes : 10,
  }
}

export function effectivePrayers(prayers: Prisma.JsonValue): Record<PrayerName, PrayerSettings> {
  return Object.fromEntries(
    PRAYER_NAMES.map((p) => [p, settingsFor(prayers, p) ?? { enabled: false, offsetMinutes: 0, pauseDurationMinutes: 10 }])
  ) as Record<PrayerName, PrayerSettings>
}

function prayerLabel(prayer: PrayerName): string {
  return prayer.charAt(0) + prayer.slice(1).toLowerCase()
}

/** Queues one zone transport command exactly the way the portal does:
 * bump the zone's sequence, record it PENDING with source SCHEDULE, then
 * nudge a connected agent (its own poll remains authoritative). */
async function issueZoneCommand(zone: Zone, type: "PAUSE" | "PLAY", payload: Prisma.InputJsonValue) {
  const bumped = await prisma.zone.update({
    where: { id: zone.id },
    data: { commandSequence: { increment: 1 } },
    select: { commandSequence: true, localZoneId: true },
  })
  const command = await prisma.remoteCommand.create({
    data: {
      serverId: zone.serverId,
      zoneId: zone.id,
      type,
      payload,
      status: "PENDING",
      source: "SCHEDULE",
      sequence: bumped.commandSequence,
      issuedById: SCHEDULER_ISSUER,
    },
  })
  pushToAgent(zone.serverId, "ReceiveCommand", [
    {
      commandId: command.id,
      type,
      zoneId: bumped.localZoneId ?? zone.id,
      payload,
      sequence: bumped.commandSequence,
    },
  ])
}

function onServer(group: Group): string {
  return group.server ? ` on ${group.server.name}` : ""
}

async function firePrayerStart(config: PrayerConfig, prayer: PrayerName, locationId: string, group: Group, quietIfNone = false) {
  // Only zones that opted in and are actually playing: a zone a manager had
  // already paused or stopped is never touched, so it can never be
  // "resumed" into playing by the end of a prayer it was never part of. A
  // Super Zones follower plays when its leader plays, even while it waits
  // silently (STOPPED) for its leader's next song (agent 2026.11.4+).
  const zones = (
    await prisma.zone.findMany({
      where: {
        prayerModeEnabled: true,
        OR: [{ playbackState: "PLAYING" }, { playbackState: "STOPPED", pausedByPrayer: null, leaderZone: { is: { playbackState: "PLAYING" } } }],
        locationId,
        ...group.where,
        server: { organizationId: config.organizationId },
      },
      include: { server: { select: { version: true } } },
    })
  ).filter((zone) => zone.playbackState === "PLAYING" || exactSync(zone))
  // Leaders first: a leader's pause pauses its followers in the same instant,
  // which their own pause then finds already done.
  zones.sort((a, b) => Number(Boolean(a.leaderZoneId)) - Number(Boolean(b.leaderZoneId)))

  for (const zone of zones) {
    await prisma.zone.update({
      where: { id: zone.id },
      data: {
        pausedByPrayer: prayer,
        prePrayerPlaybackState: zone.leaderZoneId ? "PLAYING" : zone.playbackState,
        prePrayerPlaylistId: zone.currentPlaylistId,
        prePrayerTrackId: zone.currentTrackId,
      },
    })
    await issueZoneCommand(zone, "PAUSE", { prayer })
  }

  if (quietIfNone && zones.length === 0) return
  await pushActivity({
    type: "PRAYER_STARTED",
    message: `${prayerLabel(prayer)} began${onServer(group)} — pausing ${zones.length} zone(s).`,
    serverId: group.server?.id,
  })
}

async function firePrayerEnd(config: PrayerConfig, prayer: PrayerName, locationId: string, group?: Group, leftover = false) {
  const zones = await prisma.zone.findMany({
    where: { pausedByPrayer: prayer, locationId, ...group?.where, server: { organizationId: config.organizationId } },
    include: { server: { select: { version: true } } },
  })

  let resumed = 0
  for (const zone of zones) {
    // A leftover pause on a zone someone has since stopped is cleared, not played.
    // A follower is told all the same: its PLAY ends its prayer hold, and it
    // plays only what its leader plays (agent 2026.11.4+).
    const wasPlaying =
      zone.prePrayerPlaybackState === "PLAYING" && !(leftover && zone.playbackState === "STOPPED" && !(zone.leaderZoneId && exactSync(zone)))
    await prisma.zone.update({
      where: { id: zone.id },
      data: {
        pausedByPrayer: null,
        prePrayerPlaybackState: null,
        prePrayerPlaylistId: null,
        prePrayerTrackId: null,
      },
    })
    if (!wasPlaying) continue
    await issueZoneCommand(zone, "PLAY", {
      prayer,
      restore: {
        playbackState: zone.prePrayerPlaybackState,
        currentPlaylistId: zone.prePrayerPlaylistId,
        currentTrackId: zone.prePrayerTrackId,
      },
    })
    resumed++
  }

  await pushActivity({
    type: "PRAYER_ENDED",
    message: `${prayerLabel(prayer)} ended${group ? onServer(group) : ""} — resuming ${resumed} zone(s).`,
    serverId: group?.server?.id,
  })
}

/** One pass per Location that has zones in this organization — so each
 * zone pauses on its own Location's times, and AlAdhan is asked once per
 * Location, never once per zone. */
export async function tickOrganization(config: PrayerConfig, now: Date): Promise<string[]> {
  const places = await prisma.location.findMany({
    where: { zones: { some: { server: { organizationId: config.organizationId } } } },
    select: { id: true, name: true, city: true, country: true, timezone: true },
  })
  const overrides = await loadServerOverrides(config)
  const dateKeys: string[] = []
  for (const place of places) {
    const dateKey = await tickLocation(config, place, now, overrides)
    if (dateKey) dateKeys.push(dateKey)
  }
  return dateKeys
}

interface ServerOverrides {
  servers: { serverId: string; serverName: string; prayers: Prisma.JsonValue }[]
  /** Servers with zones at each Location; only read when `servers` is non-empty. */
  serversAt: Map<string, Set<string>>
}

/** Last successful read per organization: a failed read keeps these, so a
 * database hiccup never moves a server onto the organization's times. */
const lastOverrides = new Map<string, ServerOverrides>()

/** null: not known this tick (failed read, nothing read before), so the
 * organization is left alone until a read succeeds. */
async function loadServerOverrides(config: PrayerConfig): Promise<ServerOverrides | null> {
  try {
    const rows = await prisma.serverPrayerOverride.findMany({
      where: { server: { organizationId: config.organizationId } },
      select: { serverId: true, prayers: true, server: { select: { name: true } } },
    })
    const serversAt = new Map<string, Set<string>>()
    if (rows.length > 0) {
      const zones = await prisma.zone.findMany({
        where: { server: { organizationId: config.organizationId } },
        select: { serverId: true, locationId: true },
      })
      for (const z of zones) serversAt.set(z.locationId, (serversAt.get(z.locationId) ?? new Set()).add(z.serverId))
    }
    const loaded = { servers: rows.map((r) => ({ serverId: r.serverId, serverName: r.server.name, prayers: r.prayers })), serversAt }
    lastOverrides.set(config.organizationId, loaded)
    return loaded
  } catch (error) {
    console.warn(`[prayer-scheduler] Could not read servers' own prayer settings — keeping the last ones read: ${error}`)
    const last = lastOverrides.get(config.organizationId)
    if (last) return last
    // The table not existing yet (migration still to run) means no server has its own settings.
    return (error as { code?: string }).code === "P2021" ? { servers: [], serversAt: new Map() } : null
  }
}

/** Returns the venue-local date key it evaluated, so the caller can prune
 * stale `fired` entries without resolving the location a second time. */
async function tickLocation(
  config: PrayerConfig,
  place: Pick<Location, "id" | "name" | "city" | "country" | "timezone">,
  now: Date,
  overrides: ServerOverrides | null
): Promise<string | null> {
  // The same lookup the zone cards use (src/lib/geo/locations.ts resolveGeoLocation).
  const location = resolveCityCoordinates(place.city, place.country, place.timezone)
  // No usable coordinates: stay idle rather than calculate against a point
  // nobody chose. The zone cards report the same condition to the UI.
  if (!location) {
    if (!warnedLocations.has(place.id)) {
      warnedLocations.add(place.id)
      console.warn(`[prayer-scheduler] Location "${place.name}" (${place.city}, ${place.country}) has no known coordinates — its zones are skipped.`)
    }
    // Never paused here again, but a zone already paused for prayer must not be stranded.
    for (const prayer of PRAYER_NAMES) await firePrayerEndIfZonesStillPaused(config, prayer, place.id)
    return null
  }
  warnedLocations.delete(place.id)

  const today = todayInTimeZone(location.timezone, now)
  const dateKey = calendarDateKey(today)
  if (!overrides) return dateKey
  const timings = await getTimingsForDate(location, config.calculationMethodId, today)

  const customized = overrides.servers.map((o) => o.serverId)
  const here = overrides.serversAt.get(place.id) ?? new Set<string>()
  const groups: Group[] = []
  if (customized.length === 0 || here.size === 0 || [...here].some((id) => !customized.includes(id))) {
    groups.push({ where: customized.length ? { serverId: { notIn: customized } } : {}, prayers: config.prayers, server: null })
  }
  for (const o of overrides.servers) {
    if (here.has(o.serverId)) groups.push({ where: { serverId: o.serverId }, prayers: o.prayers, server: { id: o.serverId, name: o.serverName } })
  }

  // Whether a pause still flagged outside today's window may belong to an
  // open one: yesterday's, run past midnight, or — when today's times are
  // unknown — today's, taken to be about where yesterday's was.
  const yesterday = addDays(today, -1)
  // "ended": yesterday's window ran past midnight and has now closed — an
  // ordinary end, not a leftover.
  const mayBeOpen = (prayer: PrayerName, settings: PrayerSettings, todayKnown: boolean) => async (): Promise<PauseState> => {
    const prev = await getTimingsForDate(location, config.calculationMethodId, yesterday)
    if (!prev) return todayKnown ? "closed" : "open"
    const start = zonedTimeToUtc(yesterday, prev[prayer], location.timezone).getTime() + settings.offsetMinutes * 60_000
    const end = start + settings.pauseDurationMinutes * 60_000
    if (now.getTime() < end) return "open"
    // Today's times unknown: assume today's window is a day after yesterday's (in real time, so DST changes don't move it).
    if (!todayKnown && now.getTime() >= start + DAY_MS - TIMES_DRIFT_MS && now.getTime() < end + DAY_MS + TIMES_DRIFT_MS) return "open"
    return end > zonedTimeToUtc(today, "00:00", location.timezone).getTime() ? "ended" : "closed"
  }

  for (const group of groups) {
    const keyPrefix = `${config.organizationId}:${dateKey}:${place.id}`
    const keySuffix = group.server ? `:srv:${group.server.id}` : ""
    for (const prayer of PRAYER_NAMES) {
      const settings = settingsFor(group.prayers, prayer)
      if (!settings?.enabled) {
        await firePrayerEndIfZonesStillPaused(config, prayer, place.id, group, { leftover: true })
        continue
      }
      if (!timings) {
        await firePrayerEndIfZonesStillPaused(config, prayer, place.id, group, { leftover: true, mayBeOpen: mayBeOpen(prayer, settings, false) })
        continue
      }

      const startAt = new Date(
        zonedTimeToUtc(today, timings[prayer], location.timezone).getTime() + settings.offsetMinutes * 60_000
      )
      const endAt = new Date(startAt.getTime() + settings.pauseDurationMinutes * 60_000)
      const startKey = `${keyPrefix}:${prayer}${keySuffix}:start`
      const endKey = `${keyPrefix}:${prayer}${keySuffix}:end`

      if (now < startAt) {
        if (startAt.getTime() - now.getTime() <= 2 * 60_000) notePrayerWindow(place.id, endAt.getTime())
        if (!fired.has(startKey)) {
          await firePrayerEndIfZonesStillPaused(config, prayer, place.id, group, { leftover: true, mayBeOpen: mayBeOpen(prayer, settings, true) })
        }
        continue
      }

      if (now >= endAt) {
        // The window has closed. If we paused for it, resume now (a tick may
        // simply have been missed); otherwise just record it as done so a
        // restart doesn't replay a prayer hours after the fact.
        if (!fired.has(endKey)) {
          if (fired.has(startKey)) await firePrayerEnd(config, prayer, place.id, group)
          else await firePrayerEndIfZonesStillPaused(config, prayer, place.id, group)
          fired.add(startKey)
          fired.add(endKey)
        } else {
          await firePrayerEndIfZonesStillPaused(config, prayer, place.id, group, { leftover: true })
        }
        continue
      }

      // Inside the pause window.
      notePrayerWindow(place.id, endAt.getTime())
      if (!fired.has(startKey)) {
        fired.add(startKey)
        await firePrayerStart(config, prayer, place.id, group)
      } else if (!group.server) {
        const hadOwn = ownAtStart.get(startKey) ?? new Set<string>()
        const joined = [...hadOwn].filter((id) => !customized.includes(id))
        if (joined.length) {
          await firePrayerStart(config, prayer, place.id, { ...group, where: { serverId: { in: joined }, pausedByPrayer: null } }, true)
        }
      }
      if (!group.server) {
        const ownHere = customized.filter((id) => here.has(id))
        if (ownHere.length) ownAtStart.set(startKey, new Set(ownHere))
        else ownAtStart.delete(startKey)
      }
    }
  }

  return dateKey
}

/** Covers a restart mid-prayer: the in-memory record of the start is gone,
 * but zones still carry `pausedByPrayer`, so they must still be resumed. */
async function firePrayerEndIfZonesStillPaused(
  config: PrayerConfig,
  prayer: PrayerName,
  locationId: string,
  group?: Group,
  options: { leftover?: boolean; mayBeOpen?: () => Promise<PauseState> } = {}
) {
  const stillPaused = await prisma.zone.count({
    where: { pausedByPrayer: prayer, locationId, ...group?.where, server: { organizationId: config.organizationId } },
  })
  if (stillPaused === 0) return
  const state = (await options.mayBeOpen?.()) ?? "closed"
  if (state !== "open") await firePrayerEnd(config, prayer, locationId, group, options.leftover && state === "closed")
}

/** Keeps `fired` from growing without bound — yesterday's keys can never
 * match again once the venue's date has rolled over. */
function pruneFired(activeDateKeys: Set<string>) {
  for (const key of fired) {
    const dateKey = key.split(":")[1]
    if (!activeDateKeys.has(dateKey)) fired.delete(key)
  }
  for (const key of ownAtStart.keys()) if (!fired.has(key)) ownAtStart.delete(key)
}

export function startPrayerScheduler() {
  const timer = setInterval(async () => {
    try {
      const configs = await prisma.prayerConfig.findMany()
      const now = new Date()
      const unconfigured = await prisma.organization.findMany({
        where: { id: { notIn: configs.map((c) => c.organizationId) } },
        select: { id: true },
      })
      for (const { id } of unconfigured) {
        configs.push({
          id: `default:${id}`,
          organizationId: id,
          enabled: true,
          linkedLocationId: null,
          country: null,
          city: null,
          latitude: null,
          longitude: null,
          timezone: null,
          calculationMethodId: 3,
          prayers: Object.fromEntries(PRAYER_NAMES.map((name) => [name, { enabled: true, offsetMinutes: 0, pauseDurationMinutes: 10 }])),
          updatedAt: now,
        })
      }
      const activeDateKeys = new Set<string>()
      for (const config of configs) {
        for (const dateKey of await tickOrganization(config, now)) activeDateKeys.add(dateKey)
      }
      pruneFired(activeDateKeys)
    } catch {
      // Best-effort, exactly like the agent sweep: a failed tick must never
      // take the process down, and the next one re-evaluates from scratch.
    }
  }, TICK_MS)
  timer.unref()
  return timer
}
