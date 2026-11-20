import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Fastify from "fastify"
import { publishedUpdate, publishedVersionsOf, readSignedManifest } from "../src/lib/update-manifest.js"
import { registerUpdateRoutes } from "../src/routes/agent-update.js"

const signed = (m: unknown, signature = "c2ln") => JSON.stringify({ manifest: typeof m === "string" ? m : JSON.stringify(m), signature })
const MANIFEST = { schema: 1, agent: { version: "2026.11.21", file: "agent.zip" }, musicServer: { version: "1.4.0" } }

let dir: string
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmmp-update-test-"))
  process.env.UPDATE_DIR = dir
})
after(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("manifest parsing", () => {
  test("versions from a schema-1 manifest", () => {
    assert.deepEqual(publishedVersionsOf(signed(MANIFEST)), { agentVersion: "2026.11.21", musicServerVersion: "1.4.0" })
    assert.deepEqual(publishedVersionsOf(signed({ schema: 1, agent: { version: "2026.11.21" } })), { agentVersion: "2026.11.21", musicServerVersion: null })
  })
  test("null for anything else", () => {
    assert.equal(publishedVersionsOf("not json"), null)
    assert.equal(publishedVersionsOf(JSON.stringify({ manifest: { schema: 1 } })), null)
    assert.equal(publishedVersionsOf(signed({ schema: 2, agent: { version: "1.0" } })), null)
    assert.equal(publishedVersionsOf(signed({ schema: 1, agent: { version: "v1" } })), null)
    assert.equal(publishedVersionsOf(signed("{broken")), null)
  })
})

describe("publishedUpdate cache", () => {
  test("missing file is null; re-read only when the file changes", () => {
    const d = fs.mkdtempSync(path.join(dir, "cache-"))
    assert.equal(publishedUpdate(d), null)
    const file = path.join(d, "manifest.signed.json")
    fs.writeFileSync(file, signed(MANIFEST))
    const first = publishedUpdate(d)
    assert.deepEqual(first, { agentVersion: "2026.11.21", musicServerVersion: "1.4.0" })
    assert.equal(publishedUpdate(d), first, "same object from the cache")
    fs.writeFileSync(file, signed({ ...MANIFEST, agent: { version: "2026.11.22" } }))
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000))
    assert.equal(publishedUpdate(d)?.agentVersion, "2026.11.22")
    fs.writeFileSync(file, "x".repeat(70 * 1024))
    assert.equal(publishedUpdate(d), null)
  })
})

describe("readSignedManifest", () => {
  test("missing vs invalid", async () => {
    const d = fs.mkdtempSync(path.join(dir, "read-"))
    assert.equal(await readSignedManifest(d), "missing")
    const file = path.join(d, "manifest.signed.json")
    fs.writeFileSync(file, JSON.stringify({ manifest: "{}", signature: "s".repeat(201) }))
    assert.equal(await readSignedManifest(d), "invalid")
    fs.writeFileSync(file, JSON.stringify({ manifest: {}, signature: "s" }))
    assert.equal(await readSignedManifest(d), "invalid")
    fs.writeFileSync(file, " ".repeat(64 * 1024 + 1))
    assert.equal(await readSignedManifest(d), "invalid")
    fs.writeFileSync(file, signed(MANIFEST))
    assert.deepEqual(await readSignedManifest(d), { manifest: JSON.stringify(MANIFEST), signature: "c2ln" })
  })
})

describe("update routes", () => {
  async function appWith(authOk = true) {
    const app = Fastify()
    registerUpdateRoutes(app, "/api", async () => {
      if (!authOk) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 })
      return {}
    })
    await app.ready()
    return app
  }

  test("manifest: 404 when nothing is published, then served with no-store", async () => {
    const app = await appWith()
    fs.rmSync(path.join(dir, "manifest.signed.json"), { force: true })
    let res = await app.inject({ method: "GET", url: "/api/server/update/manifest" })
    assert.equal(res.statusCode, 404)
    assert.deepEqual(res.json(), { error: "No update published" })
    fs.writeFileSync(path.join(dir, "manifest.signed.json"), "{oops")
    res = await app.inject({ method: "GET", url: "/api/server/update/manifest" })
    assert.equal(res.statusCode, 404)
    fs.writeFileSync(path.join(dir, "manifest.signed.json"), signed(MANIFEST))
    res = await app.inject({ method: "GET", url: "/api/server/update/manifest" })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers["cache-control"], "no-store")
    assert.deepEqual(res.json(), { manifest: JSON.stringify(MANIFEST), signature: "c2ln" })
    await app.close()
  })

  test("auth runs first", async () => {
    const app = await appWith(false)
    assert.equal((await app.inject({ method: "GET", url: "/api/server/update/manifest" })).statusCode, 401)
    assert.equal((await app.inject({ method: "GET", url: "/api/server/update/file/agent.zip" })).statusCode, 401)
    await app.close()
  })

  test("files: streamed regular files only", async () => {
    const app = await appWith()
    const files = path.join(dir, "files")
    fs.mkdirSync(files, { recursive: true })
    const body = Buffer.from("PK\u0003\u0004 zip bytes")
    fs.writeFileSync(path.join(files, "agent-2026.11.21.zip"), body)
    fs.writeFileSync(path.join(dir, "outside.zip"), "secret")
    fs.symlinkSync(path.join(dir, "outside.zip"), path.join(files, "link.zip"))
    fs.mkdirSync(path.join(files, "sub.zip"))

    const ok = await app.inject({ method: "GET", url: "/api/server/update/file/agent-2026.11.21.zip" })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.headers["content-type"], "application/zip")
    assert.equal(ok.headers["content-length"], String(body.length))
    assert.equal(ok.headers["cache-control"], "no-store")
    assert.ok(ok.rawPayload.equals(body))

    for (const name of ["link.zip", "sub.zip", "missing.zip", ".hidden", "..%2Foutside.zip", "a%20b.zip", "-lead.zip", "x".repeat(100)]) {
      const res = await app.inject({ method: "GET", url: `/api/server/update/file/${name}` })
      assert.equal(res.statusCode, 404, name)
      assert.deepEqual(res.json(), { error: "Update file not found" })
    }
    await app.close()
  })
})
