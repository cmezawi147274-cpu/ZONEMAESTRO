/**
 * Server-side port of src/lib/prayer/timezone-math.ts — identical logic,
 * shared by GET /prayer/times/today and the backend prayer scheduler.
 *
 * Small set of timezone-aware date helpers used by the prayer scheduler.
 * Everything here is computed via `Intl.DateTimeFormat`, so DST rules are
 * always current — there's no fixed-offset table to go stale.
 */

export interface CalendarDate {
  year: number
  month: number // 1-12
  day: number
}

/**
 * Server-side port of src/lib/prayer/timezone-math.ts — identical logic,
 * shared by GET /prayer/times/today and the backend prayer scheduler.
 * Today's calendar date *as observed in `timeZone`* — deliberately not the
 * browser's local date, since an admin's browser and the configured
 * location can be in different days at the same instant. */
export function todayInTimeZone(timeZone: string, at: Date = new Date()): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return { year: get("year"), month: get("month"), day: get("day") }
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day))
  d.setUTCDate(d.getUTCDate() + days)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

export function calendarDateKey(date: CalendarDate): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`
}

/**
 * Server-side port of src/lib/prayer/timezone-math.ts — identical logic,
 * shared by GET /prayer/times/today and the backend prayer scheduler.
 *
 * Converts a wall-clock "HH:mm" on a given calendar date, interpreted in
 * `timeZone`, to the correct UTC instant — correctly handling that zone's
 * current DST rules for that specific date (the standard "double
 * formatting" technique: guess as UTC, see how that instant reads back in
 * the target zone, then correct by the difference).
 */
export function zonedTimeToUtc(date: CalendarDate, timeHHmm: string, timeZone: string): Date {
  const [hourStr, minuteStr] = timeHHmm.split(":")
  const hour = Number(hourStr)
  const minute = Number(minuteStr)

  const guessUtcMs = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0)

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(guessUtcMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)

  const readBackHour = get("hour") % 24 // Intl can format midnight as "24"
  const readBackAsUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), readBackHour, get("minute"), get("second"))

  const driftMs = guessUtcMs - readBackAsUtcMs
  return new Date(guessUtcMs + driftMs)
}

export function isValidHHmm(value: unknown): value is string {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value)
}
