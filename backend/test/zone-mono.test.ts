import { test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { FastifyInstance } from "fastify"

/**
 * Per-zone Mono rides SET_EQ (`equalizer.mono`). A SUCCESS ack for a SET_EQ
 * that asked for mono only counts when the agent reports `zoneState.mono:
 * true`; an older agent that wrote the curve but knows nothing of mono is
 * recorded as FAILED, and the zone saves that curve with mono off, which is
 * what the PC is really playing.
 *
 * No database: every Prisma call the ack route makes is replaced by an
 * in-memory fake below, and DATABASE_URL points nowhere, so an unstubbed
 * query fails loudly instead of touching real data.
 */

const P = "zzmono-"
const SERVER = `${P}srv`
const ZONE = `${P}zone`
const AGENT_TOKEN = `${SERVER}.zz-agent-secret`

type Row = Record<string, any>

type Db = typeof import("../src/lib/db.js")
let prisma: Db["prisma"]
let app: FastifyInstance

let zone: Row
let commands: Row[] = []
let nextId = 0

const flat = { enabled: false, presetId: "flat", bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bassBoost: { on: false, amount: 50 }, loudness: { on: false, amount: 50 }, virtualizer: { on: false, amount: 50 } }

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
  const { sha256Hex } = await import("../src/lib/agent-auth.js")
  const { default: agentRoutes } = await import("../src/routes/agent.js")

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
    Object.assign(c, structuredClone(data))
    return structuredClone(c)
  })
  stub(prisma.zone, "findUnique", async ({ where }: any) => (where.id === zone.id ? structuredClone(zone) : null))
  stub(prisma.zone, "update", async ({ where, data }: any) => {
    assert.equal(where.id, zone.id)
    Object.assign(zone, structuredClone(data))
    return structuredClone(zone)
  })
  stub(prisma.activityEvent, "create", async ({ data }: any) => data)
  stub(prisma.alert, "create", async () => assert.fail("a zone SET_EQ failure must not raise an Alert"))

  app = Fastify()
  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send({ code: error.code, message: error.message })
    return reply.status(error.statusCode ?? 500).send({ code: error.code, message: error.message })
  })
  await app.register(agentRoutes)
  await app.ready()
})

after(async () => {
  await app?.close()
  for (const [delegate, method, original] of originals.reverse()) delegate[method] = original
  await prisma?.$disconnect()
})

beforeEach(() => {
  zone = { id: ZONE, serverId: SERVER, volume: 40, muted: false, playbackState: "PLAYING", equalizer: null, lastAppliedSequence: 0 }
  commands = []
})

async function ackSetEq(payload: Record<string, unknown>, zoneState: Record<string, unknown>) {
  const id = `${P}cmd-${++nextId}`
  commands.push({ id, serverId: SERVER, zoneId: ZONE, type: "SET_EQ", payload, status: "SENT", sequence: nextId, executingAt: null, completedAt: null, resultMessage: null })
  const res = await app.inject({
    method: "POST",
    url: "/api/server/commands/ack",
    headers: { authorization: `Bearer ${AGENT_TOKEN}` },
    payload: { commandId: id, status: "SUCCESS", zoneState },
  })
  assert.equal(res.statusCode, 200, res.body)
  return commands.find((c) => c.id === id)!
}

const state = { playbackState: "Playing", volume: 40, muted: false }

test("mono confirmed by the agent: SUCCESS, and the zone saves mono", async () => {
  const cmd = await ackSetEq({ ...flat, mono: true }, { ...state, mono: true })
  assert.equal(cmd.status, "SUCCESS")
  assert.equal(zone.equalizer.mono, true)
})

test("mono asked of an older agent (no zoneState.mono): FAILED, zone saved with mono off", async () => {
  const cmd = await ackSetEq({ ...flat, enabled: true, mono: true }, state)
  assert.equal(cmd.status, "FAILED")
  assert.match(cmd.resultMessage, /newest venue installer/)
  assert.deepEqual(zone.equalizer, { ...flat, enabled: true, mono: false })
})

test("a PC back on an older agent after mono was on: the zone stops showing mono", async () => {
  zone.equalizer = { ...flat, mono: true }
  const cmd = await ackSetEq({ ...flat, mono: true }, state)
  assert.equal(cmd.status, "FAILED")
  assert.equal(zone.equalizer.mono, false)
})

test("mono asked but the agent reports mono: false: FAILED", async () => {
  const cmd = await ackSetEq({ ...flat, mono: true }, { ...state, mono: false })
  assert.equal(cmd.status, "FAILED")
  assert.equal(zone.equalizer.mono, false)
})

test("turning mono off on an older agent still succeeds", async () => {
  const cmd = await ackSetEq({ ...flat, mono: false }, state)
  assert.equal(cmd.status, "SUCCESS")
  assert.equal(zone.equalizer.mono, false)
})

test("a plain EQ change from an older agent is unaffected", async () => {
  const cmd = await ackSetEq({ ...flat, enabled: true, bands: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0] }, state)
  assert.equal(cmd.status, "SUCCESS")
  assert.equal(zone.equalizer.enabled, true)
  assert.equal("mono" in zone.equalizer, false)
})
