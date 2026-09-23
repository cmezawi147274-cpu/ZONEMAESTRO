"use strict";

/**
 * The hub URL must advertise what this build can do safely.
 *
 * The cloud pushes commands only to sockets carrying `caps=cmdfix`
 * (backend/src/lib/agent-registry.ts pushToAgent), because a fixed and an
 * unfixed 1.0.0 report the same version. Drop the marker and this agent
 * silently falls back to poll-only delivery — which still works, so nothing
 * else would fail loudly enough to notice.
 *
 * `hub.js` destructures `./config` at load time, so a stub has to be in the
 * module cache before it is required. Test-only: no source change, and no
 * real state file, token, network or cloud is touched.
 *
 *   node --test
 */
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const configPath = require.resolve("../lib/config");
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: {
    getState: () => ({ agentToken: "zz-server.zz-secret" }),
    cmmpApiUrl: () => "https://cloud.example.com/api",
  },
};

const hub = require("../lib/hub");

describe("hub connect URL", () => {
  let opened;
  let realWebSocket;

  beforeEach(() => {
    opened = [];
    realWebSocket = globalThis.WebSocket;
    // Captures the URL the client would dial; never opens a socket.
    globalThis.WebSocket = class {
      constructor(url) {
        opened.push(url);
        this.readyState = 0;
      }
      addEventListener() {}
      close() {}
    };
  });

  afterEach(() => {
    hub.disconnect();
    if (realWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = realWebSocket;
  });

  test("carries the cmdfix capability, the token, and the unchanged hub path", () => {
    hub.connect(() => {});

    assert.equal(opened.length, 1, "no connection was attempted");
    const url = new URL(opened[0]);
    assert.equal(url.searchParams.get("caps"), "cmdfix", "without this the cloud will never push to this agent");
    assert.equal(url.searchParams.get("access_token"), "zz-server.zz-secret");
    assert.equal(url.protocol, "wss:");
    assert.equal(url.pathname, "/hubs/musicserver");
  });

  test("the backend reads that exact marker the way it is written", () => {
    hub.connect(() => {});

    // Mirrors backend/src/agent/signalrHub.ts: the two sides must agree on
    // the parameter name and value, which is the only thing a typo here
    // would break.
    const url = new URL(opened[0]);
    const caps = (url.searchParams.get("caps") ?? "").split(",").map((c) => c.trim());
    assert.equal(caps.includes("cmdfix"), true);
  });
});
