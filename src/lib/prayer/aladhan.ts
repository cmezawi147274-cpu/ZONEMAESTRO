import { ALADHAN_TIMING_KEYS, PRAYER_NAMES, type PrayerName } from "@/lib/constants"
import type { PrayerLocation } from "@/lib/api/types"

/**
 * Thin client for the free AlAdhan Prayer Times API
 * (https://aladhan.com/prayer-times-api). No API key required. Called
 * directly from the browser — the endpoint is CORS-enabled.
 */

export class AladhanApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AladhanApiError"
  }
}

export interface AladhanTimings {
  /** "HH:mm" strings as returned by the API, one per requested prayer. */
  timings: Record<PrayerName, string>
  /** Raw date the API confirmed it calculated for (DD-MM-YYYY). */
  gregorianDate: string
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** AlAdhan expects DD-MM-YYYY. */
export function toAladhanDate(date: Date): string {
  return `${pad2(date.getUTCDate())}-${pad2(date.getUTCMonth() + 1)}-${date.getUTCFullYear()}`
}

/**
 * Fetches one day's prayer timings for a location. Throws AladhanApiError on
 * any network failure, non-200 response, or a payload that doesn't look
 * like valid timings — callers (the scheduler) are expected to fall back to
 * cache on failure rather than let this throw propagate to the UI.
 */
export async function fetchPrayerTimings(
  location: PrayerLocation,
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

  if (!res.ok) {
    throw new AladhanApiError(`AlAdhan API returned HTTP ${res.status}`)
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new AladhanApiError("AlAdhan API returned invalid JSON")
  }

  const timings = extractTimings(body)
  if (!timings) {
    throw new AladhanApiError("AlAdhan API response did not contain valid prayer timings")
  }

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

/** Defensively validates the shape of `data.timings` before trusting it —
 * handles "invalid data" (missing keys, malformed strings, non-200 payloads
 * that still parse as JSON) without throwing deep in the caller. */
function extractTimings(body: unknown): Record<PrayerName, string> | null {
  if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.data.timings)) return null
  const rawTimings = body.data.timings

  const result = {} as Record<PrayerName, string>
  for (const prayer of PRAYER_NAMES) {
    const key = ALADHAN_TIMING_KEYS[prayer]
    const value = rawTimings[key]
    if (typeof value !== "string" || !TIME_PATTERN.test(value)) return null
    // AlAdhan sometimes appends a timezone annotation like "05:12 (+04)" —
    // keep just the HH:mm portion.
    result[prayer] = value.slice(0, 5)
  }
  return result
}
