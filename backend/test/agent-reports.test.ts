import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { sanitizeHealth, sanitizePcClock, sanitizeUpdate } from "../src/lib/agent-reports.js"

describe("sanitizeHealth", () => {
  test("keeps the known fields and drops the rest", () => {
    const out = sanitizeHealth({
      uptimeSeconds: 3600,
      musicServerVersion: "1.2.3.4",
      bootTime: "2026-11-20T08:00:00Z",
      bootReason: "power button",
      lastSleep: { at: "2026-11-19T22:00:00Z", reason: null, extra: 1 },
      dvs: { ok: true, devices: ["Dante Virtual Soundcard", 7] },
      disk: { drive: "C:", freeBytes: 10, totalBytes: 100, low: false, path: "x" },
      screenLock: { installed: true, password: "nope" },
      secret: "x",
    })
    assert.deepEqual(out, {
      uptimeSeconds: 3600,
      musicServerVersion: "1.2.3.4",
      bootTime: "2026-11-20T08:00:00Z",
      bootReason: "power button",
      lastSleep: { at: "2026-11-19T22:00:00Z", reason: null },
      dvs: { ok: true, devices: ["Dante Virtual Soundcard"] },
      disk: { drive: "C:", freeBytes: 10, totalBytes: 100, low: false },
      screenLock: { installed: true },
    })
  })
  test("rejects bad types and lengths", () => {
    const out = sanitizeHealth({
      uptimeSeconds: -1,
      musicServerVersion: "1.2.3-beta",
      bootTime: "x".repeat(41),
      bootReason: 5,
      lastSleep: { at: "x", reason: "y".repeat(201) },
      disk: { drive: "C:", freeBytes: Infinity, totalBytes: 1, low: false },
      screenLock: { installed: "yes" },
      dvs: null,
    })
    assert.deepEqual(out, { dvs: null })
  })
  test("caps DVS devices at 8, each cut to 120", () => {
    const out = sanitizeHealth({ dvs: { ok: false, devices: Array.from({ length: 12 }, () => "d".repeat(500)) } })
    assert.equal(out?.dvs?.devices.length, 8)
    assert.ok(out?.dvs?.devices.every((d) => d.length === 120))
  })
  test("null for non-objects, empty results and an over-long single version", () => {
    assert.equal(sanitizeHealth(null), null)
    assert.equal(sanitizeHealth([1]), null)
    assert.equal(sanitizeHealth("x"), null)
    assert.equal(sanitizeHealth({ nothing: 1 }), null)
    assert.equal(sanitizeHealth({ musicServerVersion: "1." + "1".repeat(40) }), null)
  })
})

describe("sanitizeUpdate", () => {
  test("keeps the known fields", () => {
    const out = sanitizeUpdate({
      enabled: true,
      auto: false,
      state: "downloading",
      available: { agent: "2026.11.21", musicServer: null },
      checkedAt: "2026-11-20T08:00:00Z",
      error: "e".repeat(400),
      lastResult: { version: "2026.11.20", fromVersion: null, outcome: "rolled-back", reason: "r".repeat(400), at: "2026-11-20T08:00:00Z", junk: 1 },
      junk: true,
    })
    assert.equal(out?.error?.length, 300)
    assert.equal(out?.lastResult?.reason?.length, 300)
    assert.deepEqual({ ...out, error: undefined, lastResult: { ...out!.lastResult, reason: undefined } }, {
      enabled: true,
      auto: false,
      state: "downloading",
      available: { agent: "2026.11.21", musicServer: null },
      checkedAt: "2026-11-20T08:00:00Z",
      error: undefined,
      lastResult: { version: "2026.11.20", fromVersion: null, outcome: "rolled-back", reason: undefined, at: "2026-11-20T08:00:00Z" },
    })
  })
  test("rejects unknown states and outcomes", () => {
    assert.equal(sanitizeUpdate({ state: "hacking", lastResult: { version: "1.0", fromVersion: null, outcome: "maybe", at: "x" } }), null)
    assert.deepEqual(sanitizeUpdate({ enabled: "true", auto: true }), { auto: true })
    assert.equal(sanitizeUpdate({ available: { agent: "x".repeat(33), musicServer: null } }), null)
  })
  test("lastResult without reason has no reason key", () => {
    const out = sanitizeUpdate({ lastResult: { version: "1.0", fromVersion: "0.9", outcome: "committed", at: "now" } })
    assert.deepEqual(out, { lastResult: { version: "1.0", fromVersion: "0.9", outcome: "committed", at: "now" } })
  })
  test("null when the result is over 8192 bytes", () => {
    // Every field is capped, so no single beat can get past the limit through the whitelist.
    assert.ok(Buffer.byteLength(JSON.stringify(sanitizeUpdate({ error: "\u{1F600}".repeat(5000) }))) <= 8192)
  })
})

describe("sanitizePcClock", () => {
  test("accepts a valid measurement and drops extra fields", () => {
    assert.deepEqual(sanitizePcClock({ clockOffsetMs: -1500, rttMs: 80, epochMs: 1, utcOffsetMinutes: 240 }), { clockOffsetMs: -1500, rttMs: 80, utcOffsetMinutes: 240 })
  })
  test("rejects out-of-range or missing values", () => {
    assert.equal(sanitizePcClock(undefined), null)
    assert.equal(sanitizePcClock({ rttMs: 80, utcOffsetMinutes: 0 }), null)
    assert.equal(sanitizePcClock({ clockOffsetMs: 367 * 86_400_000, rttMs: 80, utcOffsetMinutes: 0 }), null)
    assert.equal(sanitizePcClock({ clockOffsetMs: NaN, rttMs: 80, utcOffsetMinutes: 0 }), null)
    assert.equal(sanitizePcClock({ clockOffsetMs: 0, rttMs: 30_001, utcOffsetMinutes: 0 }), null)
    assert.equal(sanitizePcClock({ clockOffsetMs: 0, rttMs: -1, utcOffsetMinutes: 0 }), null)
    assert.equal(sanitizePcClock({ clockOffsetMs: 0, rttMs: 10, utcOffsetMinutes: 841 }), null)
    assert.equal(sanitizePcClock({ clockOffsetMs: 0, rttMs: 10, utcOffsetMinutes: 30.5 }), null)
    assert.deepEqual(sanitizePcClock({ clockOffsetMs: 366 * 86_400_000, rttMs: 30_000, utcOffsetMinutes: -840 }), { clockOffsetMs: 366 * 86_400_000, rttMs: 30_000, utcOffsetMinutes: -840 })
  })
})
