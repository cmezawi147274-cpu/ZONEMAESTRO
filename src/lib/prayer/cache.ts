"use client"

import type { PrayerName } from "@/lib/constants"
import { PRAYER_NAMES } from "@/lib/constants"
import { isValidHHmm } from "@/lib/prayer/timezone-math"

/**
 * Local cache of raw AlAdhan timings, keyed by (location + calculation
 * method + calendar date) so the scheduler can keep working — fully
 * offline — from the last successful fetch, and so a location/method change
 * or a new day doesn't reuse stale data by accident.
 */

const STORAGE_KEY = "cmmp.prayer.cache.v1"
const MAX_ENTRIES = 14 // ~2 weeks of history is plenty; keeps storage bounded

interface CacheEntry {
  key: string
  fetchedAt: string
  timings: Record<PrayerName, string>
}

interface CacheShape {
  version: 1
  entries: CacheEntry[]
}

function isValidEntry(value: unknown): value is CacheEntry {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.key !== "string" || typeof entry.fetchedAt !== "string") return false
  if (typeof entry.timings !== "object" || entry.timings === null) return false
  const timings = entry.timings as Record<string, unknown>
  return PRAYER_NAMES.every((p) => isValidHHmm(timings[p]))
}

function readAll(): CacheEntry[] {
  if (typeof window === "undefined") return []
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object")
    const shape = parsed as Partial<CacheShape>
    if (shape.version !== 1 || !Array.isArray(shape.entries)) throw new Error("unexpected shape")
    const valid = shape.entries.filter(isValidEntry)
    if (valid.length !== shape.entries.length) {
      // Partial corruption — keep what's valid rather than discarding
      // everything, but persist the cleaned-up version immediately.
      writeAll(valid)
    }
    return valid
  } catch {
    // Corrupted cache: drop it entirely rather than let a bad JSON blob
    // wedge the scheduler forever.
    window.localStorage.removeItem(STORAGE_KEY)
    return []
  }
}

function writeAll(entries: CacheEntry[]) {
  if (typeof window === "undefined") return
  const trimmed = entries.slice(-MAX_ENTRIES)
  const shape: CacheShape = { version: 1, entries: trimmed }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shape))
  } catch {
    // Storage full/unavailable (private browsing, quota) — cache becomes
    // best-effort in-memory only for this session; never throw.
  }
}

export function cacheKey(dateKey: string, latitude: number, longitude: number, methodId: number): string {
  return `${dateKey}|${latitude.toFixed(3)},${longitude.toFixed(3)}|m${methodId}`
}

export function getCachedTimings(key: string): Record<PrayerName, string> | null {
  return readAll().find((e) => e.key === key)?.timings ?? null
}

export function setCachedTimings(key: string, timings: Record<PrayerName, string>) {
  const entries = readAll().filter((e) => e.key !== key)
  entries.push({ key, fetchedAt: new Date().toISOString(), timings })
  writeAll(entries)
}

/** Most recent cache entry regardless of key — last resort when even the
 * exact (date, location, method) combination was never fetched, e.g. the
 * admin changed location while offline. Better to show slightly-wrong
 * cached times than nothing. */
export function getMostRecentTimings(): { timings: Record<PrayerName, string>; fetchedAt: string } | null {
  const entries = readAll()
  if (entries.length === 0) return null
  const latest = entries.reduce((a, b) => (a.fetchedAt > b.fetchedAt ? a : b))
  return { timings: latest.timings, fetchedAt: latest.fetchedAt }
}
