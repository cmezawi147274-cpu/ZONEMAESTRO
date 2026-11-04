import assert from "node:assert/strict"
import { mock } from "node:test"

/**
 * In-memory Prisma + AlAdhan stubs for scratch scheduler tests, with
 * switchable "worlds" so the original and the patched scheduler can be
 * driven side by side against separate zone tables.
 * Pattern copied from backend/test/prayer-scheduler-location.test.ts.
 */

export const P = "zzs-"
export const ORG = `${P}org`

export interface ZoneRow {
  id: string
  serverId: string
  locationId: string
  localZoneId: string
  playbackState: string
  prayerModeEnabled: boolean
  pausedByPrayer: string | null
  prePrayerPlaybackState: string | null
  prePrayerPlaylistId: string | null
  prePrayerTrackId: string | null
  currentPlaylistId: string | null
  currentTrackId: string | null
  commandSequence: number
  leaderZoneId?: string | null
}

export interface World {
  zones: ZoneRow[]
  commands: { zoneId: string; type: string; payload: any; at: string }[]
  activity: { type: string; message: string; serverId: string | null; at: string }[]
  overrides: { serverId: string; prayers: Record<string, unknown> }[]
  overridesError: (Error & { code?: string }) | null
}

export function newWorld(): World {
  return { zones: [], commands: [], activity: [], overrides: [], overridesError: null }
}

export let world: World = newWorld()
export function useWorld(w: World) {
  world = w
}
export let nowIso = ""
export function setNow(iso: string) {
  nowIso = iso
}

export const serverOrg: Record<string, string> = {}
export const serverName: Record<string, string> = {}

export const locations = [
  { id: `${P}loc-dxb`, name: "Dubai", city: "Dubai", country: "United Arab Emirates", timezone: "Asia/Dubai" },
  { id: `${P}loc-ruh`, name: "Riyadh", city: "Riyadh", country: "Saudi Arabia", timezone: "Asia/Riyadh" },
  { id: `${P}loc-lon`, name: "London", city: "London", country: "United Kingdom", timezone: "Europe/London" },
]

/** (latitude string, DD-MM-YYYY) -> timings, or null for "service down". */
export let timingsProvider: (lat: string, date: string) => Record<string, string> | null = () => null
export function setTimings(fn: typeof timingsProvider) {
  timingsProvider = fn
}
export let fetchCount = 0

export function zone(id: string, server: string, location: string, over: Partial<ZoneRow> = {}): ZoneRow {
  serverOrg[`${P}${server}`] ??= ORG
  return {
    id: `${P}${id}`,
    serverId: `${P}${server}`,
    locationId: `${P}${location}`,
    localZoneId: id,
    playbackState: "PLAYING",
    prayerModeEnabled: true,
    pausedByPrayer: null,
    prePrayerPlaybackState: null,
    prePrayerPlaylistId: null,
    prePrayerTrackId: null,
    currentPlaylistId: null,
    currentTrackId: `${P}trk-${id}`,
    commandSequence: 0,
    ...over,
  }
}

function matches(row: ZoneRow, where: Record<string, any>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === "server") {
      assert.deepEqual(Object.keys(value), ["organizationId"], "unexpected server filter")
      if (serverOrg[row.serverId] !== value.organizationId) return false
      continue
    }
    if (key === "serverId" && value && typeof value === "object") {
      const [op, ...rest] = Object.keys(value)
      assert.ok(rest.length === 0 && (op === "in" || op === "notIn"), "unexpected serverId filter")
      if (value[op].includes(row.serverId) !== (op === "in")) return false
      continue
    }
    if (key === "OR") {
      if (!value.some((w: Record<string, any>) => matches(row, w))) return false
      continue
    }
    if (key === "leaderZone") {
      assert.deepEqual(Object.keys(value), ["is"], "unexpected leaderZone filter")
      const leader = world.zones.find((z) => z.id === row.leaderZoneId)
      if (!leader || !matches(leader, value.is)) return false
      continue
    }
    assert.ok(key in row, `unexpected zone filter key ${key}`)
    assert.ok(value === null || typeof value !== "object", `unexpected nested filter on ${key}`)
    if ((row as any)[key] !== value) return false
  }
  return true
}

export let prisma: any
const originals: [any, string, unknown][] = []
function stub(delegate: any, method: string, impl: (...args: any[]) => unknown) {
  originals.push([delegate, method, delegate[method]])
  delegate[method] = impl
}

export async function install() {
  process.env.DATABASE_URL = "postgresql://no-db:no-db@127.0.0.1:1/no-db"
  process.env.JWT_ACCESS_SECRET ??= "zz-test-access"
  process.env.JWT_REFRESH_SECRET ??= "zz-test-refresh"
  ;({ prisma } = await import("../src/lib/db.js"))

  stub(prisma.location, "findMany", async ({ where, select }: any) => {
    const org = where.zones.some.server.organizationId
    const used = new Set(world.zones.filter((z) => serverOrg[z.serverId] === org).map((z) => z.locationId))
    return locations.filter((l) => used.has(l.id)).map((l) => Object.fromEntries(Object.keys(select).map((k) => [k, (l as any)[k]])))
  })
  stub(prisma.zone, "findMany", async ({ where }: any) => world.zones.filter((z) => matches(z, where)).map((z) => ({ ...z })))
  stub(prisma.zone, "count", async ({ where }: any) => world.zones.filter((z) => matches(z, where)).length)
  stub(prisma.zone, "update", async ({ where, data }: any) => {
    const z = world.zones.find((r) => r.id === where.id)
    assert.ok(z, `update of unknown zone ${where.id}`)
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in (v as any)) (z as any)[k] += (v as any).increment
      else (z as any)[k] = v
    }
    return { ...z }
  })
  stub(prisma.remoteCommand, "create", async ({ data }: any) => {
    world.commands.push({ zoneId: data.zoneId, type: data.type, payload: data.payload, at: nowIso })
    return { id: `${P}cmd-${world.commands.length}`, ...data }
  })
  stub(prisma.activityEvent, "create", async ({ data }: any) => {
    world.activity.push({ type: data.type, message: data.message, serverId: data.serverId, at: nowIso })
    return data
  })
  stub(prisma.serverPrayerOverride, "findMany", async ({ where }: any) => {
    if (world.overridesError) throw world.overridesError
    return world.overrides
      .filter((o) => serverOrg[o.serverId] === where.server.organizationId)
      .map((o) => ({ serverId: o.serverId, prayers: structuredClone(o.prayers), server: { name: serverName[o.serverId] ?? o.serverId } }))
  })

  mock.method(globalThis, "fetch", async (input: string | URL) => {
    fetchCount++
    const url = new URL(String(input))
    const date = url.pathname.split("/").pop()!
    const timings = timingsProvider(url.searchParams.get("latitude") ?? "", date)
    if (!timings) return new Response("down", { status: 503 })
    return new Response(JSON.stringify({ code: 200, data: { timings, date: { gregorian: { date } } } }), { status: 200 })
  })
  mock.method(console, "warn", () => {})
}

export function uninstall() {
  for (const [delegate, method, original] of originals.reverse()) delegate[method] = original
  mock.restoreAll()
}

/** Fresh scheduler module instance, as after a backend restart. */
let generation = 0
export async function freshNew() {
  return import(`../src/lib/prayer-scheduler.js?gen=${++generation}`)
}

/** Evicts every cached day from lib/prayer-times.ts (200-entry LRU-by-insertion),
 * as a restart would. */
export async function flushTimingsCache() {
  const { getTimingsForDate } = await import("../src/lib/prayer-times.js")
  const save = timingsProvider
  timingsProvider = () => ({ Fajr: "01:00", Dhuhr: "02:00", Asr: "03:00", Maghrib: "04:00", Isha: "05:00" })
  for (let i = 0; i < 205; i++) await getTimingsForDate({ latitude: -80 + i * 0.01, longitude: 0, timezone: "UTC" }, 99, { year: 1990, month: 1, day: 1 })
  timingsProvider = save
}

export function prayers(only: string | string[], offsetMinutes = 0, pauseDurationMinutes = 10) {
  const list = Array.isArray(only) ? only : [only]
  const all: Record<string, unknown> = {}
  for (const name of ["FAJR", "DHUHR", "ASR", "MAGHRIB", "ISHA"]) {
    all[name] = { enabled: list.includes("ALL") || list.includes(name), offsetMinutes, pauseDurationMinutes }
  }
  return all
}

export function config(prayerSettings: Record<string, unknown>, methodId = 3) {
  return {
    id: `${P}cfg`,
    organizationId: ORG,
    enabled: true,
    linkedLocationId: null,
    country: null,
    city: null,
    latitude: null,
    longitude: null,
    timezone: null,
    calculationMethodId: methodId,
    prayers: prayerSettings,
    updatedAt: new Date(),
  } as any
}

export const ids = (list: { zoneId: string }[]) => list.map((c) => c.zoneId.slice(P.length)).sort()
export const cmds = (w: World, type: string) => ids(w.commands.filter((c) => c.type === type))
export const row = (w: World, id: string) => w.zones.find((z) => z.id === `${P}${id}`)!
