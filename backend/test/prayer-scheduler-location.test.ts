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
const FRESH_ORG = `${P}fresh-org`

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
  leaderZoneId?: string | null
}

const serverOrg: Record<string, string> = {
  [`${P}srv-dxb`]: ORG,
  [`${P}srv-ruh`]: ORG,
  [`${P}srv-bad`]: ORG,
  [`${P}srv-other`]: OTHER_ORG,
  [`${P}srv-two`]: ORG,
  [`${P}srv-fresh`]: FRESH_ORG,
}
const serverName: Record<string, string> = { [`${P}srv-two`]: "Venue Two", [`${P}srv-ruh`]: "Venue Riyadh" }
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
/** ServerPrayerOverride rows: servers with their own prayer settings. */
let overrides: { serverId: string; prayers: Record<string, unknown> }[] = []
let activityServers: (string | null)[] = []
/** AlAdhan dates (DD-MM-YYYY) the stub refuses, as if the service were down. */
let aladhanDown = new Set<string>()
/** Agent versions the servers report (MusicServer.version). */
let serverVersion: Record<string, string> = {}

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
  overrides = []
  activityServers = []
  serverVersion = {}
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
    if (key === "serverId" && typeof value === "object") {
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
      const leader = zones.find((z) => z.id === row.leaderZoneId)
      if (!leader || !matches(leader, value.is)) return false
      continue
    }
    assert.ok(key in row, `unexpected zone filter key ${key}`)
    assert.ok(value === null || typeof value !== "object", `unexpected nested filter on ${key}`)
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

async function overridesFindMany({ where }: any) {
  assert.deepEqual(Object.keys(where.server), ["organizationId"], "unexpected override filter")
  return overrides
    .filter((o) => serverOrg[o.serverId] === where.server.organizationId)
    .map((o) => ({ serverId: o.serverId, prayers: structuredClone(o.prayers), server: { name: serverName[o.serverId] } }))
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
  stub(prisma.zone, "findMany", async ({ where, include }: any) => {
    if (include) assert.deepEqual(include, { server: { select: { version: true } } }, "unexpected zone include")
    return zones.filter((z) => matches(z, where)).map((z) => ({ ...z, ...(include ? { server: { version: serverVersion[z.serverId] ?? null } } : {}) }))
  })
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
    activityServers.push(data.serverId)
    return data
  })
  stub(prisma.serverPrayerOverride, "findMany", overridesFindMany)

  mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(String(input))
    fetchUrls.push(url)
    const timings = TIMINGS[url.searchParams.get("latitude") ?? ""]
    if (!timings) return new Response("unknown location", { status: 500 })
    const date = url.pathname.split("/").pop()
    if (aladhanDown.has(date!)) return new Response("down", { status: 503 })
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

// ---------------------------------------------------------------------------
// A Music Server's own prayer settings (ServerPrayerOverride)
// ---------------------------------------------------------------------------

/** Dubai gets a second server, "Venue Two", with two zones of its own. */
function withVenueTwo() {
  resetFixtures()
  zones.push(zone("two-1", "srv-two", "loc-dxb"), zone("two-2", "srv-two", "loc-dxb"))
}
const own = (prayerSettings: Record<string, unknown>) => {
  overrides = [{ serverId: `${P}srv-two`, prayers: prayerSettings }]
}

test("a server with its own settings pauses on its own times; every other zone is unchanged", async () => {
  withVenueTwo()
  own(prayers("MAGHRIB", 5, 20)) // Dubai Maghrib 18:14 +04 → 14:19Z–14:39Z
  const cfg = config(prayers("MAGHRIB")) // organization: 14:14Z–14:24Z

  await tick(cfg, "2026-09-29T14:14:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2"])
  assert.deepEqual(activity, [{ type: "PRAYER_STARTED", message: "Maghrib began — pausing 2 zone(s)." }])
  assert.deepEqual(activityServers, [null], "the organization's events carry no server, as before")

  await tick(cfg, "2026-09-29T14:18:59Z")
  assert.equal(commands.length, 2)

  await tick(cfg, "2026-09-29T14:19:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2", "two-1", "two-2"])
  assert.deepEqual(activity.at(-1), { type: "PRAYER_STARTED", message: "Maghrib began on Venue Two — pausing 2 zone(s)." })
  assert.equal(activityServers.at(-1), `${P}srv-two`)
  assert.equal(row("two-1").pausedByPrayer, "MAGHRIB")

  await tick(cfg, "2026-09-29T14:24:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2"], "the organization's end never resumes Venue Two")
  assert.equal(row("two-1").pausedByPrayer, "MAGHRIB")

  await tick(cfg, "2026-09-29T14:38:59Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2"])

  await tick(cfg, "2026-09-29T14:39:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2", "two-1", "two-2"])
  assert.deepEqual(activity.at(-1), { type: "PRAYER_ENDED", message: "Maghrib ended on Venue Two — resuming 2 zone(s)." })
  assert.equal(row("two-1").pausedByPrayer, null)

  await tick(cfg, "2026-09-29T14:48:00Z") // Riyadh, organization settings
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2", "ruh-1", "two-1", "two-2"])
  await tick(cfg, "2026-09-29T15:30:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2", "ruh-1", "two-1", "two-2"])
  assert.equal(commands.length, 10, "nothing paused twice, nothing resumed twice")
  assert.ok(!commands.some((c) => c.zoneId === `${P}other-1` || c.zoneId === `${P}dxb-optout` || c.zoneId === `${P}dxb-paused`))
})

test("a server's own settings can switch a prayer off for that server only", async () => {
  withVenueTwo()
  own(prayers("ASR"))
  await tick(config(prayers("MAGHRIB")), "2026-09-30T14:14:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2"])
})

test("back to the organization's settings mid-pause, after the organization's window: resumed at once", async () => {
  withVenueTwo()
  own(prayers("MAGHRIB", 5, 20))
  const cfg = config(prayers("MAGHRIB"))
  await tick(cfg, "2026-10-01T14:25:00Z") // organization window already closed, Venue Two's open
  assert.deepEqual(commandsFor("PAUSE"), ["two-1", "two-2"])

  overrides = []
  await tick(cfg, "2026-10-01T14:26:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["two-1", "two-2"])
  assert.deepEqual(activity.at(-1), { type: "PRAYER_ENDED", message: "Maghrib ended — resuming 2 zone(s)." })
  assert.equal(row("two-1").pausedByPrayer, null)

  await tick(cfg, "2026-10-01T14:40:00Z")
  assert.equal(commands.length, 4, "resumed once")
})

test("own settings saved mid-pause with a later window: resumed now, paused again at its own start", async () => {
  withVenueTwo()
  const cfg = config(prayers("MAGHRIB"))
  await tick(cfg, "2026-10-02T14:14:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2", "two-1", "two-2"])

  own(prayers("MAGHRIB", 30, 10)) // 14:44Z–14:54Z
  await tick(cfg, "2026-10-02T14:15:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["two-1", "two-2"])
  assert.deepEqual(activity.at(-1), { type: "PRAYER_ENDED", message: "Maghrib ended on Venue Two — resuming 2 zone(s)." })

  await tick(cfg, "2026-10-02T14:24:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2", "two-1", "two-2"])

  await tick(cfg, "2026-10-02T14:44:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2", "two-1", "two-1", "two-2", "two-2"])
  await tick(cfg, "2026-10-02T14:54:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2", "two-1", "two-1", "two-2", "two-2"])
  assert.equal(row("two-2").pausedByPrayer, null)
})

test("own settings, reset, then own settings again inside one window: never paused twice", async () => {
  withVenueTwo()
  const cfg = config(prayers("MAGHRIB"))
  own(prayers("MAGHRIB", 5, 20))
  await tick(cfg, "2026-10-03T14:19:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2", "two-1", "two-2"])

  overrides = []
  await tick(cfg, "2026-10-03T14:20:00Z") // inside the organization's window: stays paused
  assert.deepEqual(commandsFor("PLAY"), [])
  await tick(cfg, "2026-10-03T14:24:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2", "two-1", "two-2"])

  own(prayers("MAGHRIB", 5, 20))
  await tick(cfg, "2026-10-03T14:25:00Z")
  await tick(cfg, "2026-10-03T14:39:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2", "two-1", "two-2"])
  assert.equal(commandsFor("PLAY").length, 4)
  for (const z of zones) assert.equal(z.pausedByPrayer, null, z.id)
})

test("a prayer switched off during its pause resumes its zones — organization and server alike", async () => {
  withVenueTwo()
  own(prayers("MAGHRIB", 0, 20))
  await tick(config(prayers("MAGHRIB")), "2026-10-04T14:14:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2", "two-1", "two-2"])

  await tick(config(prayers("ASR")), "2026-10-04T14:15:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2"])
  assert.equal(row("two-1").pausedByPrayer, "MAGHRIB", "Venue Two follows its own settings")

  own(prayers("ASR"))
  await tick(config(prayers("ASR")), "2026-10-04T14:16:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2", "two-1", "two-2"])
  for (const z of zones) assert.equal(z.pausedByPrayer, null, z.id)
})

test("a pause running past the venue's midnight ends on time the next day", async () => {
  resetFixtures()
  const cfg = config(prayers("ISHA", 270, 10)) // Dubai Isha 19:26 +04 → 23:56–00:06 local
  await tick(cfg, "2026-10-05T19:56:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2"])
  await tick(cfg, "2026-10-05T20:00:00Z") // 00:00 in Dubai: still inside yesterday's window
  await tick(cfg, "2026-10-05T20:05:30Z")
  assert.deepEqual(commandsFor("PLAY"), [])
  await tick(cfg, "2026-10-05T20:06:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2"])
  assert.equal(row("dxb-1").pausedByPrayer, null)
  await tick(cfg, "2026-10-05T20:29:00Z") // Riyadh's own Isha pause starts at 20:30Z
  assert.equal(commands.length, 4)
})

test("prayer times unavailable for the new day: yesterday's pause still ends on time", async () => {
  resetFixtures()
  const cfg = config(prayers("ISHA", 270, 10))
  await tick(cfg, "2026-10-07T19:56:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2"])
  aladhanDown = new Set(["08-10-2026"])
  try {
    await tick(cfg, "2026-10-07T20:03:00Z")
    assert.deepEqual(commandsFor("PLAY"), [])
    await tick(cfg, "2026-10-07T20:06:00Z")
    assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2"])
  } finally {
    aladhanDown = new Set()
  }
})

test("prayer times unavailable: a prayer switched off still resumes its zones", async () => {
  resetFixtures()
  Object.assign(row("dxb-1"), { pausedByPrayer: "MAGHRIB", prePrayerPlaybackState: "PLAYING" })
  aladhanDown = new Set(["09-10-2026", "10-10-2026"])
  try {
    await tick(config(prayers("ASR")), "2026-10-09T14:20:00Z")
    assert.deepEqual(commandsFor("PLAY"), ["dxb-1"])
    assert.deepEqual(commandsFor("PAUSE"), [])
  } finally {
    aladhanDown = new Set()
  }
})

test("prayer times unavailable after a restart: an open pause is left alone, not guessed at", async () => {
  resetFixtures()
  Object.assign(row("dxb-1"), { pausedByPrayer: "MAGHRIB", prePrayerPlaybackState: "PLAYING" })
  aladhanDown = new Set(["10-10-2026", "11-10-2026"])
  try {
    await tick(config(prayers("MAGHRIB")), "2026-10-11T14:20:00Z")
    assert.equal(commands.length, 0)
  } finally {
    aladhanDown = new Set()
  }
})

test("a Location whose servers all use their own settings gets no organization events", async () => {
  resetFixtures()
  overrides = [{ serverId: `${P}srv-ruh`, prayers: prayers("MAGHRIB") }]
  await tick(config(prayers("MAGHRIB")), "2026-10-12T14:48:00Z") // Riyadh Maghrib
  assert.deepEqual(commandsFor("PAUSE"), ["ruh-1"])
  assert.deepEqual(activity, [{ type: "PRAYER_STARTED", message: "Maghrib began on Venue Riyadh — pausing 1 zone(s)." }])
  await tick(config(prayers("MAGHRIB")), "2026-10-12T14:58:00Z")
  assert.deepEqual(activity.at(-1), { type: "PRAYER_ENDED", message: "Maghrib ended on Venue Riyadh — resuming 1 zone(s)." })
  assert.equal(activity.length, 2)
})

test("the server settings table fails after a good read: the last ones read are kept", async () => {
  withVenueTwo()
  own(prayers("MAGHRIB", 30, 10)) // 14:44Z–14:54Z; organization 14:14Z–14:24Z
  const cfg = config(prayers("MAGHRIB"))
  await tick(cfg, "2026-10-13T14:44:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["two-1", "two-2"])

  const before = warnings.length
  stub(prisma.serverPrayerOverride, "findMany", async () => {
    throw new Error("connection reset")
  })
  try {
    await tick(cfg, "2026-10-13T14:46:00Z")
    assert.deepEqual(commandsFor("PLAY"), [], "never resumed inside its own window")
    assert.equal(warnings.length, before + 1)
    assert.match(warnings.at(-1)!, /servers' own prayer settings/)
    await tick(cfg, "2026-10-13T14:54:00Z")
    assert.deepEqual(commandsFor("PLAY"), ["two-1", "two-2"])
  } finally {
    ;(prisma.serverPrayerOverride as any).findMany = overridesFindMany
  }
})

test("the server settings table cannot be read at all: the organization waits; a missing table means none", async () => {
  resetFixtures()
  zones.push(zone("fresh-1", "srv-fresh", "loc-dxb"))
  overrides = [{ serverId: `${P}srv-fresh`, prayers: prayers("MAGHRIB", 30, 10) }]
  const cfg = { ...config(prayers("MAGHRIB")), organizationId: FRESH_ORG }
  let error: Error & { code?: string } = new Error("connection reset")
  stub(prisma.serverPrayerOverride, "findMany", async () => {
    throw error
  })
  try {
    await tick(cfg, "2026-10-14T14:14:00Z")
    assert.equal(commands.length, 0, "not known which servers have their own settings: nothing is done")

    error = Object.assign(new Error("The table `public.ServerPrayerOverride` does not exist"), { code: "P2021" })
    await tick(cfg, "2026-10-14T14:15:00Z")
    assert.deepEqual(commandsFor("PAUSE"), ["fresh-1"], "before the migration: the organization's settings")
  } finally {
    ;(prisma.serverPrayerOverride as any).findMany = overridesFindMany
  }
})

test("restart mid-pause with today's times unavailable: the pause is kept until about when it should end", async () => {
  resetFixtures()
  Object.assign(row("dxb-1"), { pausedByPrayer: "MAGHRIB", prePrayerPlaybackState: "PLAYING", playbackState: "PAUSED" })
  aladhanDown = new Set(["16-10-2026"]) // yesterday's times still load
  try {
    const cfg = config(prayers("MAGHRIB")) // Dubai 14:14Z–14:24Z
    await tick(cfg, "2026-10-16T14:16:00Z")
    await tick(cfg, "2026-10-16T14:33:00Z")
    assert.equal(commands.length, 0, "inside today's likely window, with margin")
    await tick(cfg, "2026-10-16T14:35:00Z")
    assert.deepEqual(commandsFor("PLAY"), ["dxb-1"])
  } finally {
    aladhanDown = new Set()
  }
})

test("a server switched back to the organization mid-window is paused for the rest of it", async () => {
  withVenueTwo()
  own(prayers("MAGHRIB", 30, 10)) // 14:44Z–14:54Z
  const cfg = config(prayers("MAGHRIB")) // 14:14Z–14:24Z
  await tick(cfg, "2026-10-17T14:14:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2"])

  overrides = []
  await tick(cfg, "2026-10-17T14:16:00Z")
  assert.deepEqual(commandsFor("PAUSE"), ["dxb-1", "dxb-2", "two-1", "two-2"])
  await tick(cfg, "2026-10-17T14:17:00Z")
  assert.equal(commandsFor("PAUSE").length, 4, "once")
  await tick(cfg, "2026-10-17T14:24:00Z")
  assert.deepEqual(commandsFor("PLAY"), ["dxb-1", "dxb-2", "two-1", "two-2"])
  await tick(cfg, "2026-10-17T14:44:00Z")
  assert.equal(commandsFor("PAUSE").length, 4, "its old own window no longer applies")
})

test("a leftover pause on a zone someone has since stopped is cleared without playing it", async () => {
  resetFixtures()
  Object.assign(row("dxb-1"), { pausedByPrayer: "ASR", prePrayerPlaybackState: "PLAYING", playbackState: "STOPPED" })
  Object.assign(row("dxb-2"), { pausedByPrayer: "ASR", prePrayerPlaybackState: "PLAYING", playbackState: "PAUSED" })
  await tick(config(prayers("MAGHRIB")), "2026-10-18T10:00:00Z") // Asr switched off
  assert.deepEqual(commandsFor("PLAY"), ["dxb-2"])
  assert.equal(row("dxb-1").pausedByPrayer, null)
  assert.equal(row("dxb-1").prePrayerPlaybackState, null)
})

test("Super Zones: leaders pause first, a follower silently waiting for its playing leader's next song is paused too, and its leftover pause is always ended", async () => {
  // Only on a server running agent 2026.11.4 or newer; any other gets exactly what it always did.
  for (const [i, version] of ["2026.11.4", "2026.11.10", "2026.11.3", "1.0.0", null].entries()) {
    const day = `2026-10-${20 + i}` // a day of its own: each prayer fires once a day
    resetFixtures()
    if (version) serverVersion[`${P}srv-dxb`] = version
    const exact = version === "2026.11.4" || version === "2026.11.10"
    zones = [
      zone("f1", "srv-dxb", "loc-dxb", { leaderZoneId: `${P}lead`, playbackState: "STOPPED" }), // waits for its leader's next song
      zone("f2", "srv-dxb", "loc-dxb", { leaderZoneId: `${P}lead` }),
      zone("f3", "srv-dxb", "loc-dxb", { leaderZoneId: `${P}quiet`, playbackState: "STOPPED" }),
      zone("f4", "srv-dxb", "loc-dxb", { leaderZoneId: `${P}lead`, playbackState: "PAUSED" }),
      zone("f5", "srv-dxb", "loc-dxb", { leaderZoneId: `${P}lead`, playbackState: "OFFLINE" }),
      zone("x", "srv-dxb", "loc-dxb"),
      zone("lead", "srv-dxb", "loc-dxb"),
      zone("quiet", "srv-dxb", "loc-dxb", { playbackState: "STOPPED" }),
    ]
    await tick(config(prayers("MAGHRIB")), `${day}T14:14:00Z`)
    assert.deepEqual(
      commands.filter((c) => c.type === "PAUSE").map((c) => c.zoneId.slice(P.length)),
      exact ? ["x", "lead", "f1", "f2"] : ["x", "lead", "f2"],
      `${version}: a leader before its followers`
    )
    assert.equal(row("f1").pausedByPrayer, exact ? "MAGHRIB" : null, `${version}`)
    assert.equal(row("f1").prePrayerPlaybackState, exact ? "PLAYING" : null, `${version}`)
    for (const id of ["f3", "f4", "f5", "quiet"]) assert.equal(row(id).pausedByPrayer, null, `${version}: ${id} is left alone`)

    // Maghrib switched off mid-window: a stopped follower is still told (its PLAY ends its hold), another stopped zone is not.
    for (const id of ["x", "f1", "f2"]) row(id).playbackState = "STOPPED"
    row("lead").playbackState = "PAUSED"
    await tick(config(prayers("ISHA")), `${day}T14:16:00Z`)
    assert.deepEqual(commandsFor("PLAY"), exact ? ["f1", "f2", "lead"] : ["lead"], `${version}`)
    for (const id of ["x", "f1", "f2", "lead"]) assert.equal(row(id).pausedByPrayer, null, `${version}: ${id}`)
  }
})
