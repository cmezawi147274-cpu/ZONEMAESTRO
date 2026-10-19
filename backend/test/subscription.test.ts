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
 * The portal-subscription mount lets the banner tests run the page's own
 * derive.ts rather than a copy of it.
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
const SERVERS: Record<string, { name: string; organizationId: string }> = {
  "srv-real-1": { name: "Venue One", organizationId: "org-1" },
  "srv-real-2": { name: "Venue Two", organizationId: "org-1" },
  "zzhub-fixture": { name: "Fixture", organizationId: "zzhub-org" },
}
const tokenFor = (id: string) => `${id}.secret-${id}`
const PORTAL_DERIVE = "../portal-subscription/derive.ts"

/* eslint-disable @typescript-eslint/no-explicit-any */
let prisma: any
let hooks: typeof import("../src/subscription/hooks.js")
let store: typeof import("../src/subscription/store.js")
let time: typeof import("../src/subscription/time.js")
let app: FastifyInstance
let hub: http.Server
let hubPort = 0
let tokens: Record<string, string> = {}
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => unhandled.push(reason)

async function rows(): Promise<any[]> {
  return prisma.$queryRawUnsafe("SELECT * FROM subscription.record")
}

async function row(): Promise<any> {
  const r = await rows()
  assert.equal(r.length, 1, "expected exactly one subscription record")
  return r[0]
}

async function until(check: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail("condition not met in time")
}

async function settle() {
  await new Promise((r) => setTimeout(r, 150))
}

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

const stable = (r: any) => ({
  id: r.id,
  server_label: r.server_label,
  started_at: r.started_at.toISOString(),
  ends_at: r.ends_at.toISOString(),
  status: r.status,
  created_by_connection: r.created_by_connection,
  terms: r.terms,
  notes: r.notes,
  reminder_days: r.reminder_days,
  dismissed: r.dismissed,
})

describe("subscription", { skip }, () => {
  before(async () => {
    process.env.DATABASE_URL = TEST_DB
    process.env.JWT_ACCESS_SECRET ??= "zz-test-access"
    process.env.JWT_REFRESH_SECRET ??= "zz-test-refresh"
    process.env.MUSIC_SERVER_AGENT_ALLOWED = "true"
    process.env.PUBLIC_API_URL = "https://cloud.zonemaestro.com"
    process.on("unhandledRejection", onUnhandled)

    ;({ prisma } = await import("../src/lib/db.js"))
    hooks = await import("../src/subscription/hooks.js")
    store = await import("../src/subscription/store.js")
    time = await import("../src/subscription/time.js")
    const { sha256Hex } = await import("../src/lib/agent-auth.js")
    const { attachMusicServerHub } = await import("../src/agent/signalrHub.js")
    const { signAccessToken } = await import("../src/lib/jwt.js")
    const { HttpError } = await import("../src/lib/http-error.js")
    const { default: Fastify } = await import("fastify")

    await prisma.$executeRawUnsafe("DROP SCHEMA IF EXISTS subscription CASCADE")

    prisma.musicServer.findUnique = async ({ where }: any) => {
      const s = SERVERS[where.id]
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

  test("a restart with no record writes nothing", async () => {
    await hooks.recordRestart()
    await store.ensureTable()
    await settle()
    assert.equal(await store.appendRestart(new Date()), false)
    assert.equal((await rows()).length, 0)
  })

  test("the first hub connection creates one record and the connection succeeds", async () => {
    await connectAndClose("srv-real-1")
    await until(async () => (await rows()).length === 1)
    const r = await row()
    assert.match(r.id, /^[0-9a-f-]{36}$/)
    assert.equal(r.server_label, "cloud.zonemaestro.com")
    assert.equal(r.status, "active")
    assert.ok(Math.abs(r.started_at.getTime() - Date.now()) < 10_000)
    assert.equal(r.ends_at.toISOString(), time.addCalendarMonthsUTC(r.started_at, 12).toISOString())
    assert.equal(r.last_connection_at.toISOString(), r.started_at.toISOString())
    assert.equal(r.connection_count, 1)
    assert.equal(r.notes, "")
    assert.deepEqual(r.reminder_days, [90, 30, 7, 1])
    assert.deepEqual(r.dismissed, [])
    assert.equal(r.terms.length, 1)
    assert.deepEqual(r.terms[0], {
      index: 1,
      startedAt: r.started_at.toISOString(),
      endsAt: r.ends_at.toISOString(),
      reason: "initial",
      confirmedBy: { type: "system", label: "First venue connection" },
    })
    assert.deepEqual(r.events.map((e: any) => e.type), ["created"])
    assert.deepEqual(Object.keys(r.created_by_connection).sort(), ["at", "caps", "ipAddress", "organizationId", "serverId", "serverName", "source", "version"])
    assert.equal(r.created_by_connection.serverId, "srv-real-1")
    assert.deepEqual(r.created_by_connection.caps, ["cmdfix"])
    assert.ok(!JSON.stringify(r).includes("SECRET"), "a secret field was stored")
  })

  test("a second connection only updates connectionCount and lastConnectionAt", async () => {
    const before = await row()
    await connectAndClose("srv-real-2")
    await until(async () => (await row()).connection_count === 2)
    const after = await row()
    assert.deepEqual(stable(after), stable(before))
    assert.deepEqual(after.events, before.events)
    assert.ok(after.last_connection_at.getTime() >= before.last_connection_at.getTime())
  })

  test("zz fixture venues are ignored", async () => {
    await connectAndClose("zzhub-fixture")
    await settle()
    assert.equal((await row()).connection_count, 2)
  })

  test("a restart keeps the original dates and appends one restarted event", async () => {
    const before = await row()
    assert.equal(await store.appendRestart(new Date()), true)
    const after = await row()
    assert.deepEqual(stable(after), stable(before))
    assert.equal(after.connection_count, before.connection_count)
    assert.equal(after.last_connection_at.toISOString(), before.last_connection_at.toISOString())
    assert.deepEqual(after.events.slice(before.events.length).map((e: any) => e.type), ["restarted"])
  })

  test("the routes plugin schedules one restart per process, and it was already used", async () => {
    const before = await row()
    await hooks.recordRestart()
    assert.equal((await row()).events.length, before.events.length)
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
      const before = await row()
      await connectAndClose("srv-real-1")
      await until(async () => warnings.some((w) => w.startsWith("[subscription]")))
      assert.equal((await row()).connection_count, before.connection_count)
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
      const before = await row()
      const { ws, ackMs } = await hubConnect("srv-real-1")
      assert.ok(ackMs < 1000, `handshake took ${ackMs} ms`)
      await settle()
      assert.equal(ws.readyState, WebSocket.OPEN)
      assert.equal((await row()).connection_count, before.connection_count)
      release()
      await until(async () => (await row()).connection_count === before.connection_count + 1)
      ws.close()
    } finally {
      prisma.$transaction = original
    }
  })

  test("simultaneous connections create exactly one record", async () => {
    await prisma.$executeRawUnsafe("DELETE FROM subscription.record")
    await Promise.all(Array.from({ length: 6 }, () => hooks.onClientConnected({ source: "hub", serverId: "srv-real-1" })))
    const r = await row()
    assert.equal(r.connection_count, 6)
    assert.deepEqual(r.events.map((e: any) => e.type), ["created"])
  })

  test("thresholds are stored once per term, only by connection and restart writes", async () => {
    await prisma.$executeRawUnsafe("UPDATE subscription.record SET ends_at = now() + interval '20 days'")
    const before = await row()

    assert.equal((await call(tokens.SUPER_ADMIN, "GET", "/api/subscription")).status, 200)
    assert.equal((await call(tokens.SUPER_ADMIN, "GET", "/api/subscription/clock")).status, 200)
    assert.deepEqual((await row()).events, before.events, "a read recorded a threshold")

    await call(tokens.SUPER_ADMIN, "PUT", "/api/subscription/notes", { notes: "no thresholds here" })
    assert.deepEqual((await row()).events.filter((e: any) => e.type === "threshold"), [], "a notes write recorded a threshold")

    await hooks.onClientConnected({ source: "hub", serverId: "srv-real-1" })
    const thresholds = async () => (await row()).events.filter((e: any) => e.type === "threshold").map((e: any) => `${e.term}:${e.threshold}`)
    assert.deepEqual(await thresholds(), ["1:90", "1:30"])

    await hooks.onClientConnected({ source: "hub", serverId: "srv-real-2" })
    await store.appendRestart(new Date())
    assert.deepEqual(await thresholds(), ["1:90", "1:30"])

    await prisma.$executeRawUnsafe("UPDATE subscription.record SET ends_at = now() + interval '3 days'")
    await Promise.all([
      hooks.onClientConnected({ source: "hub", serverId: "srv-real-1" }),
      store.appendRestart(new Date()),
      hooks.onClientConnected({ source: "hub", serverId: "srv-real-2" }),
    ])
    assert.deepEqual(await thresholds(), ["1:90", "1:30", "1:7"])

    await prisma.$executeRawUnsafe("UPDATE subscription.record SET ends_at = now() - interval '1 hour'")
    await connectAndClose("srv-real-1")
    await until(async () => (await thresholds()).length === 5)
    assert.deepEqual(await thresholds(), ["1:90", "1:30", "1:7", "1:1", "1:ended"])
    const r = await row()
    assert.deepEqual(r.terms, before.terms, "a threshold write changed the terms")
    assert.equal(r.started_at.toISOString(), before.started_at.toISOString())
  })

  test("an ended term still accepts connections and blocks nothing else", async () => {
    const before = await row()
    assert.ok(before.ends_at.getTime() < Date.now())
    await connectAndClose("srv-real-2")
    await until(async () => (await row()).connection_count === before.connection_count + 1)
    assert.deepEqual(await call(null, "GET", "/api/control"), { status: 200, body: { ok: true } })
  })

  test("every endpoint is super-admin only, with the existing forbidden response", async () => {
    const before = await row()
    const endpoints: [string, string, unknown?][] = [
      ["GET", "/api/subscription"],
      ["GET", "/api/subscription/clock"],
      ["PUT", "/api/subscription/notes", { notes: "x" }],
      ["PUT", "/api/subscription/reminders", { reminderDays: [] }],
      ["POST", "/api/subscription/banners/30/dismiss"],
      ["POST", "/api/subscription/export", { format: "json" }],
      ["POST", "/api/subscription/renew", { confirmEndDate: "2000-01-01" }],
    ]
    for (const [method, url, body] of endpoints) {
      for (const role of ["ORGANIZATION_ADMIN", "LOCATION_MANAGER", "VIEWER"]) {
        assert.deepEqual(await call(tokens[role], method, url, body), {
          status: 403,
          body: { status: 403, code: "FORBIDDEN", message: "You do not have access to this resource." },
        }, `${role} ${method} ${url}`)
      }
      assert.equal((await call(null, method, url, body)).status, 401, `anonymous ${method} ${url}`)
    }
    const after = await row()
    assert.deepEqual(stable(after), stable(before))
    assert.deepEqual(after.events, before.events)
  })

  test("the plugin adds no auth to sibling routes, and a missing module still boots", async () => {
    assert.deepEqual(await call(null, "GET", "/api/control"), { status: 200, body: { ok: true } })
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
            child.get("/subscription", async () => ({ shadow: true }))
            await child.register(import("../src/subscription/routes.js").catch(() => ({ default: async () => {} })))
          })
        },
        { prefix: "/api" }
      )
      await second.ready()
      const res = await second.inject({ method: "GET", url: "/api/control" })
      assert.deepEqual(res.json(), { ok: true })
      assert.ok(warnings.some((w) => w.startsWith("[subscription] could not register routes")), "the registration error was not logged")
    } finally {
      console.warn = warn
      await second.close()
    }
  })

  test("there is no delete, reset or date edit endpoint", async () => {
    for (const method of ["DELETE", "PATCH"]) {
      assert.equal((await call(tokens.SUPER_ADMIN, method, "/api/subscription")).status, 404)
    }
  })

  test("read endpoints only read", async () => {
    await prisma.$executeRawUnsafe("DELETE FROM subscription.record")
    await hooks.onClientConnected({ source: "hub", serverId: "srv-real-1" })
    const before = await row()
    const read = await call(tokens.SUPER_ADMIN, "GET", "/api/subscription")
    assert.equal(read.status, 200)
    assert.equal(read.body.record.id, before.id)
    assert.equal(read.body.record.endsAt, before.ends_at.toISOString())
    const clock = await call(tokens.SUPER_ADMIN, "GET", "/api/subscription/clock")
    assert.deepEqual(Object.keys(clock.body).sort(), ["endsAt", "now"])
    assert.equal(clock.body.endsAt, before.ends_at.toISOString())
    const after = await row()
    assert.deepEqual(stable(after), stable(before))
    assert.deepEqual(after.events, before.events)
    assert.equal(after.connection_count, before.connection_count)
  })

  test("notes and reminders write only their field plus one event", async () => {
    const before = await row()
    const notes = await call(tokens.SUPER_ADMIN, "PUT", "/api/subscription/notes", { notes: "Renew with finance" })
    assert.equal(notes.status, 200)
    let after = await row()
    assert.equal(after.notes, "Renew with finance")
    assert.deepEqual({ ...stable(after), notes: before.notes }, stable(before))
    assert.deepEqual(after.events.slice(before.events.length).map((e: any) => [e.type, e.by.email]), [["note_saved", "super@example.test"]])

    const mid = after
    assert.equal((await call(tokens.SUPER_ADMIN, "PUT", "/api/subscription/reminders", { reminderDays: [7, 30] })).status, 200)
    after = await row()
    assert.deepEqual(after.reminder_days, [30, 7])
    assert.deepEqual({ ...stable(after), reminder_days: mid.reminder_days }, stable(mid))
    assert.deepEqual(after.events.slice(mid.events.length).map((e: any) => e.type), ["reminders_saved"])
    assert.equal(after.connection_count, before.connection_count)

    assert.equal((await call(tokens.SUPER_ADMIN, "PUT", "/api/subscription/reminders", { reminderDays: [45] })).status, 400)
    assert.equal((await call(tokens.SUPER_ADMIN, "PUT", "/api/subscription/notes", { notes: 5 })).status, 400)
  })

  test("dismissing a banner is stored once per threshold per term and hides only that threshold", async () => {
    const { derive } = await import(PORTAL_DERIVE)
    assert.equal((await call(tokens.SUPER_ADMIN, "PUT", "/api/subscription/reminders", { reminderDays: [90, 30, 7, 1] })).status, 200)
    const original = await row()
    const daysLeft = (days: number) =>
      prisma.$executeRawUnsafe(`UPDATE subscription.record SET ends_at = now() + interval '${days} days'`)
    const banner = async () => {
      const { body } = await call(tokens.SUPER_ADMIN, "GET", "/api/subscription")
      return derive(body.record.startedAt, body.record.endsAt, body.now, body.record).banner
    }
    const dismiss = async (days: number) =>
      assert.equal((await call(tokens.SUPER_ADMIN, "POST", `/api/subscription/banners/${days}/dismiss`)).status, 200)
    try {
      await daysLeft(60)
      const before = await row()
      assert.equal(await banner(), 90)
      await dismiss(90)
      assert.equal(await banner(), null)

      await daysLeft(20)
      assert.equal(await banner(), 30, "dismissing 90 hid the 30 day banner")
      await dismiss(30)
      await dismiss(30)
      assert.equal(await banner(), null)

      await daysLeft(5)
      assert.equal(await banner(), 7, "dismissing 90 and 30 hid the 7 day banner")
      await dismiss(7)
      assert.equal(await banner(), null)

      const after = await row()
      assert.deepEqual(after.dismissed.map((d: any) => [d.term, d.threshold]), [[1, 90], [1, 30], [1, 7]])
      assert.deepEqual(after.events, before.events, "a dismissal changed the activity events")
      assert.deepEqual({ ...stable(after), dismissed: before.dismissed, ends_at: before.ends_at.toISOString() }, stable(before))
      assert.equal(after.connection_count, before.connection_count)
      assert.equal((await call(tokens.SUPER_ADMIN, "POST", "/api/subscription/banners/45/dismiss")).status, 400)
    } finally {
      await prisma.$executeRawUnsafe("UPDATE subscription.record SET ends_at = $1::timestamptz", original.ends_at.toISOString())
    }
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
    assert.equal(banner(60, rec([[1, 90]])), null)
    assert.equal(banner(20, rec([[1, 90]])), 30)
    assert.equal(banner(5, rec([[1, 90]])), 7)
    assert.equal(banner(0.5, rec([[1, 90]])), 1)
    assert.equal(banner(5, rec([[1, 7]])), 30)
    assert.equal(banner(5, rec([[1, 7], [1, 30]])), 90)
    assert.equal(banner(5, rec([[1, 7], [1, 30], [1, 90]])), null)
    assert.equal(banner(5, rec([], [90, 30, 1])), 30)
    assert.equal(banner(5, rec([], [])), null)
    assert.equal(banner(5, rec([[1, 7]], [90, 30, 7, 1], 2)), 7)
    const ended = derive(start, end, at(-1), rec([]))
    assert.equal(ended.banner, null)
    assert.equal(ended.band, "ended")
    assert.equal(derive(start, end, at(0), rec([])).banner, null)
  })

  test("export returns this record only and appends one exported event", async () => {
    const before = await row()
    const json = await call(tokens.SUPER_ADMIN, "POST", "/api/subscription/export", { format: "json" })
    assert.equal(json.status, 200)
    const snapshot = JSON.parse(json.body.content)
    assert.equal(snapshot.id, before.id)
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "connectionCount", "createdByConnection", "dismissed", "endsAt", "events", "id", "lastConnectionAt",
      "notes", "reminderDays", "serverLabel", "startedAt", "status", "terms",
    ])
    const text = await call(tokens.SUPER_ADMIN, "POST", "/api/subscription/export", { format: "text" })
    assert.match(text.body.content, /Term history\n1\. /)
    assert.match(text.body.content, /Status: Active/)
    const after = await row()
    assert.deepEqual(after.events.slice(before.events.length).map((e: any) => [e.type, e.format]), [["exported", "json"], ["exported", "text"]])
    assert.deepEqual(stable(after), stable(before))
  })

  test("renewal needs the exact end date and only appends a term", async () => {
    const before = await row()
    const wrong = await call(tokens.SUPER_ADMIN, "POST", "/api/subscription/renew", { confirmEndDate: "1999-01-01" })
    assert.equal(wrong.status, 400)
    assert.deepEqual(stable(await row()), stable(before))

    const endDate = before.ends_at.toISOString().slice(0, 10)
    const ok = await call(tokens.SUPER_ADMIN, "POST", "/api/subscription/renew", { confirmEndDate: endDate })
    assert.equal(ok.status, 200)
    const after = await row()
    assert.equal(after.started_at.toISOString(), before.started_at.toISOString())
    assert.deepEqual(after.terms[0], before.terms[0])
    assert.equal(after.terms.length, 2)
    assert.equal(after.terms[1].startedAt, before.ends_at.toISOString())
    assert.equal(after.terms[1].endsAt, time.addCalendarMonthsUTC(before.ends_at, 12).toISOString())
    assert.equal(after.terms[1].reason, "renewal")
    assert.deepEqual(after.terms[1].confirmedBy, { type: "user", userId: "super", email: "super@example.test" })
    assert.equal(after.ends_at.toISOString(), after.terms[1].endsAt)
    assert.equal(after.connection_count, before.connection_count)
    const last = after.events[after.events.length - 1]
    assert.equal(last.type, "renewal_confirmed")
    assert.equal(last.by.email, "super@example.test")
    assert.equal(last.term, 2)
  })

  test("renewing an ended term starts the new term now", async () => {
    await prisma.$executeRawUnsafe("UPDATE subscription.record SET ends_at = now() - interval '2 days'")
    const before = await row()
    const ok = await call(tokens.SUPER_ADMIN, "POST", "/api/subscription/renew", { confirmEndDate: before.ends_at.toISOString().slice(0, 10) })
    assert.equal(ok.status, 200)
    const after = await row()
    const term = after.terms[after.terms.length - 1]
    assert.ok(Math.abs(new Date(term.startedAt).getTime() - Date.now()) < 10_000)
    assert.equal(term.endsAt, time.addCalendarMonthsUTC(new Date(term.startedAt), 12).toISOString())
    assert.equal(after.started_at.toISOString(), before.started_at.toISOString())
    assert.deepEqual(after.terms.slice(0, before.terms.length), before.terms)
  })

  test("a new term has its own thresholds and earlier ones stay as stored", async () => {
    const before = await row()
    const term = before.terms.length
    await prisma.$executeRawUnsafe("UPDATE subscription.record SET ends_at = now() + interval '60 days'")
    await hooks.onClientConnected({ source: "hub", serverId: "srv-real-1" })
    const after = await row()
    assert.deepEqual(after.events.slice(0, before.events.length), before.events)
    assert.deepEqual(after.events.filter((e: any) => e.type === "threshold" && e.term === term).map((e: any) => e.threshold), ["90"])
  })

  test("calendar months are UTC and clamp like the database", async () => {
    assert.equal(time.addCalendarMonthsUTC(new Date("2028-02-29T10:00:00.000Z"), 12).toISOString(), "2029-02-28T10:00:00.000Z")
    assert.equal(time.addCalendarMonthsUTC(new Date("2026-01-31T23:30:00.000Z"), 1).toISOString(), "2026-02-28T23:30:00.000Z")
    await prisma.$executeRawUnsafe("DELETE FROM subscription.record")
    await store.recordConnection(
      { source: "hub", serverId: "srv-real-1", serverName: null, organizationId: null, version: null, ipAddress: null, caps: [] },
      new Date("2028-02-29T10:00:00.000Z")
    )
    assert.equal((await row()).ends_at.toISOString(), "2029-02-28T10:00:00.000Z")
    assert.deepEqual(time.spanBetween(new Date("2026-01-31T00:00:00Z"), new Date("2026-03-02T05:07:00Z")), { months: 1, days: 2, hours: 5, minutes: 7 })
    assert.equal(time.bandFor(91 * DAY), "active")
    assert.equal(time.bandFor(90 * DAY), "attention")
    assert.equal(time.bandFor(30 * DAY), "warning")
    assert.equal(time.bandFor(7 * DAY), "critical")
    assert.equal(time.bandFor(1), "critical")
    assert.equal(time.bandFor(0), "ended")
  })

  test("a server clock behind the start leaves the stored dates unchanged", async () => {
    const before = await row()
    assert.ok(before.started_at.getTime() > Date.now())
    await hooks.onClientConnected({ source: "hub", serverId: "srv-real-1" })
    const after = await row()
    assert.deepEqual(stable(after), stable(before))
    const read = await call(tokens.SUPER_ADMIN, "GET", "/api/subscription")
    assert.ok(new Date(read.body.now).getTime() < new Date(read.body.record.startedAt).getTime())
  })

  test("no unhandled rejection escaped the feature", () => {
    assert.deepEqual(unhandled, [])
  })
})
