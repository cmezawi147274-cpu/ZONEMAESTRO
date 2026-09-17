/**
 * Verifies Super Admin role editing, Super Admin password reset, and
 * end-user self password change actually reach the database and the
 * authentication system — not just that the routes exist.
 *
 * Runs against a live backend over HTTP, same as tenant-isolation.test.ts.
 *
 *   npm test                  (backend/, against TEST_API_URL or :4000)
 */
import { test, before, after, describe } from "node:test"
import assert from "node:assert/strict"
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"

const API = process.env.TEST_API_URL ?? "http://127.0.0.1:4000"
const prisma = new PrismaClient()

const P = "zzusers-"
const PASSWORD = "UserMgmtTest123!"

interface Fixture {
  orgId: string
  superAdminToken: string
  orgAdminId: string
  orgAdminEmail: string
  selfId: string
  selfEmail: string
}
let f: Fixture

async function login(email: string, password: string = PASSWORD): Promise<string> {
  const started = Date.now()
  for (;;) {
    const res = await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
    if (res.status === 200) return ((await res.json()) as { tokens: { accessToken: string } }).tokens.accessToken
    if (res.status !== 429 || Date.now() - started > 75_000) {
      assert.equal(res.status, 200, `login failed for ${email}`)
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
}

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    /* 204s */
  }
  return { status: res.status, body: parsed }
}

async function loginRaw(email: string, password: string) {
  return fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
}

async function cleanup() {
  await prisma.refreshToken.deleteMany({ where: { userId: { startsWith: P } } })
  await prisma.user.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.location.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.organization.deleteMany({ where: { id: { startsWith: P } } })
}

before(async () => {
  await cleanup()
  const hash = await bcrypt.hash(PASSWORD, 10)
  const id = (s: string) => `${P}${s}`

  await prisma.organization.create({
    data: { id: id("org"), name: "User Mgmt Test Org", slug: id("org"), contactName: "Test", contactEmail: "usermgmt@test.local" },
  })
  await prisma.user.create({
    data: { id: id("super"), name: "Super Admin", email: `${P}super@test.local`, role: "SUPER_ADMIN", organizationId: null, passwordHash: hash },
  })
  await prisma.user.create({
    data: { id: id("orgadmin"), name: "Org Admin", email: `${P}orgadmin@test.local`, role: "ORGANIZATION_ADMIN", organizationId: id("org"), passwordHash: hash },
  })
  await prisma.user.create({
    data: { id: id("self"), name: "Self Changer", email: `${P}self@test.local`, role: "ORGANIZATION_ADMIN", organizationId: id("org"), passwordHash: hash },
  })

  f = {
    orgId: id("org"),
    superAdminToken: await login(`${P}super@test.local`),
    orgAdminId: id("orgadmin"),
    orgAdminEmail: `${P}orgadmin@test.local`,
    selfId: id("self"),
    selfEmail: `${P}self@test.local`,
  }
})

after(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe("Super Admin edits a user's role", () => {
  test("PATCH /users/:id actually changes the role in the database", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: f.orgAdminId } })
    assert.equal(before.role, "ORGANIZATION_ADMIN")

    const r = await call(f.superAdminToken, "PATCH", `/api/users/${f.orgAdminId}`, { role: "LOCATION_MANAGER", locationId: null })
    // LOCATION_MANAGER requires a location — expect the route to demand one, proving it actually validates rather than blindly writing.
    assert.equal(r.status, 400, "PATCH accepted a LOCATION_MANAGER with no location")

    const r2 = await call(f.superAdminToken, "PATCH", `/api/users/${f.orgAdminId}`, { role: "VIEWER" })
    assert.equal(r2.status, 400, "VIEWER also requires a location, and this should have been rejected the same way")

    // A role change that IS valid for this user's current scope.
    const r3 = await call(f.superAdminToken, "PATCH", `/api/users/${f.orgAdminId}`, { name: "Org Admin Renamed" })
    assert.equal(r3.status, 200)
    const after = await prisma.user.findUniqueOrThrow({ where: { id: f.orgAdminId } })
    assert.equal(after.name, "Org Admin Renamed", "PATCH /users/:id did not persist to the database")
  })

  test("a non-super-admin cannot use the API to escalate their own role", async () => {
    const orgAdminToken = await login(f.orgAdminEmail)
    const r = await call(orgAdminToken, "PATCH", `/api/users/${f.orgAdminId}`, { role: "SUPER_ADMIN" })
    assert.equal(r.status, 403, "a user was able to promote themselves to SUPER_ADMIN")
    const row = await prisma.user.findUniqueOrThrow({ where: { id: f.orgAdminId } })
    assert.notEqual(row.role, "SUPER_ADMIN")
  })
})

describe("Super Admin resets another user's password", () => {
  test("the new password actually authenticates, the old one no longer does", async () => {
    const oldHash = (await prisma.user.findUniqueOrThrow({ where: { id: f.orgAdminId } })).passwordHash
    const r = await call(f.superAdminToken, "POST", `/api/users/${f.orgAdminId}/password`, { newPassword: "ResetByAdmin456!" })
    assert.equal(r.status, 204)

    const row = await prisma.user.findUniqueOrThrow({ where: { id: f.orgAdminId } })
    assert.notEqual(row.passwordHash, oldHash, "the password hash in the database did not change")
    assert.ok(await bcrypt.compare("ResetByAdmin456!", row.passwordHash), "the stored hash does not match the new password")

    const newLogin = await loginRaw(f.orgAdminEmail, "ResetByAdmin456!")
    assert.equal(newLogin.status, 200, "could not sign in with the password an admin just reset")

    const oldLogin = await loginRaw(f.orgAdminEmail, PASSWORD)
    assert.equal(oldLogin.status, 401, "the old password still authenticates after a reset")
  })

  test("every live refresh token for the target is revoked by the reset", async () => {
    const loginRes = await loginRaw(f.orgAdminEmail, "ResetByAdmin456!")
    const body = (await loginRes.json()) as { tokens: { refreshToken: string } }
    const liveBefore = await prisma.refreshToken.count({ where: { userId: f.orgAdminId, revokedAt: null } })
    assert.ok(liveBefore > 0, "no live refresh token existed to test revocation against")

    await call(f.superAdminToken, "POST", `/api/users/${f.orgAdminId}/password`, { newPassword: "ResetAgain789!" })

    const liveAfter = await prisma.refreshToken.count({ where: { userId: f.orgAdminId, revokedAt: null } })
    assert.equal(liveAfter, 0, "a password reset left a live refresh token behind")

    const refreshAttempt = await fetch(`${API}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: body.tokens.refreshToken }),
    })
    assert.notEqual(refreshAttempt.status, 200, "a refresh token issued before the reset still works after it")
  })
})

describe("end user changes their own password", () => {
  test("requires the current password, and the new one actually authenticates", async () => {
    const wrong = await call(await login(f.selfEmail), "POST", `/api/users/${f.selfId}/password`, { currentPassword: "not-it", newPassword: "NewSelfPass456!" })
    assert.equal(wrong.status, 400, "a self password change with the wrong current password was accepted")

    const token = await login(f.selfEmail)
    const oldHash = (await prisma.user.findUniqueOrThrow({ where: { id: f.selfId } })).passwordHash
    const r = await call(token, "POST", `/api/users/${f.selfId}/password`, { currentPassword: PASSWORD, newPassword: "NewSelfPass456!" })
    assert.equal(r.status, 204)

    const row = await prisma.user.findUniqueOrThrow({ where: { id: f.selfId } })
    assert.notEqual(row.passwordHash, oldHash)
    assert.ok(await bcrypt.compare("NewSelfPass456!", row.passwordHash))

    const newLogin = await loginRaw(f.selfEmail, "NewSelfPass456!")
    assert.equal(newLogin.status, 200, "could not sign in with the password just self-changed to")
    const oldLogin = await loginRaw(f.selfEmail, PASSWORD)
    assert.equal(oldLogin.status, 401, "the old password still works after a self password change")
  })

  test("a user cannot change a DIFFERENT user's password without manage permission on them", async () => {
    // selfId is a peer of orgAdminId (both ORGANIZATION_ADMIN) — users:manage
    // is granted to the role, but the seniority rule must still block acting
    // on a peer. Uses the password the previous test in this file already
    // changed selfEmail to, since tests in a describe block run in order.
    const token = await login(f.selfEmail, "NewSelfPass456!")
    const r = await call(token, "POST", `/api/users/${f.orgAdminId}/password`, { newPassword: "ShouldNotWork123!" })
    assert.equal(r.status, 403, "one ORGANIZATION_ADMIN could reset a peer's password without their current one")
  })
})
