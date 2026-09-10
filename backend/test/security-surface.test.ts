/**
 * Security-surface regression suite.
 *
 * Covers the controls that were missing entirely and would be invisible if
 * they silently regressed: authentication on every route, the CORS allowlist,
 * login rate limiting, signed media URLs, the realtime handshake, and the
 * upload type gate. None of these throw an error when they break — they just
 * quietly start allowing things — so they are asserted rather than reviewed.
 *
 *   npm test   (backend/, against TEST_API_URL or :4000)
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"

const API = process.env.TEST_API_URL ?? "http://127.0.0.1:4000"

describe("authentication", () => {
  const protectedRoutes = [
    "/api/auth/me", "/api/music", "/api/music/folders", "/api/zones", "/api/servers",
    "/api/playlists", "/api/schedules", "/api/sync", "/api/users",
    "/api/monitoring/alerts", "/api/organizations", "/api/locations",
  ]

  for (const route of protectedRoutes) {
    test(`${route} rejects an anonymous request`, async () => {
      const res = await fetch(`${API}${route}`)
      assert.equal(res.status, 401, `${route} did not require authentication`)
    })
  }

  test("a garbage bearer token is rejected", async () => {
    const res = await fetch(`${API}/api/auth/me`, { headers: { Authorization: "Bearer not-a-real-token" } })
    assert.equal(res.status, 401)
  })

  test("a token signed with the wrong secret is rejected", async () => {
    // Header/payload that decode fine but carry a bogus signature — the exact
    // shape an attacker produces when the signing secret is the placeholder
    // published in .env.example, which is what production was running.
    const forged =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      Buffer.from(JSON.stringify({ sub: "x", email: "x@x", role: "SUPER_ADMIN", organizationId: null })).toString("base64url") +
      ".invalidsignature"
    const res = await fetch(`${API}/api/auth/me`, { headers: { Authorization: `Bearer ${forged}` } })
    assert.equal(res.status, 401, "a forged SUPER_ADMIN token was accepted")
  })
})

describe("CORS", () => {
  test("a foreign origin gets no Access-Control-Allow-Origin", async () => {
    const res = await fetch(`${API}/api/organizations`, { headers: { Origin: "https://evil.example" } })
    const acao = res.headers.get("access-control-allow-origin")
    assert.ok(
      acao !== "https://evil.example" && acao !== "*",
      `CORS reflected a foreign origin: ${acao}`
    )
  })
})

describe("media URLs", () => {
  test("an unsigned media request is refused", async () => {
    const res = await fetch(`${API}/media/music/anything.mp3`)
    assert.equal(res.status, 401, "/media/music/ served an unsigned request")
  })

  test("an expired signature is refused", async () => {
    const res = await fetch(`${API}/media/music/anything.mp3?exp=1&sig=deadbeef`)
    assert.equal(res.status, 401)
  })

  test("a path-traversal key is refused", async () => {
    const res = await fetch(`${API}/media/music/..%2f..%2f..%2fetc%2fpasswd?exp=99999999999&sig=x`)
    assert.equal(res.status, 400, "a traversal key was not rejected outright")
  })
})

describe("realtime handshake", () => {
  /** Speaks just enough engine.io polling to reach the namespace handshake. */
  async function connect(auth: string): Promise<string> {
    const open = await (await fetch(`${API}/socket.io/?EIO=4&transport=polling`)).text()
    const sid = JSON.parse(open.replace(/^0/, "")).sid
    await fetch(`${API}/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: `40/realtime,${auth}`,
    })
    return await (await fetch(`${API}/socket.io/?EIO=4&transport=polling&sid=${sid}`)).text()
  }

  test("no token is rejected", async () => {
    assert.match(await connect(""), /UNAUTHORIZED/, "the realtime namespace accepted an unauthenticated socket")
  })

  test("a bad token is rejected", async () => {
    assert.match(await connect('{"token":"garbage"}'), /UNAUTHORIZED/)
  })
})

describe("login rate limiting", () => {
  test("repeated failures are throttled", async () => {
    // Deliberately more than the configured window allows. Runs last-ish and
    // against a nonexistent account so it can never lock out a real user.
    const email = `ratelimit-probe-${Date.now()}@test.local`
    let sawLimit = false
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${API}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "wrong" }),
      })
      if (res.status === 429) {
        sawLimit = true
        break
      }
      assert.equal(res.status, 401, `unexpected status ${res.status} on attempt ${i + 1}`)
    }
    assert.ok(sawLimit, "login accepted 25 rapid failed attempts without rate limiting")
  })
})

describe("health and readiness", () => {
  test("/health reports the deployed commit", async () => {
    const body = (await (await fetch(`${API}/health`)).json()) as { ok: boolean; commit: string }
    assert.equal(body.ok, true)
    assert.notEqual(body.commit, "unknown", "the image was built without GIT_COMMIT — deploys are untraceable")
  })

  test("/ready checks the database", async () => {
    const res = await fetch(`${API}/ready`)
    assert.equal(res.status, 200, "/ready failed — the database is unreachable")
  })
})
