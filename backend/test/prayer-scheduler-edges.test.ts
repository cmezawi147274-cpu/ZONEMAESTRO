import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import * as h from "./prayer-scheduler-harness.ts"

const { P } = h

/** London times (MWL-ish shape): wall clock jumps an hour across the DST change,
 * while the UTC instant only moves a couple of minutes. */
const LONDON: Record<string, Record<string, string>> = {
  "20-10-2026": { Fajr: "05:37", Dhuhr: "12:45", Asr: "15:26", Maghrib: "17:59", Isha: "19:37" },
  "21-10-2026": { Fajr: "05:39", Dhuhr: "12:45", Asr: "15:24", Maghrib: "17:57", Isha: "19:35" },
  "24-10-2026": { Fajr: "05:44", Dhuhr: "12:44", Asr: "15:20", Maghrib: "17:51", Isha: "19:30" }, // BST, Maghrib 16:51Z
  "25-10-2026": { Fajr: "04:46", Dhuhr: "11:44", Asr: "14:18", Maghrib: "16:49", Isha: "18:28" }, // GMT, Maghrib 16:49Z
  "28-03-2026": { Fajr: "04:52", Dhuhr: "12:13", Asr: "15:38", Maghrib: "18:24", Isha: "19:58" }, // GMT, 18:24Z
  "29-03-2026": { Fajr: "05:49", Dhuhr: "13:13", Asr: "16:39", Maghrib: "19:26", Isha: "21:01" }, // BST, 18:26Z
}
const DUBAI = { Fajr: "04:52", Dhuhr: "12:11", Asr: "15:38", Maghrib: "18:14", Isha: "19:26" }
const RIYADH = { Fajr: "04:26", Dhuhr: "11:45", Asr: "15:12", Maghrib: "17:48", Isha: "19:00" }
let down = new Set<string>()

before(async () => {
  await h.install()
  h.setTimings((lat, date) => {
    if (down.has(date)) return null
    if (lat.startsWith("51.")) return LONDON[date] ?? null
    if (lat.startsWith("25.2")) return DUBAI
    if (lat.startsWith("24.6")) return RIYADH
    return null
  })
})
after(() => h.uninstall())

async function tickAt(s: any, cfg: any, iso: string) {
  h.setNow(iso)
  await s.tickOrganization(cfg, new Date(iso))
}
/** The agent acknowledges every command issued so far. */
function ack(w: h.World) {
  for (const c of w.commands) {
    const z = w.zones.find((r) => r.id === c.zoneId)!
    z.playbackState = c.type === "PLAY" ? "PLAYING" : "PAUSED"
  }
}

// ---------------------------------------------------------------------------
// mayBeOpen's "today's estimated window" on DST change days
// ---------------------------------------------------------------------------

for (const [label, todayDate, yesterdayDate, restartAt] of [
  ["autumn (fall back), restart 3 min into Maghrib", "25-10-2026", "24-10-2026", "2026-10-25T16:52:00Z"],
  ["spring (forward), restart 2 min into Maghrib", "29-03-2026", "28-03-2026", "2026-03-29T18:28:00Z"],
  ["control, ordinary day", "21-10-2026", "20-10-2026", "2026-10-21T16:59:00Z"],
] as const) {
  test(`DST estimate: ${label}; today's AlAdhan down, yesterday's up`, async () => {
    const w = h.newWorld()
    h.useWorld(w)
    w.zones = [h.zone("lon-1", "srv-lon", "loc-lon", { pausedByPrayer: "MAGHRIB", prePrayerPlaybackState: "PLAYING", playbackState: "PAUSED" })]
    down = new Set([todayDate])
    await h.flushTimingsCache()
    const s = await h.freshNew() // the restart
    try {
      await tickAt(s, h.config(h.prayers("MAGHRIB")), restartAt)
      // eslint-disable-next-line no-console
      console.log(label, "->", JSON.stringify(h.cmds(w, "PLAY")), "yesterday", yesterdayDate)
      assert.deepEqual(h.cmds(w, "PLAY"), [], "real Maghrib pause is still running: must not resume")
    } finally {
      down = new Set()
    }
  })
}

// ---------------------------------------------------------------------------
// ownAtStart: a server customized AFTER the organization's start, then reset
// ---------------------------------------------------------------------------

function dubaiTwoServers(w: h.World) {
  h.serverName[`${P}srv-two`] = "Venue Two"
  w.zones = [h.zone("dxb-1", "srv-dxb", "loc-dxb"), h.zone("two-1", "srv-two", "loc-dxb"), h.zone("two-2", "srv-two", "loc-dxb")]
}
const ownTwo = (w: h.World, prayerSettings: Record<string, unknown>) => {
  w.overrides = [{ serverId: `${P}srv-two`, prayers: prayerSettings }]
}

test("ownAtStart: customized after the org start, then reset inside the org window", async () => {
  const w = h.newWorld()
  h.useWorld(w)
  dubaiTwoServers(w)
  const s = await h.freshNew()
  const cfg = h.config(h.prayers("MAGHRIB")) // org 14:14Z–14:24Z
  await tickAt(s, cfg, "2026-11-10T14:14:00Z")
  ack(w)
  assert.deepEqual(h.cmds(w, "PAUSE"), ["dxb-1", "two-1", "two-2"])

  ownTwo(w, h.prayers("MAGHRIB", 30, 10)) // 14:44Z–14:54Z
  await tickAt(s, cfg, "2026-11-10T14:15:00Z")
  ack(w)
  assert.deepEqual(h.cmds(w, "PLAY"), ["two-1", "two-2"], "resumed: its own window is later")

  w.overrides = [] // back to the organization, org window still open
  await tickAt(s, cfg, "2026-11-10T14:16:00Z")
  ack(w)
  console.log("after reset at 14:16Z: PAUSE", JSON.stringify(h.cmds(w, "PAUSE")), "two-1", h.row(w, "two-1").playbackState)
  assert.deepEqual(h.cmds(w, "PAUSE"), ["dxb-1", "two-1", "two-1", "two-2", "two-2"], "expected: paused for the rest of the org window like every other org zone")
})

test("ownAtStart: customized at start, reset (re-paused), customized again, reset again", async () => {
  const w = h.newWorld()
  h.useWorld(w)
  dubaiTwoServers(w)
  const s = await h.freshNew()
  const cfg = h.config(h.prayers("MAGHRIB"))
  ownTwo(w, h.prayers("MAGHRIB", 30, 10))
  await tickAt(s, cfg, "2026-11-11T14:14:00Z")
  ack(w)
  assert.deepEqual(h.cmds(w, "PAUSE"), ["dxb-1"])
  w.overrides = []
  await tickAt(s, cfg, "2026-11-11T14:15:00Z")
  ack(w)
  assert.deepEqual(h.cmds(w, "PAUSE"), ["dxb-1", "two-1", "two-2"], "first reset: re-paused (the round-2 fix)")
  ownTwo(w, h.prayers("MAGHRIB", 30, 10))
  await tickAt(s, cfg, "2026-11-11T14:16:00Z")
  ack(w)
  assert.deepEqual(h.cmds(w, "PLAY"), ["two-1", "two-2"])
  w.overrides = []
  await tickAt(s, cfg, "2026-11-11T14:17:00Z")
  ack(w)
  console.log("second reset: PAUSE", JSON.stringify(h.cmds(w, "PAUSE")))
  assert.equal(h.cmds(w, "PAUSE").length, 5, "expected: paused again for the rest of the org window")
})

test("ownAtStart: joined re-pause posts extra 'began' events, also at Locations where the server has no zones", async () => {
  const w = h.newWorld()
  h.useWorld(w)
  dubaiTwoServers(w)
  w.zones.push(h.zone("ruh-1", "srv-ruh", "loc-ruh"))
  const s = await h.freshNew()
  const cfg = h.config(h.prayers("MAGHRIB", 0, 40)) // Dubai 14:14Z–14:54Z, Riyadh 14:48Z–15:28Z
  ownTwo(w, h.prayers("ASR")) // Venue Two: Maghrib off
  await tickAt(s, cfg, "2026-11-12T14:14:00Z")
  await tickAt(s, cfg, "2026-11-12T14:48:00Z")
  ack(w)
  const before = w.activity.length
  w.overrides = []
  await tickAt(s, cfg, "2026-11-12T14:50:00Z")
  const added = w.activity.slice(before)
  console.log("activity after reset:", JSON.stringify(added))
  assert.ok(!added.some((a) => /pausing 0 zone/.test(a.message)), "a 'Maghrib began — pausing 0 zone(s)' event at Riyadh, where Venue Two has no zones")
})

// ---------------------------------------------------------------------------
// STOPPED rule on a regular (not leftover) end that crosses midnight
// ---------------------------------------------------------------------------

for (const [label, settings, startIso, stopIso, endIso] of [
  ["crossing midnight", h.prayers("ISHA", 270, 10), "2026-11-13T19:56:00Z", "2026-11-13T19:58:00Z", "2026-11-13T20:06:00Z"],
  ["same day", h.prayers("ISHA", 0, 10), "2026-11-13T15:26:00Z", "2026-11-13T15:28:00Z", "2026-11-13T15:36:00Z"],
] as const) {
  test(`STOPPED during an ordinary Isha pause (${label})`, async () => {
    const w = h.newWorld()
    h.useWorld(w)
    w.zones = [h.zone("dxb-1", "srv-dxb", "loc-dxb")]
    const s = await h.freshNew()
    const cfg = h.config(settings)
    await tickAt(s, cfg, startIso)
    ack(w)
    assert.deepEqual(h.cmds(w, "PAUSE"), ["dxb-1"])
    h.row(w, "dxb-1").playbackState = "STOPPED" // e.g. player came back idle after a venue-PC reboot
    await tickAt(s, cfg, stopIso)
    await tickAt(s, cfg, endIso)
    console.log(label, "PLAY:", JSON.stringify(h.cmds(w, "PLAY")), "flag:", h.row(w, "dxb-1").pausedByPrayer)
    assert.equal(h.row(w, "dxb-1").pausedByPrayer, null)
  })
}
