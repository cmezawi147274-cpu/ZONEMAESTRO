import { prisma } from "./db.js"
import { pushActivity } from "./activity.js"
import { pushToAgent } from "./agent-registry.js"
import { resolvePrayerLocation } from "./prayer-location.js"
import { getTimingsForDate } from "./prayer-times.js"
import { calendarDateKey, todayInTimeZone, zonedTimeToUtc } from "./timezone-math.js"
import { PRAYER_NAMES, type PrayerName } from "./constants.js"
import type { Prisma, PrayerConfig, Zone } from "@prisma/client"

/**
 * Cloud-side Prayer Mode execution: pauses participating zones when a
 * prayer starts and resumes them `pauseDurationMinutes` later.
 *
 * This is the half that actually runs in a real deployment. The browser
 * scheduler (src/lib/prayer/scheduler.ts) only drives mock mode — a portal
 * tab being closed must never stop a venue's prayer pauses.
 *
 * Design notes:
 *  - Everything is evaluated against the *venue's* clock, resolved per
 *    organization (lib/prayer-location.ts): the venue PC's reported IANA
 *    zone, else its Location's. The cloud host's timezone is never used.
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

/** RemoteCommand.issuedById has no FK to User, and routes/commands.ts
 * resolves an unknown id to itself for display — so scheduler-issued
 * commands are attributed honestly instead of borrowing a real admin. */
const SCHEDULER_ISSUER = "prayer-scheduler"

/** `${organizationId}:${dateKey}:${prayer}:start|end` */
const fired = new Set<string>()

interface PrayerSettings {
  enabled: boolean
  offsetMinutes: number
  pauseDurationMinutes: number
}

function settingsFor(config: PrayerConfig, prayer: PrayerName): PrayerSettings | null {
  const all = config.prayers as Record<string, unknown> | null
  const raw = all && typeof all === "object" ? (all[prayer] as Record<string, unknown> | undefined) : undefined
  if (!raw) return null
  return {
    enabled: raw.enabled !== false,
    offsetMinutes: typeof raw.offsetMinutes === "number" ? raw.offsetMinutes : 0,
    pauseDurationMinutes: typeof raw.pauseDurationMinutes === "number" ? raw.pauseDurationMinutes : 10,
  }
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

async function firePrayerStart(config: PrayerConfig, prayer: PrayerName) {
  // Only zones that opted in and are actually playing: a zone a manager had
  // already paused or stopped is never touched, so it can never be
  // "resumed" into playing by the end of a prayer it was never part of.
  const zones = await prisma.zone.findMany({
    where: {
      prayerModeEnabled: true,
      playbackState: "PLAYING",
      server: { organizationId: config.organizationId },
    },
  })

  for (const zone of zones) {
    await prisma.zone.update({
      where: { id: zone.id },
      data: {
        pausedByPrayer: prayer,
        prePrayerPlaybackState: zone.playbackState,
        prePrayerPlaylistId: zone.currentPlaylistId,
        prePrayerTrackId: zone.currentTrackId,
      },
    })
    await issueZoneCommand(zone, "PAUSE", { prayer })
  }

  await pushActivity({
    type: "PRAYER_STARTED",
    message: `${prayerLabel(prayer)} began — pausing ${zones.length} zone(s).`,
  })
}

async function firePrayerEnd(config: PrayerConfig, prayer: PrayerName) {
  const zones = await prisma.zone.findMany({
    where: { pausedByPrayer: prayer, server: { organizationId: config.organizationId } },
  })

  let resumed = 0
  for (const zone of zones) {
    const wasPlaying = zone.prePrayerPlaybackState === "PLAYING"
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
    message: `${prayerLabel(prayer)} ended — resuming ${resumed} zone(s).`,
  })
}

/** Returns the venue-local date key it evaluated, so the caller can prune
 * stale `fired` entries without resolving the location a second time. */
async function tickOrganization(config: PrayerConfig, now: Date): Promise<string | null> {
  const location = await resolvePrayerLocation(config)
  // No usable coordinates: stay idle rather than calculate against a point
  // nobody chose. The times endpoint reports the same condition to the UI.
  if (!location) return null

  const today = todayInTimeZone(location.timezone, now)
  const dateKey = calendarDateKey(today)
  const timings = await getTimingsForDate(location, config.calculationMethodId, today)
  if (!timings) return dateKey

  for (const prayer of PRAYER_NAMES) {
    const settings = settingsFor(config, prayer)
    if (!settings?.enabled) continue

    const startAt = new Date(
      zonedTimeToUtc(today, timings[prayer], location.timezone).getTime() + settings.offsetMinutes * 60_000
    )
    const endAt = new Date(startAt.getTime() + settings.pauseDurationMinutes * 60_000)
    const startKey = `${config.organizationId}:${dateKey}:${prayer}:start`
    const endKey = `${config.organizationId}:${dateKey}:${prayer}:end`

    if (now < startAt) continue

    if (now >= endAt) {
      // The window has closed. If we paused for it, resume now (a tick may
      // simply have been missed); otherwise just record it as done so a
      // restart doesn't replay a prayer hours after the fact.
      if (!fired.has(endKey)) {
        if (fired.has(startKey)) await firePrayerEnd(config, prayer)
        else await firePrayerEndIfZonesStillPaused(config, prayer)
        fired.add(startKey)
        fired.add(endKey)
      }
      continue
    }

    // Inside the pause window.
    if (!fired.has(startKey)) {
      fired.add(startKey)
      await firePrayerStart(config, prayer)
    }
  }

  return dateKey
}

/** Covers a restart mid-prayer: the in-memory record of the start is gone,
 * but zones still carry `pausedByPrayer`, so they must still be resumed. */
async function firePrayerEndIfZonesStillPaused(config: PrayerConfig, prayer: PrayerName) {
  const stillPaused = await prisma.zone.count({
    where: { pausedByPrayer: prayer, server: { organizationId: config.organizationId } },
  })
  if (stillPaused > 0) await firePrayerEnd(config, prayer)
}

/** Keeps `fired` from growing without bound — yesterday's keys can never
 * match again once the venue's date has rolled over. */
function pruneFired(activeDateKeys: Set<string>) {
  for (const key of fired) {
    const dateKey = key.split(":")[1]
    if (!activeDateKeys.has(dateKey)) fired.delete(key)
  }
}

export function startPrayerScheduler() {
  const timer = setInterval(async () => {
    try {
      const configs = await prisma.prayerConfig.findMany({ where: { enabled: true } })
      const now = new Date()
      const activeDateKeys = new Set<string>()
      for (const config of configs) {
        const dateKey = await tickOrganization(config, now)
        if (dateKey) activeDateKeys.add(dateKey)
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
