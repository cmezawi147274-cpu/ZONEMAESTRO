import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { CALCULATION_METHODS, PRAYER_NAMES } from "@/lib/constants"
import { readEffectivePrayerConfig, writePrayerConfig } from "@/lib/prayer/config-store"
import { cacheKey, getCachedTimings, setCachedTimings } from "@/lib/prayer/cache"
import { fetchPrayerTimings } from "@/lib/prayer/aladhan"
import { calendarDateKey, todayInTimeZone } from "@/lib/prayer/timezone-math"
import type { PrayerConfig, PrayerLocation, PrayerTimesToday } from "@/lib/api/types"

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

  /** Today's prayer times for display/verification in the settings UI —
   * cache-first, falling back to a live AlAdhan fetch, exactly like the
   * scheduler itself, so what the admin sees here always matches what will
   * actually trigger pauses. */
  async getTodayTimes(location: PrayerLocation, calculationMethodId: number): Promise<PrayerTimesToday | null> {
    const today = todayInTimeZone(location.timezone)
    const key = cacheKey(calendarDateKey(today), location.latitude, location.longitude, calculationMethodId)

    const cached = getCachedTimings(key)
    if (cached) return cached

    try {
      const referenceInstant = new Date(Date.UTC(today.year, today.month - 1, today.day, 12))
      const { timings } = await fetchPrayerTimings(location, calculationMethodId, referenceInstant)
      setCachedTimings(key, timings)
      return timings
    } catch {
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
