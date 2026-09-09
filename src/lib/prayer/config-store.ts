"use client"

import { PRAYER_NAMES, type PrayerName } from "@/lib/constants"
import { store } from "@/lib/mock/store"
import type { PrayerConfig, PrayerSettings, GeoLocation } from "@/lib/api/types"

/**
 * Persisted Prayer Mode configuration. Deliberately backed by localStorage
 * (unlike the rest of mock data, which intentionally resets every reload —
 * see src/lib/mock/store.ts) because "survive server restarts" is an
 * explicit Prayer Mode requirement: this is the one piece of state that
 * really does need to outlive a page reload / dev-server restart to behave
 * like it would on a real always-on MusicServer.
 */

const STORAGE_KEY = "cmmp.prayer.config.v1"

const DEFAULT_PRAYER_SETTINGS: PrayerSettings = {
  enabled: true,
  offsetMinutes: 0,
  pauseDurationMinutes: 30,
}

export function defaultPrayerConfig(): PrayerConfig {
  return {
    enabled: false,
    location: null,
    linkedLocationId: null,
    calculationMethodId: 3, // Muslim World League
    prayers: Object.fromEntries(PRAYER_NAMES.map((p) => [p, { ...DEFAULT_PRAYER_SETTINGS }])) as Record<
      PrayerName,
      PrayerSettings
    >,
    updatedAt: new Date().toISOString(),
  }
}

function isValidConfig(value: unknown): value is PrayerConfig {
  if (typeof value !== "object" || value === null) return false
  const config = value as Record<string, unknown>
  if (typeof config.enabled !== "boolean") return false
  if (typeof config.calculationMethodId !== "number") return false
  if (config.linkedLocationId !== null && config.linkedLocationId !== undefined && typeof config.linkedLocationId !== "string")
    return false
  if (typeof config.prayers !== "object" || config.prayers === null) return false
  const prayers = config.prayers as Record<string, unknown>
  return PRAYER_NAMES.every((p) => {
    const setting = prayers[p] as Record<string, unknown> | undefined
    return (
      setting &&
      typeof setting.enabled === "boolean" &&
      typeof setting.offsetMinutes === "number" &&
      typeof setting.pauseDurationMinutes === "number"
    )
  })
}

export function readPrayerConfig(): PrayerConfig {
  if (typeof window === "undefined") return defaultPrayerConfig()
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return defaultPrayerConfig()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isValidConfig(parsed)) throw new Error("invalid shape")
    // Normalize configs saved before `linkedLocationId` existed.
    return { ...parsed, linkedLocationId: parsed.linkedLocationId ?? null }
  } catch {
    // Corrupted config — fail safe to defaults (Prayer Mode off) rather
    // than crash the app or the scheduler.
    window.localStorage.removeItem(STORAGE_KEY)
    return defaultPrayerConfig()
  }
}

/** Builds the GeoLocation Prayer Mode needs from a Location record. Returns
 * null if that location hasn't been given coordinates yet (e.g. created
 * before the shared Country/City picker existed and never re-saved). */
function geoLocationFromLocation(locationId: string): GeoLocation | null {
  const loc = store.locations.find((l) => l.id === locationId)
  if (!loc || loc.latitude == null || loc.longitude == null) return null
  return { country: loc.country, city: loc.city, region: loc.region, latitude: loc.latitude, longitude: loc.longitude, timezone: loc.timezone }
}

/**
 * Resolves the config actually used for calculations: when
 * `linkedLocationId` is set, `location` is always overwritten with a fresh
 * read of that Location record — this (not any copy/paste sync step) is
 * what keeps Prayer Mode and Locations "synchronized": editing the Location
 * changes what this function returns on the very next read, with no extra
 * plumbing required. Falls back to the last-saved `location` snapshot if
 * the linked Location was deleted or still lacks coordinates.
 */
export function resolveEffectivePrayerConfig(config: PrayerConfig): PrayerConfig {
  if (!config.linkedLocationId) return config
  const resolved = geoLocationFromLocation(config.linkedLocationId)
  return resolved ? { ...config, location: resolved } : config
}

export function readEffectivePrayerConfig(): PrayerConfig {
  return resolveEffectivePrayerConfig(readPrayerConfig())
}

type Listener = (config: PrayerConfig) => void
const listeners = new Set<Listener>()

export function writePrayerConfig(config: PrayerConfig) {
  const next: PrayerConfig = { ...config, updatedAt: new Date().toISOString() }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* storage unavailable — config still applies for this session via listeners */
    }
  }
  const effective = resolveEffectivePrayerConfig(next)
  listeners.forEach((fn) => fn(effective))
}

/** Notifies subscribers (the scheduler) whenever the config changes, so it
 * can recalculate immediately — location, timezone, method, and per-prayer
 * settings changes all flow through here. Also called by
 * src/lib/api/locations.ts after updating a Location that Prayer Mode is
 * linked to, so an edit there reaches the scheduler right away too. */
export function subscribePrayerConfig(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Re-notifies subscribers with the current (re-resolved) effective config
 * without changing anything in storage — used when a linked Location was
 * edited elsewhere, so the scheduler recalculates against the new
 * coordinates/timezone immediately instead of waiting for its own change. */
export function notifyPrayerConfigListeners() {
  listeners.forEach((fn) => fn(readEffectivePrayerConfig()))
}
