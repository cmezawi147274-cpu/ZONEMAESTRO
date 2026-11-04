import { test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { FastifyInstance } from "fastify"

/**
 * POST /api/pairing/complete with previousServerId moves the old row's own
 * Prayer Mode settings (ServerPrayerOverride) to the new row, and never
 * fails a pairing over them.
 *
 * No database: every Prisma call is replaced by an in-memory fake below,
 * and DATABASE_URL points nowhere, so an unstubbed query fails loudly.
 */

const P = "zzrepair-"
const ORG = `${P}org`
const OTHER_ORG = `${P}other-org`

type Row = Record<string, any> & { id: string }
type Db = typeof import("../src/lib/db.js")
let prisma: Db["prisma"]
let app: FastifyInstance
let hashPairingCode: (c: string) => string

let servers: Row[] = []
let overrides: Record<string, { serverId: string; prayers: unknown; updatedAt: Date }> = {}
let calls: string[] = []
let failMode: null | "findUnique" | "upsert" | "deleteMany" = null

const OWN = { FAJR: { enabled: true, offsetMinutes: 5, pauseDurationMinutes: 20 } }
const NEWOWN = { FAJR: { enabled: false, offsetMinutes: 1, pauseDurationMinutes: 2 } }

const originals: [any, string, unknown][] = []
function stub(delegate: any, method: string, impl: (...args: any[]) => unknown) {
  originals.push([delegate, method, delegate[method]])
  delegate[method] = impl
}

let codeCounter = 0
function server(id: string, over: Record<string, unknown> = {}): Row {
  return {
    id,
    name: id,
    organizationId: ORG,
    locationId: `${P}loc-${id}`,
    status: "ONLINE",
    version: "1.0.0",
    pairingCodeHash: null,
    pairingExpiresAt: null,
    pairingConsumedCodeHash: null,
    pairingConsumedAt: null,
    pairingConsumedTokenPlain: null,
    pairingRevokedCodeHash: null,
    agentTokenHash: "old",
    ...over,
  }
}

before(async () => {
  process.env.DATABASE_URL = "postgresql://no-db:no-db@127.0.0.1:1/no-db"
  process.env.JWT_ACCESS_SECRET ??= "zz-test-access"
  process.env.JWT_REFRESH_SECRET ??= "zz-test-refresh"
  process.env.MUSIC_SERVER_AGENT_ALLOWED = "true"
  process.env.AGENT_API_PREFIX = "/api"
  ;({ prisma } = await import("../src/lib/db.js"))
  ;({ hashPairingCode } = await import("../src/lib/pairing.js"))
  const { default: Fastify } = await import("fastify")
  const { HttpError } = await import("../src/lib/http-error.js")
  const { default: agentRoutes } = await import("../src/routes/agent.js")

  const matches = (r: Row, where: Record<string, any>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && "gt" in v) return r[k] != null && r[k] > v.gt
      return r[k] === v
    })
  stub(prisma.musicServer, "findFirst", async ({ where }: any) => {
    const s = servers.find((r) => matches(r, where))
    return s ? structuredClone(s) : null
  })
  stub(prisma.musicServer, "findUnique", async ({ where }: any) => {
    const s = servers.find((r) => r.id === where.id)
    return s ? structuredClone(s) : null
  })
  stub(prisma.musicServer, "update", async ({ where, data }: any) => {
    const s = servers.find((r) => r.id === where.id)
    assert.ok(s, `update of unknown server ${where.id}`)
    Object.assign(s, data)
    calls.push(`musicServer.update:${where.id}`)
    return structuredClone(s)
  })
  stub(prisma.agentLink, "upsert", async () => ({}))
  stub(prisma.activityEvent, "create", async () => ({}))

  const so: any = prisma.serverPrayerOverride
  stub(so, "findUnique", (args: any) => {
    calls.push(`override.findUnique:${args.where.serverId}`)
    if (failMode === "findUnique") return Promise.reject(new Error("db down"))
    const o = overrides[args.where.serverId]
    return Promise.resolve(o ? structuredClone(o) : null)
  })
  stub(so, "upsert", async (args: any) => {
    calls.push(`override.upsert:${args.where.serverId}`)
    if (failMode === "upsert") throw new Error("db down")
    const existing = overrides[args.where.serverId]
    if (existing) {
      Object.assign(existing, args.update)
      return structuredClone(existing)
    }
    overrides[args.where.serverId] = { serverId: args.create.serverId, prayers: structuredClone(args.create.prayers), updatedAt: new Date() }
    return structuredClone(overrides[args.where.serverId])
  })
  stub(so, "deleteMany", async (args: any) => {
    calls.push(`override.deleteMany:${args.where.serverId}`)
    if (failMode === "deleteMany") throw new Error("db down")
    const had = !!overrides[args.where.serverId]
    delete overrides[args.where.serverId]
    return { count: had ? 1 : 0 }
  })
  stub(so, "create", async () => assert.fail("must use upsert, not create"))
  stub(so, "update", async () => assert.fail("must use upsert, not update"))

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
  servers = []
  overrides = {}
  calls = []
  failMode = null
})

/** Sets up an OLD paired row and a NEW row awaiting `code`, returns the code. */
function setup(opts: { oldOrg?: string } = {}) {
  const code = `ZZRP-${String(++codeCounter).padStart(4, "0")}`
  servers.push(server(`${P}old`, { organizationId: opts.oldOrg ?? ORG }))
  servers.push(
    server(`${P}new`, {
      status: "UNKNOWN",
      agentTokenHash: null,
      pairingCodeHash: hashPairingCode(code),
      pairingExpiresAt: new Date(Date.now() + 60_000),
    })
  )
  return code
}

function pair(code: string, previousServerId?: string) {
  return app.inject({
    method: "POST",
    url: "/api/pairing/complete",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ code, serverGuid: `${P}guid-${code}`, ...(previousServerId ? { previousServerId } : {}) }),
  })
}

test("moves the old row's own settings to the new row and deletes the old one", async () => {
  const code = setup()
  overrides[`${P}old`] = { serverId: `${P}old`, prayers: structuredClone(OWN), updatedAt: new Date() }
  const res = await pair(code, `${P}old`)
  assert.equal(res.statusCode, 201, res.body)
  assert.equal(res.json().serverId, `${P}new`)
  assert.deepEqual(overrides[`${P}new`]?.prayers, OWN)
  assert.equal(overrides[`${P}old`], undefined)
  assert.equal(servers.find((s) => s.id === `${P}old`)!.agentTokenHash, null)
})

test("keeps the new row's own settings when it already had some (old one still removed)", async () => {
  const code = setup()
  overrides[`${P}old`] = { serverId: `${P}old`, prayers: structuredClone(OWN), updatedAt: new Date() }
  overrides[`${P}new`] = { serverId: `${P}new`, prayers: structuredClone(NEWOWN), updatedAt: new Date() }
  const res = await pair(code, `${P}old`)
  assert.equal(res.statusCode, 201, res.body)
  assert.deepEqual(overrides[`${P}new`]?.prayers, NEWOWN)
  assert.equal(overrides[`${P}old`], undefined)
})

test("no override on the old row: nothing written", async () => {
  const code = setup()
  const res = await pair(code, `${P}old`)
  assert.equal(res.statusCode, 201, res.body)
  assert.deepEqual(overrides, {})
  assert.ok(!calls.some((c) => c.startsWith("override.upsert") || c.startsWith("override.deleteMany")), calls.join(","))
})

for (const mode of ["findUnique", "upsert", "deleteMany"] as const) {
  test(`pairing still succeeds when override ${mode} rejects`, async () => {
    const code = setup()
    overrides[`${P}old`] = { serverId: `${P}old`, prayers: structuredClone(OWN), updatedAt: new Date() }
    failMode = mode
    const res = await pair(code, `${P}old`)
    assert.equal(res.statusCode, 201, res.body)
    assert.ok(res.json().agentToken)
    assert.ok(overrides[`${P}old`] || overrides[`${P}new`], "the settings are on one row or the other, never lost")
  })
}

test("skipped across organizations: old row in another org is neither released nor read", async () => {
  const code = setup({ oldOrg: OTHER_ORG })
  overrides[`${P}old`] = { serverId: `${P}old`, prayers: structuredClone(OWN), updatedAt: new Date() }
  const res = await pair(code, `${P}old`)
  assert.equal(res.statusCode, 201, res.body)
  assert.deepEqual(overrides[`${P}old`]?.prayers, OWN)
  assert.equal(overrides[`${P}new`], undefined)
  assert.ok(!calls.some((c) => c.startsWith("override.")), calls.join(","))
  assert.equal(servers.find((s) => s.id === `${P}old`)!.agentTokenHash, "old")
})

test("previousServerId === active id: no override work", async () => {
  const code = setup()
  overrides[`${P}new`] = { serverId: `${P}new`, prayers: structuredClone(NEWOWN), updatedAt: new Date() }
  const res = await pair(code, `${P}new`)
  assert.equal(res.statusCode, 201, res.body)
  assert.deepEqual(overrides[`${P}new`]?.prayers, NEWOWN)
  assert.ok(!calls.some((c) => c.startsWith("override.")), calls.join(","))
})

test("unknown previousServerId: no override work, pairing succeeds", async () => {
  const code = setup()
  const res = await pair(code, `${P}ghost`)
  assert.equal(res.statusCode, 201, res.body)
  assert.ok(!calls.some((c) => c.startsWith("override.")), calls.join(","))
})

test("replay of the same code within the window does not re-run the move", async () => {
  const code = setup()
  overrides[`${P}old`] = { serverId: `${P}old`, prayers: structuredClone(OWN), updatedAt: new Date() }
  const first = await pair(code, `${P}old`)
  assert.equal(first.statusCode, 201, first.body)
  calls = []
  const replay = await pair(code, `${P}old`)
  assert.equal(replay.statusCode, 201, replay.body)
  assert.equal(replay.json().agentToken, first.json().agentToken)
  assert.ok(!calls.some((c) => c.startsWith("override.")), calls.join(","))
  assert.deepEqual(overrides[`${P}new`]?.prayers, OWN)
})
