import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { nextId } from "@/lib/mock/ids"
import { readPrayerConfig, notifyPrayerConfigListeners } from "@/lib/prayer/config-store"
import { getTenantScope } from "@/lib/auth/session"
import type { GeoLocation, Location } from "@/lib/api/types"

export interface CreateLocationInput {
  organizationId: string
  name: string
  address: string
  city: string
  region: string
  country: string
  timezone: string
  latitude: number | null
  longitude: number | null
}

/** Applies a picked GeoLocation (see CountryCityPicker) onto the
 * city/region/country/timezone/lat/lng fields of a create/update payload —
 * the one conversion point between "the shared picker's shape" and "what a
 * Location record stores". */
export function geoLocationToLocationFields(geo: GeoLocation) {
  return {
    city: geo.city,
    region: geo.region ?? "",
    country: geo.country,
    timezone: geo.timezone,
    latitude: geo.latitude,
    longitude: geo.longitude,
  }
}

export const locationsApi = {
  async list(organizationId?: string): Promise<Location[]> {
    if (isMockMode) {
      await delay()
      store.recomputeCounts()
      // SUPER_ADMIN can filter by any org (or see all); every other role is
      // confined to its own org regardless of what was requested — see
      // getTenantScope(). No org (null) means no data, not the fleet.
      const scope = getTenantScope()
      let items: Location[]
      if (scope.isSuperAdmin) {
        items = organizationId ? store.locations.filter((l) => l.organizationId === organizationId) : store.locations
      } else {
        items = scope.organizationId ? store.locations.filter((l) => l.organizationId === scope.organizationId) : []
      }
      return items.map((l) => ({ ...l })).sort((a, b) => a.name.localeCompare(b.name))
    }
    const qs = organizationId ? `?organizationId=${organizationId}` : ""
    return apiClient.get<Location[]>(`/locations${qs}`)
  },

  async get(id: string): Promise<Location | null> {
    if (isMockMode) {
      await delay(200)
      // A copy, not the live store reference — otherwise a background
      // refetch after update() (which mutates in place) would resolve to
      // an object that's `===` the already-cached one, and TanStack
      // Query's structural sharing would treat that as "no change" and
      // never re-render this query's subscribers (this is exactly what
      // made an edited location's page look like the save silently failed).
      const loc = store.locations.find((l) => l.id === id)
      if (!loc) return null
      // Tenant isolation: a scoped role must not be able to open another
      // org's location by guessing/typing its id in the URL.
      const scope = getTenantScope()
      if (!scope.isSuperAdmin && loc.organizationId !== scope.organizationId) return null
      return { ...loc }
    }
    return apiClient.get<Location>(`/locations/${id}`)
  },

  async create(input: CreateLocationInput): Promise<Location> {
    if (isMockMode) {
      await delay(500)
      const loc: Location = {
        id: nextId("loc"),
        serverCount: 0,
        zoneCount: 0,
        createdAt: new Date().toISOString(),
        ...input,
      }
      store.locations.push(loc)
      store.recomputeCounts()
      return { ...loc }
    }
    return apiClient.post<Location>("/locations", input)
  },

  async update(id: string, input: Partial<CreateLocationInput>): Promise<Location> {
    if (isMockMode) {
      await delay(400)
      const loc = store.locations.find((l) => l.id === id)
      if (!loc) throw new Error("Location not found")
      Object.assign(loc, input)
      // Keep Prayer Mode in sync when it's following this exact location —
      // see src/lib/prayer/config-store.ts `resolveEffectivePrayerConfig`.
      // No copying needed there: that function always re-reads the
      // Location record; this just wakes the running scheduler up to do
      // so now instead of on its next unrelated recalculation.
      if (readPrayerConfig().linkedLocationId === id) {
        notifyPrayerConfigListeners()
      }
      return { ...loc }
    }
    return apiClient.patch<Location>(`/locations/${id}`, input)
  },

  async remove(id: string): Promise<void> {
    if (isMockMode) {
      await delay(400)
      store.locations = store.locations.filter((l) => l.id !== id)
      store.recomputeCounts()
      return
    }
    await apiClient.delete(`/locations/${id}`)
  },
}
