import { listCountries, listCitiesForCountry } from "@/lib/geo/locations"
import type { GeoLocation } from "@/lib/api/types"

/**
 * Worldwide Country → City → GMT-timezone lookup. Static dataset (no
 * network/mock distinction needed) shared by every picker that needs it —
 * Locations (src/components/locations/*) and Prayer Mode
 * (src/components/prayer/prayer-mode-form.tsx) both call this same module,
 * so "the same GMT-based timezone system" is literally one implementation,
 * not two that could drift apart.
 */
export const geoApi = {
  async listCountries(): Promise<string[]> {
    return listCountries()
  },
  async listCitiesForCountry(country: string): Promise<GeoLocation[]> {
    return listCitiesForCountry(country)
  },
}
