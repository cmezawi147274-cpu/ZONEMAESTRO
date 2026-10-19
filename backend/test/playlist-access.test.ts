import { test, before, after, describe } from "node:test"
import assert from "node:assert/strict"
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"

const API = process.env.TEST_API_URL ?? "http://127.0.0.1:4000"
const prisma = new PrismaClient()

const P = "zzplaccess-"
const PASSWORD = "PlaylistAccess123!"
const id = (s: string) => `${P}${s}`

const orgA = id("org-a")
const orgB = id("org-b")
const zoneA = id("zone-a")
const zoneB = id("zone-b")
const jazz = id("pl-jazz")
const playlistA = id("pl-a")
const sharedOther = id("pl-shared")
const trackShared = id("trk-shared")
const slotAJazz = id("sch-a-jazz")
const slotBJazz = id("sch-b-jazz")
const slotBShared = id("sch-b-shared")
const slotBLegacy = id("sch-b-legacy")

let superToken: string
let tokenA: string
let tokenB: string
let tokenLM: string

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

async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
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

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: { startsWith: P } }, { actorId: { startsWith: P } }] } })
  await prisma.remoteCommand.deleteMany({ where: { serverId: { startsWith: P } } })
  await prisma.trackSyncState.deleteMany({ where: { serverId: { startsWith: P } } })
  await prisma.schedule.deleteMany({ where: { zoneId: { startsWith: P } } })
  await prisma.playlistAssignment.deleteMany({ where: { playlistId: { startsWith: P } } })
  await prisma.playlistTrack.deleteMany({ where: { playlistId: { startsWith: P } } })
  await prisma.alert.deleteMany({ where: { serverId: { startsWith: P } } })
  await prisma.zone.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.musicServer.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.playlist.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.track.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.refreshToken.deleteMany({ where: { userId: { startsWith: P } } })
  await prisma.user.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.location.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.organization.deleteMany({ where: { id: { startsWith: P } } })
}

before(async () => {
  await cleanup()
  const hash = await bcrypt.hash(PASSWORD, 10)

  for (const o of ["a", "b"]) {
    await prisma.organization.create({
      data: { id: id(`org-${o}`), name: `zzplaccess test org ${o.toUpperCase()}`, slug: id(`org-${o}`), contactName: "Test", contactEmail: `${o}@test.local` },
    })
    await prisma.location.create({
      data: { id: id(`loc-${o}`), organizationId: id(`org-${o}`), name: `Venue ${o}`, address: "1 Test St", city: "Testville", region: "TS", country: "TS", timezone: "UTC" },
    })
    await prisma.musicServer.create({
      data: { id: id(`srv-${o}`), organizationId: id(`org-${o}`), locationId: id(`loc-${o}`), name: `Server ${o}`, status: "UPDATING" },
    })
    await prisma.zone.create({
      data: { id: id(`zone-${o}`), serverId: id(`srv-${o}`), locationId: id(`loc-${o}`), name: `Zone ${o}`, playbackState: "STOPPED" },
    })
    await prisma.user.create({
      data: { id: id(`user-${o}`), name: `Admin ${o}`, email: `${P}${o}@test.local`, role: "ORGANIZATION_ADMIN", organizationId: id(`org-${o}`), passwordHash: hash },
    })
  }
  await prisma.user.create({
    data: { id: id("super"), name: "Super Admin", email: `${P}super@test.local`, role: "SUPER_ADMIN", organizationId: null, passwordHash: hash },
  })
  await prisma.user.create({
    data: { id: id("lm"), name: "Location Manager A", email: `${P}lm@test.local`, role: "LOCATION_MANAGER", organizationId: orgA, locationId: id("loc-a"), passwordHash: hash },
  })

  await prisma.track.create({
    data: { id: trackShared, title: "zzplaccess test track", artist: "S", album: "S", genre: "Jazz", durationSec: 10, fileSizeMb: 1, storageKey: id("s.mp3"), uploadedById: id("super"), organizationId: null },
  })
  await prisma.playlist.create({ data: { id: jazz, name: "zzplaccess test playlist (do not use)", organizationId: null } })
  await prisma.playlist.create({ data: { id: playlistA, name: "zzplaccess test private playlist", organizationId: orgA } })
  await prisma.playlist.create({ data: { id: sharedOther, name: "zzplaccess test shared playlist (do not use)", organizationId: null } })

  await prisma.zone.update({ where: { id: zoneA }, data: { currentPlaylistId: jazz } })
  await prisma.zone.update({ where: { id: zoneB }, data: { currentPlaylistId: jazz, prePrayerPlaylistId: jazz } })
  await prisma.playlistAssignment.create({ data: { playlistId: jazz, targetType: "ZONE", targetId: zoneA } })
  await prisma.playlistAssignment.create({ data: { playlistId: jazz, targetType: "ZONE", targetId: zoneB } })
  const slot = { startTime: "08:00", endTime: "09:00", days: ["MON"] }
  await prisma.schedule.create({ data: { id: slotAJazz, zoneId: zoneA, playlistId: jazz, name: "A Jazz", ...slot } })
  await prisma.schedule.create({ data: { id: slotBJazz, zoneId: zoneB, playlistId: jazz, name: "B Jazz", ...slot } })
  await prisma.schedule.create({ data: { id: slotBShared, zoneId: zoneB, playlistId: sharedOther, name: "B Shared", ...slot } })
  await prisma.schedule.create({ data: { id: slotBLegacy, zoneId: zoneB, playlistId: playlistA, name: "B Legacy", ...slot } })

  superToken = await login(`${P}super@test.local`)
  tokenA = await login(`${P}a@test.local`)
  tokenB = await login(`${P}b@test.local`)
  tokenLM = await login(`${P}lm@test.local`)
})

after(async () => {
  await cleanup()
  await prisma.$disconnect()
})

async function orgOf(playlistId: string) {
  return (await prisma.playlist.findUnique({ where: { id: playlistId } }))?.organizationId
}

describe("PATCH /playlists/:id/access", () => {
  test("anyone other than Super Admin gets 403", async () => {
    assert.equal((await call(tokenA, "PATCH", `/api/playlists/${jazz}/access`, { organizationId: orgA })).status, 403)
    assert.equal((await call(tokenB, "PATCH", `/api/playlists/${jazz}/access`, { organizationId: orgB })).status, 403)
    assert.equal((await call(tokenLM, "PATCH", `/api/playlists/${jazz}/access`, { organizationId: orgA })).status, 403)
    assert.equal(await orgOf(jazz), null)
  })

  test("a missing organizationId returns 400", async () => {
    assert.equal((await call(superToken, "PATCH", `/api/playlists/${jazz}/access`, {})).status, 400)
    assert.equal(await orgOf(jazz), null)
  })

  test("an unknown organization returns 404", async () => {
    assert.equal((await call(superToken, "PATCH", `/api/playlists/${jazz}/access`, { organizationId: id("nope") })).status, 404)
    assert.equal(await orgOf(jazz), null)
  })

  test("an unknown playlist returns 404", async () => {
    assert.equal((await call(superToken, "PATCH", `/api/playlists/${id("nope")}/access`, { organizationId: null })).status, 404)
  })

  test("an unchanged value returns the playlist as it is", async () => {
    const auditsBefore = await prisma.auditLog.count({ where: { action: "playlist.access_change", targetId: jazz } })
    const updatedBefore = (await prisma.playlist.findUnique({ where: { id: jazz } }))?.updatedAt
    const r = await call(superToken, "PATCH", `/api/playlists/${jazz}/access`, { organizationId: null })
    assert.equal(r.status, 200)
    const body = r.body as { playlist: { organizationId: string | null }; zonesAffected: number; schedulesRemoved: number }
    assert.equal(body.playlist.organizationId, null)
    assert.equal(body.zonesAffected, 0)
    assert.equal(body.schedulesRemoved, 0)
    assert.equal(await prisma.auditLog.count({ where: { action: "playlist.access_change", targetId: jazz } }), auditsBefore)
    assert.deepEqual((await prisma.playlist.findUnique({ where: { id: jazz } }))?.updatedAt, updatedBefore)
  })

  test("Shared to Org A hides it from Org B and removes it from Org B's zone and slot", async () => {
    const r = await call(superToken, "PATCH", `/api/playlists/${jazz}/access`, { organizationId: orgA })
    assert.equal(r.status, 200)
    const body = r.body as { playlist: { organizationId: string | null }; zonesAffected: number; schedulesRemoved: number }
    assert.equal(body.playlist.organizationId, orgA)
    assert.equal(body.zonesAffected, 1)
    assert.equal(body.schedulesRemoved, 1)

    assert.equal((await call(tokenB, "GET", `/api/playlists/${jazz}`)).status, 404)
    const listB = ((await call(tokenB, "GET", "/api/playlists")).body as { id: string }[]).map((p) => p.id)
    assert.ok(!listB.includes(jazz), "Jazz is still in Org B's list")

    const zb = await prisma.zone.findUnique({ where: { id: zoneB } })
    assert.equal(zb?.currentPlaylistId, null)
    assert.equal(zb?.prePrayerPlaylistId, null)
    assert.equal(await prisma.playlistAssignment.count({ where: { playlistId: jazz, targetId: zoneB } }), 0)
    assert.equal(await prisma.schedule.count({ where: { id: slotBJazz } }), 0)
    assert.equal(await prisma.schedule.count({ where: { id: slotBShared } }), 1)

    const za = await prisma.zone.findUnique({ where: { id: zoneA } })
    assert.equal(za?.currentPlaylistId, jazz)
    assert.equal(await prisma.playlistAssignment.count({ where: { playlistId: jazz, targetId: zoneA } }), 1)
    assert.equal(await prisma.schedule.count({ where: { id: slotAJazz } }), 1)

    assert.equal(await prisma.remoteCommand.count({ where: { serverId: { startsWith: P } } }), 0, "a command was sent to a venue")

    const entry = await prisma.auditLog.findFirst({ where: { action: "playlist.access_change", targetId: jazz }, orderBy: { at: "desc" } })
    assert.deepEqual(entry?.metadata, { before: { organizationId: null }, after: { organizationId: orgA }, zonesAffected: 1, schedulesRemoved: 1 })
  })

  test("Org A to Shared makes it visible to Org B without restoring zones or slots", async () => {
    const r = await call(superToken, "PATCH", `/api/playlists/${jazz}/access`, { organizationId: null })
    assert.equal(r.status, 200)
    const body = r.body as { playlist: { organizationId: string | null }; zonesAffected: number; schedulesRemoved: number }
    assert.equal(body.playlist.organizationId, null)
    assert.equal(body.zonesAffected, 0)
    assert.equal(body.schedulesRemoved, 0)

    assert.equal((await call(tokenB, "GET", `/api/playlists/${jazz}`)).status, 200)
    const listB = ((await call(tokenB, "GET", "/api/playlists")).body as { id: string }[]).map((p) => p.id)
    assert.ok(listB.includes(jazz), "Jazz is missing from Org B's list")

    assert.equal((await prisma.zone.findUnique({ where: { id: zoneB } }))?.currentPlaylistId, null)
    assert.equal(await prisma.playlistAssignment.count({ where: { playlistId: jazz, targetId: zoneB } }), 0)
    assert.equal(await prisma.schedule.count({ where: { playlistId: jazz, zoneId: zoneB } }), 0)
  })
})

describe("PATCH /playlists/:id", () => {
  test("organizationId sent through the old route is ignored", async () => {
    assert.equal((await call(tokenA, "PATCH", `/api/playlists/${playlistA}`, { organizationId: null })).status, 200)
    assert.equal(await orgOf(playlistA), orgA)
    assert.equal((await call(superToken, "PATCH", `/api/playlists/${playlistA}`, { organizationId: orgB })).status, 200)
    assert.equal(await orgOf(playlistA), orgA)
    assert.equal((await call(tokenA, "PATCH", `/api/playlists/${playlistA}`, { zones: { connect: [{ id: zoneB }] } })).status, 200)
    assert.notEqual((await prisma.zone.findUnique({ where: { id: zoneB } }))?.currentPlaylistId, playlistA)
  })

  test("name, description and tracks still update", async () => {
    const r = await call(tokenA, "PATCH", `/api/playlists/${playlistA}`, { name: "Renamed A", description: "New description", trackIds: [trackShared] })
    assert.equal(r.status, 200)
    const body = r.body as { name: string; description: string; trackIds: string[] }
    assert.equal(body.name, "Renamed A")
    assert.equal(body.description, "New description")
    assert.deepEqual(body.trackIds, [trackShared])
    const row = await prisma.playlist.findUnique({ where: { id: playlistA } })
    assert.equal(row?.name, "Renamed A")
    assert.equal(row?.description, "New description")
    assert.equal(await prisma.playlistTrack.count({ where: { playlistId: playlistA, trackId: trackShared } }), 1)
  })
})

describe("assigning another organization's private playlist", () => {
  test("is rejected by Assign", async () => {
    const r = await call(superToken, "POST", `/api/playlists/${playlistA}/assign`, { targetType: "ZONE", targetId: zoneB })
    assert.equal(r.status, 400)
    assert.equal(await prisma.playlistAssignment.count({ where: { playlistId: playlistA, targetId: zoneB } }), 0)
    assert.notEqual((await prisma.zone.findUnique({ where: { id: zoneB } }))?.currentPlaylistId, playlistA)
  })

  test("is rejected by the zone card", async () => {
    const r = await call(superToken, "POST", `/api/zones/${zoneB}/playlist`, { playlistId: playlistA })
    assert.equal(r.status, 400)
    assert.match((r.body as { message: string }).message, /another organization/)
    assert.notEqual((await prisma.zone.findUnique({ where: { id: zoneB } }))?.currentPlaylistId, playlistA)
  })

  test("is rejected when creating a schedule slot", async () => {
    const before = await prisma.schedule.count({ where: { zoneId: zoneB, playlistId: playlistA } })
    const r = await call(superToken, "POST", "/api/schedules", {
      zoneId: zoneB, playlistId: playlistA, name: "Forbidden", startTime: "10:00", endTime: "11:00", days: ["TUE"],
    })
    assert.equal(r.status, 400)
    assert.equal(await prisma.schedule.count({ where: { zoneId: zoneB, playlistId: playlistA } }), before)
  })

  test("is rejected when changing a schedule slot's playlist", async () => {
    const r = await call(superToken, "PATCH", `/api/schedules/${slotBShared}`, { playlistId: playlistA })
    assert.equal(r.status, 400)
    assert.equal((await prisma.schedule.findUnique({ where: { id: slotBShared } }))?.playlistId, sharedOther)
  })

  test("Shared playlists can still be assigned anywhere, and a slot keeping its playlist stays editable", async () => {
    const r = await call(superToken, "POST", `/api/playlists/${sharedOther}/assign`, { targetType: "ZONE", targetId: zoneB })
    assert.ok(r.status === 200 || r.status === 201, `assigning a Shared playlist failed with ${r.status}`)
    const edit = await call(superToken, "PATCH", `/api/schedules/${slotBLegacy}`, { name: "B Legacy renamed", playlistId: playlistA })
    assert.equal(edit.status, 200)
    assert.equal((await prisma.schedule.findUnique({ where: { id: slotBLegacy } }))?.name, "B Legacy renamed")
  })
})
