/**
 * Tenant-isolation regression suite.
 *
 * This exists because the same class of bug was found twice, by two separate
 * audits, in code that looked scoped on inspection:
 *
 *   - routes/music.ts, schedules.ts and sync.ts had no organization filter at
 *     all, so any authenticated user could read, edit and delete another
 *     tenant's library — and POST /sync/queue would push audio onto another
 *     tenant's venue hardware.
 *   - routes/servers.ts and monitoring.ts *did* have tenant helpers, and used
 *     them on some routes but not others. A file-level read counted the
 *     checks, saw plenty, and moved on. DELETE /servers/:id had none, so one
 *     organization could delete another's server row by guessing an id.
 *
 * Reading for this is unreliable; asserting it is not. Every route that takes
 * an id someone else could own belongs in here.
 *
 * Runs against a live backend over HTTP — the same path a real client takes,
 * so it exercises auth, RBAC and routing rather than calling handlers
 * directly. Fixtures are created and removed through Prisma because creating
 * an organization requires SUPER_ADMIN, which is the thing under test.
 *
 *   npm test                  (backend/, against TEST_API_URL or :4000)
 *   TEST_API_URL=... npm test
 */
import { test, before, after, describe } from "node:test"
import assert from "node:assert/strict"
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"

const API = process.env.TEST_API_URL ?? "http://127.0.0.1:4000"
const prisma = new PrismaClient()

/** Everything this suite creates carries this prefix so teardown can never
 * touch real rows, even if a test throws half-way through. */
const P = "zztest-"
const PASSWORD = "TenantTest123!"

interface Fixture {
  orgA: string
  orgB: string
  locA: string
  locB: string
  serverA: string
  serverB: string
  zoneA: string
  playlistA: string
  trackA: string
  trackShared: string
  folderA: string
  alertA: string
  tokenA: string
  tokenB: string
}
let f: Fixture

/**
 * Retries on 429, because these fixtures share one source IP with
 * security-surface.test.ts's login-rate-limiting probe — which deliberately
 * burns the per-IP auth budget with 25 rapid failures. Node's runner
 * executes test files concurrently, so whether that probe lands before this
 * `before()` hook is a race: losing it took the whole suite down with nine
 * "cancelled" failures that had nothing to do with tenant isolation.
 * Backing off here keeps both tests honest — the probe still asserts that
 * limiting happens, and this still asserts real logins work — instead of
 * making the suite reliably red and therefore ignored.
 */
async function login(email: string): Promise<string> {
  const started = Date.now()
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
    if (res.status === 200) {
      const body = (await res.json()) as { tokens: { accessToken: string } }
      return body.tokens.accessToken
    }
    // Only a rate-limit rejection is worth waiting out; a 401 here means the
    // fixture itself is wrong and should fail immediately and loudly.
    if (res.status !== 429 || Date.now() - started > 75_000) {
      assert.equal(res.status, 200, `login failed for ${email} after ${attempt} attempt(s)`)
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
}

/** Authenticated request helper. Returns status plus parsed body. */
async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    /* non-JSON responses (204) stay as text */
  }
  return { status: res.status, body: parsed }
}

async function cleanup() {
  // Order matters: children before parents, since several FKs are Restrict.
  await prisma.remoteCommand.deleteMany({ where: { serverId: { startsWith: P } } })
  await prisma.trackSyncState.deleteMany({ where: { serverId: { startsWith: P } } })
  await prisma.trackSyncState.deleteMany({ where: { trackId: { startsWith: P } } })
  await prisma.schedule.deleteMany({ where: { zoneId: { startsWith: P } } })
  await prisma.playlistAssignment.deleteMany({ where: { playlistId: { startsWith: P } } })
  await prisma.playlistTrack.deleteMany({ where: { playlistId: { startsWith: P } } })
  await prisma.alert.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.zone.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.musicServer.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.playlist.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.track.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.musicFolder.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.refreshToken.deleteMany({ where: { userId: { startsWith: P } } })
  await prisma.user.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.location.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.organization.deleteMany({ where: { id: { startsWith: P } } })
}

before(async () => {
  await cleanup()
  const hash = await bcrypt.hash(PASSWORD, 10)
  const id = (s: string) => `${P}${s}`

  for (const o of ["a", "b"]) {
    await prisma.organization.create({
      data: {
        id: id(`org-${o}`),
        name: `Test Org ${o.toUpperCase()}`,
        slug: id(`org-${o}`),
        contactName: "Test",
        contactEmail: `${o}@test.local`,
      },
    })
    await prisma.location.create({
      data: { id: id(`loc-${o}`), organizationId: id(`org-${o}`), name: `Venue ${o}`, address: "1 Test St", city: "Testville", region: "TS", country: "TS", timezone: "UTC" },
    })
    await prisma.musicServer.create({
      data: { id: id(`srv-${o}`), organizationId: id(`org-${o}`), locationId: id(`loc-${o}`), name: `Server ${o}`, status: "OFFLINE" },
    })
    await prisma.user.create({
      data: {
        id: id(`user-${o}`),
        name: `Admin ${o}`,
        email: `${P}${o}@test.local`,
        role: "ORGANIZATION_ADMIN",
        organizationId: id(`org-${o}`),
        passwordHash: hash,
      },
    })
  }

  await prisma.zone.create({
    data: { id: id("zone-a"), serverId: id("srv-a"), locationId: id("loc-a"), name: "Zone A", playbackState: "STOPPED" },
  })
  await prisma.playlist.create({ data: { id: id("pl-a"), name: "Playlist A", organizationId: id("org-a") } })
  await prisma.track.create({
    data: { id: id("trk-a"), title: "Track A", artist: "A", album: "A", genre: "Pop", durationSec: 10, fileSizeMb: 1, storageKey: id("a.mp3"), uploadedById: id("user-a"), organizationId: id("org-a") },
  })
  // organizationId null = the operator's shared catalogue: both tenants must
  // be able to READ it and neither may mutate it.
  await prisma.track.create({
    data: { id: id("trk-shared"), title: "Shared Track", artist: "S", album: "S", genre: "Pop", durationSec: 10, fileSizeMb: 1, storageKey: id("s.mp3"), uploadedById: id("user-a"), organizationId: null },
  })
  await prisma.musicFolder.create({ data: { id: id("fld-a"), name: "Folder A", organizationId: id("org-a") } })
  await prisma.alert.create({ data: { id: id("alert-a"), severity: "warning", title: "A alert", message: "m", serverId: id("srv-a") } })

  f = {
    orgA: id("org-a"), orgB: id("org-b"), locA: id("loc-a"), locB: id("loc-b"),
    serverA: id("srv-a"), serverB: id("srv-b"), zoneA: id("zone-a"),
    playlistA: id("pl-a"), trackA: id("trk-a"), trackShared: id("trk-shared"),
    folderA: id("fld-a"), alertA: id("alert-a"),
    tokenA: await login(`${P}a@test.local`),
    tokenB: await login(`${P}b@test.local`),
  }
})

after(async () => {
  await cleanup()
  await prisma.$disconnect()
})

/** A foreign id must 404, never 403 — a 403 confirms the id exists. */
function assertNotFound(r: { status: number }, what: string) {
  assert.equal(r.status, 404, `${what} should 404 for a foreign tenant, got ${r.status}`)
}

/**
 * Music library — readable by any role that can read playlists, mutable only
 * by SUPER_ADMIN, and in both cases scoped to the caller's own tenant.
 *
 * These assertions were briefly rewritten to expect a blanket 403 for
 * ORGANIZATION_ADMIN, on the reading that lib/rbac.ts's SUPER_ADMIN-only
 * comment described the intended model. It did not: withholding
 * "music:read" while granting "playlist:read" is what made a playlist
 * report "29 tracks" and then render an empty list in production. The
 * original assertions here were correct and are restored — this suite was
 * telling the truth and was overruled.
 */
describe("music library", () => {
  // Reads are id-scoped, so a foreign id must 404 and never confirm it exists.
  test("B cannot read A's track", async () => assertNotFound(await call(f.tokenB, "GET", `/api/music/${f.trackA}`), "GET /music/:id"))

  // Writes are refused by the role gate before any lookup happens, so these
  // answer 403 — and that 403 is safe precisely because it is identical for
  // a real, a foreign and a fabricated id (pinned down below).
  test("B cannot edit A's track", async () => {
    assert.equal((await call(f.tokenB, "PATCH", `/api/music/${f.trackA}`, { title: "pwned" })).status, 403)
  })
  test("B cannot delete A's track", async () => {
    assert.equal((await call(f.tokenB, "DELETE", `/api/music/${f.trackA}`)).status, 403)
  })
  test("B cannot edit A's folder", async () => {
    assert.equal((await call(f.tokenB, "PATCH", `/api/music/folders/${f.folderA}`, { name: "pwned" })).status, 403)
  })
  test("B cannot delete A's folder", async () => {
    assert.equal((await call(f.tokenB, "DELETE", `/api/music/folders/${f.folderA}`)).status, 403)
  })

  test("the write refusal reveals nothing about whether the id exists", async () => {
    const foreign = await call(f.tokenB, "DELETE", `/api/music/${f.trackA}`)
    const fabricated = await call(f.tokenB, "DELETE", `/api/music/${P}definitely-not-a-real-track`)
    assert.equal(foreign.status, fabricated.status)
    assert.deepEqual(foreign.body, fabricated.body, "a foreign id answered differently from a fabricated one")
  })

  test("A's track is absent from B's list", async () => {
    const r = await call(f.tokenB, "GET", "/api/music?limit=500")
    const ids = (r.body as { id: string }[]).map((t) => t.id)
    assert.ok(!ids.includes(f.trackA), "A's private track leaked into B's library list")
  })

  test("owner still has full access", async () => {
    assert.equal((await call(f.tokenA, "GET", `/api/music/${f.trackA}`)).status, 200)
  })

  test("shared catalogue is readable by both tenants", async () => {
    assert.equal((await call(f.tokenA, "GET", `/api/music/${f.trackShared}`)).status, 200)
    assert.equal((await call(f.tokenB, "GET", `/api/music/${f.trackShared}`)).status, 200)
  })

  /** The regression that started this: a playlist is unreadable without the
   * track metadata behind it, so any role holding "playlist:read" must be
   * able to resolve the ids that playlist contains. */
  test("a role that can read playlists can resolve the tracks inside them", async () => {
    assert.equal((await call(f.tokenA, "GET", "/api/music?limit=500")).status, 200, "an org admin cannot list tracks, so playlists render empty")
    assert.equal((await call(f.tokenA, "GET", `/api/playlists`)).status, 200)
  })

  /** The library list is paginated, so resolving a known set of ids by
   * fetching "everything" and joining client-side silently dropped any track
   * past the first page — which is how a 16-track playlist rendered as empty
   * once the library passed 100 tracks. ?ids= must return the exact rows
   * asked for, regardless of where they fall in the library. */
  test("?ids= resolves exact tracks regardless of pagination", async () => {
    const r = await call(f.tokenA, "GET", `/api/music?ids=${f.trackA},${f.trackShared}`)
    assert.equal(r.status, 200)
    const ids = (r.body as { id: string }[]).map((t) => t.id).sort()
    assert.deepEqual(ids, [f.trackA, f.trackShared].sort(), "?ids= did not return exactly the requested tracks")
  })

  test("?ids= is still tenant-scoped", async () => {
    // B asking for A's private track by id must not receive it.
    const r = await call(f.tokenB, "GET", `/api/music?ids=${f.trackA}`)
    assert.equal(r.status, 200)
    assert.deepEqual((r.body as { id: string }[]).map((t) => t.id), [], "?ids= leaked another tenant's track")
  })

  test("mutating the library is still SUPER_ADMIN-only", async () => {
    // Read was widened; write deliberately was not.
    assert.equal((await call(f.tokenA, "PATCH", `/api/music/${f.trackA}`, { genre: "Jazz" })).status, 403)
    assert.equal((await call(f.tokenA, "DELETE", `/api/music/${f.trackA}`)).status, 403)
  })
})

describe("sync — cross-tenant writes reach physical hardware", () => {
  test("B cannot queue audio onto A's server", async () => {
    const r = await call(f.tokenB, "POST", "/api/sync/queue", { trackIds: [f.trackShared], serverIds: [f.serverA] })
    assertNotFound(r, "POST /sync/queue")
    const queued = await prisma.remoteCommand.count({ where: { serverId: f.serverA } })
    assert.equal(queued, 0, "a command was queued onto another tenant's server")
  })

  test("B cannot queue A's private track onto B's own server", async () => {
    assertNotFound(await call(f.tokenB, "POST", "/api/sync/queue", { trackIds: [f.trackA], serverIds: [f.serverB] }), "POST /sync/queue with a foreign track")
  })

  test("B cannot read A's sync state", async () => assertNotFound(await call(f.tokenB, "GET", `/api/sync?serverId=${f.serverA}`), "GET /sync?serverId"))

  test("owner can queue to their own server", async () => {
    assert.equal((await call(f.tokenA, "POST", "/api/sync/queue", { trackIds: [f.trackShared], serverIds: [f.serverA] })).status, 201)
  })
})

describe("servers", () => {
  test("B cannot issue a pairing code for A's server", async () => assertNotFound(await call(f.tokenB, "POST", `/api/servers/${f.serverA}/pairing-code`), "POST /servers/:id/pairing-code"))
  test("B cannot read A's server logs", async () => assertNotFound(await call(f.tokenB, "GET", `/api/servers/${f.serverA}/logs`), "GET /servers/:id/logs"))

  test("B cannot delete A's server", async () => {
    assertNotFound(await call(f.tokenB, "DELETE", `/api/servers/${f.serverA}`), "DELETE /servers/:id")
    assert.ok(await prisma.musicServer.findUnique({ where: { id: f.serverA } }), "A's server was deleted by another tenant")
  })

  test("A's server is absent from B's list", async () => {
    const ids = ((await call(f.tokenB, "GET", "/api/servers")).body as { id: string }[]).map((s) => s.id)
    assert.ok(!ids.includes(f.serverA), "A's server leaked into B's list")
  })

  test("owner can still issue a pairing code and read logs", async () => {
    assert.equal((await call(f.tokenA, "POST", `/api/servers/${f.serverA}/pairing-code`)).status, 200)
    assert.equal((await call(f.tokenA, "GET", `/api/servers/${f.serverA}/logs`)).status, 200)
  })
})

describe("schedules", () => {
  test("B cannot create a schedule on A's zone", async () => {
    const r = await call(f.tokenB, "POST", "/api/schedules", {
      zoneId: f.zoneA, playlistId: f.playlistA, name: "evil", startTime: "09:00", endTime: "17:00", days: ["MON"],
    })
    assertNotFound(r, "POST /schedules")
  })

  test("B cannot list A's zone schedules", async () => assertNotFound(await call(f.tokenB, "GET", `/api/schedules?zoneId=${f.zoneA}`), "GET /schedules?zoneId"))

  test("invalid times are rejected", async () => {
    const r = await call(f.tokenA, "POST", "/api/schedules", {
      zoneId: f.zoneA, playlistId: f.playlistA, name: "bad", startTime: "25:99", endTime: "17:00", days: ["MON"],
    })
    assert.equal(r.status, 400, "an invalid HH:mm was accepted")
  })

  test("invalid days are rejected", async () => {
    const r = await call(f.tokenA, "POST", "/api/schedules", {
      zoneId: f.zoneA, playlistId: f.playlistA, name: "bad", startTime: "09:00", endTime: "17:00", days: ["FUNDAY"],
    })
    assert.equal(r.status, 400, "an invalid day was accepted")
  })
})

describe("monitoring", () => {
  test("B cannot acknowledge A's alert", async () => {
    assertNotFound(await call(f.tokenB, "POST", `/api/monitoring/alerts/${f.alertA}/acknowledge`), "POST /monitoring/alerts/:id/acknowledge")
    const alert = await prisma.alert.findUnique({ where: { id: f.alertA } })
    assert.equal(alert?.acknowledged, false, "another tenant acknowledged this alert")
  })

  test("A's alert is absent from B's list", async () => {
    const ids = ((await call(f.tokenB, "GET", "/api/monitoring/alerts")).body as { id: string }[]).map((a) => a.id)
    assert.ok(!ids.includes(f.alertA), "A's alert leaked into B's list")
  })

  test("owner can acknowledge their own alert", async () => {
    assert.equal((await call(f.tokenA, "POST", `/api/monitoring/alerts/${f.alertA}/acknowledge`)).status, 200)
  })
})

describe("zones", () => {
  test("B cannot read A's zone", async () => assertNotFound(await call(f.tokenB, "GET", `/api/zones/${f.zoneA}`), "GET /zones/:id"))
  test("A's zone is absent from B's list", async () => {
    const ids = ((await call(f.tokenB, "GET", "/api/zones")).body as { id: string }[]).map((z) => z.id)
    assert.ok(!ids.includes(f.zoneA), "A's zone leaked into B's list")
  })
})
