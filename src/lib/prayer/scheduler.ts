"use client"

import { PRAYER_NAMES, type PrayerName } from "@/lib/constants"
import { isMockMode } from "@/lib/config"
import type { PrayerConfig, PrayerTimesToday } from "@/lib/api/types"
import { readEffectivePrayerConfig, subscribePrayerConfig } from "@/lib/prayer/config-store"
import { cacheKey, getCachedTimings, getMostRecentTimings, setCachedTimings } from "@/lib/prayer/cache"
import { fetchPrayerTimings } from "@/lib/prayer/aladhan"
import { addDays, calendarDateKey, todayInTimeZone, zonedTimeToUtc, type CalendarDate } from "@/lib/prayer/timezone-math"
import { mockBus } from "@/lib/realtime/bus"
import { store } from "@/lib/mock/store"
import { commandsApi } from "@/lib/api/commands"

/**
 * Central Prayer Scheduler — the single source of truth for when prayer
 * pauses start/end, for every zone, cloud-wide. There is exactly one
 * instance (stashed on globalThis to survive Fast Refresh, exactly like
 * src/lib/mock/store.ts), never one per zone or per server.
 *
 * Design notes (see README "Prayer Mode" for the full picture):
 *  - Purely event-driven: each prayer gets a `setTimeout` fired at its exact
 *    instant, plus one midnight-rollover timer — never a polling interval.
 *  - Works entirely from the local cache once a day's timings are fetched,
 *    so a cached schedule keeps triggering pauses with zero network access.
 *  - Recomputes on config change (location/timezone/method/prayer toggles)
 *    and on day rollover, always in the *configured* timezone, not the
 *    browser's.
 *  - Idempotent: each (date, prayer, start|end) fires at most once, tracked
 *    in `fired`, so re-running recalculate() mid-day (e.g. after a config
 *    edit) never re-triggers something that already happened today.
 *  - This module drives zone pause/resume in mock mode by issuing ordinary
 *    SCHEDULE-sourced remote commands through the existing command system
 *    (src/lib/api/commands.ts) — it never touches playback state directly.
 *    In a real deployment this same decision logic runs on the Windows
 *    MusicServer itself against its own cached schedule (see architecture
 *    note in README); the cloud only ships it the configuration.
 */

interface ScheduledEvent {
  prayer: PrayerName
  startAt: Date
  endAt: Date
}

class PrayerScheduler {
  private config: PrayerConfig = readEffectivePrayerConfig()
  private todayKey: string | null = null
  private todayEvents: ScheduledEvent[] = []
  private fired = new Set<string>() // `${dateKey}:${prayer}:start|end`
  private startTimers = new Map<PrayerName, ReturnType<typeof setTimeout>>()
  private endTimers = new Map<PrayerName, ReturnType<typeof setTimeout>>()
  private midnightTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private unsubscribeConfig: (() => void) | null = null
  private visibilityHandler = () => this.reconcile()

  start() {
    if (this.started) return
    this.started = true
    this.unsubscribeConfig = subscribePrayerConfig((next) => {
      log("info", "Prayer configuration changed — recalculating schedule", { enabled: next.enabled })
      this.config = next
      void this.recalculate()
    })
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.visibilityHandler)
    }
    void this.recalculate()
  }

  stop() {
    this.clearAllTimers()
    this.unsubscribeConfig?.()
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler)
    }
    this.started = false
  }

  /** Re-reads config from storage and recalculates — used after an external
   * write (e.g. the settings form saved via prayerApi) when this instance
   * didn't originate the change. */
  refreshFromStorage() {
    this.config = readEffectivePrayerConfig()
    void this.recalculate()
  }

  getTodayEvents(): ScheduledEvent[] {
    return this.todayEvents
  }

  private clearAllTimers() {
    this.startTimers.forEach(clearTimeout)
    this.endTimers.forEach(clearTimeout)
    this.startTimers.clear()
    this.endTimers.clear()
    if (this.midnightTimer) clearTimeout(this.midnightTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.midnightTimer = null
    this.retryTimer = null
  }

  private async recalculate() {
    this.clearAllTimers()

    if (!this.config.enabled || !this.config.location) {
      this.todayEvents = []
      return
    }

    const location = this.config.location
    const today = todayInTimeZone(location.timezone)
    const dateKey = calendarDateKey(today)
    this.todayKey = dateKey

    const timings = await this.getTimingsForDate(today)
    if (!timings) {
      // No network, no cache, nothing recent to fall back to — fail safe
      // (no pauses today) and retry soon rather than polling continuously.
      log("error", "No prayer timings available (API unreachable and no cache) — Prayer Mode idle until next retry")
      this.retryTimer = setTimeout(() => void this.recalculate(), 15 * 60 * 1000)
      return
    }

    this.todayEvents = PRAYER_NAMES.filter((p) => this.config.prayers[p].enabled).map((prayer) => {
      const settings = this.config.prayers[prayer]
      const startAt = new Date(zonedTimeToUtc(today, timings[prayer], location.timezone).getTime() + settings.offsetMinutes * 60_000)
      const endAt = new Date(startAt.getTime() + settings.pauseDurationMinutes * 60_000)
      return { prayer, startAt, endAt }
    })

    this.scheduleAll(dateKey)
    this.scheduleMidnightRollover(location.timezone)
  }

  /** Cache-first, network-fallback, with a last-resort "most recent
   * anything we have" tier so a location/method change while offline still
   * produces *some* schedule rather than none. */
  private async getTimingsForDate(date: CalendarDate): Promise<PrayerTimesToday | null> {
    const location = this.config.location!
    const key = cacheKey(calendarDateKey(date), location.latitude, location.longitude, this.config.calculationMethodId)

    const cached = getCachedTimings(key)
    if (cached) {
      log("debug", "Using cached prayer timings", { key })
      return cached
    }

    try {
      const referenceInstant = new Date(Date.UTC(date.year, date.month - 1, date.day, 12))
      const { timings } = await fetchPrayerTimings(location, this.config.calculationMethodId, referenceInstant)
      setCachedTimings(key, timings)
      log("info", "Refreshed prayer timings from AlAdhan API", { key })
      return timings
    } catch (err) {
      log("warn", "AlAdhan API refresh failed — falling back to cache", { error: (err as Error).message })
      const fallback = getMostRecentTimings()
      if (fallback) {
        log("warn", "Using most recent cached prayer timings as fallback", { fetchedAt: fallback.fetchedAt })
        return fallback.timings
      }
      return null
    }
  }

  private scheduleAll(dateKey: string) {
    const now = Date.now()
    for (const event of this.todayEvents) {
      const startKey = `${dateKey}:${event.prayer}:start`
      const endKey = `${dateKey}:${event.prayer}:end`
      const startFired = this.fired.has(startKey)
      const endFired = this.fired.has(endKey)
      if (endFired) continue

      if (!startFired && now >= event.startAt.getTime()) {
        // We're already inside (or past) this prayer's window — e.g. the
        // page just loaded, or a background tab's timers were throttled.
        // Catch up immediately instead of silently skipping it.
        this.firePrayerStart(event)
      } else if (!startFired) {
        this.startTimers.set(
          event.prayer,
          setTimeout(() => this.firePrayerStart(event), event.startAt.getTime() - now)
        )
      }

      if (now >= event.endAt.getTime()) {
        if (this.fired.has(startKey) && !endFired) this.firePrayerEnd(event)
      } else {
        this.endTimers.set(
          event.prayer,
          setTimeout(() => this.firePrayerEnd(event), event.endAt.getTime() - now)
        )
      }
    }
  }

  private scheduleMidnightRollover(timeZone: string) {
    const tomorrow = addDays(todayInTimeZone(timeZone), 1)
    const midnightUtc = zonedTimeToUtc(tomorrow, "00:00", timeZone)
    const delay = Math.max(1000, midnightUtc.getTime() - Date.now())
    this.midnightTimer = setTimeout(() => void this.recalculate(), delay)
  }

  /** Re-checks "are we inside a window we haven't fired yet" without
   * refetching — cheap, called on tab focus/visibility change to catch up
   * after the browser throttled background timers. */
  private reconcile() {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return
    if (!this.todayKey) return
    this.scheduleAll(this.todayKey)
  }

  private firePrayerStart(event: ScheduledEvent) {
    const key = `${this.todayKey}:${event.prayer}:start`
    if (this.fired.has(key)) return
    this.fired.add(key)

    // In real mode, pausing zones is the Windows MusicServer's own job,
    // running this exact schedule locally against its own cache — this
    // browser-side scheduler exists to compute/preview/cache the schedule
    // and (in mock mode only) stand in for that local execution. See
    // README "Prayer Mode" for the full local-first architecture note.
    if (!isMockMode) return

    const eligibleZones = store.zones.filter((z) => z.prayerModeEnabled && z.playbackState === "PLAYING")

    log("info", "Prayer started", { prayer: event.prayer, zonesAffected: eligibleZones.length })
    store.pushActivity({
      type: "PRAYER_STARTED",
      message: `${prayerLabel(event.prayer)} began — pausing ${eligibleZones.length} zone(s).`,
    })
    mockBus.emit({ type: "PRAYER_STARTED", data: { prayer: event.prayer }, timestamp: new Date().toISOString() })

    for (const zone of eligibleZones) {
      zone.pausedByPrayer = event.prayer
      zone.prePrayerSnapshot = {
        playbackState: zone.playbackState,
        currentPlaylistId: zone.currentPlaylistId,
        currentTrackId: zone.currentTrackId,
      }
      void commandsApi.send({
        serverId: zone.serverId,
        zoneId: zone.id,
        type: "PAUSE",
        issuedBy: "prayer-scheduler",
        source: "SCHEDULE",
        payload: { prayer: event.prayer },
      })
      log("info", "Zone paused for prayer", { zone: zone.name, prayer: event.prayer }, zone.serverId)
    }
  }

  private firePrayerEnd(event: ScheduledEvent) {
    const key = `${this.todayKey}:${event.prayer}:end`
    if (this.fired.has(key)) return
    this.fired.add(key)

    if (!isMockMode) return

    const zonesToRestore = store.zones.filter((z) => z.pausedByPrayer === event.prayer)

    log("info", "Prayer ended", { prayer: event.prayer, zonesRestored: zonesToRestore.length })
    store.pushActivity({
      type: "PRAYER_ENDED",
      message: `${prayerLabel(event.prayer)} ended — resuming ${zonesToRestore.length} zone(s).`,
    })
    mockBus.emit({ type: "PRAYER_ENDED", data: { prayer: event.prayer }, timestamp: new Date().toISOString() })

    for (const zone of zonesToRestore) {
      const snapshot = zone.prePrayerSnapshot
      zone.pausedByPrayer = null
      zone.prePrayerSnapshot = null
      // Only auto-resume what we actually paused for prayer — a zone a
      // manager had already stopped/paused before the prayer started was
      // never touched at PRAYER_START (see firePrayerStart), so it can
      // never end up here with a PLAYING snapshot by accident.
      if (snapshot?.playbackState === "PLAYING") {
        void commandsApi.send({
          serverId: zone.serverId,
          zoneId: zone.id,
          type: "PLAY",
          issuedBy: "prayer-scheduler",
          source: "SCHEDULE",
          payload: { prayer: event.prayer, restore: snapshot },
        })
        log("info", "Zone resumed after prayer", { zone: zone.name, prayer: event.prayer }, zone.serverId)
      }
    }
  }
}

function prayerLabel(prayer: PrayerName): string {
  return prayer.charAt(0) + prayer.slice(1).toLowerCase()
}

function log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>, serverId?: string) {
  // Structured, no sensitive data — mirrors the shape of src/lib/mock logs.
  // eslint-disable-next-line no-console
  console[level === "debug" ? "log" : level](`[prayer-scheduler] ${message}`, data ?? "")
  // Also surface anything above debug in the portal's own Monitoring > Logs
  // view (serverId "cloud" is a sentinel for scheduler-wide events not tied
  // to one server) so admins don't need devtools to see what's happening.
  if (level !== "debug" && isMockMode) {
    store.pushLog({
      serverId: serverId ?? "cloud",
      level: level.toUpperCase() as "INFO" | "WARN" | "ERROR",
      source: "prayer.scheduler",
      message: data ? `${message} (${Object.entries(data).map(([k, v]) => `${k}=${v}`).join(", ")})` : message,
    })
  }
}

const globalForScheduler = globalThis as unknown as { __cmmpPrayerScheduler?: PrayerScheduler }
export const prayerScheduler: PrayerScheduler = globalForScheduler.__cmmpPrayerScheduler ?? new PrayerScheduler()
if (process.env.NODE_ENV !== "production") {
  globalForScheduler.__cmmpPrayerScheduler = prayerScheduler
}
