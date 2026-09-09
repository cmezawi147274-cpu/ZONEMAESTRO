import cityTimezones from "city-timezones"

/**
 * Backend half of src/lib/geo/locations.ts — the exact same
 * `city-timezones` dataset the portal's Country → City picker resolves
 * coordinates and IANA timezones from, so a Location saved through that
 * picker resolves to the same point here.
 *
 * This is deliberately a lookup in the dataset the UI already uses, not a
 * geocoder: prayer times must never be computed against invented
 * coordinates, and 0,0 is never a valid answer — an unresolvable city
 * yields null and the caller reports that it cannot compute times.
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

const VALID: CityRecord[] = (cityTimezones.cityMapping as CityRecord[]).filter(
  (r) => r.city && r.country && r.timezone && Number.isFinite(r.lat) && Number.isFinite(r.lng)
)

export interface ResolvedCoordinates {
  latitude: number
  longitude: number
  timezone: string
}

const normalize = (value: string) => value.trim().toLowerCase()

/**
 * Resolves a (city, country) pair to real coordinates plus its IANA
 * timezone. When several rows share a city name, the most populous wins —
 * the same tie-break the picker's city list is ordered by. Returns null
 * when the dataset has no such city, never a fallback point.
 */
export function resolveCityCoordinates(city: string | null, country: string | null): ResolvedCoordinates | null {
  if (!city || !country) return null
  const wantedCity = normalize(city)
  const wantedCountry = normalize(country)

  const matches = VALID.filter((r) => normalize(r.city) === wantedCity && normalize(r.country) === wantedCountry)
  if (matches.length === 0) return null

  const best = matches.reduce((a, b) => ((b.pop ?? 0) > (a.pop ?? 0) ? b : a))
  return { latitude: best.lat, longitude: best.lng, timezone: best.timezone }
}

/** True for a timezone string Intl actually recognizes — guards against a
 * malformed value from an agent heartbeat reaching the date math. */
export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone })
    return true
  } catch {
    return false
  }
}
