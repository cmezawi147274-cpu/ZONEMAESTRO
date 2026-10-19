/**
 * Subscription module, run in-process against a THROWAWAY Postgres only.
 *
 * Skips unless SUBSCRIPTION_TEST_DATABASE_URL is set, so `ops/test.sh`
 * (which points DATABASE_URL at the live database) never runs it:
 *
 *   docker run -d --name zzsub-pg --network none -e POSTGRES_PASSWORD=zzsub postgres:16-alpine
 *   docker run --rm --network container:zzsub-pg \
 *     -v /opt/CMMP/backend/src:/app/src:ro -v /opt/CMMP/backend/test:/app/test:ro \
 *     -v /opt/CMMP/src/components/subscription:/app/portal-subscription:ro -w /app \
 *     -e SUBSCRIPTION_TEST_DATABASE_URL=postgresql://postgres:zzsub@127.0.0.1:5432/postgres?schema=public \
 *     --entrypoint sh cmmp-backend-migrate -c 'node --test --import tsx test/subscription.test.ts'
 *   docker rm -f zzsub-pg
 *
 * The throwaway database gets minimal "Organization" and "MusicServer"
 * tables (the columns the module reads) and a legacy subscription.record
 * row shaped like the one production holds. The portal-subscription mount
 * lets the banner and fleet tests run the page's own derive.ts.
 */
import { test, before, after, describe } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { AddressInfo } from "node:net"
import type { FastifyInstance } from "fastify"

const TEST_DB = process.env.SUBSCRIPTION_TEST_DATABASE_URL
const skip = TEST_DB ? false : "SUBSCRIPTION_TEST_DATABASE_URL is not set (needs a throwaway Postgres)"

const RS = "\u001e"
const DAY = 86_400_000
const PORTAL_DERIVE = "../portal-subscription/derive.ts"
const CARRIED_OVER_NOTE = "This connection count and last connection were fleet-wide before the per-server change."

const HUB_SERVERS: Record<string, { name: string; organizationId: string }> = {
  "srv-demo": { name: "DEMO-SERVER", organizationId: "org-1" },
  "srv-a": { name: "Alpha", organizationId: "org-1" },
  "srv-b": { name: "Bravo", organizationId: "org-2" },
  "srv-gone": { name: "Gone Venue", organizationId: "org-2" },
  "zzhub-fixture": { name: "Fixture", organizationId: "zzhub-org" },
}
const LISTED = [
  ["srv-demo", "DEMO-SERVER", "org-1"],
  ["srv-a", "Alpha", "org-1"],
  ["srv-b", "Bravo", "org-2"],
  ["srv-idle", "Idle Venue", "org-2"],
  ["zzhub-fixture", "Fixture", "zzhub-org"],
]
const LEGACY = {
  id: "legacy-0000-0000-0000-000000000001",
  started_at: "2026-10-19T12:13:07.284Z",
  ends_at: "2027-10-19T12:13:07.284Z",
  created_by_connection: {
    at: "2026-10-19T12:13:07.284Z",
    caps: ["cmdfix"],
    source: "hub",
    version: "1.0.0",
    serverId: "srv-demo",
    ipAddress: "203.0.113.5",
    serverName: "DEMO-SERVER",
    organizationId: "org-1",
  },
  terms: [
    {
      index: 1,
      reason: "initial",
      endsAt: "2027-10-19T12:13:07.284Z",
      startedAt: "2026-10-19T12:13:07.284Z",
      confirmedBy: { type: "system", label: "First venue connection" },
    },
  ],
  events: [{ id: "legacy-created", at: "2026-10-19T12:13:07.284Z", term: 1, type: "created" }],
  connection_count: 3,
  last_connection_at: "2026-10-19T12:13:20.000Z",
}
const tokenFor = (id: string) => `${id}.secret-${id}`

/* eslint-disable @typescript-eslint/no-explicit-any */
let prisma: any
let hooks: typeof import("../src/subscription/hooks.js")
let store: typeof import("../src/subscription/store.js")
let time: typeof import("../src/subscription/time.js")
let app: FastifyInstance
let hub: http.Server
let hubPort = 0
let tokens: Record<string, string> = {}
let legacyAtBoot: any
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => unhandled.push(reason)

const all = async (): Promise<any[]> => prisma.$queryRawUnsafe("SELECT * FROM subscription.server_record ORDER BY server_id")
const one = async (id: string): Promise<any> =>
  (await prisma.$queryRawUnsafe("SELECT * FROM subscription.server_record WHERE server_id = $1", id))[0] ?? null
const legacy = async (): Promise<any> => (await prisma.$queryRawUnsafe("SELECT * FROM subscription.record"))[0]
const setEnds = (id: string, sql: string) => prisma.$executeRawUnsafe(`UPDATE subscription.server_record SET ends_at = ${sql} WHERE server_id = $1`, id)

async function until(check: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail("condition not met in time")
}

const settle = () => new Promise((r) => setTimeout(r, 150))

function hubConnect(serverId: string): Promise<{ ws: WebSocket; ackMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/hubs/musicserver?access_token=${encodeURIComponent(tokenFor(serverId))}&caps=cmdfix`)
    const timer = setTimeout(() => reject(new Error("no handshake ack")), 3000)
    ws.addEventListener("open", () => ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS))
    ws.addEventListener("message", (ev) => {
      if (String(ev.data) === "{}" + RS) {
        clearTimeout(timer)
        resolve({ ws, ackMs: Date.now() - started })
      }
    })
    ws.addEventListener("close", () => {
      clearTimeout(timer)
      reject(new Error("hub closed the connection"))
    })
  })
}

async function connectAndClose(serverId: string) {
  const { ws } = await hubConnect(serverId)
  await settle()
  assert.equal(ws.readyState, WebSocket.OPEN, "the venue connection did not stay open")
  ws.close()
}

async function call(token: string | null, method: string, url: string, body?: unknown) {
  const res = await app.inject({
    method: method as any,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined ? { payload: body as any } : {}),
  })
  return { status: res.statusCode, body: res.body ? res.json() : null }
}

const SUPER = () => tokens.SUPER_ADMIN

const stable = (r: any) => ({
  server_id: r.server_id,
  id: r.id,
  started_at: r.started_at.toISOString(),
  ends_at: r.ends_at.toISOString(),
  status: r.status,
  created_by_connection: r.created_by_connection,
  terms: r.terms,
  notes: r.notes,
  reminder_days: r.reminder_days,
  dismissed: r.dismissed,
})
const full = (r: any) => (r ? { ...stable(r), events: r.events, connection_count: r.connection_count, last_connection_at: r.last_connection_at.toISOString() } : null)
const snapshot = async () => (await all()).map(full)

describe("subscription", { skip }, () => {
  before(async () => {
    process.env.DATABASE_URL = TEST_DB
    process.env.JWT_ACCESS_SECRET ??= "zz-test-access"
    process.env.JWT_REFRESH_SECRET ??= "zz-test-refresh"
    process.env.MUSIC_SERVER_AGENT_ALLOWED = "true"
    process.env.PUBLIC_API_URL = "https://cloud.zonemaestro.com"
    process.on("unhandledRejection", onUnhandled)

    ;({ prisma } = await import("../src/lib/db.js"))

    for (const sql of [
      `DROP SCHEMA IF EXISTS subscription CASCADE`,
      `DROP TABLE IF EXISTS "MusicServer"`,
      `DROP TABLE IF EXISTS "Organization"`,
      `DROP TYPE IF EXISTS "ServerStatus"`,
      `CREATE TYPE "ServerStatus" AS ENUM ('ONLINE', 'OFFLINE', 'WARNING', 'UPDATING', 'UNKNOWN')`,
      `CREATE TABLE "Organization" (id text PRIMARY KEY, name text NOT NULL)`,
      `CREATE TABLE "MusicServer" (id text PRIMARY KEY, name text NOT NULL, "organizationId" text NOT NULL, status "ServerStatus" NOT NULL DEFAULT 'ONLINE')`,
      `INSERT INTO "Organization" VALUES ('org-1', 'North Org'), ('org-2', 'South Org'), ('zzhub-org', 'Fixture Org')`,
      `CREATE SCHEMA subscription`,
      `CREATE TABLE subscription.record (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), id text NOT NULL, server_label text NOT NULL,
        started_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'active',
        created_by_connection jsonb NOT NULL, terms jsonb NOT NULL, events jsonb NOT NULL, notes text NOT NULL DEFAULT '',
        reminder_days jsonb NOT NULL, dismissed jsonb NOT NULL DEFAULT '[]'::jsonb, connection_count integer NOT NULL,
        last_connection_at timestamptz NOT NULL)`,
    ]) {
      await prisma.$executeRawUnsafe(sql)
    }
    for (const [id, name, org] of LISTED) {
      await prisma.$executeRawUnsafe(`INSERT INTO "MusicServer" (id, name, "organizationId") VALUES ($1, $2, $3)`, id, name, org)
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO subscription.record (id, server_label, started_at, ends_at, created_by_connection, terms, events, reminder_days, connection_count, last_connection_at)
       VALUES ($1, 'cloud.zonemaestro.com', $2::timestamptz, $3::timestamptz, $4::jsonb, $5::jsonb, $6::jsonb, '[90, 30, 7, 1]'::jsonb, $7, $8::timestamptz)`,
      LEGACY.id,
      LEGACY.started_at,
      LEGACY.ends_at,
      JSON.stringify(LEGACY.created_by_connection),
      JSON.stringify(LEGACY.terms),
      JSON.stringify(LEGACY.events),
      LEGACY.connection_count,
      LEGACY.last_connection_at
    )
    legacyAtBoot = await legacy()

    hooks = await import("../src/subscription/hooks.js")
    store = await import("../src/subscription/store.js")
    time = await import("../src/subscription/time.js")
    const { sha256Hex } = await import("../src/lib/agent-auth.js")
    const { attachMusicServerHub } = await import("../src/agent/signalrHub.js")
    const { signAccessToken } = await import("../src/lib/jwt.js")
    const { HttpError } = await import("../src/lib/http-error.js")
    const { default: Fastify } = await import("fastify")

    prisma.musicServer.findUnique = async ({ where }: any) => {
      const s = HUB_SERVERS[where.id]
      if (!s) return null
      return {
        id: where.id,
        name: s.name,
        organizationId: s.organizationId,
        locationId: "loc-1",
        version: "1.0.0",
        os: "Windows",
        ipAddress: "203.0.113.5",
        status: "ONLINE",
        agentTokenHash: sha256Hex(tokenFor(where.id)),
        pairingConsumedTokenPlain: "SECRET-PLAIN-TOKEN",
        pairingCodeHash: "SECRET-CODE-HASH",
      }
    }
    prisma.deletedServerTombstone.findUnique = async () => null

    hub = http.createServer()
    attachMusicServerHub(hub)
    await new Promise<void>((r) => hub.listen(0, "127.0.0.1", () => r()))
    hubPort = (hub.address() as AddressInfo).port

    app = Fastify()
    app.setErrorHandler((error: any, _request, reply) => {
      if (error instanceof HttpError) return reply.status(error.status).send({ status: error.status, code: error.code, message: error.message })
      const status = error.statusCode ?? 500
      return reply.status(status).send({ status, code: status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST", message: error.message })
    })
    await app.register(
      async (api) => {
        api.get("/control", async () => ({ ok: true }))
        await api.register(import("../src/subscription/routes.js").catch(() => ({ default: async () => {} })))
        await api.register(import("../src/subscription/missing-on-purpose.js" as string).catch(() => ({ default: async () => {} })))
      },
      { prefix: "/api" }
    )
    await app.ready()

    const user = (role: string, id: string) =>
      signAccessToken({ id, email: `${id}@example.test`, role: role as any, organizationId: role === "SUPER_ADMIN" ? null : "org-1", locationId: null })
    tokens = {
      SUPER_ADMIN: user("SUPER_ADMIN", "super"),
      ORGANIZATION_ADMIN: user("ORGANIZATION_ADMIN", "orgadmin"),
      LOCATION_MANAGER: user("LOCATION_MANAGER", "manager"),
      VIEWER: user("VIEWER", "viewer"),
    }
  })

  after(async () => {
    process.off("unhandledRejection", onUnhandled)
    await app?.close()
    await new Promise((r) => hub?.close(() => r(null)))
    await prisma?.$disconnect()
  })

  test("boot copies the legacy row onto its stored server once, with one carried-over event", async () => {
    await store.ensureTable()
    await until(async () => ((await one("srv-demo"))?.events ?? []).some((e: any) => e.type === "restarted"))
    const rows = await all()
    assert.deepEqual(rows.map((r) => r.server_id), ["srv-demo"], "the copy created rows for other servers")
    const r = rows[0]
    assert.equal(r.id, LEGACY.id)
    assert.equal(r.started_at.toISOString(), LEGACY.started_at)
    assert.equal(r.ends_at.toISOString(), LEGACY.ends_at)
    assert.deepEqual(r.terms, LEGACY.terms)
    assert.deepEqual(r.created_by_connection, LEGACY.created_by_connection)
    assert.equal(r.notes, "")
    assert.deepEqual(r.reminder_days, [90, 30, 7, 1])
    assert.deepEqual(r.dismissed, [])
    assert.equal(r.connection_count, LEGACY.connection_count)
    assert.equal(r.last_connection_at.toISOString(), LEGACY.last_connection_at)
    assert.equal(r.duration_months, 12, "an existing row did not get the 12-month duration")
    assert.deepEqual(r.events.slice(0, 1), LEGACY.events)
    assert.deepEqual(r.events.map((e: any) => e.type), ["created", "carried_over", "restarted"])
    const carried = r.events[1]
    assert.equal(carried.note, CARRIED_OVER_NOTE)
    assert.equal(carried.term, 1)
    assert.ok(!/Xenia|WIJEI|SPA|Alpha|Bravo/.test(carried.note), "the carried-over note names other venues")
    assert.deepEqual(await legacy(), legacyAtBoot, "the legacy row was written")
  })

  test("repeating the copy adds nothing", async () => {
    const before = await snapshot()
    assert.deepEqual(await store.copyLegacyRecord(new Date()), [])
    assert.deepEqual(await snapshot(), before)
  })

  test("a restart with existing rows appends one restarted event per row and creates none", async () => {
    const before = await one("srv-demo")
    assert.equal(await store.appendRestart(new Date()), 1)
    const after = await one("srv-demo")
    assert.deepEqual(stable(after), stable(before))
    assert.equal(after.connection_count, before.connection_count)
    assert.deepEqual(after.events.slice(before.events.length).map((e: any) => e.type), ["restarted"])
    assert.deepEqual((await all()).map((r) => r.server_id), ["srv-demo"])
  })

  test("the routes plugin schedules one restart per process, and it was already used", async () => {
    const before = await snapshot()
    await hooks.recordRestart()
    assert.deepEqual(await snapshot(), before)
  })

  test("a server's first hub connection creates only that server's term", async () => {
    const demoBefore = full(await one("srv-demo"))
    await connectAndClose("srv-a")
    await until(async () => !!(await one("srv-a")))
    const a = await one("srv-a")
    assert.ok(Math.abs(a.started_at.getTime() - Date.now()) < 10_000)
    assert.equal(a.ends_at.toISOString(), time.addCalendarMonthsUTC(a.started_at, 12).toISOString())
    assert.equal(a.connection_count, 1)
    assert.equal(a.last_connection_at.toISOString(), a.started_at.toISOString())
    assert.deepEqual(a.events.map((e: any) => e.type), ["created"])
    assert.equal(a.created_by_connection.serverId, "srv-a")
    assert.equal(a.terms.length, 1)
    assert.ok(!JSON.stringify(a).includes("SECRET"), "a secret field was stored")
    assert.deepEqual(full(await one("srv-demo")), demoBefore, "server A's connection changed DEMO-SERVER")
    assert.equal(await one("srv-b"), null, "server A's connection created server B")
    assert.equal(await one("srv-idle"), null)
  })

  test("a later connection updates only that server's count and last connection", async () => {
    const [aBefore, demoBefore] = [await one("srv-a"), full(await one("srv-demo"))]
    await connectAndClose("srv-a")
    await until(async () => (await one("srv-a")).connection_count === 2)
    const a = await one("srv-a")
    assert.deepEqual(stable(a), stable(aBefore))
    assert.deepEqual(a.events, aBefore.events)
    assert.ok(a.last_connection_at.getTime() >= aBefore.last_connection_at.getTime())
    assert.deepEqual(full(await one("srv-demo")), demoBefore)
  })

  test("two first connections for the same server create one row", async () => {
    await Promise.all([
      hooks.onClientConnected({ source: "hub", serverId: "srv-b" }),
      hooks.onClientConnected({ source: "hub", serverId: "srv-b" }),
    ])
    const b = await one("srv-b")
    assert.equal(b.connection_count, 2)
    assert.deepEqual(b.events.map((e: any) => e.type), ["created"])
  })

  test("zz fixture venues are ignored", async () => {
    await connectAndClose("zzhub-fixture")
    await settle()
    assert.equal(await one("zzhub-fixture"), null)
  })

  test("the fleet lists every real server, sorted by urgency then name, and only reads", async () => {
    await connectAndClose("srv-gone")
    await until(async () => !!(await one("srv-gone")))
    await setEnds("srv-a", "now() - interval '1 hour'")
    await setEnds("srv-b", "now() + interval '5 days'")
    const before = await snapshot()

    const res = await call(SUPER(), "GET", "/api/subscription/servers")
    assert.equal(res.status, 200)
    const names = res.body.servers.map((s: any) => s.name)
    assert.deepEqual(names, ["Alpha", "Bravo", "DEMO-SERVER", "Idle Venue"])
    assert.deepEqual(res.body.servers.map((s: any) => s.status), ["ended", "critical", "active", "not_started"])
    assert.deepEqual(res.body.summary, { total: 4, notStarted: 1, active: 1, attention: 0, warning: 0, critical: 1, ended: 1 })
    const idle = res.body.servers.find((s: any) => s.serverId === "srv-idle")
    assert.deepEqual(
      { startedAt: idle.startedAt, endsAt: idle.endsAt, connectionCount: idle.connectionCount, lastConnectionAt: idle.lastConnectionAt },
      { startedAt: null, endsAt: null, connectionCount: 0, lastConnectionAt: null }
    )
    assert.equal(res.body.servers.find((s: any) => s.serverId === "srv-demo").organizationName, "North Org")
    assert.ok(!names.includes("Gone Venue") && !names.includes("Fixture"), "a removed or fixture server was listed")

    assert.equal((await call(SUPER(), "GET", "/api/subscription/servers/srv-demo")).status, 200)
    assert.equal((await call(SUPER(), "GET", "/api/subscription/servers/srv-demo/clock")).status, 200)
    assert.equal((await call(SUPER(), "GET", "/api/subscription/export")).status, 200)
    assert.deepEqual(await snapshot(), before, "a read wrote")
    assert.ok(!!(await one("srv-gone")), "the removed server's row was not kept")
  })

  test("detail and clock reads: not-started has no record, removed and fixture servers are not found", async () => {
    const before = await snapshot()
    const demo = await call(SUPER(), "GET", "/api/subscription/servers/srv-demo")
    assert.equal(demo.body.record.serverId, "srv-demo")
    assert.equal(demo.body.server.name, "DEMO-SERVER")
    const idle = await call(SUPER(), "GET", "/api/subscription/servers/srv-idle")
    assert.equal(idle.status, 200)
    assert.equal(idle.body.record, null)
    assert.equal((await call(SUPER(), "GET", "/api/subscription/servers/srv-gone")).status, 404)
    assert.equal((await call(SUPER(), "GET", "/api/subscription/servers/zzhub-fixture")).status, 404)
    const clock = await call(SUPER(), "GET", "/api/subscription/servers/srv-demo/clock")
    assert.deepEqual(Object.keys(clock.body).sort(), ["endsAt", "now"])
    assert.equal(clock.body.endsAt, LEGACY.ends_at)
    assert.equal((await call(SUPER(), "GET", "/api/subscription/servers/srv-idle/clock")).body.endsAt, null)
    assert.ok(!!(await one("srv-gone")), "the removed server's row should still exist for this check")
    assert.equal((await call(SUPER(), "GET", "/api/subscription/servers/srv-gone/clock")).status, 404, "a removed server's clock was readable")
    assert.equal((await call(SUPER(), "GET", "/api/subscription/servers/zzhub-fixture/clock")).status, 404, "a fixture server's clock was readable")
    assert.deepEqual(await snapshot(), before)
  })

  test("the fleet export has the seven counts and one line per listed server, nothing else", async () => {
    await call(SUPER(), "PUT", "/api/subscription/servers/srv-demo/notes", { notes: "private-note-text" })
    const before = await snapshot()
    const res = await call(SUPER(), "GET", "/api/subscription/export")
    assert.equal(res.status, 200)
    const text: string = res.body.content
    const lines = text.split("\n")
    assert.equal(lines[0], "Subscription fleet summary", "the first line carries more than the title")
    assert.match(lines[1], /^As of: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/)
    assert.ok(lines.includes("Server | Organization | Status | Start | End"), "the column header row is missing")
    assert.ok(!text.includes("cloud.zonemaestro.com") && !text.includes("zonemaestro"), "the fleet export names the cloud host")
    for (const line of ["Total: 4", "Not started: 1", "Active: 1", "Attention: 0", "Warning: 0", "Critical: 1", "Ended: 1"]) {
      assert.ok(text.includes(`\n${line}\n`), `missing "${line}"`)
    }
    const serverLines = text.trim().split("\n").slice(-4)
    assert.deepEqual(serverLines.map((l) => l.split(" | ").slice(0, 3)), [
      ["Alpha", "North Org", "Ended"],
      ["Bravo", "South Org", "Critical"],
      ["DEMO-SERVER", "North Org", "Active"],
      ["Idle Venue", "South Org", "Not started"],
    ])
    assert.ok(serverLines[2].endsWith(`| 2026-10-19 12:13 UTC | 2027-10-19 12:13 UTC`))
    assert.ok(serverLines[3].endsWith("| - | -"))
    for (const forbidden of ["203.0.113.5", "1.0.0", "cmdfix", "private-note-text", "created", "SECRET", "Gone Venue", "Fixture"]) {
      assert.ok(!text.includes(forbidden), `the fleet export contains "${forbidden}"`)
    }
    assert.deepEqual(await snapshot(), before, "the fleet export wrote an event")
  })

  test("per-server writes touch only that server", async () => {
    const others = async (except: string) => (await snapshot()).filter((r: any) => r.server_id !== except)

    let rest = await others("srv-b")
    const reminders = await call(SUPER(), "PUT", "/api/subscription/servers/srv-b/reminders", { reminderDays: [30, 7] })
    assert.equal(reminders.status, 200)
    assert.deepEqual((await one("srv-b")).reminder_days, [30, 7])
    assert.deepEqual(await others("srv-b"), rest)

    rest = await others("srv-b")
    const bBefore = await one("srv-b")
    await call(SUPER(), "POST", "/api/subscription/servers/srv-b/banners/7/dismiss")
    await call(SUPER(), "POST", "/api/subscription/servers/srv-b/banners/7/dismiss")
    const b = await one("srv-b")
    assert.deepEqual(b.dismissed.map((d: any) => [d.term, d.threshold]), [[1, 7]])
    assert.deepEqual(b.events, bBefore.events)
    assert.deepEqual(await others("srv-b"), rest)

    rest = await others("srv-demo")
    const demoBefore = await one("srv-demo")
    const exp = await call(SUPER(), "POST", "/api/subscription/servers/srv-demo/export", { format: "json" })
    const file = JSON.parse(exp.body.content)
    assert.deepEqual(Object.keys(file).sort(), ["record", "server"])
    assert.deepEqual(file.server, { serverId: "srv-demo", name: "DEMO-SERVER", organization: "North Org" })
    assert.equal(file.record.serverId, "srv-demo")
    assert.ok(!JSON.stringify(file).includes("SECRET"))
    assert.match(exp.body.filename, /^subscription-DEMO-SERVER-\d{4}-\d{2}-\d{2}\.json$/)
    const demo = await one("srv-demo")
    assert.deepEqual(demo.events.slice(demoBefore.events.length).map((e: any) => [e.type, e.format]), [["exported", "json"]])
    assert.deepEqual(await others("srv-demo"), rest)

    rest = await others("srv-b")
    const wrong = await call(SUPER(), "POST", "/api/subscription/servers/srv-b/renew", { confirmEndDate: "1999-01-01" })
    assert.equal(wrong.status, 400)
    const oldEnd = (await one("srv-b")).ends_at
    const renewed = await call(SUPER(), "POST", "/api/subscription/servers/srv-b/renew", { confirmEndDate: oldEnd.toISOString().slice(0, 10) })
    assert.equal(renewed.status, 200)
    const b2 = await one("srv-b")
    assert.equal(b2.terms.length, 2)
    assert.equal(b2.terms[1].startedAt, oldEnd.toISOString())
    assert.equal(b2.terms[1].endsAt, time.addCalendarMonthsUTC(oldEnd, 12).toISOString())
    assert.deepEqual(b2.terms[0], bBefore.terms[0])
    assert.equal(b2.started_at.toISOString(), bBefore.started_at.toISOString())
    assert.equal(b2.connection_count, bBefore.connection_count)
    assert.deepEqual(await others("srv-b"), rest)

    const aBefore = await one("srv-a")
    const renewA = await call(SUPER(), "POST", "/api/subscription/servers/srv-a/renew", { confirmEndDate: aBefore.ends_at.toISOString().slice(0, 10) })
    assert.equal(renewA.status, 200)
    const aTerm = (await one("srv-a")).terms[1]
    assert.ok(Math.abs(new Date(aTerm.startedAt).getTime() - Date.now()) < 10_000, "an ended term did not restart from now")
  })

  test("writes on a not-started or removed server change nothing and create no row", async () => {
    const before = await snapshot()
    for (const [method, path, body] of [
      ["PUT", "notes", { notes: "x" }],
      ["PUT", "reminders", { reminderDays: [] }],
      ["POST", "banners/30/dismiss", undefined],
      ["POST", "export", { format: "json" }],
      ["POST", "renew", { confirmEndDate: "2027-01-01" }],
    ] as [string, string, unknown][]) {
      assert.equal((await call(SUPER(), method, `/api/subscription/servers/srv-idle/${path}`, body)).status, 404, `not-started ${path}`)
      assert.equal((await call(SUPER(), method, `/api/subscription/servers/srv-gone/${path}`, body)).status, 404, `removed ${path}`)
    }
    assert.deepEqual(await snapshot(), before)
    assert.equal(await one("srv-idle"), null)
  })

  test("thresholds are stored once per term per server, only by connection and restart writes", async () => {
    await setEnds("srv-demo", "now() + interval '20 days'")
    const before = await snapshot()
    const thresholds = async (id: string) =>
      (await one(id)).events.filter((e: any) => e.type === "threshold").map((e: any) => `${e.term}:${e.threshold}`)

    await call(SUPER(), "GET", "/api/subscription/servers/srv-demo")
    await call(SUPER(), "PUT", "/api/subscription/servers/srv-demo/notes", { notes: "still no thresholds" })
    assert.deepEqual(await thresholds("srv-demo"), [], "a read or notes write recorded a threshold")

    await hooks.onClientConnected({ source: "hub", serverId: "srv-demo" })
    assert.deepEqual(await thresholds("srv-demo"), ["1:90", "1:30"])
    const aBefore = before.find((r: any) => r.server_id === "srv-a")
    assert.deepEqual(full(await one("srv-a")), aBefore, "DEMO-SERVER's thresholds were written to another server")

    await Promise.all([hooks.onClientConnected({ source: "hub", serverId: "srv-demo" }), store.appendRestart(new Date())])
    assert.deepEqual(await thresholds("srv-demo"), ["1:90", "1:30"])
    assert.deepEqual((await one("srv-demo")).terms, LEGACY.terms)
  })

  test("the banner is per server and per threshold", async () => {
    const { derive } = await import(PORTAL_DERIVE)
    await setEnds("srv-b", "now() + interval '20 days'")
    await call(SUPER(), "PUT", "/api/subscription/servers/srv-b/reminders", { reminderDays: [90, 30, 7, 1] })
    const banner = async (id: string) => {
      const { body } = await call(SUPER(), "GET", `/api/subscription/servers/${id}`)
      return derive(body.record.startedAt, body.record.endsAt, body.now, body.record).banner
    }
    assert.equal(await banner("srv-demo"), 30)
    assert.equal(await banner("srv-b"), 30)
    await call(SUPER(), "POST", "/api/subscription/servers/srv-demo/banners/30/dismiss")
    assert.equal(await banner("srv-demo"), 90)
    assert.equal(await banner("srv-b"), 30, "a dismissal on DEMO-SERVER hid server B's banner")
  })

  test("the banner shows only the most urgent undismissed threshold whose reminder is enabled", async () => {
    const { derive } = await import(PORTAL_DERIVE)
    const start = "2026-01-01T00:00:00.000Z"
    const end = "2027-01-01T00:00:00.000Z"
    const at = (days: number) => new Date(Date.parse(end) - days * DAY).toISOString()
    const rec = (dismissed: [number, number][], reminderDays = [90, 30, 7, 1], terms = 1) => ({
      reminderDays,
      dismissed: dismissed.map(([term, threshold]) => ({ term, threshold, at: start })),
      terms: Array.from({ length: terms }, (_, i) => ({ index: i + 1 })),
    })
    const banner = (days: number, r: unknown) => derive(start, end, at(days), r).banner
    assert.equal(banner(120, rec([])), null)
    assert.equal(banner(60, rec([])), 90)
    assert.equal(banner(20, rec([[1, 90]])), 30)
    assert.equal(banner(5, rec([[1, 7]])), 30)
    assert.equal(banner(5, rec([[1, 7], [1, 30]])), 90)
    assert.equal(banner(5, rec([], [90, 30, 1])), 30)
    assert.equal(banner(5, rec([[1, 7]], [90, 30, 7, 1], 2)), 7)
    assert.equal(derive(start, end, at(-1), rec([])).banner, null)
    assert.equal(derive(start, end, at(-1), rec([])).band, "ended")
  })

  test("the page's sort, search, filter and summary match the backend", async () => {
    const { fleetRows, filterFleet, summarizeFleet, compareFleet } = await import(PORTAL_DERIVE)
    const now = "2026-06-01T00:00:00.000Z"
    const servers = [
      { serverId: "1", name: "bravo", organizationId: "o1", organizationName: "North", serverStatus: "ONLINE" },
      { serverId: "2", name: "Alpha", organizationId: "o2", organizationName: "South", serverStatus: "ONLINE" },
      { serverId: "3", name: "Charlie", organizationId: "o1", organizationName: "North", serverStatus: "OFFLINE" },
      { serverId: "4", name: "Delta", organizationId: "o2", organizationName: "South", serverStatus: "ONLINE" },
      { serverId: "5", name: "Echo", organizationId: "o1", organizationName: "North", serverStatus: "ONLINE" },
    ]
    const rec = (serverId: string, endsAt: string) => ({ serverId, startedAt: "2026-01-01T00:00:00.000Z", endsAt, connectionCount: 1, lastConnectionAt: now })
    const rows = fleetRows(servers, [
      rec("1", "2026-06-20T00:00:00.000Z"),
      rec("2", "2026-06-20T00:00:00.000Z"),
      rec("3", "2026-05-01T00:00:00.000Z"),
      rec("4", "2027-01-01T00:00:00.000Z"),
    ], now)
    assert.deepEqual(rows.map((r: any) => [r.name, r.status]), [
      ["Charlie", "ended"], ["Alpha", "warning"], ["bravo", "warning"], ["Delta", "active"], ["Echo", "not_started"],
    ])
    assert.deepEqual(summarizeFleet(rows), { total: 5, notStarted: 1, active: 1, attention: 0, warning: 2, critical: 0, ended: 1 })
    assert.deepEqual(filterFleet(rows, "south", "all").map((r: any) => r.name), ["Alpha", "Delta"])
    assert.deepEqual(filterFleet(rows, "", "warning").map((r: any) => r.name), ["Alpha", "bravo"])
    assert.deepEqual(filterFleet(rows, "ECH", "not_started").map((r: any) => r.name), ["Echo"])
    const backendSorted = [...rows].sort(time.compareFleet).map((r: any) => r.name)
    assert.deepEqual(backendSorted, [...rows].sort(compareFleet).map((r: any) => r.name))
    assert.deepEqual(time.STATUS_ORDER, ["ended", "critical", "warning", "attention", "active", "not_started"])
  })

  test("a failing subscription write leaves the venue connection successful", async () => {
    const original = prisma.$transaction
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "))
    prisma.$transaction = async () => {
      throw new Error("forced failure")
    }
    try {
      const before = (await one("srv-a")).connection_count
      await connectAndClose("srv-a")
      await until(async () => warnings.some((w) => w.startsWith("[subscription]")))
      prisma.$transaction = original
      assert.equal((await one("srv-a")).connection_count, before)
    } finally {
      prisma.$transaction = original
      console.warn = warn
    }
  })

  test("a slow subscription write does not delay the handshake", async () => {
    const original = prisma.$transaction
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    prisma.$transaction = async (...args: any[]) => {
      await held
      return original.apply(prisma, args)
    }
    try {
      const before = (await one("srv-a")).connection_count
      const { ws, ackMs } = await hubConnect("srv-a")
      assert.ok(ackMs < 1000, `handshake took ${ackMs} ms`)
      await settle()
      assert.equal(ws.readyState, WebSocket.OPEN)
      release()
      prisma.$transaction = original
      await until(async () => (await one("srv-a")).connection_count === before + 1)
      ws.close()
    } finally {
      prisma.$transaction = original
    }
  })

  test("every endpoint is super-admin only, with the existing forbidden response", async () => {
    const before = await snapshot()
    const endpoints: [string, string, unknown?][] = [
      ["GET", "/api/subscription/servers"],
      ["GET", "/api/subscription/export"],
      ["GET", "/api/subscription/servers/srv-demo"],
      ["GET", "/api/subscription/servers/srv-demo/clock"],
      ["PUT", "/api/subscription/servers/srv-demo/notes", { notes: "x" }],
      ["PUT", "/api/subscription/servers/srv-demo/reminders", { reminderDays: [] }],
      ["POST", "/api/subscription/servers/srv-demo/banners/30/dismiss"],
      ["POST", "/api/subscription/servers/srv-demo/export", { format: "json" }],
      ["POST", "/api/subscription/servers/srv-demo/renew", { confirmEndDate: "2000-01-01" }],
      ["PUT", "/api/subscription/servers/srv-demo/duration", { months: 6, confirmEndDate: "2000-01-01" }],
    ]
    for (const [method, url, body] of endpoints) {
      for (const role of ["ORGANIZATION_ADMIN", "LOCATION_MANAGER", "VIEWER"]) {
        assert.deepEqual(
          await call(tokens[role], method, url, body),
          { status: 403, body: { status: 403, code: "FORBIDDEN", message: "You do not have access to this resource." } },
          `${role} ${method} ${url}`
        )
      }
      assert.equal((await call(null, method, url, body)).status, 401, `anonymous ${method} ${url}`)
    }
    assert.deepEqual(await snapshot(), before)
  })

  test("the plugin adds no auth to sibling routes, and there is no delete, reset or date edit", async () => {
    assert.deepEqual(await call(null, "GET", "/api/control"), { status: 200, body: { ok: true } })
    for (const method of ["DELETE", "PATCH"]) {
      assert.equal((await call(SUPER(), method, "/api/subscription/servers/srv-demo")).status, 404)
      assert.equal((await call(SUPER(), method, "/api/subscription/servers")).status, 404)
    }
  })

  test("an error while registering the routes still lets the app boot", async () => {
    const { default: Fastify } = await import("fastify")
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "))
    const second = Fastify()
    try {
      await second.register(
        async (api) => {
          api.get("/control", async () => ({ ok: true }))
          await api.register(async (child) => {
            child.get("/subscription/servers", async () => ({ shadow: true }))
            await child.register(import("../src/subscription/routes.js").catch(() => ({ default: async () => {} })))
          })
        },
        { prefix: "/api" }
      )
      await second.ready()
      assert.deepEqual((await second.inject({ method: "GET", url: "/api/control" })).json(), { ok: true })
      assert.ok(warnings.some((w) => w.startsWith("[subscription] could not register routes")))
    } finally {
      console.warn = warn
      await second.close()
    }
  })

  test("calendar months are UTC and clamp like the database", async () => {
    assert.equal(time.addCalendarMonthsUTC(new Date("2028-02-29T10:00:00.000Z"), 12).toISOString(), "2029-02-28T10:00:00.000Z")
    assert.deepEqual(time.spanBetween(new Date("2026-01-31T00:00:00Z"), new Date("2026-03-02T05:07:00Z")), { months: 1, days: 2, hours: 5, minutes: 7 })
    assert.equal(time.bandFor(91 * DAY), "active")
    assert.equal(time.bandFor(90 * DAY), "attention")
    assert.equal(time.bandFor(30 * DAY), "warning")
    assert.equal(time.bandFor(7 * DAY), "critical")
    assert.equal(time.bandFor(0), "ended")
  })

  test("a server clock behind a server's start leaves its dates unchanged and shows in the list", async () => {
    await prisma.$executeRawUnsafe(`INSERT INTO "MusicServer" (id, name, "organizationId") VALUES ('srv-future', 'Zulu', 'org-1')`)
    await store.recordConnection(
      { source: "hub", serverId: "srv-future", serverName: null, organizationId: null, version: null, ipAddress: null, caps: [] },
      new Date("2028-02-29T10:00:00.000Z")
    )
    const before = await one("srv-future")
    assert.equal(before.ends_at.toISOString(), "2029-02-28T10:00:00.000Z")
    await hooks.onClientConnected({ source: "hub", serverId: "srv-future" })
    assert.deepEqual(stable(await one("srv-future")), stable(before))
    const list = await call(SUPER(), "GET", "/api/subscription/servers")
    const row = list.body.servers.find((s: any) => s.serverId === "srv-future")
    assert.ok(new Date(list.body.now).getTime() < new Date(row.startedAt).getTime())
  })

  test("changing the duration from 12 to 6 moves only that server's current end", async () => {
    await prisma.$executeRawUnsafe(`INSERT INTO "MusicServer" (id, name, "organizationId") VALUES ('srv-c', 'Charlie', 'org-1')`)
    await hooks.onClientConnected({ source: "hub", serverId: "srv-c" })
    const before = await one("srv-c")
    assert.equal(before.duration_months, 12)
    const others = (await snapshot()).filter((r: any) => r.server_id !== "srv-c")
    const typed = before.ends_at.toISOString().slice(0, 10)

    const wrong = await call(SUPER(), "PUT", "/api/subscription/servers/srv-c/duration", { months: 6, confirmEndDate: "1999-01-01" })
    assert.equal(wrong.status, 400)
    assert.deepEqual(full(await one("srv-c")), full(before), "a mismatched date changed the row")

    const ok = await call(SUPER(), "PUT", "/api/subscription/servers/srv-c/duration", { months: 6, confirmEndDate: typed })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.record.durationMonths, 6)
    const after = await one("srv-c")
    const newEnd = time.addCalendarMonthsUTC(before.started_at, 6).toISOString()
    assert.equal(after.ends_at.toISOString(), newEnd)
    assert.equal(after.duration_months, 6)
    assert.equal(after.started_at.toISOString(), before.started_at.toISOString())
    assert.deepEqual(after.terms, [{ ...before.terms[0], endsAt: newEnd }])
    assert.equal(after.notes, before.notes)
    assert.deepEqual(after.reminder_days, before.reminder_days)
    assert.deepEqual(after.dismissed, before.dismissed)
    assert.equal(after.connection_count, before.connection_count)
    assert.equal(after.last_connection_at.toISOString(), before.last_connection_at.toISOString())
    const added = after.events.slice(before.events.length)
    assert.equal(added.length, 1)
    assert.equal(added[0].type, "duration_changed")
    assert.equal(added[0].previousDurationMonths, 12)
    assert.equal(added[0].durationMonths, 6)
    assert.equal(added[0].previousEndsAt, before.ends_at.toISOString())
    assert.equal(added[0].endsAt, newEnd)
    assert.equal(added[0].by.email, "super@example.test")
    assert.deepEqual((await snapshot()).filter((r: any) => r.server_id !== "srv-c"), others, "another server changed")

    const list = await call(SUPER(), "GET", "/api/subscription/servers")
    assert.equal(list.body.servers.find((s: any) => s.serverId === "srv-c").endsAt, newEnd)
    const fleet = await call(SUPER(), "GET", "/api/subscription/export")
    assert.ok(fleet.body.content.includes(`Charlie | North Org | Active | ${time.formatUTC(before.started_at.toISOString())} | ${time.formatUTC(newEnd)}`))
    const detail = await call(SUPER(), "GET", "/api/subscription/servers/srv-c")
    assert.equal(detail.body.record.endsAt, newEnd)
  })

  test("changing a renewed server's duration keeps its start and older terms", async () => {
    const before = await one("srv-b")
    assert.ok(before.terms.length >= 2)
    const res = await call(SUPER(), "PUT", "/api/subscription/servers/srv-b/duration", {
      months: 3,
      confirmEndDate: before.ends_at.toISOString().slice(0, 10),
    })
    assert.equal(res.status, 200)
    const after = await one("srv-b")
    const last = before.terms.length - 1
    const newEnd = time.addCalendarMonthsUTC(new Date(before.terms[last].startedAt), 3).toISOString()
    assert.deepEqual(after.terms.slice(0, last), before.terms.slice(0, last), "an older term changed")
    assert.deepEqual(after.terms[last], { ...before.terms[last], endsAt: newEnd })
    assert.equal(after.ends_at.toISOString(), newEnd)
    assert.equal(after.started_at.toISOString(), before.started_at.toISOString())
  })

  test("durations outside 1 to 60 or not whole numbers are rejected", async () => {
    const before = await snapshot()
    const typed = (await one("srv-c")).ends_at.toISOString().slice(0, 10)
    for (const months of [0, 61, -3, 6.5, "6", "abc", null]) {
      const res = await call(SUPER(), "PUT", "/api/subscription/servers/srv-c/duration", { months, confirmEndDate: typed })
      assert.equal(res.status, 400, `months ${JSON.stringify(months)} was accepted`)
    }
    assert.equal((await call(SUPER(), "PUT", "/api/subscription/servers/srv-c/duration", { months: 6 })).status, 400)
    assert.deepEqual(await snapshot(), before)
  })

  test("not-started, removed and fixture servers have no duration action", async () => {
    const before = await snapshot()
    for (const id of ["srv-idle", "srv-gone", "zzhub-fixture"]) {
      const res = await call(SUPER(), "PUT", `/api/subscription/servers/${id}/duration`, { months: 6, confirmEndDate: "2027-01-01" })
      assert.equal(res.status, 404, `${id} returned ${res.status}`)
    }
    assert.deepEqual(await snapshot(), before)
    assert.equal(await one("srv-idle"), null)
    assert.equal(await one("zzhub-fixture"), null)
  })

  test("renewal after a duration change adds one term of the new duration", async () => {
    const before = await one("srv-c")
    assert.equal(before.duration_months, 6)
    const res = await call(SUPER(), "POST", "/api/subscription/servers/srv-c/renew", { confirmEndDate: before.ends_at.toISOString().slice(0, 10) })
    assert.equal(res.status, 200)
    const after = await one("srv-c")
    assert.equal(after.terms.length, before.terms.length + 1)
    const added = after.terms[after.terms.length - 1]
    assert.equal(added.startedAt, before.ends_at.toISOString())
    assert.equal(added.endsAt, time.addCalendarMonthsUTC(before.ends_at, 6).toISOString())
    assert.equal(after.ends_at.toISOString(), added.endsAt)
    assert.equal(after.duration_months, 6)
    assert.deepEqual(after.terms.slice(0, before.terms.length), before.terms)
  })

  test("a failed duration write leaves the row as it was", async () => {
    const before = full(await one("srv-c"))
    const original = prisma.$transaction
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "))
    let failedWrites = 0
    prisma.$transaction = async (ops: unknown[]) => {
      if (Array.isArray(ops) && ops.length === 3) {
        failedWrites++
        throw new Error("forced write failure")
      }
      return original.call(prisma, ops)
    }
    try {
      const res = await call(SUPER(), "PUT", "/api/subscription/servers/srv-c/duration", {
        months: 12,
        confirmEndDate: before!.ends_at.slice(0, 10),
      })
      assert.equal(res.status, 503)
    } finally {
      prisma.$transaction = original
      console.warn = warn
    }
    assert.equal(failedWrites, 1, "the duration write was not the step that failed")
    assert.ok(warnings.some((w) => w.startsWith("[subscription]")))
    assert.deepEqual(full(await one("srv-c")), before)
  })

  test("the legacy row was never written", async () => {
    assert.deepEqual(await legacy(), legacyAtBoot)
  })

  test("a legacy row without a server id stays unattached", async () => {
    await prisma.$executeRawUnsafe("DELETE FROM subscription.server_record WHERE server_id = 'srv-demo'")
    await prisma.$executeRawUnsafe("UPDATE subscription.record SET created_by_connection = created_by_connection - 'serverId'")
    assert.deepEqual(await store.copyLegacyRecord(new Date()), [])
    assert.equal(await one("srv-demo"), null)
    assert.ok(!(await all()).some((r) => r.id === LEGACY.id), "the legacy row was attached without a server id")
  })

  test("no unhandled rejection escaped the feature", () => {
    assert.deepEqual(unhandled, [])
  })
})
