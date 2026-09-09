import cityTimezones from "city-timezones"
import type { GeoLocation } from "@/lib/api/types"

/**
 * Worldwide country/city/timezone lookup, backed by the `city-timezones`
 * dataset (~7,300 cities) rather than a hand-maintained list, per the
 * "comprehensive worldwide dataset" requirement. Shared by every feature
 * that needs a Country → City picker with an auto-resolved GMT timezone —
 * currently Prayer Mode (src/components/prayer/prayer-mode-form.tsx) and
 * Locations (src/components/locations/*) — so both speak the exact same
 * location data and there is only one place to fix if it's ever wrong.
 *
 * Administrators only ever pick Country → City; latitude, longitude and the
 * IANA timezone id are resolved internally and never shown raw in the UI —
 * only the human `formatTimezoneLabel` output is.
 */

interface CityRecord {
  city: string
  country: string
  province?: string
  lat: number
  lng: number
  timezone: string
  pop?: number
}

const RAW = cityTimezones.cityMapping as CityRecord[]

/** Some source rows are missing a timezone or coordinates — exclude those,
 * they can't produce a valid GeoLocation. */
const VALID = RAW.filter((r) => r.city && r.country && r.timezone && Number.isFinite(r.lat) && Number.isFinite(r.lng))

export function listCountries(): string[] {
  return Array.from(new Set(VALID.map((r) => r.country))).sort((a, b) => a.localeCompare(b))
}

export function listCitiesForCountry(country: string): GeoLocation[] {
  return VALID.filter((r) => r.country === country)
    .sort((a, b) => (b.pop ?? 0) - (a.pop ?? 0) || a.city.localeCompare(b.city))
    .map((r) => ({
      country: r.country,
      city: r.city,
      region: r.province || "",
      latitude: r.lat,
      longitude: r.lng,
      timezone: r.timezone,
    }))
}

/** Resolves the GMT offset for an IANA timezone *right now* (so it
 * automatically reflects daylight saving) as e.g. "GMT+4:00". */
export function formatGmtOffset(timezone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "shortOffset" }).formatToParts(at)
    const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0"
    // Normalize "GMT+4" -> "GMT+4:00", "GMT" -> "GMT+0:00"
    const match = raw.match(/GMT([+-]\d+)(?::(\d+))?/)
    if (!match) return "GMT+0:00"
    const hours = match[1]
    const minutes = match[2] ?? "00"
    return `GMT${hours}:${minutes.padStart(2, "0")}`
  } catch {
    return "GMT+0:00"
  }
}

/** e.g. "Dubai, United Arab Emirates (GMT+4:00)" — the standard way a
 * timezone is shown to an administrator anywhere in the portal. */
export function formatTimezoneLabel(location: Pick<GeoLocation, "city" | "country" | "timezone">): string {
  return `${location.city}, ${location.country} (${formatGmtOffset(location.timezone)})`
}
