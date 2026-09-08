import { fetchPrayerTimings } from "./aladhan.js"
import { calendarDateKey, todayInTimeZone, type CalendarDate } from "./timezone-math.js"
import type { PrayerName } from "./constants.js"

/**
 * One day's prayer timings for one point, cached so the portal polling the
 * times endpoint and the scheduler recomputing its timers don't hit AlAdhan
 * once per call. Keyed by date + coordinates + calculation method, so a
 * location or method change misses the cache and refetches immediately.
 *
 * The cache is also what keeps Prayer Mode working through an AlAdhan
 * outage: once a day is fetched, its timers keep firing with no network at
 * all (see lib/prayer-scheduler.ts).
 */

interface CacheEntry {
  timings: Record<PrayerName, string>
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()
/** A handful of venues × a couple of days; bounded so a long-running
 * process can't accumulate entries for every past date. */
const MAX_ENTRIES = 200

export interface TimingsQuery {
  latitude: number
  longitude: number
  timezone: string
}

function keyFor(dateKey: string, location: TimingsQuery, calculationMethodId: number): string {
  return `${dateKey}:${location.latitude.toFixed(4)}:${location.longitude.toFixed(4)}:${calculationMethodId}`
}

function remember(key: string, timings: Record<PrayerName, string>) {
  if (cache.size >= MAX_ENTRIES) {
    // Oldest insertion first — Map preserves insertion order.
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  cache.set(key, { timings, fetchedAt: Date.now() })
}

/**
 * Timings for a specific calendar date at a specific point. Cache-first;
 * on an API failure a cached copy is returned if one exists, otherwise
 * null — never a fabricated schedule.
 */
export async function getTimingsForDate(
  location: TimingsQuery,
  calculationMethodId: number,
  date: CalendarDate
): Promise<Record<PrayerName, string> | null> {
  const key = keyFor(calendarDateKey(date), location, calculationMethodId)
  const cached = cache.get(key)
  if (cached) return cached.timings

  try {
    // Noon UTC on the target date: far enough from either midnight that the
    // date AlAdhan calculates for can't slip a day either way.
    const reference = new Date(Date.UTC(date.year, date.month - 1, date.day, 12))
    const { timings } = await fetchPrayerTimings(location, calculationMethodId, reference)
    remember(key, timings)
    return timings
  } catch {
    return cached ?? null
  }
}

/** Today *at the venue*, not on the cloud host — the whole point of
 * carrying the venue's timezone around. */
export async function getTodayTimings(
  location: TimingsQuery,
  calculationMethodId: number
): Promise<{ date: CalendarDate; timings: Record<PrayerName, string> } | null> {
  const date = todayInTimeZone(location.timezone)
  const timings = await getTimingsForDate(location, calculationMethodId, date)
  return timings ? { date, timings } : null
}
