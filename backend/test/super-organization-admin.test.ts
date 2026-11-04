import { test, before, after, describe } from "node:test"
import assert from "node:assert/strict"
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"
import { can, type Permission } from "../src/lib/rbac.js"

const API = process.env.TEST_API_URL ?? "http://127.0.0.1:4000"
const prisma = new PrismaClient()

const P = "zzsoa-"
const PASSWORD = "SuperOrgAdmin123!"
const id = (s: string) => `${P}${s}`

const orgA = id("org-a")
const orgB = id("org-b")
const playlistA = id("pl-a")
const playlistB = id("pl-b")
const playlistShared = id("pl-shared")
const visibleTrack = id("trk-visible")

let superToken: string
let soaToken: string
let oaToken: string
let lmToken: string

const uploadedTrackIds: string[] = []

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
    if (res.status !== 429 || Date.now() - started > 75_000) {
      assert.equal(res.status, 200, `login failed for ${email} after ${attempt} attempt(s)`)
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
}

async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
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
    /* 204 */
  }
  return { status: res.status, body: parsed }
}

/** One second of 8 kHz, 8-bit mono silence — a real WAV music-metadata can read. */
function wav(): Uint8Array {
  const samples = 8000
  const buf = Buffer.alloc(44 + samples, 0x80)
  buf.write("RIFF", 0)
  buf.writeUInt32LE(36 + samples, 4)
  buf.write("WAVE", 8)
  buf.write("fmt ", 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(8000, 24)
  buf.writeUInt32LE(8000, 28)
  buf.writeUInt16LE(1, 32)
  buf.writeUInt16LE(8, 34)
  buf.write("data", 36)
  buf.writeUInt32LE(samples, 40)
  return new Uint8Array(buf)
}

async function upload(token: string, path: string, filename: string | null, bytes: Uint8Array, fields: Record<string, string> = {}) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  if (filename) form.append("file", new Blob([bytes]), filename)
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form })
  const text = await res.text()
  let parsed: any = text
  try {
    parsed = JSON.parse(text)
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed }
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: { startsWith: P } }, { actorId: { startsWith: P } }] } })
  await prisma.playlistTrack.deleteMany({ where: { playlistId: { startsWith: P } } })
  await prisma.playlist.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.track.deleteMany({ where: { OR: [{ id: { startsWith: P } }, { organizationId: { startsWith: P } }] } })
  await prisma.musicFolder.deleteMany({ where: { organizationId: { startsWith: P } } })
  await prisma.refreshToken.deleteMany({ where: { user: { email: { startsWith: P } } } })
  await prisma.user.deleteMany({ where: { email: { startsWith: P } } })
  await prisma.location.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.organization.deleteMany({ where: { id: { startsWith: P } } })
}

before(async () => {
  await cleanup()
  const hash = await bcrypt.hash(PASSWORD, 10)
  for (const o of ["a", "b"]) {
    await prisma.organization.create({
      data: { id: id(`org-${o}`), name: `zzsoa test org ${o.toUpperCase()}`, slug: id(`org-${o}`), contactName: "Test", contactEmail: `${o}@test.local` },
    })
    await prisma.location.create({
      data: { id: id(`loc-${o}`), organizationId: id(`org-${o}`), name: `Venue ${o}`, address: "1 Test St", city: "Testville", region: "TS", country: "TS", timezone: "UTC" },
    })
  }
  await prisma.user.create({ data: { id: id("super"), name: "Super Admin", email: `${P}super@test.local`, role: "SUPER_ADMIN", organizationId: null, passwordHash: hash } })
  await prisma.user.create({ data: { id: id("soa"), name: "Super Org Admin A", email: `${P}soa@test.local`, role: "SUPER_ORGANIZATION_ADMIN", organizationId: orgA, passwordHash: hash } })
  await prisma.user.create({ data: { id: id("oa"), name: "Org Admin A", email: `${P}oa@test.local`, role: "ORGANIZATION_ADMIN", organizationId: orgA, passwordHash: hash } })
  await prisma.user.create({ data: { id: id("oa-b"), name: "Org Admin B", email: `${P}oa-b@test.local`, role: "ORGANIZATION_ADMIN", organizationId: orgB, passwordHash: hash } })
  await prisma.user.create({ data: { id: id("lm"), name: "Location Manager A", email: `${P}lm@test.local`, role: "LOCATION_MANAGER", organizationId: orgA, locationId: id("loc-a"), passwordHash: hash } })

  await prisma.track.create({
    data: { id: visibleTrack, title: "zzsoa visible track", artist: "V", album: "V", genre: "Jazz", durationSec: 10, fileSizeMb: 1, storageKey: id("v.mp3"), uploadedById: id("super"), organizationId: orgA },
  })
  await prisma.playlist.create({ data: { id: playlistA, name: "zzsoa playlist A", organizationId: orgA } })
  await prisma.playlist.create({ data: { id: playlistB, name: "zzsoa playlist B", organizationId: orgB } })
  await prisma.playlist.create({ data: { id: playlistShared, name: "zzsoa shared playlist (do not use)", organizationId: null } })
  await prisma.playlistTrack.create({ data: { playlistId: playlistA, trackId: visibleTrack, position: 0 } })

  superToken = await login(`${P}super@test.local`)
  soaToken = await login(`${P}soa@test.local`)
  oaToken = await login(`${P}oa@test.local`)
  lmToken = await login(`${P}lm@test.local`)
})

after(async () => {
  // Through the API, so the audio files are unlinked too.
  for (const trackId of uploadedTrackIds) await call(superToken, "DELETE", `/api/music/${trackId}`)
  await cleanup()
  await prisma.$disconnect()
})

const ALL_PERMISSIONS: Permission[] = [
  "org:read", "org:write", "location:read", "location:write", "server:read", "server:write", "server:pair",
  "server:command", "zone:read", "zone:control", "zone:assign", "music:read", "music:upload", "music:delete",
  "playlist:read", "playlist:write", "playlist:upload", "schedule:read", "schedule:write", "sync:trigger",
  "users:manage", "logs:read", "prayer:read", "prayer:manage", "zone:override", "server:forget",
]

describe("permission matrix", () => {
  test("SUPER_ORGANIZATION_ADMIN = ORGANIZATION_ADMIN + playlist:upload, nothing else", () => {
    for (const p of ALL_PERMISSIONS) {
      if (p === "playlist:upload") continue
      assert.equal(can("SUPER_ORGANIZATION_ADMIN", p), can("ORGANIZATION_ADMIN", p), p)
    }
    assert.equal(can("SUPER_ORGANIZATION_ADMIN", "playlist:upload"), true)
  })

  test("only Super Admin and Super Organization Admin hold playlist:upload", () => {
    assert.equal(can("SUPER_ADMIN", "playlist:upload"), true)
    for (const role of ["ORGANIZATION_ADMIN", "LOCATION_MANAGER", "VIEWER"] as const) {
      assert.equal(can(role, "playlist:upload"), false, role)
    }
  })
})

describe("POST /api/playlists/:id/upload authorization", () => {
  test("Organization Admin direct call is rejected and creates nothing", async () => {
    const res = await upload(oaToken, `/api/playlists/${playlistA}/upload`, "oa.wav", wav())
    assert.equal(res.status, 403)
    assert.equal(await prisma.track.count({ where: { organizationId: orgA, id: { not: visibleTrack } } }), 0)
    assert.equal(await prisma.musicFolder.count({ where: { organizationId: orgA } }), 0)
  })

  test("Location Manager is rejected", async () => {
    assert.equal((await upload(lmToken, `/api/playlists/${playlistA}/upload`, "lm.wav", wav())).status, 403)
  })

  test("another organization's, a shared, or an unknown playlist is rejected", async () => {
    assert.equal((await upload(soaToken, `/api/playlists/${playlistB}/upload`, "b.wav", wav())).status, 404)
    assert.equal((await upload(soaToken, `/api/playlists/${playlistShared}/upload`, "s.wav", wav())).status, 404)
    assert.equal((await upload(soaToken, `/api/playlists/${id("nope")}/upload`, "n.wav", wav())).status, 404)
    assert.equal(await prisma.musicFolder.count({ where: { organizationId: { in: [orgA, orgB] } } }), 0)
    assert.equal(await prisma.playlistTrack.count({ where: { playlistId: { in: [playlistB, playlistShared] } } }), 0)
  })

  test("same validation as the library upload", async () => {
    const badExt = await upload(soaToken, `/api/playlists/${playlistA}/upload`, "notes.txt", new TextEncoder().encode("hello"))
    assert.equal(badExt.status, 400)
    assert.match(badExt.body.message, /is not a supported audio file\. Accepted formats: \.mp3, \.wav/)
    const notAudio = await upload(soaToken, `/api/playlists/${playlistA}/upload`, "fake.wav", new TextEncoder().encode("not audio at all"))
    assert.equal(notAudio.status, 400)
    assert.match(notAudio.body.message, /could not be read as audio/)
    const noFile = await upload(soaToken, `/api/playlists/${playlistA}/upload`, null, new Uint8Array(), { title: "x" })
    assert.equal(noFile.status, 400)
    assert.match(noFile.body.message, /A file is required/)
    assert.equal(await prisma.musicFolder.count({ where: { organizationId: orgA } }), 0)
  })
})

describe("playlist-only upload", () => {
  let first: string
  let dumpId: string

  test("Super Organization Admin upload is stored in the org's DUMP and attached only to that playlist", async () => {
    const res = await upload(soaToken, `/api/playlists/${playlistA}/upload`, "zzsoa-song.wav", wav(), { title: "zzsoa playlist only song", artist: "A", album: "B", genre: "Jazz" })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    first = res.body.id
    uploadedTrackIds.push(first)
    const track = await prisma.track.findUnique({ where: { id: first }, include: { folder: true } })
    assert.equal(track?.organizationId, orgA)
    assert.equal(track?.durationSec, 1)
    assert.equal(track?.folder?.hidden, true)
    assert.equal(track?.folder?.name, "DUMP")
    assert.equal(track?.folder?.organizationId, orgA)
    dumpId = track!.folderId!
    const links = await prisma.playlistTrack.findMany({ where: { trackId: first } })
    assert.deepEqual(links.map((l) => [l.playlistId, l.position]), [[playlistA, 1]])
    const pl = await call(soaToken, "GET", `/api/playlists/${playlistA}`)
    assert.deepEqual(pl.body.trackIds, [visibleTrack, first])
  })

  test("a second upload reuses the same DUMP; other organizations get none", async () => {
    const res = await upload(soaToken, `/api/playlists/${playlistA}/upload`, "zzsoa-song2.wav", wav())
    assert.equal(res.status, 201)
    uploadedTrackIds.push(res.body.id)
    assert.equal((await prisma.track.findUnique({ where: { id: res.body.id } }))?.folderId, dumpId)
    assert.equal(await prisma.musicFolder.count({ where: { organizationId: orgA, hidden: true } }), 1)
    assert.equal(await prisma.musicFolder.count({ where: { organizationId: orgA } }), 1)
    assert.equal(await prisma.musicFolder.count({ where: { organizationId: orgB } }), 0)
  })

  test("not in any visible library query, but resolvable by id for the playlist", async () => {
    for (const token of [soaToken, oaToken, superToken]) {
      const list = await call(token, "GET", "/api/music")
      assert.equal(list.status, 200)
      assert.ok(!list.body.some((t: { id: string }) => uploadedTrackIds.includes(t.id)), "library list")
      assert.ok(list.body.some((t: { id: string }) => t.id === visibleTrack), "visible track still listed")
      const search = await call(token, "GET", `/api/music?search=${encodeURIComponent("zzsoa playlist only")}`)
      assert.deepEqual(search.body, [], "library search")
      const folders = await call(token, "GET", "/api/music/folders")
      assert.ok(!folders.body.some((f: { id: string }) => f.id === dumpId), "folder list")
    }
    const byIds = await call(soaToken, "GET", `/api/music?ids=${visibleTrack},${first}`)
    assert.deepEqual(byIds.body.map((t: { id: string }) => t.id).sort(), [visibleTrack, first].sort())
    const otherOrg = await call(await login(`${P}oa-b@test.local`), "GET", `/api/music?ids=${first}`)
    assert.deepEqual(otherOrg.body, [])
  })

  test("DUMP cannot be renamed, deleted or targeted, and nothing moves in or out of it", async () => {
    assert.equal((await call(superToken, "PATCH", `/api/music/folders/${dumpId}`, { name: "Visible now" })).status, 404)
    assert.equal((await call(superToken, "DELETE", `/api/music/folders/${dumpId}`)).status, 404)
    assert.equal((await upload(superToken, "/api/music/upload", "zzsoa-lib.wav", wav(), { folderId: dumpId })).status, 404)
    assert.equal((await call(superToken, "PATCH", `/api/music/${visibleTrack}`, { folderId: dumpId })).status, 404)
    assert.equal((await prisma.track.findUnique({ where: { id: visibleTrack } }))?.folderId, null)
    assert.equal((await call(superToken, "PATCH", `/api/music/${first}`, { folderId: null })).status, 404)
    assert.equal((await prisma.track.findUnique({ where: { id: first } }))?.folderId, dumpId)
    const folder = await prisma.musicFolder.findUnique({ where: { id: dumpId } })
    assert.equal(folder?.name, "DUMP")
    assert.equal(folder?.hidden, true)
  })

  test("removing the song from the playlist keeps it in DUMP and leaves the library alone", async () => {
    const res = await call(soaToken, "DELETE", `/api/playlists/${playlistA}/tracks/${first}`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.trackIds.includes(first), false)
    assert.equal((await prisma.track.findUnique({ where: { id: first } }))?.folderId, dumpId)
    assert.equal((await prisma.track.findUnique({ where: { id: visibleTrack } }))?.folderId, null)
    assert.ok(res.body.trackIds.includes(visibleTrack))
  })

  test("the music library upload still adds a visible track", async () => {
    const res = await upload(superToken, "/api/music/upload", "zzsoa-library.wav", wav(), { title: "zzsoa library song" })
    assert.equal(res.status, 201)
    uploadedTrackIds.push(res.body.id)
    assert.equal(res.body.folderId, null)
    const list = await call(superToken, "GET", `/api/music?search=${encodeURIComponent("zzsoa library song")}`)
    assert.deepEqual(list.body.map((t: { id: string }) => t.id), [res.body.id])
    assert.equal(await prisma.playlistTrack.count({ where: { trackId: res.body.id } }), 0)
  })
})

describe("Super Admin playlist upload", () => {
  const superUploads: string[] = []

  test("a shared or unknown playlist is rejected and no DUMP is created", async () => {
    assert.equal((await upload(superToken, `/api/playlists/${playlistShared}/upload`, "s.wav", wav())).status, 404)
    assert.equal((await upload(superToken, `/api/playlists/${id("nope")}/upload`, "n.wav", wav())).status, 404)
    assert.equal(await prisma.musicFolder.count({ where: { hidden: true, organizationId: null } }), 0)
    assert.equal(await prisma.playlistTrack.count({ where: { playlistId: playlistShared } }), 0)
  })

  test("uploads onto any organization's playlist, stored in that organization's DUMP only", async () => {
    const res = await upload(superToken, `/api/playlists/${playlistB}/upload`, "zzsoa-super-b.wav", wav(), { title: "zzsoa super admin song" })
    assert.equal(res.status, 201, JSON.stringify(res.body))
    uploadedTrackIds.push(res.body.id)
    superUploads.push(res.body.id)
    const track = await prisma.track.findUnique({ where: { id: res.body.id }, include: { folder: true } })
    assert.equal(track?.organizationId, orgB)
    assert.equal(track?.folder?.hidden, true)
    assert.equal(track?.folder?.name, "DUMP")
    assert.equal(track?.folder?.organizationId, orgB)
    assert.equal(await prisma.musicFolder.count({ where: { organizationId: orgB, hidden: true } }), 1)
    const links = await prisma.playlistTrack.findMany({ where: { trackId: res.body.id } })
    assert.deepEqual(links.map((l) => l.playlistId), [playlistB])

    const intoA = await upload(superToken, `/api/playlists/${playlistA}/upload`, "zzsoa-super-a.wav", wav())
    assert.equal(intoA.status, 201)
    uploadedTrackIds.push(intoA.body.id)
    superUploads.push(intoA.body.id)
    const dumpA = await prisma.musicFolder.findMany({ where: { organizationId: orgA, hidden: true } })
    assert.equal(dumpA.length, 1)
    assert.equal((await prisma.track.findUnique({ where: { id: intoA.body.id } }))?.folderId, dumpA[0].id)
  })

  test("Super Admin uploads stay out of every visible library query", async () => {
    const oaB = await login(`${P}oa-b@test.local`)
    for (const token of [superToken, oaB, soaToken]) {
      const list = await call(token, "GET", "/api/music")
      assert.ok(!list.body.some((t: { id: string }) => superUploads.includes(t.id)))
      const search = await call(token, "GET", `/api/music?search=${encodeURIComponent("zzsoa super admin song")}`)
      assert.deepEqual(search.body, [])
      const folders = await call(token, "GET", "/api/music/folders")
      assert.ok(!folders.body.some((f: { name: string }) => f.name === "DUMP"))
    }
    const pl = await call(oaB, "GET", `/api/playlists/${playlistB}`)
    const byIds = await call(oaB, "GET", `/api/music?ids=${pl.body.trackIds.join(",")}`)
    assert.ok(byIds.body.some((t: { title: string }) => t.title === "zzsoa super admin song"))
  })
})

describe("Super Organization Admin keeps Organization Admin access", () => {
  test("sees the same users as an Organization Admin of the same org", async () => {
    const soa = await call(soaToken, "GET", "/api/users")
    const oa = await call(oaToken, "GET", "/api/users")
    assert.equal(soa.status, 200)
    const ids = (r: { body: { id: string }[] }) => r.body.map((u) => u.id).sort()
    assert.deepEqual(ids(soa), ids(oa))
    assert.ok(ids(soa).every((u) => u !== id("oa-b") && u !== id("super")))
  })

  test("may create Location Managers in its own org only, never admins", async () => {
    const ok = await call(soaToken, "POST", "/api/users/invite", { name: "LM", email: `${P}new-lm@test.local`, role: "LOCATION_MANAGER", organizationId: null, locationId: id("loc-a") })
    assert.equal(ok.status, 201, JSON.stringify(ok.body))
    const foreign = await call(soaToken, "POST", "/api/users/invite", { name: "LM", email: `${P}new-lm-b@test.local`, role: "LOCATION_MANAGER", organizationId: null, locationId: id("loc-b") })
    assert.equal(foreign.status, 403)
    for (const role of ["ORGANIZATION_ADMIN", "SUPER_ORGANIZATION_ADMIN", "SUPER_ADMIN"]) {
      assert.equal((await call(soaToken, "POST", "/api/users/invite", { name: "X", email: `${P}x-${role}@test.local`, role, organizationId: orgA, locationId: null })).status, 403, role)
    }
  })

  test("only a Super Admin may assign the new role; unknown roles stay rejected", async () => {
    assert.equal((await call(oaToken, "POST", "/api/users/invite", { name: "X", email: `${P}oa-mint@test.local`, role: "SUPER_ORGANIZATION_ADMIN", organizationId: orgA, locationId: null })).status, 403)
    assert.equal((await call(oaToken, "DELETE", `/api/users/${id("soa")}`)).status, 403)
    const minted = await call(superToken, "POST", "/api/users/invite", { name: "SOA 2", email: `${P}soa2@test.local`, role: "SUPER_ORGANIZATION_ADMIN", organizationId: orgA, locationId: null, password: PASSWORD })
    assert.equal(minted.status, 201, JSON.stringify(minted.body))
    assert.equal(minted.body.role ?? minted.body.user?.role, "SUPER_ORGANIZATION_ADMIN")
    assert.equal((await call(superToken, "POST", "/api/users/invite", { name: "X", email: `${P}bogus@test.local`, role: "ROOT", organizationId: orgA, locationId: null })).status, 400)
  })

  test("playlist read/write behaves like an Organization Admin", async () => {
    const list = await call(soaToken, "GET", "/api/playlists")
    assert.equal(list.status, 200)
    const names = list.body.map((p: { id: string }) => p.id)
    assert.ok(names.includes(playlistA) && names.includes(playlistShared) && !names.includes(playlistB))
    assert.equal((await call(soaToken, "PATCH", `/api/playlists/${playlistA}`, { name: "zzsoa playlist A renamed" })).status, 200)
    assert.equal((await call(soaToken, "PATCH", `/api/playlists/${playlistShared}`, { name: "nope" })).status, 404)
    assert.equal((await call(soaToken, "PATCH", `/api/playlists/${playlistB}`, { name: "nope" })).status, 404)
    assert.equal((await call(soaToken, "POST", "/api/music/upload", {})).status, 403)
  })
})
