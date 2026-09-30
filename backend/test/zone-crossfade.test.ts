import { test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { FastifyInstance } from "fastify"

/**
 * Per-zone crossfade: what PUT /api/zones/:id/crossfade accepts and writes,
 * what the agent's POST /api/server/zone-playlists/sync hands the venue, and
 * that crossfade and the SET_EQ-written equalizer never overwrite each other.
 *
 * No database: every Prisma call these routes make is replaced by an
 * in-memory fake below, and DATABASE_URL points nowhere, so an unstubbed
 * query fails loudly instead of touching real data.
 */

const P = "zzxfade-"
const SERVER = `${P}srv`
const AGENT_TOKEN = `${SERVER}.zz-agent-secret`
const EQ = { enabled: true, presetId: "rock", bands: [3, 2, 1, 0, -1, -1, 0, 1, 2, 3] }
const SAVED = { enabled: true, durationMs: 4500 }

type Row = Record<string, unknown> & { id: string }

type Db = typeof import("../src/lib/db.js")
let prisma: Db["prisma"]
let DbNull: unknown
let app: FastifyInstance
let superToken: string
let viewerToken: string
let orgAdminToken: string
let otherOrgAdminToken: string
let otherVenueManagerToken: string

let zones: Row[] = []
let zoneWrites: { id: string; data: Record<string, unknown> }[] = []
let commands: Row[] = []

function zone(id: string, over: Record<string, unknown> = {}): Row {
  return {
    id: `${P}${id}`,
    serverId: SERVER,
    locationId: `${P}loc`,
    localZoneId: id,
    name: id,
    playbackState: "PLAYING",
    currentPlaylistId: null,
    currentTrackId: null,
    volume: 50,
    muted: false,
    updatedAt: new Date("2026-09-30T12:00:00Z"),
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
    ...over,
  }
}

const row = (id: string) => zones.find((z) => z.id === `${P}${id}`)!

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
  ;({ prisma } = await import("../src/lib/db.js"))
  DbNull = (await import("@prisma/client")).Prisma.DbNull
  const { default: Fastify } = await import("fastify")
  const { HttpError } = await import("../src/lib/http-error.js")
  const { signAccessToken } = await import("../src/lib/jwt.js")
  const { sha256Hex } = await import("../src/lib/agent-auth.js")
  const { default: zonesRoutes } = await import("../src/routes/zones.js")
  const { default: agentRoutes } = await import("../src/routes/agent.js")

  stub(prisma.zone, "findUnique", async ({ where }: any) => {
    const z = zones.find((r) => r.id === where.id)
    return z ? structuredClone(z) : null
  })
  stub(prisma.zone, "findMany", async ({ where }: any) => {
    assert.deepEqual(Object.keys(where), ["serverId"], "unexpected zone filter")
    return zones.filter((z) => z.serverId === where.serverId).map((z) => structuredClone(z))
  })
  stub(prisma.zone, "update", async ({ where, data }: any) => {
    const z = zones.find((r) => r.id === where.id)
    assert.ok(z, `update of unknown zone ${where.id}`)
    zoneWrites.push({ id: where.id, data })
    for (const [key, value] of Object.entries(data)) z[key] = value === DbNull ? null : structuredClone(value)
    return structuredClone(z)
  })
  stub(prisma.location, "findUnique", async ({ where }: any) =>
    where.id === `${P}loc` ? { id: `${P}loc`, organizationId: `${P}org` } : null
  )
  stub(prisma.playlist, "findUnique", async ({ where }: any) =>
    where.id === `${P}pl`
      ? { id: `${P}pl`, tracks: [{ trackId: `${P}t1`, position: 0 }, { trackId: `${P}t2`, position: 1 }] }
      : null
  )
  stub(prisma.musicServer, "findUnique", async ({ where }: any) =>
    where.id === SERVER
      ? { id: SERVER, name: "ZZ venue", organizationId: `${P}org`, locationId: `${P}loc`, agentTokenHash: sha256Hex(AGENT_TOKEN) }
      : null
  )
  stub(prisma.deletedServerTombstone, "findUnique", async () => null)
  stub(prisma.remoteCommand, "findUnique", async ({ where }: any) => {
    const c = commands.find((r) => r.id === where.id)
    return c ? structuredClone(c) : null
  })
  stub(prisma.remoteCommand, "update", async ({ where, data }: any) => {
    const c = commands.find((r) => r.id === where.id)
    assert.ok(c, `update of unknown command ${where.id}`)
    Object.assign(c, data)
    return structuredClone(c)
  })
  stub(prisma.activityEvent, "create", async () => ({}))

  app = Fastify()
  // Same mapping as src/index.ts: an HttpError carries its own status.
  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send({ code: error.code, message: error.message })
    return reply.status(error.statusCode ?? 500).send({ code: error.code, message: error.message })
  })
  await app.register(async (api) => {
    await api.register(zonesRoutes)
  }, { prefix: "/api" })
  await app.register(agentRoutes)
  await app.ready()

  superToken = signAccessToken({ id: `${P}super`, email: "zz-super@example.test", role: "SUPER_ADMIN", organizationId: null, locationId: null })
  viewerToken = signAccessToken({ id: `${P}viewer`, email: "zz-viewer@example.test", role: "VIEWER", organizationId: `${P}org`, locationId: `${P}loc` })
  orgAdminToken = signAccessToken({ id: `${P}oa`, email: "zz-oa@example.test", role: "ORGANIZATION_ADMIN", organizationId: `${P}org`, locationId: null })
  otherOrgAdminToken = signAccessToken({ id: `${P}oa-other`, email: "zz-oa-other@example.test", role: "ORGANIZATION_ADMIN", organizationId: `${P}other-org`, locationId: null })
  otherVenueManagerToken = signAccessToken({ id: `${P}lm-other`, email: "zz-lm-other@example.test", role: "LOCATION_MANAGER", organizationId: `${P}org`, locationId: `${P}other-loc` })
})

after(async () => {
  await app?.close()
  for (const [delegate, method, original] of originals.reverse()) delegate[method] = original
  await prisma?.$disconnect()
})

beforeEach(() => {
  zones = [
    zone("plain"),
    zone("eq", { equalizer: structuredClone(EQ) }),
    zone("saved", {
      crossfade: structuredClone(SAVED),
      currentPlaylistId: `${P}pl`,
      currentTrackId: `${P}t1`,
      excludedTrackIds: [`${P}t2`],
    }),
  ]
  zoneWrites = []
  commands = []
})

function putCrossfade(zoneId: string, payload: string | undefined, token = superToken) {
  return app.inject({
    method: "PUT",
    url: `/api/zones/${P}${zoneId}/crossfade`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(payload !== undefined ? { payload } : {}),
  })
}

async function sync() {
  const res = await app.inject({
    method: "POST",
    url: "/api/server/zone-playlists/sync",
    headers: { authorization: `Bearer ${AGENT_TOKEN}` },
  })
  assert.equal(res.statusCode, 200, res.body)
  const items = res.json().zonePlaylists as Record<string, unknown>[]
  return new Map(items.map((item) => [item.zoneId as string, item]))
}

// ------------------------------------------------------------------------
// PUT /zones/:id/crossfade — rejected bodies
// ------------------------------------------------------------------------

const BAD_BODIES: [string, string | undefined][] = [
  ["no body at all", undefined],
  ["an empty object (missing fields)", "{}"],
  ["enabled with no durationMs", JSON.stringify({ enabled: true })],
  ["durationMs with no enabled", JSON.stringify({ durationMs: 4000 })],
  ["a non-integer durationMs", JSON.stringify({ enabled: true, durationMs: 4000.5 })],
  ['the string "4000"', JSON.stringify({ enabled: true, durationMs: "4000" })],
  ["999", JSON.stringify({ enabled: true, durationMs: 999 })],
  ["10001", JSON.stringify({ enabled: true, durationMs: 10001 })],
  ["1250 (not a multiple of 500)", JSON.stringify({ enabled: true, durationMs: 1250 })],
  ["an extra property", JSON.stringify({ enabled: true, durationMs: 4000, curve: "linear" })],
  ["enabled as a string", JSON.stringify({ enabled: "true", durationMs: 4000 })],
  ["a JSON array", JSON.stringify([true, 4000])],
  ["a JSON string", JSON.stringify("on")],
  ["a JSON number", "4000"],
  ["a JSON boolean", "true"],
]

for (const [label, payload] of BAD_BODIES) {
  test(`PUT rejects ${label} with 400 and writes nothing`, async () => {
    const res = await putCrossfade("saved", payload)
    assert.equal(res.statusCode, 400, res.body)
    assert.equal(zoneWrites.length, 0)
    assert.deepEqual(row("saved").crossfade, SAVED)
  })
}

test("a VIEWER (no zone:assign) gets 403 and nothing is written", async () => {
  const res = await putCrossfade("plain", JSON.stringify({ enabled: true, durationMs: 4000 }), viewerToken)
  assert.equal(res.statusCode, 403, res.body)
  assert.equal(zoneWrites.length, 0)
  assert.equal(row("plain").crossfade, null)
})

test("an organization admin can set crossfade on their own organization's zone", async () => {
  const res = await putCrossfade("plain", JSON.stringify({ enabled: true, durationMs: 3500 }), orgAdminToken)
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(row("plain").crossfade, { enabled: true, durationMs: 3500 })
})

for (const [label, token] of [
  ["an admin of another organization", () => otherOrgAdminToken],
  ["a location manager at another venue", () => otherVenueManagerToken],
] as const) {
  test(`${label} gets 404 and nothing is written`, async () => {
    const res = await putCrossfade("saved", JSON.stringify({ enabled: false, durationMs: 4500 }), token())
    assert.equal(res.statusCode, 404, res.body)
    assert.equal(zoneWrites.length, 0)
    assert.deepEqual(row("saved").crossfade, SAVED)
  })
}

// ------------------------------------------------------------------------
// PUT /zones/:id/crossfade — accepted bodies
// ------------------------------------------------------------------------

for (const value of [
  { enabled: true, durationMs: 4000 },
  { enabled: true, durationMs: 1500 },
  { enabled: true, durationMs: 1000 },
  { enabled: true, durationMs: 10000 },
  { enabled: false, durationMs: 3000 },
]) {
  test(`PUT accepts ${JSON.stringify(value)} and writes only crossfade`, async () => {
    const res = await putCrossfade("plain", JSON.stringify(value))
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(row("plain").crossfade, value)
    assert.deepEqual(res.json().crossfade, value)
    assert.deepEqual(zoneWrites.map((w) => Object.keys(w.data)), [["crossfade"]])
  })
}

test("PUT null stores database null", async () => {
  const res = await putCrossfade("saved", "null")
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(zoneWrites.length, 1)
  assert.equal(zoneWrites[0].data.crossfade, DbNull, "must be database null, not a JSON null value")
  assert.equal(row("saved").crossfade, null)
  assert.equal(res.json().crossfade, null)
})

// ------------------------------------------------------------------------
// POST /server/zone-playlists/sync
// ------------------------------------------------------------------------

test("sync carries the saved crossfade, null when unset, and keeps every existing key", async () => {
  const items = await sync()
  assert.equal(items.size, 3)
  const saved = items.get(`${P}saved`)!
  assert.deepEqual(Object.keys(saved).sort(), [
    "crossfade",
    "currentTrackId",
    "excludedTrackIds",
    "localZoneId",
    "playlistId",
    "trackIds",
    "zoneId",
  ])
  assert.deepEqual(saved.crossfade, SAVED)
  assert.equal(saved.localZoneId, "saved")
  assert.equal(saved.playlistId, `${P}pl`)
  assert.deepEqual([...(saved.trackIds as string[])].sort(), [`${P}t1`, `${P}t2`])
  assert.deepEqual(saved.excludedTrackIds, [`${P}t2`])
  assert.equal(saved.currentTrackId, `${P}t1`)
  assert.equal(items.get(`${P}plain`)!.crossfade, null)
  assert.equal(items.get(`${P}eq`)!.crossfade, null)
})

test("an invalid stored crossfade is sent as null and the sync still returns 200", async () => {
  zones.push(
    zone("bad-type", { crossfade: "on" }),
    zone("bad-range", { crossfade: { enabled: true, durationMs: 250 } }),
    zone("bad-step", { crossfade: { enabled: true, durationMs: 1250 } }),
    zone("bad-extra", { crossfade: { enabled: true, durationMs: 4000, curve: "linear" } }),
    zone("bad-enabled", { crossfade: { enabled: "yes", durationMs: 4000 } }),
    zone("bad-array", { crossfade: [true, 4000] })
  )
  const items = await sync()
  assert.equal(items.size, 9, "no zone may be skipped")
  for (const id of ["bad-type", "bad-range", "bad-step", "bad-extra", "bad-enabled", "bad-array"]) {
    const item = items.get(`${P}${id}`)!
    assert.equal(item.crossfade, null, id)
    assert.equal(item.localZoneId, id)
  }
  assert.deepEqual(items.get(`${P}saved`)!.crossfade, SAVED)
})

// ------------------------------------------------------------------------
// Crossfade and equalizer stay independent
// ------------------------------------------------------------------------

test("saving crossfade leaves equalizer unchanged", async () => {
  const res = await putCrossfade("eq", JSON.stringify({ enabled: true, durationMs: 5000 }))
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(row("eq").equalizer, EQ)
  assert.deepEqual(res.json().equalizer, EQ)
  assert.deepEqual(zoneWrites.map((w) => Object.keys(w.data)), [["crossfade"]])
})

test("saving equalizer (the SET_EQ ack) leaves crossfade unchanged", async () => {
  const nextEq = { ...EQ, presetId: "jazz" }
  commands.push({
    id: `${P}cmd-eq`,
    serverId: SERVER,
    zoneId: `${P}saved`,
    type: "SET_EQ",
    payload: nextEq,
    status: "SENT",
    sequence: 7,
    executingAt: null,
    completedAt: null,
    resultMessage: null,
  })
  const res = await app.inject({
    method: "POST",
    url: "/api/server/commands/ack",
    headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
    payload: JSON.stringify({
      commandId: `${P}cmd-eq`,
      status: "SUCCESS",
      zoneState: { volume: 40, muted: false, playbackState: "PLAYING" },
    }),
  })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(row("saved").equalizer, nextEq)
  assert.deepEqual(row("saved").crossfade, SAVED)
  assert.equal(zoneWrites.length, 1)
  assert.ok(!("crossfade" in zoneWrites[0].data), "the SET_EQ ack must not write crossfade")
})
