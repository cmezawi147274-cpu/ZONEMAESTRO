import { test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { FastifyInstance } from "fastify"

/**
 * Per-zone output device name: what POST /api/server/zones/sync stores from
 * the venue agent's optional `outputDeviceName`, and what the zone list and
 * zone detail the portal loads (GET /api/zones, GET /api/zones/:id) return.
 *
 * No database: every Prisma call these routes make is replaced by an
 * in-memory fake below, and DATABASE_URL points nowhere, so an unstubbed
 * query fails loudly instead of touching real data.
 */

const P = "zzoutdev-"
const SERVER = `${P}srv`
const AGENT_TOKEN = `${SERVER}.zz-agent-secret`
const HEADPHONES = "Headphones (JLab JBuds Lux ANC)"

type Row = Record<string, unknown> & { id: string }

type Db = typeof import("../src/lib/db.js")
let prisma: Db["prisma"]
let app: FastifyInstance
let superToken: string

let zones: Row[] = []
let zoneWrites: { op: "create" | "update"; data: Record<string, unknown> }[] = []
let nextId = 0

function zoneRow(over: Record<string, unknown>): Row {
  return {
    id: `${P}zone-${++nextId}`,
    serverId: SERVER,
    locationId: `${P}loc`,
    localZoneId: null,
    name: "Zone",
    playbackState: "OFFLINE",
    currentPlaylistId: null,
    currentTrackId: null,
    volume: 50,
    muted: false,
    updatedAt: new Date("2026-10-01T07:00:00Z"),
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
    ...over,
  }
}

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
  const { default: Fastify } = await import("fastify")
  const { HttpError } = await import("../src/lib/http-error.js")
  const { signAccessToken } = await import("../src/lib/jwt.js")
  const { sha256Hex } = await import("../src/lib/agent-auth.js")
  const { default: zonesRoutes } = await import("../src/routes/zones.js")
  const { default: agentRoutes } = await import("../src/routes/agent.js")

  stub(prisma.musicServer, "findUnique", async ({ where }: any) =>
    where.id === SERVER
      ? { id: SERVER, name: "ZZ venue", organizationId: `${P}org`, locationId: `${P}loc`, agentTokenHash: sha256Hex(AGENT_TOKEN) }
      : null
  )
  stub(prisma.deletedServerTombstone, "findUnique", async () => null)
  stub(prisma.zone, "findUnique", async ({ where }: any) => {
    const key = where.serverId_localZoneId
    const z = key
      ? zones.find((r) => r.serverId === key.serverId && r.localZoneId === key.localZoneId)
      : zones.find((r) => r.id === where.id)
    return z ? structuredClone(z) : null
  })
  stub(prisma.zone, "create", async ({ data }: any) => {
    zoneWrites.push({ op: "create", data })
    const z = zoneRow(structuredClone(data))
    zones.push(z)
    return structuredClone(z)
  })
  stub(prisma.zone, "update", async ({ where, data }: any) => {
    const z = zones.find((r) => r.id === where.id)
    assert.ok(z, `update of unknown zone ${where.id}`)
    zoneWrites.push({ op: "update", data })
    Object.assign(z, structuredClone(data))
    return structuredClone(z)
  })
  stub(prisma.zone, "findMany", async ({ where }: any) => {
    // zones/sync's stale-zone query: nothing in these tests is stale.
    if (where?.NOT) return []
    return zones.filter((z) => !where?.serverId || z.serverId === where.serverId).map((z) => structuredClone(z))
  })
  stub(prisma.zone, "deleteMany", async () => ({ count: 0 }))

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
})

after(async () => {
  await app?.close()
  for (const [delegate, method, original] of originals.reverse()) delegate[method] = original
  await prisma?.$disconnect()
})

beforeEach(() => {
  zones = []
  zoneWrites = []
})

async function zonesSync(zone: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/server/zones/sync",
    headers: { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" },
    payload: JSON.stringify({ zones: [{ localZoneId: "lobby", name: "Lobby", playbackState: "PLAYING", volume: 40, muted: false, ...zone }] }),
  })
  assert.equal(res.statusCode, 200, res.body)
  return res.json().zones as { localZoneId: string; zoneId: string }[]
}

async function zoneList() {
  const res = await app.inject({ method: "GET", url: "/api/zones", headers: { authorization: `Bearer ${superToken}` } })
  assert.equal(res.statusCode, 200, res.body)
  return res.json() as Record<string, unknown>[]
}

async function zoneDetail(id: string) {
  const res = await app.inject({ method: "GET", url: `/api/zones/${id}`, headers: { authorization: `Bearer ${superToken}` } })
  assert.equal(res.statusCode, 200, res.body)
  return res.json() as Record<string, unknown>
}

test("a zone with no stored value reports outputDeviceName null (older agent omits the field)", async () => {
  const [mapped] = await zonesSync({})
  assert.equal(zoneWrites[0].op, "create")
  assert.ok(!("outputDeviceName" in zoneWrites[0].data), "a missing field must not be written")
  const [listed] = await zoneList()
  assert.equal(listed.outputDeviceName, null)
  assert.equal((await zoneDetail(mapped.zoneId)).outputDeviceName, null)
})

test("zones/sync with outputDeviceName stores it and the zone list and detail show it", async () => {
  const [first] = await zonesSync({})
  await zonesSync({ outputDeviceName: HEADPHONES })
  assert.deepEqual(zoneWrites[1], {
    op: "update",
    data: { name: "Lobby", playbackState: "PLAYING", volume: 40, muted: false, outputDeviceName: HEADPHONES },
  })
  const [listed] = await zoneList()
  assert.equal(listed.outputDeviceName, HEADPHONES)
  assert.equal((await zoneDetail(first.zoneId)).outputDeviceName, HEADPHONES)
})

test("a later zones/sync without the field keeps the last value", async () => {
  const [first] = await zonesSync({ outputDeviceName: HEADPHONES })
  await zonesSync({})
  assert.equal(zoneWrites[1].op, "update")
  assert.ok(!("outputDeviceName" in zoneWrites[1].data), "a missing field must not overwrite the stored value")
  assert.equal((await zoneDetail(first.zoneId)).outputDeviceName, HEADPHONES)
})

test("the value is trimmed and capped at 200 characters; a non-string leaves it unchanged", async () => {
  const [first] = await zonesSync({ outputDeviceName: `  ${"x".repeat(250)}  ` })
  assert.equal((await zoneDetail(first.zoneId)).outputDeviceName, "x".repeat(200))
  await zonesSync({ outputDeviceName: "  Speakers (Realtek(R) Audio)  " })
  assert.equal((await zoneDetail(first.zoneId)).outputDeviceName, "Speakers (Realtek(R) Audio)")
  for (const notAString of [42, null, true, { name: "x" }]) {
    await zonesSync({ outputDeviceName: notAString })
    assert.equal((await zoneDetail(first.zoneId)).outputDeviceName, "Speakers (Realtek(R) Audio)", JSON.stringify(notAString))
  }
})
