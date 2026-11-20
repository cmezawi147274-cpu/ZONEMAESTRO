import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { clockCheckSlots, noteDirectClock, pcClockFor, wantClockCheck } from "../src/lib/pc-clock.js"

const NOW = Date.UTC(2026, 10, 20, 9, 0, 0)
const slot = { id: "s1", localZoneId: "z1", startTime: "08:00", endTime: "18:00", days: ["FRI"], priority: null }

describe("direct PC clock", () => {
  test("no direct entry and no estimate: nothing known", () => {
    assert.deepEqual(pcClockFor("never-seen", "Asia/Dubai", NOW), { wallMs: null, measuring: false })
  })
  test("a fresh direct entry gives the wall clock and is not measuring", () => {
    noteDirectClock("pc-a", { clockOffsetMs: 2500, rttMs: 40, utcOffsetMinutes: 240 }, NOW)
    assert.deepEqual(pcClockFor("pc-a", "Asia/Dubai", NOW + 1000), { wallMs: NOW + 1000 + 240 * 60_000 + 2500, measuring: false })
    assert.deepEqual(pcClockFor("pc-a", null, NOW + 4 * 60_000), { wallMs: NOW + 4 * 60_000 + 240 * 60_000 + 2500, measuring: false })
  })
  test("a direct entry goes stale after 5 minutes", () => {
    noteDirectClock("pc-b", { clockOffsetMs: -1000, rttMs: 40, utcOffsetMinutes: 0 }, NOW)
    assert.equal(pcClockFor("pc-b", "UTC", NOW + 5 * 60_000).wallMs, null)
  })
  test("no phantom-slot probe while a fresh direct entry exists", () => {
    noteDirectClock("pc-c", { clockOffsetMs: 0, rttMs: 40, utcOffsetMinutes: 240 }, NOW)
    wantClockCheck("pc-c", true, NOW)
    assert.deepEqual(clockCheckSlots("pc-c", [slot], "Asia/Dubai", NOW, () => true), [])
    assert.equal(pcClockFor("pc-c", "Asia/Dubai", NOW).measuring, false)
  })
  test("an agent that sends no clock still gets the probe", () => {
    const slots = clockCheckSlots("pc-d", [slot], "Asia/Dubai", NOW, () => true)
    assert.ok(slots.length > 0)
  })
})
