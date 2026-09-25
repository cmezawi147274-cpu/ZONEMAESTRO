import { test, before, after, mock } from "node:test"
import assert from "node:assert/strict"

/**
 * Prayer Mode pauses each zone on its OWN Location's times — the same city
 * lookup and AlAdhan times the zone cards show — never on the
 * organization's PrayerConfig location.
 *
 * No database: every Prisma call the scheduler makes is replaced by an
 * in-memory fake below, and DATABASE_URL points nowhere, so an unstubbed
 * query fails loudly instead of touching real data. AlAdhan is stubbed too.
 */

const P = "zzprayer-"
const ORG = `${P}org`
const OTHER_ORG = `${P}other-org`

type Db = typeof import("../src/lib/db.js")
type Scheduler = typeof import("../src/lib/prayer-scheduler.js")
type Geo = typeof import("../src/lib/geo.js")
let prisma: Db["prisma"]
let scheduler: Scheduler
let geo: Geo

// Real AlAdhan values for 23-09-2026, method 3 — served for any date.
const TIMINGS: Record<string, Record<string, string>> = {
  "25.22999615": { Fajr: "04:52", Dhuhr: "12:11", Asr: "15:38", Maghrib: "18:14", Isha: "19:26" }, // Dubai, UTC+4
  "24.64083315": { Fajr: "04:26", Dhuhr: "11:45", Asr: "15:12", Maghrib: "17:48", Isha: "19:00" }, // Riyadh, UTC+3
}

interface LocationRow { id: string; name: string; city: string; country: string; timezone: string }
interface ZoneRow {
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
}

const serverOrg: Record<string, string> = {
  [`${P}srv-dxb`]: ORG,
  [`${P}srv-ruh`]: ORG,
  [`${P}srv-bad`]: ORG,
  [`${P}srv-other`]: OTHER_ORG,
}
const locations: LocationRow[] = [
  { id: `${P}loc-dxb`, name: "Venue Dubai", city: "Dubai", country: "United Arab Emirates", timezone: "Asia/Dubai" },
  { id: `${P}loc-ruh`, name: "Venue Riyadh", city: "Riyadh", country: "Saudi Arabia", timezone: "Asia/Riyadh" },
  { id: `${P}loc-bad`, name: "Venue bad", city: "Testville", country: "TS", timezone: "UTC" },
  { id: `${P}loc-other`, name: "Other org Dubai", city: "Dubai", country: "United Arab Emirates", timezone: "Asia/Dubai" },
]

let zones: ZoneRow[] = []
let commands: { zoneId: string; type: string; payload: any; source: string; issuedById: string; status: string }[] = []
let activity: { type: string; message: string }[] = []
let fetchUrls: URL[] = []
let warnings: string[] = []

function zone(id: string, server: string, location: string, over: Partial<ZoneRow> = {}): ZoneRow {
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

function resetFixtures() {
  zones = [
    zone("dxb-1", "srv-dxb", "loc-dxb"),
    zone("dxb-2", "srv-dxb", "loc-dxb"),
    zone("dxb-optout", "srv-dxb", "loc-dxb", { prayerModeEnabled: false }),
    zone("dxb-paused", "srv-dxb", "loc-dxb", { playbackState: "PAUSED" }),
    zone("ruh-1", "srv-ruh", "loc-ruh"),
    zone("bad-1", "srv-bad", "loc-bad"),
    zone("other-1", "srv-other", "loc-other"),
  ]
  commands = []
  activity = []
  fetchUrls = []
}

/** Strict matcher: an unexpected filter shape fails the test rather than
 * being silently ignored. */
function matches(row: ZoneRow, where: Record<string, any>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === "server") {
      assert.deepEqual(Object.keys(value), ["organizationId"], "unexpected server filter")
      if (serverOrg[row.serverId] !== value.organizationId) return false
      continue
    }
    assert.ok(key in row, `unexpected zone filter key ${key}`)
    assert.notEqual(typeof value, "object", `unexpected nested filter on ${key}`)
    if ((row as any)[key] !== value) return false
  }
  return true
}

const originals: [any, string, unknown][] = []
function stub(delegate: any, method: string, impl: (...args: any[]) => unknown) {
  originals.push([delegate, method, delegate[method]])
  delegate[method] = impl
}

function prayers(only: string, offsetMinutes = 0, pauseDurationMinutes = 10) {
  const all: Record<string, unknown> = {}
  for (const name of ["FAJR", "DHUHR", "ASR", "MAGHRIB", "ISHA"]) {
    all[name] = { enabled: only === "ALL" || name === only, offsetMinutes, pauseDurationMinutes }
  }
  return all
}

/** Deliberately Durres: the scheduler must ignore the org-level location. */
function config(prayerSettings: Record<string, unknown>) {
  return {
    id: `${P}cfg`,
    organizationId: ORG,
    enabled: true,
    linkedLocationId: null,
    country: "Albania",
    city: "Durres",
    latitude: 41.3177997,
    longitude: 19.44820797,
    timezone: "Europe/Tirane",
    calculationMethodId: 3,
    prayers: prayerSettings,
    updatedAt: new Date(),
  } as any
}

const tick = (cfg: any, iso: string) => scheduler.tickOrganization(cfg, new Date(iso))
const commandsFor = (type: string) => commands.filter((c) => c.type === type).map((c) => c.zoneId.slice(P.length)).sort()
const row = (id: string) => zones.find((z) => z.id === `${P}${id}`)!

before(async () => {
  process.env.DATABASE_URL = "postgresql://no-db:no-db@127.0.0.1:1/no-db"
  process.env.JWT_ACCESS_SECRET ??= "zz-test-access"
  process.env.JWT_REFRESH_SECRET ??= "zz-test-refresh"
  ;({ prisma } = await import("../src/lib/db.js"))
  scheduler = await import("../src/lib/prayer-scheduler.js")
  geo = await import("../src/lib/geo.js")

  stub(prisma.location, "findMany", async ({ where, select }: any) => {
    assert.deepEqual(Object.keys(where), ["zones"])
    const org = where.zones.some.server.organizationId
    const used = new Set(zones.filter((z) => serverOrg[z.serverId] === org).map((z) => z.locationId))
    return locations
      .filter((l) => used.has(l.id))
      .map((l) => Object.fromEntries(Object.keys(select).map((k) => [k, (l as any)[k]])))
  })
  stub(prisma.zone, "findMany", async ({ where }: any) => zones.filter((z) => matches(z, where)).map((z) => ({ ...z })))
  stub(prisma.zone, "count", async ({ where }: any) => zones.filter((z) => matches(z, where)).length)
  stub(prisma.zone, "update", async ({ where, data }: any) => {
    const z = zones.find((r) => r.id === where.id)
    assert.ok(z, `update of unknown zone ${where.id}`)
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in (v as any)) (z as any)[k] += (v as any).increment
      else (z as any)[k] = v
    }
    return { ...z }
  })
  stub(prisma.remoteCommand, "create", async ({ data }: any) => {
    commands.push(data)
    return { id: `${P}cmd-${commands.length}`, ...data }
  })
  stub(prisma.activityEvent, "create", async ({ data }: any) => {
    activity.push({ type: data.type, message: data.message })
    return data
  })

  mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(String(input))
    fetchUrls.push(url)
    const timings = TIMINGS[url.searchParams.get("latitude") ?? ""]
    if (!timings) return new Response("unknown location", { status: 500 })
    const date = url.pathname.split("/").pop()
    return new Response(JSON.stringify({ code: 200, data: { timings, date: { gregorian: { date } } } }), { status: 200 })
  })
  mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  })
})

after(() => {
  for (const [delegate, method, original] of originals.reverse()) delegate[method] = original
  mock.restoreAll()
})

test("the stubs are in place — nothing reaches a database", async () => {
  resetFixtures()
  assert.equal(await prisma.zone.count({ where: { locationId: `${P}loc-dxb` } } as any), 4)
})

test("backend city lookup uses the same timezone-then-population tie-break as the zone cards", () => {
  assert.deepEqual(geo.resolveCityCoordinates("Dubai", "United Arab Emirates", "Asia/Dubai"), {
    latitude: 25.22999615,
    longitude: 55.27997432,
    timezone: "Asia/Dubai",
  })
  assert.deepEqual(geo.resolveCityCoordinates("Portland", "United States of America", "America/New_York"), {
    latitude: 43.67216158,
    longitude: -70.2455274,
    timezone: "America/New_York",
  })
  assert.equal(geo.resolveCityCoordinates("Portland", "United States of America")?.timezone, "America/Los_Angeles")
  assert.equal(geo.resolveCityCoordinates("Testville", "TS", "UTC"), null)
})

test("two cities: each zone pauses and resumes on its own Location's times", async () => {
  resetFixtures()
  const cfg = config(prayers("MAGHRIB"))

  await tick(cfg, "2026-09-23T14:13:59Z")
  assert.equal(commands.length, 0)
  assert.equal(fetchUrls.length, 2, "one AlAdhan call per resolvable Location")
  const params = fetchUrls.map((u) => Object.fromEntries(u.searchParams)).sort((a, b) => a.latitude.localeCompare(b.latitude))
  assert.deepEqual(params, [
    { latitude: "24.64083315", longitude: "46.77274166", method: "3", timezonestring: "Asia/Riyadh" },
    { latitude: "25.22999615", longitude: "55.27997432", method: "3", timezonestring: "Asia/Dubai" },
  ])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /Venue bad.*Testville/)

  await tick(cfg, "2026-09-23T14:14:00Z") // Dubai Maghrib 18:14 +04
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2"])
  for (const c of commands) {
    assert.deepEqual(c.payload, { prayer: "MAGHRIB" })
    assert.equal(c.source, "SCHEDULE")
    assert.equal(c.issuedById, "prayer-scheduler")
    assert.equal(c.status, "PENDING")
  }
  assert.equal(row("dxb-1").pausedByPrayer, "MAGHRIB")
  assert.equal(row("dxb-1").prePrayerPlaybackState, "PLAYING")
  assert.equal(row("dxb-1").prePrayerTrackId, `${P}trk-dxb-1`)
  for (const id of ["dxb-optout", "dxb-paused", "ruh-1", "bad-1", "other-1"]) assert.equal(row(id).pausedByPrayer, null, id)
  assert.deepEqual(activity, [{ type: "PRAYER_STARTED", message: "Maghrib began — pausing 2 zone(s)." }])

  await tick(cfg, "2026-09-23T14:20:00Z")
  assert.equal(commands.length, 2, "nothing new inside the window")

  await tick(cfg, "2026-09-23T14:24:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2"])
  const play = commands.find((c) => c.type === "PLAY" && c.zoneId === `${P}dxb-1`)!
  assert.deepEqual(play.payload, {
    prayer: "MAGHRIB",
    restore: { playbackState: "PLAYING", currentPlaylistId: null, currentTrackId: `${P}trk-dxb-1` },
  })
  assert.equal(row("dxb-1").pausedByPrayer, null)
  assert.equal(row("dxb-1").prePrayerPlaybackState, null)
  assert.equal(row("ruh-1").pausedByPrayer, null)
  assert.deepEqual(activity.at(-1), { type: "PRAYER_ENDED", message: "Maghrib ended — resuming 2 zone(s)." })

  await tick(cfg, "2026-09-23T14:48:00Z") // Riyadh Maghrib 17:48 +03
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2", "ruh-1"], "only Riyadh pauses; Dubai is not paused again")

  await tick(cfg, "2026-09-23T14:58:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2", "ruh-1"])

  await tick(cfg, "2026-09-23T16:38:00Z") // Durres Maghrib — must be ignored
  assert.equal(commands.length, 6)
  assert.equal(fetchUrls.length, 2, "times were fetched once per Location, then cached")
  assert.ok(!fetchUrls.some((u) => u.searchParams.get("latitude") === "41.3177997"), "Durres was never asked for")
  assert.equal(warnings.length, 1, "unknown city warned once, not every tick")
  assert.ok(!commands.some((c) => c.zoneId === `${P}bad-1` || c.zoneId === `${P}other-1`))
})

test("overlapping windows: a Dubai end never resumes a Riyadh zone", async () => {
  resetFixtures()
  const cfg = config(prayers("MAGHRIB", 0, 40))
  await tick(cfg, "2026-09-24T14:14:00Z")
  await tick(cfg, "2026-09-24T14:48:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2", "ruh-1"])

  await tick(cfg, "2026-09-24T14:54:00Z") // Dubai window (40 min) closes
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2"])
  assert.equal(row("ruh-1").pausedByPrayer, "MAGHRIB")

  await tick(cfg, "2026-09-24T15:28:00Z") // Riyadh window closes
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2", "ruh-1"])
})

test("offsets and pause lengths are applied as before", async () => {
  resetFixtures()
  const cfg = config(prayers("MAGHRIB", 3, 5))
  await tick(cfg, "2026-09-25T14:16:59Z")
  assert.equal(commands.length, 0)
  await tick(cfg, "2026-09-25T14:17:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2"])
  await tick(cfg, "2026-09-25T14:21:59Z")
  assert.deepEqual(commandsFor("PLAY"), [])
  await tick(cfg, "2026-09-25T14:22:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2"])
  await tick(cfg, "2026-09-25T14:50:59Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2"])
  await tick(cfg, "2026-09-25T14:51:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2", "ruh-1"])
  await tick(cfg, "2026-09-25T14:56:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2", "ruh-1"])
})

test("deploy day: a zone the old code paused is resumed once, and nothing is replayed", async () => {
  resetFixtures()
  Object.assign(row("dxb-1"), { pausedByPrayer: "ASR", prePrayerPlaybackState: "PLAYING" })
  await tick(config(prayers("ALL")), "2026-09-27T14:05:00Z") // Dubai Asr closed at 11:48Z
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1"])
  assert.deepEqual(commandsFor("PAUSE"), [])
  assert.deepEqual(activity, [{ type: "PRAYER_ENDED", message: "Asr ended — resuming 1 zone(s)." }])
  assert.equal(row("dxb-1").pausedByPrayer, null)
})

test("unknown city: its zones are never paused, but one already paused is not stranded", async () => {
  resetFixtures()
  Object.assign(row("bad-1"), { pausedByPrayer: "MAGHRIB", prePrayerPlaybackState: "PLAYING" })
  await tick(config(prayers("MAGHRIB")), "2026-09-28T06:00:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["bad-1"])
  assert.deepEqual(commandsFor("PAUSE"), [])
  assert.equal(row("bad-1").pausedByPrayer, null)
  assert.deepEqual(activity, [{ type: "PRAYER_ENDED", message: "Maghrib ended — resuming 1 zone(s)." }])
  assert.equal(warnings.length, 1)
})
