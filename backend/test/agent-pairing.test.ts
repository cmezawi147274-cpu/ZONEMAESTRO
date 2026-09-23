/**
 * Agent pairing hardening — regression suite for the cloud-side half of the
 * agent-bridge pairing/auth contract (see routes/agent.ts, lib/pairing.ts,
 * lib/agent-auth.ts).
 *
 * Runs against a live backend over HTTP, same as security-surface.test.ts
 * and tenant-isolation.test.ts. Fixtures are created/removed through Prisma
 * with the same `zzagent-` prefix convention so teardown can never touch a
 * real row.
 *
 *   npm test                  (backend/, against TEST_API_URL or :4000)
 */
import { test, before, after, describe } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { PrismaClient } from "@prisma/client"

const API = process.env.TEST_API_URL ?? "http://127.0.0.1:4000"
const prisma = new PrismaClient()

const P = "zzagent-"
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function genCode(): string {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("")
  return `${group()}-${group()}`
}
function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex")
}

let orgId: string
let locId: string
let n = 0
/** A fresh, never-touched server row with an active pairing code, ready for
 * one test's own pairing/complete call. */
async function freshServer(): Promise<{ id: string; code: string }> {
  n++
  const id = `${P}srv-${n}-${Date.now()}`
  const code = genCode()
  await prisma.musicServer.create({
    data: {
      id,
      organizationId: orgId,
      locationId: locId,
      name: `Agent Test Server ${n}`,
      status: "UNKNOWN",
      pairingCode: code,
      pairingCodeHash: hashCode(code),
      pairingExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  })
  return { id, code }
}

async function complete(code: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${API}/api/pairing/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, serverVersion: "9.9.9", ...extra }),
  })
  const body = await res.json()
  return { status: res.status, body: body as Record<string, unknown> }
}

async function cleanup() {
  await prisma.deletedServerTombstone.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.agentLink.deleteMany({ where: { cmmpServerId: { startsWith: P } } })
  await prisma.remoteCommand.deleteMany({ where: { serverId: { startsWith: P } } })
  await prisma.zone.deleteMany({ where: { serverId: { startsWith: P } } })
  await prisma.musicServer.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.location.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.organization.deleteMany({ where: { id: { startsWith: P } } })
}

before(async () => {
  await cleanup()
  orgId = `${P}org`
  locId = `${P}loc`
  await prisma.organization.create({
    data: { id: orgId, name: "Agent Test Org", slug: orgId, contactName: "Test", contactEmail: "agent-test@test.local" },
  })
  await prisma.location.create({
    data: { id: locId, organizationId: orgId, name: "Agent Test Venue", address: "1 Test St", city: "Testville", region: "TS", country: "TS", timezone: "UTC" },
  })
})

after(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe("pairing is resumable", () => {
  test("a fresh code pairs successfully", async () => {
    const { code, id } = await freshServer()
    const r = await complete(code)
    assert.equal(r.status, 201)
    assert.equal(r.body.serverId, id)
    assert.equal(typeof r.body.agentToken, "string")
    assert.equal(r.body.locationId, locId)
  })

  test("replaying the exact same completed request returns the same credentials, not an error", async () => {
    const { code, id } = await freshServer()
    const first = await complete(code)
    assert.equal(first.status, 201)

    const replay = await complete(code)
    assert.equal(replay.status, 201, "a replay of an already-consumed code within the window must not error")
    assert.equal(replay.body.serverId, id, "a replay must not mint a second identity")
    assert.equal(replay.body.agentToken, first.body.agentToken, "a replay must return the same token an agent may have already stored")

    // Idempotent, not merely "still works": pairing exactly once vs. twice
    // must leave the row in the same state (one pairedAt stamp, one token).
    const server = await prisma.musicServer.findUniqueOrThrow({ where: { id } })
    assert.equal(server.agentTokenHash, crypto.createHash("sha256").update(first.body.agentToken as string).digest("hex"))
  })

  test("a replay outside the window is PAIRING_CODE_ALREADY_USED, not a silent success", async () => {
    const { code, id } = await freshServer()
    const first = await complete(code)
    assert.equal(first.status, 201)
    // Simulate the window having elapsed without waiting for it.
    await prisma.musicServer.update({ where: { id }, data: { pairingConsumedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) } })

    const late = await complete(code)
    assert.equal(late.status, 400)
    assert.equal(late.body.code, "PAIRING_CODE_ALREADY_USED")
  })
})

describe("stable, distinct error codes", () => {
  test("a code that was never issued is PAIRING_CODE_UNKNOWN", async () => {
    const r = await complete("ZZZZ-9999")
    assert.equal(r.status, 400)
    assert.equal(r.body.code, "PAIRING_CODE_UNKNOWN")
  })

  test("an expired code is PAIRING_CODE_EXPIRED, distinct from unknown", async () => {
    const { code } = await freshServer()
    await prisma.musicServer.updateMany({
      where: { pairingCodeHash: hashCode(code) },
      data: { pairingExpiresAt: new Date(Date.now() - 1000) },
    })
    const r = await complete(code)
    assert.equal(r.status, 400)
    assert.equal(r.body.code, "PAIRING_CODE_EXPIRED")
  })

  test("a superseded code is PAIRING_CODE_REVOKED, distinct from unknown or expired", async () => {
    const { code, id } = await freshServer()
    const newCode = genCode()
    // Mirrors POST /servers/:id/pairing-code's own revoke bookkeeping.
    await prisma.musicServer.update({
      where: { id },
      data: { pairingRevokedCodeHash: hashCode(code), pairingCode: newCode, pairingCodeHash: hashCode(newCode), pairingExpiresAt: new Date(Date.now() + 60_000) },
    })
    const r = await complete(code)
    assert.equal(r.status, 400)
    assert.equal(r.body.code, "PAIRING_CODE_REVOKED")
  })

  test("no/garbage bearer token on an agent route is AGENT_TOKEN_UNKNOWN", async () => {
    const res = await fetch(`${API}/api/server/heartbeat`, {
      method: "POST",
      headers: { Authorization: "Bearer not-a-real-token", "Content-Type": "application/json" },
      body: JSON.stringify({ serverVersion: "1.0.0" }),
    })
    assert.equal(res.status, 401)
    const body = (await res.json()) as { code: string }
    assert.equal(body.code, "AGENT_TOKEN_UNKNOWN")
  })

  test("a rotated-away token is AGENT_TOKEN_REVOKED, distinct from unknown", async () => {
    const { code } = await freshServer()
    const paired = await complete(code)
    const oldToken = paired.body.agentToken as string

    // Rotate — the old token is no longer the row's credential.
    const rotateRes = await fetch(`${API}/api/server/token`, { method: "POST", headers: { Authorization: `Bearer ${oldToken}` } })
    assert.equal(rotateRes.status, 200)

    const res = await fetch(`${API}/api/server/heartbeat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${oldToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ serverVersion: "1.0.0" }),
    })
    assert.equal(res.status, 401)
    const body = (await res.json()) as { code: string }
    assert.equal(body.code, "AGENT_TOKEN_REVOKED")
  })

  test("a token for a deleted server is SERVER_DELETED, distinct from unknown", async () => {
    const { code, id } = await freshServer()
    const paired = await complete(code)
    const token = paired.body.agentToken as string

    await prisma.musicServer.delete({ where: { id } })
    await prisma.deletedServerTombstone.create({ data: { id } })

    const res = await fetch(`${API}/api/server/heartbeat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ serverVersion: "1.0.0" }),
    })
    assert.equal(res.status, 401)
    const body = (await res.json()) as { code: string }
    assert.equal(body.code, "SERVER_DELETED")
  })
})

describe("previousServerId release", () => {
  test("the old row is put on the retention clock, not left as a permanent ghost", async () => {
    const a = await freshServer()
    await complete(a.code)
    const b = await freshServer()
    const r = await complete(b.code, { previousServerId: a.id })
    assert.equal(r.status, 201)

    const oldRow = await prisma.musicServer.findUniqueOrThrow({ where: { id: a.id } })
    assert.equal(oldRow.status, "UNKNOWN")
    assert.equal(oldRow.agentTokenHash, null)
    assert.notEqual(oldRow.pairingExpiresAt, null, "a released row with no pairingExpiresAt is invisible to the unpaired-retention sweep forever")
  })
})

describe("heartbeat", () => {
  test("response carries serverTime (ISO-8601), for the agent's own clock-skew check", async () => {
    const { code } = await freshServer()
    const paired = await complete(code)
    const token = paired.body.agentToken as string

    const res = await fetch(`${API}/api/server/heartbeat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ serverVersion: "9.9.9" }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { serverTime: string; serverTimeUtc: string }
    assert.ok(!Number.isNaN(Date.parse(body.serverTime)), "serverTime is not a valid ISO-8601 timestamp")
    assert.equal(body.serverTime, body.serverTimeUtc)
  })
})

describe("health", () => {
  test("GET /api/health works the same as GET /health", async () => {
    const [root, aliased] = await Promise.all([fetch(`${API}/health`), fetch(`${API}/api/health`)])
    assert.equal(root.status, 200)
    assert.equal(aliased.status, 200, "GET /api/health is not aliased to /health")
    const [rootBody, aliasedBody] = await Promise.all([root.json(), aliased.json()])
    assert.deepEqual(rootBody, aliasedBody)
  })
})

describe("idempotent sync", () => {
  test("repeating zones/sync with the same payload does not duplicate zones", async () => {
    const { code, id } = await freshServer()
    const paired = await complete(code)
    const token = paired.body.agentToken as string
    const payload = { zones: [{ localZoneId: "zone-1", name: "Dining Room", playbackState: "STOPPED", volume: 50, muted: false }] }

    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${API}/api/server/zones/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      assert.equal(res.status, 200)
    }
    const count = await prisma.zone.count({ where: { serverId: id } })
    assert.equal(count, 1, "repeating the same zones report created a duplicate zone")
  })

  test("a retried commands/ack does not re-resolve an already-terminal command", async () => {
    const { code, id } = await freshServer()
    const paired = await complete(code)
    const token = paired.body.agentToken as string
    const command = await prisma.remoteCommand.create({
      data: { id: `${P}cmd-${Date.now()}`, serverId: id, type: "RESTART_SERVICE", status: "SENT", source: "SUPER_ADMIN", issuedById: `${P}user` },
    })

    const ack = (resultMessage: string) =>
      fetch(`${API}/api/server/commands/ack`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: command.id, status: "SUCCESS", resultMessage }),
      })

    assert.equal((await ack("first")).status, 200)
    const after = await prisma.remoteCommand.findUniqueOrThrow({ where: { id: command.id } })
    assert.equal(after.status, "SUCCESS")

    // The agent retries acks with backoff, so the same ack can land twice —
    // and a *late* ack must never overwrite a resolution the cloud already
    // recorded (that is how a TIMEOUT used to silently flip to SUCCESS while
    // keeping the timeout's own "no response" text).
    const retry = await ack("second")
    assert.equal(retry.status, 200, "a retried ack must not error — the agent would keep retrying forever")
    const final = await prisma.remoteCommand.findUniqueOrThrow({ where: { id: command.id } })
    assert.equal(final.status, "SUCCESS")
    assert.equal(final.resultMessage, "first", "a retried ack overwrote the already-recorded result")
    assert.deepEqual(final.completedAt, after.completedAt, "a retried ack moved completedAt")
  })

  test("an EXECUTING ack claims a command without resolving it", async () => {
    const { code, id } = await freshServer()
    const paired = await complete(code)
    const token = paired.body.agentToken as string
    const command = await prisma.remoteCommand.create({
      data: { id: `${P}cmd-exec-${Date.now()}`, serverId: id, type: "RESTART_SERVICE", status: "SENT", source: "SUPER_ADMIN", issuedById: `${P}user` },
    })
    const ack = (status: string) =>
      fetch(`${API}/api/server/commands/ack`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: command.id, status }),
      })

    // The agent claims the command before doing the work.
    assert.equal((await ack("EXECUTING")).status, 200)
    const claimed = await prisma.remoteCommand.findUniqueOrThrow({ where: { id: command.id } })
    assert.equal(claimed.status, "EXECUTING")
    assert.notEqual(claimed.executingAt, null, "executingAt was not stamped")
    assert.equal(claimed.completedAt, null, "EXECUTING must not complete the command")

    // And it is no longer handed out, which is the point of the claim.
    const pending = await fetch(`${API}/api/server/commands/pending`, { headers: { Authorization: `Bearer ${token}` } })
    const body = (await pending.json()) as { commands: { commandId: string }[] }
    assert.equal(
      body.commands.some((c) => c.commandId === command.id),
      false,
      "a claimed command was handed out again"
    )

    // The real result still lands afterwards.
    assert.equal((await ack("SUCCESS")).status, 200)
    const done = await prisma.remoteCommand.findUniqueOrThrow({ where: { id: command.id } })
    assert.equal(done.status, "SUCCESS", "the final ack was rejected after an EXECUTING claim")
    assert.notEqual(done.completedAt, null)
  })
})

describe("SignalR hub auth", () => {
  /** Resolves how the hub closed us out, or "open" if it never did. The agent
   * holds this socket outbound; a hub that accepts (or simply never closes)
   * an unusable token leaves a venue believing it is connected while no
   * command can ever reach it. */
  function hubOutcome(accessToken: string, timeoutMs = 4000): Promise<string> {
    return new Promise((resolve) => {
      const url = `${API.replace(/^http/, "ws")}/hubs/musicserver?access_token=${encodeURIComponent(accessToken)}`
      const ws = new WebSocket(url)
      const timer = setTimeout(() => {
        ws.close()
        resolve("open")
      }, timeoutMs)
      ws.addEventListener("close", (ev) => {
        clearTimeout(timer)
        resolve(`closed:${ev.code}`)
      })
      ws.addEventListener("error", () => {
        clearTimeout(timer)
        resolve("error")
      })
    })
  }

  test("a garbage token is closed promptly, not left hanging", async () => {
    const outcome = await hubOutcome("not-a-real-token")
    assert.notEqual(outcome, "open", "the hub left an unauthenticated socket open")
  })

  test("a revoked token is closed promptly", async () => {
    const { code, id } = await freshServer()
    const paired = await complete(code)
    const token = paired.body.agentToken as string
    // Revoke it the way a re-pair or a release does: drop the row's hash.
    await prisma.musicServer.update({ where: { id }, data: { agentTokenHash: null } })

    const outcome = await hubOutcome(token)
    assert.notEqual(outcome, "open", "the hub kept a socket open for a revoked token")
  })

  test("a valid token is accepted", async () => {
    const { code } = await freshServer()
    const paired = await complete(code)
    const outcome = await hubOutcome(paired.body.agentToken as string, 1500)
    assert.equal(outcome, "open", "the hub rejected a valid agent token")
  })
})

describe("request correlation", () => {
  test("X-Request-Id is echoed back in an error body", async () => {
    const requestId = `vk-${crypto.randomBytes(6).toString("hex")}`
    const res = await fetch(`${API}/api/server/heartbeat`, {
      method: "POST",
      headers: { Authorization: "Bearer not-a-real-token", "Content-Type": "application/json", "X-Request-Id": requestId },
      body: JSON.stringify({ serverVersion: "1.0.0" }),
    })
    assert.equal(res.status, 401)
    const body = (await res.json()) as { code: string; requestId?: string }
    assert.equal(body.code, "AGENT_TOKEN_UNKNOWN")
    assert.equal(body.requestId, requestId, "the venue's request id was not echoed — the two logs cannot be correlated")
  })

  test("a request without the header gets no requestId field", async () => {
    const res = await fetch(`${API}/api/server/heartbeat`, {
      method: "POST",
      headers: { Authorization: "Bearer not-a-real-token", "Content-Type": "application/json" },
      body: JSON.stringify({ serverVersion: "1.0.0" }),
    })
    const body = (await res.json()) as Record<string, unknown>
    assert.ok(!("requestId" in body), "an always-present null requestId reads like a bug to the portal")
  })
})

describe("pairing rate limiting", () => {
  test("many attempts against one location's already-consumed code eventually 429", async () => {
    const { code } = await freshServer()
    await complete(code) // consume it — every further call is a replay, which still counts against the location limit
    let sawLimit = false
    for (let i = 0; i < 30; i++) {
      const r = await complete(code)
      if (r.status === 429) {
        sawLimit = true
        assert.equal(r.body.code, "RATE_LIMITED")
        break
      }
      assert.equal(r.status, 201, `unexpected status ${r.status} on attempt ${i + 1}`)
    }
    assert.ok(sawLimit, "30 rapid pairing attempts against one location were never rate-limited")
  })
})

/**
 * Volume write-wins grace window (lib/agent-registry.ts
 * markZoneVolumeWritten/isZoneVolumeWriteFresh).
 *
 * POST /server/zones/sync fires on every heartbeat and unconditionally
 * overwrote Zone.volume with whatever the agent reported — heartbeats run
 * independently of commands, so if a SET_VOLUME ack landed and the very
 * next heartbeat's snapshot was taken before (or the local write hadn't
 * durably applied), the value a user just set got silently reverted
 * within one heartbeat interval. Exercises both routes directly rather
 * than the full POST /commands flow (which blocks on a real agent ack and
 * needs a portal session) — these are exactly the two routes changed.
 */
/**
 * Retries a pairing completion on 429 — this file's fixtures share one
 * source IP with security-surface.test.ts's login-rate-limiting probe
 * (deliberately 25 rapid failures) and tenant-isolation.test.ts's own
 * login() helper already documents and retries the identical collision.
 * A concurrently-running test file's burst landing mid-suite is not a
 * pairing bug, so it is waited out rather than asserted against.
 */
async function completeWithRetry(code: string) {
  const started = Date.now()
  for (let attempt = 1; ; attempt++) {
    const r = await complete(code)
    // 75s, matching tenant-isolation.test.ts's login() budget for the
    // identical collision — 30s was not long enough in practice.
    if (r.status !== 429 || Date.now() - started > 75_000) return r
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
}

describe("volume write-wins grace window", () => {
  test("a heartbeat's zones/sync cannot revert a volume a command ack just set", async () => {
    const { code, id: serverId } = await freshServer()
    const paired = await completeWithRetry(code)
    assert.equal(paired.status, 201, JSON.stringify(paired.body))
    const token = paired.body.agentToken as string

    // Establish the zone via a normal heartbeat report, same as production.
    const seed = await fetch(`${API}/api/server/zones/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ zones: [{ localZoneId: "zone-vol", name: "Volume Test Zone", playbackState: "PLAYING", volume: 50, muted: false }] }),
    })
    assert.equal(seed.status, 200, JSON.stringify(await seed.clone().json().catch(() => null)))
    const zone = await prisma.zone.findFirstOrThrow({ where: { serverId, localZoneId: "zone-vol" } })

    // A command result — the same write POST /server/commands/ack does
    // for a real SET_VOLUME ack.
    const command = await prisma.remoteCommand.create({
      data: { id: `${P}cmd-${Date.now()}`, serverId, zoneId: zone.id, type: "SET_VOLUME", status: "PENDING", source: "USER", issuedById: `${P}test` },
    })
    const ack = await fetch(`${API}/api/server/commands/ack`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: command.id, status: "SUCCESS", zoneState: { volume: 77, playbackState: "PLAYING" } }),
    })
    assert.equal(ack.status, 200)
    assert.equal((await prisma.zone.findUniqueOrThrow({ where: { id: zone.id } })).volume, 77, "the command ack did not set volume at all")

    // The very next heartbeat, reporting the zone as if the local side
    // still has (or reverted to) the pre-command value.
    const sync = await fetch(`${API}/api/server/zones/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ zones: [{ localZoneId: "zone-vol", name: "Volume Test Zone", playbackState: "PLAYING", volume: 50, muted: false }] }),
    })
    assert.equal(sync.status, 200)

    const after = await prisma.zone.findUniqueOrThrow({ where: { id: zone.id } })
    assert.equal(after.volume, 77, "a routine heartbeat reverted a volume the command ack just set")
  })

  test("without a recent command result, zones/sync still applies volume normally", async () => {
    const { code, id: serverId } = await freshServer()
    const paired = await completeWithRetry(code)
    assert.equal(paired.status, 201, JSON.stringify(paired.body))
    const token = paired.body.agentToken as string

    await fetch(`${API}/api/server/zones/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ zones: [{ localZoneId: "zone-vol-2", name: "Volume Test Zone 2", playbackState: "STOPPED", volume: 50, muted: false }] }),
    })
    await fetch(`${API}/api/server/zones/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ zones: [{ localZoneId: "zone-vol-2", name: "Volume Test Zone 2", playbackState: "STOPPED", volume: 33, muted: false }] }),
    })

    const zone = await prisma.zone.findFirstOrThrow({ where: { serverId, localZoneId: "zone-vol-2" } })
    assert.equal(zone.volume, 33, "a heartbeat report with no recent command result was not applied")
  })
})
