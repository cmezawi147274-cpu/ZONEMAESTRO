import { test, describe } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { hashLockPassword, isValidLockPassword, redactCommandPayload, LOCK_PASSWORD_ITERATIONS } from "../src/lib/lock-password.js"

describe("lock password", () => {
  test("hash matches pbkdf2Sync with the returned salt", async () => {
    const out = await hashLockPassword("  Läuft 1234 ")
    assert.equal(out.algorithm, "pbkdf2-sha256")
    assert.equal(out.iterations, 150000)
    assert.equal(LOCK_PASSWORD_ITERATIONS, 150000)
    const salt = Buffer.from(out.salt, "base64")
    const hash = Buffer.from(out.hash, "base64")
    assert.equal(salt.length, 16)
    assert.equal(hash.length, 32)
    assert.equal(salt.toString("base64"), out.salt)
    assert.equal(hash.toString("base64"), out.hash)
    assert.ok(hash.equals(crypto.pbkdf2Sync("  Läuft 1234 ", salt, 150000, 32, "sha256")))
    assert.ok(!JSON.stringify(out).includes("Läuft"))
  })
  test("each hash gets a fresh salt", async () => {
    const [a, b] = await Promise.all([hashLockPassword("same-pass"), hashLockPassword("same-pass")])
    assert.notEqual(a.salt, b.salt)
    assert.notEqual(a.hash, b.hash)
  })
  test("length 4..128, not trimmed", () => {
    assert.equal(isValidLockPassword("abc"), false)
    assert.equal(isValidLockPassword("abcd"), true)
    assert.equal(isValidLockPassword("    "), true)
    assert.equal(isValidLockPassword("x".repeat(128)), true)
    assert.equal(isValidLockPassword("x".repeat(129)), false)
    assert.equal(isValidLockPassword(12345), false)
    assert.equal(isValidLockPassword(undefined), false)
  })
  test("redaction shows only algorithm and iterations", () => {
    const payload = { algorithm: "pbkdf2-sha256", iterations: 150000, salt: "c2FsdA==", hash: "aGFzaA==" }
    assert.deepEqual(redactCommandPayload("SET_LOCK_PASSWORD", payload), { algorithm: "pbkdf2-sha256", iterations: 150000, redacted: true })
    assert.equal(redactCommandPayload("SET_LOCK_PASSWORD", undefined), undefined)
    assert.deepEqual(redactCommandPayload("SET_VOLUME", { volume: 5 }), { volume: 5 })
    assert.deepEqual(redactCommandPayload("UNLOCK_SCREEN", {}), {})
  })
})
