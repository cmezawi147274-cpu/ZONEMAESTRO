"use strict";

/**
 * Command-delivery regression suite: a command must run at most once.
 *
 * GET /commands/pending keeps returning a command until its ack lands, and
 * both the poll timer and a MusicServerHub push trigger a poll. These tests
 * stand in for the cloud with a fake that behaves the same way.
 *
 *   node --test test/
 */
const { test, describe, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const local = require("../lib/local-api");
const cmmp = require("../lib/cmmp");
const agent = require("../lib/agent");

let seq = 0;
/** Fresh id per test — the agent remembers completed ids for its lifetime. */
function nextCommand(type = "NEXT") {
  seq += 1;
  return { commandId: `zz-cmd-${Date.now()}-${seq}`, type, zoneId: "z1", payload: null };
}

/**
 * Fake cloud, matching routes/agent.ts: a command is handed out until it
 * leaves PENDING/SENT, which any ack — including EXECUTING — does.
 */
function fakeCloud(commands) {
  const claimed = new Set();
  const acks = [];
  mock.method(cmmp, "pendingCommands", async () => ({ commands: commands.filter((c) => !claimed.has(c.commandId)) }));
  mock.method(cmmp, "ackCommand", async (payload) => {
    acks.push(payload);
    claimed.add(payload.commandId);
    return { ok: true };
  });
  return { acks, final: () => acks.filter((a) => a.status !== "EXECUTING") };
}

describe("pollCommandsOnce() — at-most-once execution", () => {
  beforeEach(() => {
    mock.method(local, "getZone", async () => null);
  });
  afterEach(() => mock.restoreAll());

  test("EXECUTING is reported before the action runs", async () => {
    const cmd = nextCommand("NEXT");
    const { acks } = fakeCloud([cmd]);
    const order = [];
    mock.method(cmmp, "ackCommand", async (payload) => {
      order.push(`ack:${payload.status}`);
      acks.push(payload);
      return { ok: true };
    });
    mock.method(local, "next", async () => {
      order.push("action");
      return {};
    });

    await agent.pollCommandsOnce();

    assert.deepEqual(order, ["ack:EXECUTING", "action", "ack:SUCCESS"], "EXECUTING must be claimed before the work starts");
  });

  test("a failed EXECUTING claim does not stop the command running", async () => {
    const cmd = nextCommand("NEXT");
    const acks = [];
    mock.method(cmmp, "pendingCommands", async () => ({ commands: acks.some((a) => a.status === "SUCCESS") ? [] : [cmd] }));
    mock.method(cmmp, "ackCommand", async (payload) => {
      if (payload.status === "EXECUTING") throw new Error("fetch failed");
      acks.push(payload);
      return { ok: true };
    });
    mock.method(local, "next", async () => ({}));

    await agent.pollCommandsOnce();

    assert.equal(local.next.mock.callCount(), 1, "a lost EXECUTING claim must not swallow the command");
    assert.equal(acks.at(-1).status, "SUCCESS");
  });

  test("a push arriving mid-poll does not run the same command twice", async () => {
    const cmd = nextCommand("NEXT");
    const { acks } = fakeCloud([cmd]);
    let release;
    const skipping = new Promise((r) => (release = r));
    mock.method(local, "next", async () => {
      await skipping;
      return {};
    });

    const timerPoll = agent.pollCommandsOnce();
    // The push lands while the timer's poll is still executing NEXT.
    await new Promise((r) => setImmediate(r));
    const pushPoll = agent.pollCommandsOnce();
    release();
    await Promise.all([timerPoll, pushPoll]);

    assert.equal(local.next.mock.callCount(), 1, "NEXT ran more than once — the venue skipped two tracks");
    assert.equal(acks.filter((a) => a.status !== "EXECUTING").length, 1);
    assert.equal(acks.at(-1).status, "SUCCESS");
    // The mid-poll trigger was queued, not dropped: a follow-up poll ran.
    assert.equal(cmmp.pendingCommands.mock.callCount(), 2);
  });

  test("a command whose ack was lost is re-acked, not re-run", async () => {
    const cmd = nextCommand("NEXT");
    mock.method(local, "next", async () => ({}));
    const acks = [];
    let ackReachesCloud = false;
    mock.method(cmmp, "pendingCommands", async () => ({ commands: acks.some((a) => a.delivered) ? [] : [cmd] }));
    mock.method(cmmp, "ackCommand", async (payload) => {
      if (!ackReachesCloud) throw new Error("fetch failed");
      acks.push({ ...payload, delivered: true });
      return { ok: true };
    });

    // First poll: NEXT runs, but neither the SUCCESS ack nor the follow-up
    // FAILED ack reaches the cloud, so the command stays pending there.
    await assert.rejects(agent.pollCommandsOnce());
    assert.equal(local.next.mock.callCount(), 1);

    // Network is back: the cloud hands the same command out again.
    ackReachesCloud = true;
    await agent.pollCommandsOnce();

    assert.equal(local.next.mock.callCount(), 1, "a command was re-run after its ack was lost");
    assert.equal(acks.length, 1);
    assert.equal(acks[0].status, "SUCCESS", "the resent ack must report what the action really did");
  });

  test("different commands still all run, in order", async () => {
    const a = nextCommand("PLAY");
    const b = nextCommand("PAUSE");
    const { final } = fakeCloud([a, b]);
    const calls = [];
    mock.method(local, "play", async () => calls.push("PLAY"));
    mock.method(local, "pause", async () => calls.push("PAUSE"));

    await agent.pollCommandsOnce();

    assert.deepEqual(calls, ["PLAY", "PAUSE"]);
    assert.deepEqual(final().map((x) => x.commandId), [a.commandId, b.commandId]);
  });
});
