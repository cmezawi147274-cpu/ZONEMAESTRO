import { test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { AsyncLocalStorage } from "node:async_hooks"
import type { FastifyInstance } from "fastify"

/**
 * Super Zones: GET/PUT/DELETE /api/servers/:id/super-zones, what the venue
 * is handed for a follower (GET /api/server/schedules, POST
 * /api/server/zone-playlists/sync), how a portal command to a leader is
 * repeated to its followers, and that a follower cannot be driven directly.
 *
 * No database: every Prisma call these routes make is replaced by an
 * in-memory fake below, and DATABASE_URL points nowhere, so an unstubbed
 * query fails loudly instead of touching real data.
 */

const P = "zzsuper-"
const SERVER = `${P}srv`
const OTHER_SERVER = `${P}srv-other`
const AGENT_TOKEN = `${SERVER}.zz-agent-secret`
const ORG = `${P}org`
const LOC = `${P}loc`

type Row = Record<string, any> & { id: string }

type Db = typeof import("../src/lib/db.js")
let prisma: Db["prisma"]
let resolveAck: (commandId: string, status: string, resultMessage: string | null) => void
let markAgentSeen: (serverId: string) => void
let agentTokenHash: string
let app: FastifyInstance
const tokens: Record<string, string> = {}

let zones: Row[] = []
let schedules: Row[] = []
let commands: Row[] = []
let servers: Row[] = []
let commandSeq = 0
let lockedServers: unknown[] = []

function zone(id: string, over: Record<string, unknown> = {}): Row {
  return {
    id: `${P}${id}`,
    serverId: SERVER,
    locationId: LOC,
    localZoneId: `local-${id}`,
    name: id[0].toUpperCase() + id.slice(1),
    playbackState: "PLAYING",
    currentPlaylistId: null,
    currentTrackId: null,
    volume: 50,
    muted: false,
    updatedAt: new Date("2026-11-03T12:00:00Z"),
    prayerModeEnabled: true,
    pausedByPrayer: null,
    prePrayerPlaybackState: null,
    prePrayerPlaylistId: null,
    prePrayerTrackId: null,
    commandSequence: 0,
    lastAppliedSequence: 0,
    lastOverrideAt: null,
    excludedTrackIds: [],
    equalizer: null,
    crossfade: null,
    outputDeviceName: null,
    reportedPlaylistId: null,
    leaderZoneId: null,
    superZoneCopyVolume: false,
    ...over,
  }
}

function schedule(id: string, zoneId: string, playlistId: string, over: Record<string, unknown> = {}): Row {
  return {
    id: `${P}${id}`,
    zoneId: `${P}${zoneId}`,
    playlistId: `${P}${playlistId}`,
    name: id,
    startTime: "09:00",
    endTime: "17:00",
    days: ["MON", "TUE", "WED", "THU", "FRI"],
    priority: 1,
    enabled: true,
    repeat: false,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    ...over,
  }
}

const PLAYLIST_TRACKS: Record<string, string[]> = {
  [`${P}pl-lead`]: ["a", "b", "c", "d", "e", "f"].map((t) => `${P}t-${t}`),
  [`${P}pl-own`]: ["x", "y", "z"].map((t) => `${P}t-${t}`),
}

const row = (id: string) => zones.find((z) => z.id === `${P}${id}`)!

function matches(r: Row, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "NOT") return !matches(r, value)
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("in" in value) return value.in.includes(r[key])
      if ("notIn" in value) return !value.notIn.includes(r[key])
      if ("not" in value) return (r[key] ?? null) !== value.not
      throw new Error(`unsupported filter on ${key}: ${JSON.stringify(value)}`)
    }
    return (r[key] ?? null) === value
  })
}

function withInclude(z: Row, include?: Record<string, unknown>) {
  const out = structuredClone(z)
  if (include?.leaderZone) {
    const leader = zones.find((l) => l.id === z.leaderZoneId)
    out.leaderZone = leader ? { name: leader.name } : null
  }
  return out
}

function applyData(z: Row, data: Record<string, any>) {
  for (const [key, value] of Object.entries(data)) {
    z[key] = value && typeof value === "object" && "increment" in value ? z[key] + value.increment : structuredClone(value)
  }
}

/** A real query takes a moment, long enough for a second request to overlap. */
const aMoment = () => new Promise((resolve) => setImmediate(resolve))

const originals: [any, string, unknown][] = []
function stub(delegate: any, method: string, impl: (...args: any[]) => unknown) {
  originals.push([delegate, method, delegate[method]])
  delegate[method] = impl
}

before(async () => {
  process.env.DATABASE_URL = "postgresql://no-db:no-db@127.0.0.1:1/no-db"
  process.env.JWT_ACCESS_SECRET ??= "zz-test-access"
  process.env.JWT_REFRESH_SECRET ??= "zz-test-refresh"
  process.env.MUSIC_SERVER_AGENT_ALLOWED = "true"
  process.env.AGENT_API_PREFIX = "/api"
  process.env.AGENT_COMMAND_ACK_TIMEOUT_MS = "2000"
  ;({ prisma } = await import("../src/lib/db.js"))
  const { default: Fastify } = await import("fastify")
  const { HttpError } = await import("../src/lib/http-error.js")
  const { signAccessToken } = await import("../src/lib/jwt.js")
  const { sha256Hex } = await import("../src/lib/agent-auth.js")
  agentTokenHash = sha256Hex(AGENT_TOKEN)
  ;({ resolveAck, markAgentSeen } = await import("../src/lib/agent-registry.js"))
  const { default: superZonesRoutes } = await import("../src/routes/super-zones.js")
  const { default: zonesRoutes } = await import("../src/routes/zones.js")
  const { default: commandsRoutes } = await import("../src/routes/commands.js")
  const { default: agentRoutes } = await import("../src/routes/agent.js")
  const { default: playlistsRoutes } = await import("../src/routes/playlists.js")

  // pg_advisory_xact_lock: one transaction at a time holds it, until it ends.
  const txLock = new AsyncLocalStorage<{ release?: () => void }>()
  let lockTail = Promise.resolve()
  stub(prisma, "$transaction", async (fn: any) => {
    const held: { release?: () => void } = {}
    try {
      return await txLock.run(held, () => fn(prisma))
    } finally {
      held.release?.()
    }
  })
  stub(prisma, "$queryRaw", async (sql: TemplateStringsArray, ...values: unknown[]) => {
    assert.match(sql.join("?"), /pg_advisory_xact_lock/)
    const held = txLock.getStore()
    assert.ok(held, "lock taken outside a transaction")
    lockedServers.push(values[0])
    const before = lockTail
    lockTail = new Promise((resolve) => (held.release = resolve))
    await before
    return []
  })
  stub(prisma, "$queryRawUnsafe", async () => [])
  stub(prisma, "$executeRawUnsafe", async () => 0)
  stub(prisma.zone, "findUnique", async ({ where, include }: any) => {
    const z = zones.find((r) => r.id === where.id)
    return z ? withInclude(z, include) : null
  })
  stub(prisma.zone, "findMany", async ({ where, include, orderBy }: any) => {
    await aMoment()
    const found = zones.filter((z) => matches(z, where)).map((z) => withInclude(z, include))
    return orderBy?.name ? found.sort((a, b) => a.name.localeCompare(b.name)) : found
  })
  stub(prisma.zone, "update", async ({ where, data, include }: any) => {
    const z = zones.find((r) => r.id === where.id)
    assert.ok(z, `update of unknown zone ${where.id}`)
    applyData(z, data)
    return withInclude(z, include)
  })
  stub(prisma.zone, "updateMany", async ({ where, data }: any) => {
    await aMoment()
    const hit = zones.filter((z) => matches(z, where))
    for (const z of hit) applyData(z, data)
    return { count: hit.length }
  })
  // The real column is ON DELETE SET NULL (checked against the migration below).
  stub(prisma.zone, "delete", async ({ where }: any) => {
    const z = zones.find((r) => r.id === where.id)
    assert.ok(z, `delete of unknown zone ${where.id}`)
    zones = zones.filter((r) => r.id !== where.id)
    for (const f of zones) if (f.leaderZoneId === where.id) f.leaderZoneId = null
    return z
  })
  stub(prisma.schedule, "findMany", async ({ where }: any) =>
    schedules.filter((s) => matches(s, where)).sort((a, b) => a.startTime.localeCompare(b.startTime)).map((s) => structuredClone(s))
  )
  stub(prisma.playlistTrack, "findMany", async ({ where }: any) =>
    where.playlistId.in.flatMap((playlistId: string) => (PLAYLIST_TRACKS[playlistId] ?? []).map((trackId, position) => ({ playlistId, trackId, position })))
  )
  stub(prisma.playlist, "findUnique", async ({ where }: any) =>
    PLAYLIST_TRACKS[where.id] ? { id: where.id, tracks: PLAYLIST_TRACKS[where.id].map((trackId, position) => ({ trackId, position })) } : null
  )
  stub(prisma.location, "findUnique", async ({ where }: any) => (where.id === LOC || where.id === `${P}loc-2` ? { id: where.id, organizationId: ORG } : null))
  stub(prisma.musicServer, "findUnique", async ({ where }: any) => {
    const s = servers.find((r) => r.id === where.id)
    return s ? structuredClone(s) : null
  })
  stub(prisma.musicServer, "findMany", async ({ where }: any) =>
    servers.filter((s) => matches(s, where)).map((s) => ({ id: s.id, organizationId: s.organizationId }))
  )
  stub(prisma.track, "findMany", async () => [])
  stub(prisma.playlist, "findMany", async () => [])
  stub(prisma.deletedServerTombstone, "findUnique", async () => null)
  stub(prisma.user, "findMany", async () => [])
  stub(prisma.activityEvent, "create", async ({ data }: any) => data)
  stub(prisma.remoteCommand, "create", async ({ data }: any) => {
    const c: Row = { id: `${P}cmd-${++commandSeq}`, issuedAt: new Date(), completedAt: null, resultMessage: null, sequence: null, payload: null, sentAt: null, ...data }
    commands.push(c)
    // The venue answers every zone command shortly after it is sent.
    if (c.status === "SENT") {
      setTimeout(() => {
        c.status = "SUCCESS"
        c.completedAt = new Date()
        resolveAck(c.id, "SUCCESS", null)
      }, 10)
    }
    return structuredClone(c)
  })
  stub(prisma.remoteCommand, "update", async ({ where, data }: any) => {
    const c = commands.find((r) => r.id === where.id)
    assert.ok(c, `update of unknown command ${where.id}`)
    Object.assign(c, data)
    return structuredClone(c)
  })
  stub(prisma.remoteCommand, "findUnique", async ({ where }: any) => {
    const c = commands.find((r) => r.id === where.id)
    return c ? structuredClone(c) : null
  })
  stub(prisma.remoteCommand, "findUniqueOrThrow", async ({ where }: any) => {
    const c = commands.find((r) => r.id === where.id)
    assert.ok(c, `unknown command ${where.id}`)
    return structuredClone(c)
  })

  app = Fastify()
  // Same mapping as src/index.ts: an HttpError carries its own status.
  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send({ code: error.code, message: error.message })
    return reply.status(error.statusCode ?? 500).send({ code: error.code, message: error.message })
  })
  await app.register(async (api) => {
    await api.register(superZonesRoutes)
    await api.register(zonesRoutes)
    await api.register(commandsRoutes)
    await api.register(playlistsRoutes)
  }, { prefix: "/api" })
  await app.register(agentRoutes)
  await app.ready()

  const sign = (name: string, role: any, organizationId: string | null, locationId: string | null) => {
    tokens[name] = signAccessToken({ id: `${P}${name}`, email: `${name}@example.test`, role, organizationId, locationId })
  }
  sign("super", "SUPER_ADMIN", null, null)
  sign("admin", "ORGANIZATION_ADMIN", ORG, null)
  sign("otherAdmin", "ORGANIZATION_ADMIN", `${P}other-org`, null)
  sign("manager", "LOCATION_MANAGER", ORG, LOC)
  sign("viewer", "VIEWER", ORG, LOC)
})

after(async () => {
  await app?.close()
  for (const [delegate, method, original] of originals.reverse()) delegate[method] = original
  await prisma?.$disconnect()
})

beforeEach(() => {
  servers = [
    { id: SERVER, name: "ZZ venue", organizationId: ORG, locationId: LOC, status: "ONLINE", agentTokenHash, reportedTimezone: null },
    { id: OTHER_SERVER, name: "ZZ other", organizationId: ORG, locationId: LOC, status: "ONLINE", agentTokenHash: null, reportedTimezone: null },
  ]
  zones = [
    zone("lead", {
      currentPlaylistId: `${P}pl-lead`,
      currentTrackId: `${P}t-c`,
      excludedTrackIds: [`${P}t-b`],
      crossfade: { enabled: true, durationMs: 4000 },
    }),
    zone("patio", { currentPlaylistId: `${P}pl-own`, currentTrackId: `${P}t-y` }),
    zone("bar"),
    zone("lobby"),
    zone("foreign", { serverId: OTHER_SERVER, localZoneId: "local-foreign" }),
  ]
  schedules = [schedule("s-lead", "lead", "pl-lead", { priority: 3 }), schedule("s-patio", "patio", "pl-own", { startTime: "08:00" })]
  commands = []
  lockedServers = []
})

function put(leader: string, body: unknown, token = tokens.super, server = SERVER) {
  return app.inject({
    method: "PUT",
    url: `/api/servers/${server}/super-zones/${P}${leader}`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: JSON.stringify(body),
  })
}

async function link(leader: string, followers: string[], copyVolume = false) {
  const res = await put(leader, { followerZoneIds: followers.map((f) => `${P}${f}`), copyVolume })
  assert.equal(res.statusCode, 200, res.body)
  return res.json()
}

async function agentGet(url: string, method: "GET" | "POST" = "GET") {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${AGENT_TOKEN}` } })
  assert.equal(res.statusCode, 200, res.body)
  return res.json()
}

async function servedSchedules(): Promise<Row[]> {
  return (await agentGet("/api/server/schedules")).schedules
}

function command(zoneId: string | null, type: string, payload?: Record<string, unknown>, token = tokens.super) {
  return app.inject({
    method: "POST",
    url: "/api/commands",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: JSON.stringify({ serverId: SERVER, zoneId: zoneId && `${P}${zoneId}`, type, ...(payload ? { payload } : {}) }),
  })
}

/** Follower commands are sent alongside the leader's and settle on their own. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 80))

const syncConfigs = () => commands.filter((c) => c.type === "SYNC_CONFIG")

// ------------------------------------------------------------------------
// Linking
// ------------------------------------------------------------------------

test("PUT links followers, returns the group, and queues a SYNC_CONFIG for the venue", async () => {
  const group = await link("lead", ["patio", "bar"], true)
  assert.deepEqual(group, { leaderZoneId: `${P}lead`, leaderName: "Lead", followerZoneIds: [`${P}bar`, `${P}patio`], copyVolume: true })
  assert.equal(row("patio").leaderZoneId, `${P}lead`)
  assert.equal(row("bar").leaderZoneId, `${P}lead`)
  assert.equal(row("lead").superZoneCopyVolume, true)
  assert.equal(syncConfigs().length, 1)
  assert.equal(syncConfigs()[0].status, "PENDING")
  assert.equal(syncConfigs()[0].serverId, SERVER)

  const res = await app.inject({ method: "GET", url: `/api/servers/${SERVER}/super-zones`, headers: { authorization: `Bearer ${tokens.viewer}` } })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(res.json(), { groups: [group] })
})

test("PUT replaces the follower set and an empty set removes the group", async () => {
  await link("lead", ["patio", "bar"], true)
  await link("lead", ["bar"])
  assert.equal(row("patio").leaderZoneId, null)
  assert.equal(row("bar").leaderZoneId, `${P}lead`)
  assert.equal(row("lead").superZoneCopyVolume, false)

  const group = await link("lead", [], true)
  assert.deepEqual(group.followerZoneIds, [])
  assert.equal(group.copyVolume, false)
  assert.equal(row("bar").leaderZoneId, null)
  assert.equal(syncConfigs().length, 3)
})

for (const [label, setup, leader, followers, message] of [
  ["a zone following itself", () => {}, "lead", ["lead"], /cannot follow itself/],
  ["a follower on another Music Server", () => {}, "lead", ["foreign"], /zones on this Music Server/],
  ["an unknown follower id", () => {}, "lead", ["nope"], /zones on this Music Server/],
  ["a leader that is itself a follower", () => (row("lead").leaderZoneId = `${P}lobby`), "lead", ["patio"], /Lead follows Lobby/],
  ["a follower that is itself a super zone", () => (row("bar").leaderZoneId = `${P}patio`), "lead", ["patio"], /Patio is a super zone/],
  ["a follower that already follows another zone", () => (row("patio").leaderZoneId = `${P}lobby`), "lead", ["patio"], /Patio already follows Lobby/],
] as const) {
  test(`PUT rejects ${label} with 400 and changes nothing`, async () => {
    setup()
    const before = structuredClone(zones)
    const res = await put(leader, { followerZoneIds: followers.map((f) => `${P}${f}`), copyVolume: false })
    assert.equal(res.statusCode, 400, res.body)
    assert.match(res.json().message, message)
    assert.deepEqual(zones, before)
    assert.equal(syncConfigs().length, 0)
  })
}

test("PUT rejects a malformed body with 400", async () => {
  for (const body of [{}, { followerZoneIds: `${P}patio`, copyVolume: false }, { followerZoneIds: [`${P}patio`] }, { followerZoneIds: [1], copyVolume: true }]) {
    const res = await put("lead", body)
    assert.equal(res.statusCode, 400, res.body)
  }
  assert.equal(row("patio").leaderZoneId, null)
})

test("a leader zone on another server is a 404, and so is another organization's server", async () => {
  const res = await put("foreign", { followerZoneIds: [`${P}patio`], copyVolume: false })
  assert.equal(res.statusCode, 404, res.body)
  const other = await put("lead", { followerZoneIds: [`${P}patio`], copyVolume: false }, tokens.otherAdmin)
  assert.equal(other.statusCode, 404, other.body)
  assert.equal(row("patio").leaderZoneId, null)
})

test("a VIEWER may read groups but not change them", async () => {
  const res = await put("lead", { followerZoneIds: [`${P}patio`], copyVolume: false }, tokens.viewer)
  assert.equal(res.statusCode, 403, res.body)
  const del = await app.inject({ method: "DELETE", url: `/api/servers/${SERVER}/super-zones/${P}lead`, headers: { authorization: `Bearer ${tokens.viewer}` } })
  assert.equal(del.statusCode, 403, del.body)
})

test("DELETE frees every follower and queues a SYNC_CONFIG", async () => {
  await link("lead", ["patio", "bar"], true)
  const res = await app.inject({ method: "DELETE", url: `/api/servers/${SERVER}/super-zones/${P}lead`, headers: { authorization: `Bearer ${tokens.admin}` } })
  assert.equal(res.statusCode, 204, res.body)
  assert.equal(row("patio").leaderZoneId, null)
  assert.equal(row("bar").leaderZoneId, null)
  assert.equal(row("lead").superZoneCopyVolume, false)
  assert.equal(syncConfigs().length, 2)
})

test("zones carry leaderZoneId and leaderZoneName", async () => {
  await link("lead", ["patio"])
  const res = await app.inject({ method: "GET", url: `/api/zones?serverId=${SERVER}`, headers: { authorization: `Bearer ${tokens.super}` } })
  assert.equal(res.statusCode, 200, res.body)
  const byId = new Map(res.json().map((z: Row) => [z.id, z]))
  assert.equal(byId.get(`${P}patio`).leaderZoneId, `${P}lead`)
  assert.equal(byId.get(`${P}patio`).leaderZoneName, "Lead")
  assert.equal(byId.get(`${P}lead`).leaderZoneId, null)
  assert.equal(byId.get(`${P}lead`).leaderZoneName, null)
})

// ------------------------------------------------------------------------
// What the venue is handed
// ------------------------------------------------------------------------

test("a follower is served its leader's schedules under its own zone, and none of its own", async () => {
  const unlinked = await servedSchedules()
  assert.deepEqual(unlinked.map((s) => s.id).sort(), [`${P}s-lead`, `${P}s-patio`])

  await link("lead", ["patio", "bar"])
  const served = await servedSchedules()
  assert.ok(!served.some((s) => s.id === `${P}s-patio`), "the follower's own schedule is still served")
  assert.deepEqual(served.map((s) => s.id).sort(), [`${P}s-lead`, `${P}s-lead:${P}bar`, `${P}s-lead:${P}patio`])
  const leader = served.find((s) => s.id === `${P}s-lead`)!
  for (const follower of ["patio", "bar"]) {
    const slot = served.find((s) => s.id === `${P}s-lead:${P}${follower}`)!
    assert.equal(slot.localZoneId, `local-${follower}`)
    assert.equal(slot.zoneId, `${P}${follower}`)
    assert.deepEqual({ ...slot, id: leader.id, localZoneId: leader.localZoneId, zoneId: leader.zoneId }, leader)
  }
  assert.deepEqual(leader.excludedTrackIds, [`${P}t-b`])
  assert.equal(new Set(served.map((s) => `${s.id}::${s.localZoneId}`)).size, served.length)
  // The follower's own schedule rows are left as they were.
  assert.equal(schedules.find((s) => s.id === `${P}s-patio`)!.zoneId, `${P}patio`)
})

test("unlinking gives a follower its own schedules back", async () => {
  await link("lead", ["patio"])
  await link("lead", [])
  const served = await servedSchedules()
  assert.deepEqual(served.map((s) => s.id).sort(), [`${P}s-lead`, `${P}s-patio`])
  assert.equal(served.find((s) => s.id === `${P}s-patio`)!.localZoneId, "local-patio")
})

test("deleting the leader frees its followers, which get their own schedules back", async () => {
  const sql = readdirSync(new URL("../prisma/migrations/", import.meta.url))
    .filter((d) => d.endsWith("_add_super_zones"))
    .map((d) => readFileSync(new URL(`../prisma/migrations/${d}/migration.sql`, import.meta.url), "utf8"))
  assert.equal(sql.length, 1)
  assert.match(sql[0], /FOREIGN KEY \("leaderZoneId"\) REFERENCES "Zone"\("id"\) ON DELETE SET NULL/)

  await link("lead", ["patio"])
  const res = await app.inject({ method: "DELETE", url: `/api/zones/${P}lead`, headers: { authorization: `Bearer ${tokens.super}` } })
  assert.equal(res.statusCode, 204, res.body)
  assert.equal(row("patio").leaderZoneId, null)
  const served = await servedSchedules()
  assert.deepEqual(served.map((s) => s.id), [`${P}s-patio`])
})

test("zone-playlists sync hands a follower its leader's playlist, exclusions, track and crossfade", async () => {
  await link("lead", ["patio", "bar"])
  const items = new Map((await agentGet("/api/server/zone-playlists/sync", "POST")).zonePlaylists.map((z: Row) => [z.zoneId, z]))
  const leader = items.get(`${P}lead`)
  for (const follower of ["patio", "bar"]) {
    const item = items.get(`${P}${follower}`)
    assert.equal(item.localZoneId, `local-${follower}`)
    assert.equal(item.playlistId, `${P}pl-lead`)
    assert.deepEqual(item.trackIds, leader.trackIds, "a follower must be seeded with the leader's id")
    assert.deepEqual(item.excludedTrackIds, [`${P}t-b`])
    assert.equal(item.currentTrackId, `${P}t-c`)
    assert.deepEqual(item.crossfade, { enabled: true, durationMs: 4000 })
    assert.equal(item.followsLocalZoneId, "local-lead")
  }
  assert.equal("followsLocalZoneId" in leader, false)
  assert.equal("followsLocalZoneId" in items.get(`${P}lobby`), false)
  assert.equal(items.get(`${P}lobby`).playlistId, null)
  assert.equal(row("patio").currentPlaylistId, `${P}pl-own`, "the follower's own assignment is kept for when it is freed")
})

test("zone-playlists sync names the prayer a follower is paused for, so the venue holds it from the link on", async () => {
  row("bar").pausedByPrayer = "ASR"
  row("lead").pausedByPrayer = "ASR"
  await link("lead", ["patio", "bar"])
  const items = new Map((await agentGet("/api/server/zone-playlists/sync", "POST")).zonePlaylists.map((z: Row) => [z.zoneId, z]))
  assert.equal(items.get(`${P}bar`).prayerHold, "ASR")
  assert.equal("prayerHold" in items.get(`${P}patio`), false)
  assert.equal("prayerHold" in items.get(`${P}lead`), false, "a leader's own prayer is not a hold")
  assert.equal("prayerHold" in items.get(`${P}lobby`), false)
})

// ------------------------------------------------------------------------
// Commands
// ------------------------------------------------------------------------

test("PLAY on a leader is repeated to each follower as its own command, skipping one paused for prayer", async () => {
  markAgentSeen(SERVER)
  await link("lead", ["patio", "bar", "lobby"])
  row("lobby").pausedByPrayer = "DHUHR"
  row("bar").commandSequence = 7
  const res = await command("lead", "PLAY", undefined, tokens.admin)
  assert.equal(res.statusCode, 201, res.body)
  await settled()
  const plays = commands.filter((c) => c.type === "PLAY")
  assert.deepEqual(plays.map((c) => c.zoneId).sort(), [`${P}bar`, `${P}lead`, `${P}patio`])
  for (const c of plays) {
    assert.equal(c.source, "USER")
    assert.equal(c.status, "SUCCESS")
  }
  assert.equal(plays.find((c) => c.zoneId === `${P}bar`)!.sequence, 8)
  assert.equal(plays.find((c) => c.zoneId === `${P}patio`)!.sequence, 1)
  assert.equal(row("lobby").commandSequence, 0)
})

test("NEXT on a leader is not repeated, and volume only when the group copies volume", async () => {
  markAgentSeen(SERVER)
  await link("lead", ["patio"])
  assert.equal((await command("lead", "NEXT")).statusCode, 201)
  assert.equal((await command("lead", "SET_VOLUME", { volume: 30 })).statusCode, 201)
  await settled()
  assert.deepEqual(commands.filter((c) => c.zoneId === `${P}patio`), [])

  await link("lead", ["patio"], true)
  assert.equal((await command("lead", "SET_VOLUME", { volume: 40 })).statusCode, 201)
  assert.equal((await command("lead", "MUTE")).statusCode, 201)
  await settled()
  const mirrored = commands.filter((c) => c.zoneId === `${P}patio`)
  assert.deepEqual(mirrored.map((c) => c.type), ["SET_VOLUME", "MUTE"])
  assert.deepEqual(mirrored[0].payload, { volume: 40 })
})

test("a location-bound user's command reaches only followers at their own venue", async () => {
  markAgentSeen(SERVER)
  await link("lead", ["patio", "bar"])
  row("bar").locationId = `${P}loc-2`
  const res = await command("lead", "STOP", undefined, tokens.manager)
  assert.equal(res.statusCode, 201, res.body)
  await settled()
  assert.deepEqual(commands.filter((c) => c.type === "STOP").map((c) => c.zoneId).sort(), [`${P}lead`, `${P}patio`])
  assert.ok(commands.filter((c) => c.type === "STOP").every((c) => c.source === "USER"))
})

test("a follower cannot be driven directly: 409 and nothing is written", async () => {
  markAgentSeen(SERVER)
  await link("lead", ["patio"])
  const before = commands.length
  for (const type of ["PLAY", "PAUSE", "STOP", "NEXT", "PREVIOUS"]) {
    const res = await command("patio", type)
    assert.equal(res.statusCode, 409, res.body)
    assert.equal(res.json().message, "This zone follows Lead.")
  }
  assert.equal(commands.length, before)
  assert.equal(row("patio").commandSequence, 0)

  const assign = await app.inject({
    method: "POST",
    url: `/api/zones/${P}patio/playlist`,
    headers: { authorization: `Bearer ${tokens.super}`, "content-type": "application/json" },
    payload: JSON.stringify({ playlistId: `${P}pl-own` }),
  })
  assert.equal(assign.statusCode, 409, assign.body)
  assert.equal(assign.json().message, "This zone follows Lead.")
})

test("a follower's volume stays its own unless the group copies volume", async () => {
  markAgentSeen(SERVER)
  await link("lead", ["patio"])
  assert.equal((await command("patio", "SET_VOLUME", { volume: 20 })).statusCode, 201)
  await link("lead", ["patio"], true)
  const res = await command("patio", "SET_VOLUME", { volume: 25 })
  assert.equal(res.statusCode, 409, res.body)
  assert.equal(res.json().message, "This zone follows Lead.")
})

test("a follower paused for prayer still gets the group's volume, and a super admin's override", async () => {
  markAgentSeen(SERVER)
  await link("lead", ["patio"], true)
  row("patio").pausedByPrayer = "ASR"
  assert.equal((await command("lead", "SET_VOLUME", { volume: 30 }, tokens.admin)).statusCode, 201)
  assert.equal((await command("lead", "MUTE", undefined, tokens.admin)).statusCode, 201)
  assert.equal((await command("lead", "STOP", undefined, tokens.admin)).statusCode, 201)
  await settled()
  assert.deepEqual(commands.filter((c) => c.zoneId === `${P}patio`).map((c) => c.type), ["SET_VOLUME", "MUTE"])

  assert.equal((await command("lead", "STOP")).statusCode, 201)
  await settled()
  const stop = commands.find((c) => c.zoneId === `${P}patio` && c.type === "STOP")
  assert.ok(stop, "the super admin's STOP did not reach the follower paused for prayer")
  assert.equal(stop.source, "SUPER_ADMIN")
})

test("a super admin's PLAY on a leader carries its override to the leader and every follower it is repeated to", async () => {
  markAgentSeen(SERVER)
  await link("lead", ["patio", "bar"])
  row("bar").pausedByPrayer = "ASR"
  assert.equal((await command("lead", "PLAY")).statusCode, 201)
  await settled()
  const plays = () => commands.filter((c) => c.type === "PLAY").map((c) => [c.zoneId, c.payload ?? null]).sort()
  assert.deepEqual(plays(), [[`${P}bar`, { override: true }], [`${P}lead`, { override: true }], [`${P}patio`, { override: true }]])

  commands = []
  row("bar").pausedByPrayer = "ASR"
  assert.equal((await command("lead", "PLAY", undefined, tokens.admin)).statusCode, 201)
  await settled()
  assert.deepEqual(plays(), [[`${P}lead`, null], [`${P}patio`, null]], "an admin's PLAY overrides nothing")

  commands = []
  assert.equal((await command("lead", "PLAY", { override: true }, tokens.admin)).statusCode, 201)
  await settled()
  assert.deepEqual(plays(), [[`${P}lead`, {}], [`${P}patio`, {}]], "nor can an admin's client claim one")
})

// ------------------------------------------------------------------------
// Linking while the leader is not playing
// ------------------------------------------------------------------------

test("a follower linked to a stopped or paused leader is put in the same state after the SYNC_CONFIG", async () => {
  row("lead").playbackState = "STOPPED"
  row("bar").commandSequence = 4
  await link("lead", ["patio", "bar"])
  const [sync] = syncConfigs()
  const holds = commands.filter((c) => c.type !== "SYNC_CONFIG")
  assert.deepEqual(holds.map((c) => [c.zoneId, c.type]).sort(), [[`${P}bar`, "STOP"], [`${P}patio`, "STOP"]])
  for (const c of holds) {
    assert.equal(c.status, "PENDING")
    assert.equal(c.payload, null)
    assert.equal(c.serverId, SERVER)
    assert.ok(c.issuedAt > sync.issuedAt, "a hold must reach the venue after the SYNC_CONFIG")
  }
  assert.equal(holds.find((c) => c.zoneId === `${P}bar`)!.sequence, 5)

  // Only a newly linked follower is held; the ones already following are left alone.
  row("lead").playbackState = "PAUSED"
  commands = []
  await link("lead", ["patio", "bar", "lobby"])
  assert.deepEqual(commands.filter((c) => c.type !== "SYNC_CONFIG").map((c) => [c.zoneId, c.type]), [[`${P}lobby`, "PAUSE"]])
})

test("a follower linked to a playing leader is held only while it is paused for prayer", async () => {
  row("bar").pausedByPrayer = "ASR"
  await link("lead", ["patio", "bar"])
  assert.deepEqual(commands.filter((c) => c.type !== "SYNC_CONFIG").map((c) => [c.zoneId, c.type, c.payload]), [[`${P}bar`, "PAUSE", { prayer: "ASR" }]])
})

test("a follower paused for prayer and linked to a stopped leader is told its prayer", async () => {
  row("lead").playbackState = "STOPPED"
  row("bar").pausedByPrayer = "ASR"
  await link("lead", ["patio", "bar"])
  assert.deepEqual(commands.filter((c) => c.type !== "SYNC_CONFIG").map((c) => [c.zoneId, c.type, c.payload]).sort(), [
    [`${P}bar`, "STOP", { prayer: "ASR" }],
    [`${P}patio`, "STOP", null],
  ])
})

// ------------------------------------------------------------------------
// Two saves at once
// ------------------------------------------------------------------------

test("two saves at once cannot chain zones or give one zone two leaders", async () => {
  const [a, b] = await Promise.all([
    put("lead", { followerZoneIds: [`${P}patio`], copyVolume: false }),
    put("patio", { followerZoneIds: [`${P}bar`], copyVolume: false }),
  ])
  assert.deepEqual([a.statusCode, b.statusCode], [200, 400], `${a.body} ${b.body}`)
  assert.equal(row("patio").leaderZoneId, `${P}lead`)
  assert.equal(row("bar").leaderZoneId, null)

  const [c, d] = await Promise.all([
    put("lobby", { followerZoneIds: [`${P}bar`], copyVolume: false }),
    put("lead", { followerZoneIds: [`${P}patio`, `${P}bar`], copyVolume: false }),
  ])
  assert.deepEqual([c.statusCode, d.statusCode], [200, 400], `${c.body} ${d.body}`)
  assert.equal(row("bar").leaderZoneId, `${P}lobby`)

  const del = await app.inject({ method: "DELETE", url: `/api/servers/${SERVER}/super-zones/${P}lobby`, headers: { authorization: `Bearer ${tokens.super}` } })
  assert.equal(del.statusCode, 204, del.body)
  assert.deepEqual(lockedServers, Array(5).fill(SERVER))
})

// ------------------------------------------------------------------------
// Playlist routes
// ------------------------------------------------------------------------

test("a follower's playlist cannot be assigned from the playlist page or removed: 409 and nothing is written", async () => {
  await link("lead", ["patio"])
  const assign = await app.inject({
    method: "POST",
    url: `/api/playlists/${P}pl-lead/assign`,
    headers: { authorization: `Bearer ${tokens.super}`, "content-type": "application/json" },
    payload: JSON.stringify({ targetType: "ZONE", targetId: `${P}patio` }),
  })
  assert.equal(assign.statusCode, 409, assign.body)
  assert.equal(assign.json().message, "This zone follows Lead.")

  const unassign = await app.inject({
    method: "POST",
    url: `/api/zones/${P}patio/playlist/unassign`,
    headers: { authorization: `Bearer ${tokens.super}`, "content-type": "application/json" },
    payload: JSON.stringify({ playlistId: `${P}pl-own` }),
  })
  assert.equal(unassign.statusCode, 409, unassign.body)
  assert.equal(unassign.json().message, "This zone follows Lead.")
  assert.equal(row("patio").currentPlaylistId, `${P}pl-own`)
  assert.equal(row("patio").currentTrackId, `${P}t-y`)
})
