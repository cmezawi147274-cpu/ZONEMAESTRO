import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { CALCULATION_METHODS, PRAYER_NAMES } from "@/lib/constants"
import { readEffectivePrayerConfig, writePrayerConfig } from "@/lib/prayer/config-store"
import { cacheKey, getCachedTimings, setCachedTimings } from "@/lib/prayer/cache"
import { fetchPrayerTimings } from "@/lib/prayer/aladhan"
import { calendarDateKey, todayInTimeZone } from "@/lib/prayer/timezone-math"
import type { PrayerConfig, PrayerLocation, PrayerTimesToday, PrayerTimesTodayResponse } from "@/lib/api/types"

export const prayerApi = {
  /** Returns the config with `location` always resolved to whatever's
   * actually used for calculations right now — when `linkedLocationId` is
   * set, that's a fresh read of that Location record (see
   * `resolveEffectivePrayerConfig`), so the UI never shows a stale/empty
   * location just because the raw saved copy predates an edit made on the
   * Locations page. */
  async getConfig(): Promise<PrayerConfig> {
    if (isMockMode) {
      await delay(150)
      return readEffectivePrayerConfig()
    }
    return apiClient.get<PrayerConfig>("/prayer/config")
  },

  /** Persists the config and — in mock mode — immediately notifies the
   * running scheduler (src/lib/prayer/scheduler.ts) via config-store's
   * subscription, so a location/method/prayer-settings change recalculates
   * right away rather than waiting for the next poll (there is no poll). */
  async updateConfig(config: PrayerConfig): Promise<PrayerConfig> {
    if (isMockMode) {
      await delay(300)
      writePrayerConfig(config)
      const saved = readEffectivePrayerConfig()
      const location = saved.linkedLocationId
        ? "synced with an existing location"
        : saved.location
          ? `${saved.location.city}, ${saved.location.country}`
          : null
      store.pushLog({
        serverId: "cloud",
        level: "INFO",
        source: "prayer.config",
        message: config.enabled
          ? `Prayer Mode configuration updated${location ? ` (${location})` : ""}.`
          : "Prayer Mode disabled.",
      })
      return saved
    }
    return apiClient.put<PrayerConfig>("/prayer/config", config)
  },

  listCalculationMethods() {
    return CALCULATION_METHODS
  },

  /** Today's prayer times for display/verification in the settings UI.
   *
   * In a real deployment the cloud owns the calculation and the browser
   * never contacts AlAdhan: GET /prayer/times/today computes against the
   * venue's coordinates and clock, so the times an admin reads here are
   * literally the ones the backend scheduler will pause zones on. The
   * picked location is passed through so an unsaved choice still previews;
   * with none, the backend resolves the venue's own.
   *
   * Mock mode keeps the original in-browser cache + AlAdhan path — there
   * is no backend to ask. */
  async getTodayTimes(
    location: PrayerLocation,
    calculationMethodId: number,
    /** By default a failure is swallowed into `null` and the caller renders
     * a generic "unavailable". Callers that would rather show the reason —
     * the Zones cards — opt into the real network/HTTP error with
     * `rethrow`, so a 403 or an unreachable AlAdhan is legible instead of
     * looking like an empty result. */
    options?: { rethrow?: boolean }
  ): Promise<PrayerTimesTodayResponse | null> {
    if (!isMockMode) {
      const params = new URLSearchParams({
        latitude: String(location.latitude),
        longitude: String(location.longitude),
        timezone: location.timezone,
        method: String(calculationMethodId),
      })
      try {
        return await apiClient.get<PrayerTimesTodayResponse>(`/prayer/times/today?${params.toString()}`)
      } catch (error) {
        // No usable location yet, or AlAdhan unreachable from the cloud —
        // the UI renders this as "times unavailable" rather than guessing.
        if (options?.rethrow) throw error
        return null
      }
    }

    const today = todayInTimeZone(location.timezone)
    const key = cacheKey(calendarDateKey(today), location.latitude, location.longitude, calculationMethodId)

    /** Mock has no venue heartbeat to speak of, so the location is always
     * the portal-picked one — reported honestly rather than faked green. */
    const asResponse = (times: PrayerTimesToday): PrayerTimesTodayResponse => ({
      date: calendarDateKey(today),
      timezone: location.timezone,
      calculationMethodId,
      times,
      location: {
        city: location.city,
        country: location.country,
        latitude: location.latitude,
        longitude: location.longitude,
        source: "config",
      },
      venue: {
        state: "PORTAL",
        timezone: location.timezone,
        city: location.city,
        country: location.country,
        timezoneSource: "config",
        coordinatesSource: "config",
        serverName: null,
      },
    })

    const cached = getCachedTimings(key)
    if (cached) return asResponse(cached)

    try {
      const referenceInstant = new Date(Date.UTC(today.year, today.month - 1, today.day, 12))
      const { timings } = await fetchPrayerTimings(location, calculationMethodId, referenceInstant)
      setCachedTimings(key, timings)
      return asResponse(timings)
    } catch (error) {
      if (options?.rethrow) throw error
      return null
    }
  },

  async setZonePrayerParticipation(zoneId: string, enabled: boolean): Promise<void> {
    if (isMockMode) {
      await delay(150)
      const zone = store.zones.find((z) => z.id === zoneId)
      if (zone) zone.prayerModeEnabled = enabled
      return
    }
    await apiClient.patch(`/zones/${zoneId}`, { prayerModeEnabled: enabled })
  },
}

export const ALL_PRAYER_NAMES = PRAYER_NAMES
