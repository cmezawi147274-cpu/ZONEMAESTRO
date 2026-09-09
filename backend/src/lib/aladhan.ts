import { PRAYER_NAMES, type PrayerName } from "./constants.js"

/**
 * Server-side port of src/lib/prayer/aladhan.ts — a thin client for the
 * free AlAdhan Prayer Times API (https://aladhan.com/prayer-times-api), no
 * API key required.
 *
 * Prayer calculation belongs to the cloud, not the browser: the portal
 * calls GET /prayer/times/today (routes/prayer.ts) and the backend
 * scheduler (lib/prayer-scheduler.ts) uses this same helper, so what an
 * admin sees and what actually pauses a zone can never disagree.
 */

/** Maps our prayer keys to the field names AlAdhan returns in
 * `data.timings`. Sunrise/Sunset/Imsak/Midnight are deliberately ignored. */
const ALADHAN_TIMING_KEYS: Record<PrayerName, string> = {
  FAJR: "Fajr",
  DHUHR: "Dhuhr",
  ASR: "Asr",
  MAGHRIB: "Maghrib",
  ISHA: "Isha",
}

export class AladhanApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AladhanApiError"
  }
}

export interface AladhanTimings {
  /** "HH:mm" strings, one per prayer, already in the requested timezone. */
  timings: Record<PrayerName, string>
  /** The date AlAdhan confirmed it calculated for (DD-MM-YYYY). */
  gregorianDate: string
}

export interface AladhanQueryLocation {
  latitude: number
  longitude: number
  timezone: string
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** AlAdhan expects DD-MM-YYYY. */
export function toAladhanDate(date: Date): string {
  return `${pad2(date.getUTCDate())}-${pad2(date.getUTCMonth() + 1)}-${date.getUTCFullYear()}`
}

/**
 * Fetches one day's timings. Throws AladhanApiError on any network
 * failure, non-200, or a payload that doesn't look like valid timings —
 * callers are expected to fall back to cache rather than let this escape.
 */
export async function fetchPrayerTimings(
  location: AladhanQueryLocation,
  calculationMethodId: number,
  date: Date
): Promise<AladhanTimings> {
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    method: String(calculationMethodId),
    timezonestring: location.timezone,
  })
  const url = `https://api.aladhan.com/v1/timings/${toAladhanDate(date)}?${params.toString()}`

  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    throw new AladhanApiError(`Network error contacting AlAdhan API: ${(err as Error).message}`)
  }

  if (!res.ok) throw new AladhanApiError(`AlAdhan API returned HTTP ${res.status}`)

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new AladhanApiError("AlAdhan API returned invalid JSON")
  }

  const timings = extractTimings(body)
  if (!timings) throw new AladhanApiError("AlAdhan API response did not contain valid prayer timings")

  const gregorianDate =
    isRecord(body) && isRecord(body.data) && isRecord(body.data.date) && isRecord(body.data.date.gregorian)
      ? String(body.data.date.gregorian.date ?? toAladhanDate(date))
      : toAladhanDate(date)

  return { timings, gregorianDate }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

const TIME_PATTERN = /^\d{2}:\d{2}/

/** Defensively validates `data.timings` before trusting it — missing keys,
 * malformed strings and non-200 payloads that still parse as JSON all end
 * up here rather than deep in the scheduler. */
function extractTimings(body: unknown): Record<PrayerName, string> | null {
  if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.timings)) return null
  const rawTimings = body.data.timings

  const result = {} as Record<PrayerName, string>
  for (const prayer of PRAYER_NAMES) {
    const value = rawTimings[ALADHAN_TIMING_KEYS[prayer]]
    if (typeof value !== "string" || !TIME_PATTERN.test(value)) return null
    // AlAdhan sometimes appends a timezone annotation like "05:12 (+04)".
    result[prayer] = value.slice(0, 5)
  }
  return result
}
