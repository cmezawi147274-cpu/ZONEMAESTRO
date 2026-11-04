import { test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { FastifyInstance } from "fastify"

/**
 * A Music Server's own Prayer Mode settings: GET/PUT/DELETE
 * /api/servers/:id/prayer and GET /api/prayer/server-overrides — who may
 * read and change them, what PUT accepts, and which organization's
 * settings a server falls back to.
 *
 * No database: every Prisma call these routes make is replaced by an
 * in-memory fake below, and DATABASE_URL points nowhere, so an unstubbed
 * query fails loudly instead of touching real data.
 */

const P = "zzsrvprayer-"
const ORG = `${P}org`
const OTHER_ORG = `${P}other-org`
const NAMES = ["FAJR", "DHUHR", "ASR", "MAGHRIB", "ISHA"] as const

type Db = typeof import("../src/lib/db.js")
let prisma: Db["prisma"]
let app: FastifyInstance
const tokens: Record<string, string> = {}

const servers: Record<string, { id: string; name: string; organizationId: string; locationId: string }> = {
  alpha: { id: `${P}srv-alpha`, name: "Alpha", organizationId: ORG, locationId: `${P}loc-1` },
  bravo: { id: `${P}srv-bravo`, name: "Bravo", organizationId: ORG, locationId: `${P}loc-2` },
  other: { id: `${P}srv-other`, name: "Other", organizationId: OTHER_ORG, locationId: `${P}loc-x` },
}

function prayers(offsetMinutes: number, pauseDurationMinutes = 10, enabled = true) {
  return Object.fromEntries(NAMES.map((n) => [n, { enabled, offsetMinutes, pauseDurationMinutes }]))
}

let configs: Record<string, Record<string, unknown>> = {}
let overrides: Record<string, { serverId: string; prayers: unknown; updatedAt: Date }> = {}
let upserts: any[] = []
let deletes: any[] = []
let serverListWheres: any[] = []

const originals: [any, string, unknown][] = []
function stub(delegate: any, method: string, impl: (...args: any[]) => unknown) {
  originals.push([delegate, method, delegate[method]])
  delegate[method] = impl
}

before(async () => {
  process.env.DATABASE_URL = "postgresql://no-db:no-db@127.0.0.1:1/no-db"
  process.env.JWT_ACCESS_SECRET ??= "zz-test-access"
  process.env.JWT_REFRESH_SECRET ??= "zz-test-refresh"
  ;({ prisma } = await import("../src/lib/db.js"))
  const { default: Fastify } = await import("fastify")
  const { HttpError } = await import("../src/lib/http-error.js")
  const { signAccessToken } = await import("../src/lib/jwt.js")
  const { default: serverPrayerRoutes } = await import("../src/routes/server-prayer.js")

  stub(prisma.musicServer, "findUnique", async ({ where }: any) => {
    const s = Object.values(servers).find((r) => r.id === where.id)
    return s ? { ...s } : null
  })
  stub(prisma.musicServer, "findMany", async ({ where }: any) => {
    serverListWheres.push(where)
    return Object.values(servers)
      .filter((s) => s.organizationId === where.organizationId && overrides[s.id] && (!where.locationId || s.locationId === where.locationId))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ id: s.id, name: s.name }))
  })
  // A Super Admin with no organization: the oldest is deliberately the
  // OTHER organization, so falling back to it would show the wrong defaults.
  stub(prisma.organization, "findFirst", async () => ({ id: OTHER_ORG }))
  stub(prisma.prayerConfig, "findUnique", async ({ where }: any) =>
    configs[where.organizationId] ? { organizationId: where.organizationId, prayers: structuredClone(configs[where.organizationId]) } : null
  )
  stub(prisma.prayerConfig, "create", async () => assert.fail("reading a server's settings must never create a PrayerConfig"))
  stub(prisma.prayerConfig, "upsert", async () => assert.fail("a server's settings must never write the organization's"))
  stub(prisma.serverPrayerOverride, "findUnique", async ({ where }: any) => (overrides[where.serverId] ? structuredClone(overrides[where.serverId]) : null))
  stub(prisma.serverPrayerOverride, "upsert", async (args: any) => {
    upserts.push(args)
    overrides[args.where.serverId] = { serverId: args.where.serverId, prayers: structuredClone(args.update.prayers), updatedAt: new Date("2026-11-03T08:00:00Z") }
    return overrides[args.where.serverId]
  })
  stub(prisma.serverPrayerOverride, "deleteMany", async (args: any) => {
    deletes.push(args)
    const had = !!overrides[args.where.serverId]
    delete overrides[args.where.serverId]
    return { count: had ? 1 : 0 }
  })

  app = Fastify()
  // Same mapping as src/index.ts: an HttpError carries its own status.
  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send({ code: error.code, message: error.message })
    return reply.status(error.statusCode ?? 500).send({ code: error.code, message: error.message })
  })
  await app.register(async (api) => {
    await api.register(serverPrayerRoutes)
  }, { prefix: "/api" })
  await app.ready()

  const sign = (name: string, role: any, organizationId: string | null, locationId: string | null) => {
    tokens[name] = signAccessToken({ id: `${P}${name}`, email: `${name}@example.test`, role, organizationId, locationId })
  }
  sign("super", "SUPER_ADMIN", null, null)
  sign("admin", "ORGANIZATION_ADMIN", ORG, null)
  sign("otherAdmin", "ORGANIZATION_ADMIN", OTHER_ORG, null)
  sign("manager", "LOCATION_MANAGER", ORG, `${P}loc-1`)
  sign("otherManager", "LOCATION_MANAGER", ORG, `${P}loc-2`)
  sign("viewer", "VIEWER", ORG, `${P}loc-1`)
})

after(async () => {
  await app?.close()
  for (const [delegate, method, original] of originals.reverse()) delegate[method] = original
  await prisma?.$disconnect()
})

beforeEach(() => {
  configs = { [ORG]: prayers(2), [OTHER_ORG]: prayers(7) }
  overrides = {}
  upserts = []
  deletes = []
  serverListWheres = []
})

function call(method: "GET" | "PUT" | "DELETE", server: keyof typeof servers | string, who?: string, body?: unknown) {
  const id = servers[server]?.id ?? server
  return app.inject({
    method,
    url: `/api/servers/${id}/prayer`,
    headers: {
      ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  })
}

test("the stubs are in place — nothing reaches a database", async () => {
  assert.equal((await prisma.musicServer.findUnique({ where: { id: servers.alpha.id } }))?.name, "Alpha")
})

test("a server without its own settings follows its organization's", async () => {
  const res = await call("GET", "alpha", "admin")
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { custom: false, prayers: prayers(2), organizationPrayers: prayers(2), updatedAt: null })
})

test("an organization with no saved Prayer Mode settings: the scheduler's defaults, and nothing is created", async () => {
  delete configs[ORG]
  const res = await call("GET", "alpha", "admin")
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().organizationPrayers, prayers(0, 10))
  assert.deepEqual(res.json().prayers, prayers(0, 10))
})

test("a prayer missing from the organization's saved settings shows as off, the way the scheduler treats it", async () => {
  const partial = prayers(2)
  delete partial.ISHA
  configs[ORG] = partial
  const res = await call("GET", "alpha", "admin")
  assert.deepEqual(res.json().organizationPrayers.ISHA, { enabled: false, offsetMinutes: 0, pauseDurationMinutes: 10 })
})

test("an Organization Administrator saves, reads back and resets a server's own settings", async () => {
  const own = { ...prayers(5, 20), ASR: { enabled: false, offsetMinutes: -30, pauseDurationMinutes: 60 } }
  const saved = await call("PUT", "alpha", "admin", { prayers: own })
  assert.equal(saved.statusCode, 200)
  assert.deepEqual(saved.json(), { custom: true, prayers: own, organizationPrayers: prayers(2), updatedAt: "2026-11-03T08:00:00.000Z" })
  assert.equal(upserts.length, 1)
  assert.deepEqual(upserts[0].where, { serverId: servers.alpha.id })
  assert.deepEqual(upserts[0].create, { serverId: servers.alpha.id, prayers: own })
  assert.deepEqual(upserts[0].update, { prayers: own })

  const read = await call("GET", "alpha", "admin")
  assert.deepEqual(read.json(), saved.json())
  assert.equal((await call("GET", "bravo", "admin")).json().custom, false, "only that server")

  const reset = await call("DELETE", "alpha", "admin")
  assert.equal(reset.statusCode, 204)
  assert.deepEqual(deletes, [{ where: { serverId: servers.alpha.id } }])
  assert.equal((await call("DELETE", "alpha", "admin")).statusCode, 204, "resetting twice is fine")
  assert.deepEqual((await call("GET", "alpha", "admin")).json(), { custom: false, prayers: prayers(2), organizationPrayers: prayers(2), updatedAt: null })
})

test("PUT accepts exactly the five prayers with whole minutes in range", async () => {
  const bad: [string, unknown][] = [
    ["no body", undefined],
    ["no prayers", {}],
    ["prayers is a list", { prayers: [] }],
    ["a prayer missing", { prayers: (({ ISHA, ...rest }) => rest)(prayers(0)) }],
    ["an extra prayer", { prayers: { ...prayers(0), SUNRISE: { enabled: true, offsetMinutes: 0, pauseDurationMinutes: 10 } } }],
    ["an extra field", { prayers: { ...prayers(0), FAJR: { enabled: true, offsetMinutes: 0, pauseDurationMinutes: 10, volume: 3 } } }],
    ["a missing field", { prayers: { ...prayers(0), FAJR: { enabled: true, offsetMinutes: 0 } } }],
    ["enabled not a boolean", { prayers: { ...prayers(0), FAJR: { enabled: "yes", offsetMinutes: 0, pauseDurationMinutes: 10 } } }],
    ["offset a fraction", { prayers: prayers(1.5) }],
    ["offset a string", { prayers: prayers("5" as any) }],
    ["offset below -30", { prayers: prayers(-31) }],
    ["offset above 60", { prayers: prayers(61) }],
    ["pause 0", { prayers: prayers(0, 0) }],
    ["pause above 60", { prayers: prayers(0, 61) }],
    ["a prayer that is off still needs valid minutes", { prayers: { ...prayers(0), FAJR: { enabled: false, offsetMinutes: 0, pauseDurationMinutes: 0 } } }],
  ]
  for (const [label, body] of bad) {
    const res = await call("PUT", "alpha", "admin", body ?? undefined)
    assert.equal(res.statusCode, 400, label)
  }
  assert.equal(upserts.length, 0, "nothing invalid was saved")

  for (const ok of [prayers(-30, 1), prayers(60, 60), prayers(0, 10, false)]) {
    assert.equal((await call("PUT", "alpha", "admin", { prayers: ok })).statusCode, 200)
  }
})

test("a Location Manager sees their own venue's server read-only", async () => {
  assert.equal((await call("GET", "alpha", "manager")).statusCode, 200)
  assert.equal((await call("PUT", "alpha", "manager", { prayers: prayers(0) })).statusCode, 403)
  assert.equal((await call("DELETE", "alpha", "manager")).statusCode, 403)
  assert.equal(upserts.length + deletes.length, 0)
})

test("another venue's or another organization's server is not found; a Viewer and no login are refused", async () => {
  assert.equal((await call("GET", "alpha", "otherManager")).statusCode, 404)
  for (const method of ["GET", "PUT", "DELETE"] as const) {
    assert.equal((await call(method, "alpha", "otherAdmin", method === "PUT" ? { prayers: prayers(0) } : undefined)).statusCode, 404, method)
  }
  assert.equal((await call("GET", "nope", "admin")).statusCode, 404)
  assert.equal((await call("GET", "alpha", "viewer")).statusCode, 403)
  assert.equal((await call("GET", "alpha")).statusCode, 401)
  assert.equal(upserts.length + deletes.length, 0)
})

test("a Super Admin sees each server against its own organization, never the oldest one", async () => {
  assert.deepEqual((await call("GET", "alpha", "super")).json().organizationPrayers, prayers(2))
  assert.deepEqual((await call("GET", "other", "super")).json().organizationPrayers, prayers(7))
  assert.equal((await call("PUT", "alpha", "super", { prayers: prayers(3) })).statusCode, 200)
})

test("the Prayer Mode page lists the servers using their own settings", async () => {
  await call("PUT", "bravo", "admin", { prayers: prayers(3) })
  await call("PUT", "alpha", "admin", { prayers: prayers(3) })
  await call("PUT", "other", "otherAdmin", { prayers: prayers(3) })
  const list = (who: string) =>
    app.inject({ method: "GET", url: "/api/prayer/server-overrides", headers: { authorization: `Bearer ${tokens[who]}` } })

  assert.deepEqual((await list("admin")).json(), [
    { id: servers.alpha.id, name: "Alpha" },
    { id: servers.bravo.id, name: "Bravo" },
  ])
  assert.deepEqual((await list("manager")).json(), [{ id: servers.alpha.id, name: "Alpha" }], "a Location Manager sees only their venue")
  assert.deepEqual((await list("super")).json(), [{ id: servers.other.id, name: "Other" }], "the organization the Prayer Mode page shows")
  assert.equal((await list("viewer")).statusCode, 403)
  for (const where of serverListWheres) assert.deepEqual(where.prayerOverride, { isNot: null })
})
