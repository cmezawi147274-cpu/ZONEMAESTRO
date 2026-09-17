"use strict";

/**
 * Continuous-playback regression suite.
 *
 * Pure unit tests, no real CMMP or MusicServer needed: `local-api.js`'s
 * exports are a plain CommonJS object, so `mock.method` here overrides the
 * exact same reference `agent.js` calls through `require("./local-api")`.
 *
 *   node --test test/
 */
const { test, describe, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const local = require("../lib/local-api");
const shuffle = require("../lib/shuffle");
const cmmp = require("../lib/cmmp");
const agent = require("../lib/agent");

/** Every test starts a fresh shuffle bag — it's zone-id-keyed module state
 * that would otherwise leak between tests. */
function resetShuffle() {
  shuffle.prune([]);
}

describe("shuffle.js — per-zone shuffle bag", () => {
  beforeEach(resetShuffle);

  test("every track plays once before any repeats", () => {
    const ids = ["a", "b", "c", "d"];
    const seen = [];
    for (let i = 0; i < ids.length; i++) seen.push(shuffle.nextTrackId("z1", ids));
    assert.deepEqual(seen.slice().sort(), ids.slice().sort(), "a full pass did not cover every track exactly once");
  });

  test("fewer than two tracks yields no shuffle (left to the service's own repeat)", () => {
    assert.equal(shuffle.nextTrackId("z1", []), null);
    assert.equal(shuffle.nextTrackId("z1", ["only"]), null);
  });

  test("a refill never opens on the track that just played", () => {
    const ids = ["a", "b"];
    for (let i = 0; i < 50; i++) {
      const first = shuffle.nextTrackId("z2", ids);
      const second = shuffle.nextTrackId("z2", ids);
      assert.notEqual(first, second, "the same 2-track queue repeated a track back-to-back");
    }
  });

  test("zones never share shuffle state", () => {
    const a1 = shuffle.nextTrackId("zA", ["a", "b", "c"]);
    const b1 = shuffle.nextTrackId("zB", ["a", "b", "c"]);
    // Not asserting they differ (they legitimately can by chance) — asserting
    // that draining one zone's bag doesn't affect the other's remaining count.
    shuffle.nextTrackId("zA", ["a", "b", "c"]);
    shuffle.nextTrackId("zA", ["a", "b", "c"]);
    const peekB = shuffle.peek("zB");
    assert.equal(peekB.remaining.length, 2, "zone A's draws affected zone B's bag");
    void a1;
    void b1;
  });

  test("prune forgets a zone's state so a reused id starts fresh", () => {
    shuffle.nextTrackId("zPrune", ["a", "b"]);
    shuffle.prune([]);
    assert.equal(shuffle.peek("zPrune"), null, "prune() did not clear the deleted zone's bag");
  });

  test("notePlayed sets lastPlayed without drawing from the bag", () => {
    shuffle.nextTrackId("zNote", ["a", "b", "c"]);
    shuffle.notePlayed("zNote", "manual-pick");
    const peeked = shuffle.peek("zNote");
    assert.equal(peeked.lastPlayed, "manual-pick");
  });
});

describe("advancePlaybackOnce() — continuous playback", () => {
  beforeEach(() => {
    resetShuffle();
    mock.method(local, "getZones");
    mock.method(local, "getZonePlaylist");
    mock.method(local, "playTrack", async () => ({}));
  });
  afterEach(() => mock.restoreAll());

  function zone(zoneId, status) {
    return { zoneId, status };
  }
  function queue(...trackIds) {
    return { tracks: trackIds.map((trackId, position) => ({ trackId, position })) };
  }

  /** `mockImplementationOnce` without an explicit `onCall` always targets
   * call 0, not a FIFO queue — chaining two of them silently makes the
   * second overwrite the first's registration. A small self-managed queue
   * avoids relying on that indexing at all. */
  function queuedZoneStates(...responses) {
    let i = 0;
    local.getZones.mock.mockImplementation(async () => responses[Math.min(i++, responses.length - 1)]);
  }

  test("does nothing on the first tick (no prior PLAYING observation)", async () => {
    local.getZones.mock.mockImplementation(async () => [zone("z1", "idle")]);
    await agent.advancePlaybackOnce();
    assert.equal(local.playTrack.mock.callCount(), 0);
  });

  test("advances a zone whose track just ended (PLAYING -> STOPPED)", async () => {
    queuedZoneStates([zone("z1", "playing")], [zone("z1", "idle")]);
    local.getZonePlaylist.mock.mockImplementation(async () => queue("t1", "t2", "t3"));

    await agent.advancePlaybackOnce(); // observes PLAYING
    await agent.advancePlaybackOnce(); // observes the STOPPED edge -> advances

    assert.equal(local.playTrack.mock.callCount(), 1);
    const args = local.playTrack.mock.calls[0].arguments;
    assert.equal(args[0], "z1");
    assert.ok(["t1", "t2", "t3"].includes(args[1]));
  });

  test("does not advance a zone with fewer than two tracks queued", async () => {
    queuedZoneStates([zone("z1", "playing")], [zone("z1", "idle")]);
    local.getZonePlaylist.mock.mockImplementation(async () => queue("t1"));

    await agent.advancePlaybackOnce();
    await agent.advancePlaybackOnce();

    assert.equal(local.playTrack.mock.callCount(), 0);
  });

  test("an explicit STOP command is never mistaken for a finished track", async () => {
    mock.method(local, "stop", async () => ({}));
    mock.method(local, "getZone", async () => ({ zoneId: "z1", status: "stopped", currentTrackId: "t1" }));
    mock.method(cmmp, "ackCommand", async () => ({}));

    queuedZoneStates([zone("z1", "playing")], [zone("z1", "stopped")]);
    local.getZonePlaylist.mock.mockImplementation(async () => queue("t1", "t2"));

    await agent.advancePlaybackOnce(); // observes PLAYING

    // The real STOP path — executeCommand marks expectedStops itself.
    await agent.executeCommand({ commandId: "c1", type: "STOP", zoneId: "z1" });

    await agent.advancePlaybackOnce();

    assert.equal(local.playTrack.mock.callCount(), 0, "an operator's Stop was auto-resumed");
    assert.equal(local.stop.mock.callCount(), 1);
    assert.equal(cmmp.ackCommand.mock.calls[0].arguments[0].status, "SUCCESS");
  });

  test("a broken track is skipped in favor of another, bounded — not an infinite retry", async () => {
    queuedZoneStates([zone("z1", "playing")], [zone("z1", "idle")]);
    local.getZonePlaylist.mock.mockImplementation(async () => queue("bad1", "bad2", "good"));
    local.playTrack.mock.mockImplementation(async (_zoneId, trackId) => {
      if (trackId.startsWith("bad")) throw new Error(`${trackId} will not play`);
      return {};
    });

    await agent.advancePlaybackOnce();
    await agent.advancePlaybackOnce();

    // At most one attempt per track in the queue (3), never unbounded.
    assert.ok(local.playTrack.mock.callCount() <= 3, "retried more times than the queue has tracks");
    assert.ok(local.playTrack.mock.callCount() >= 1, "gave up without trying any track");
  });

  test("a zone stuck at STOPPED across ticks is not retried every tick", async () => {
    queuedZoneStates([zone("z1", "playing")], [zone("z1", "idle")], [zone("z1", "idle")]);
    local.getZonePlaylist.mock.mockImplementation(async () => queue("t1", "t2"));
    local.playTrack.mock.mockImplementation(async () => {
      throw new Error("device unavailable");
    });

    await agent.advancePlaybackOnce(); // PLAYING
    await agent.advancePlaybackOnce(); // edge -> tries both tracks, both fail
    const afterFirstEdge = local.playTrack.mock.callCount();
    await agent.advancePlaybackOnce(); // still STOPPED, but not a new edge

    assert.equal(local.playTrack.mock.callCount(), afterFirstEdge, "a non-edge STOPPED tick retried playback");
  });
});
