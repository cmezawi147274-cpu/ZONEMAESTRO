"use strict";

/**
 * Optional low-latency command channel.
 *
 * The REST poll (`GET /server/commands/pending`, every COMMAND_POLL_MS) is
 * the authoritative transport and always works on its own. But the cloud
 * blocks a portal zone command on the agent's ack for only
 * AGENT_COMMAND_ACK_TIMEOUT_MS (3s by default), and up to a full poll
 * interval of that budget is spent waiting to even *see* the command. This
 * client holds the backend's MusicServerHub socket open
 * (backend/src/agent/signalrHub.ts) so a queued command wakes the agent
 * immediately, leaving the whole budget for actually doing the work.
 *
 * It is strictly an optimization: if the socket cannot be opened — an old
 * Node without a global WebSocket, a proxy that blocks upgrades, the hub
 * disabled — the agent logs it once and carries on polling.
 */

const { getState, cmmpApiUrl } = require("./config");
const { log } = require("./log");

// SignalR's JSON hub protocol terminates every frame with 0x1E.
const RS = "";
const RECONNECT_MS = 10_000;

let socket = null;
let reconnectTimer = null;
let warnedUnsupported = false;

/** `<cmmpApiUrl minus /api>/hubs/musicserver` as a ws:// or wss:// URL. */
function hubUrl(token) {
  const api = new URL(cmmpApiUrl());
  const base = api.pathname.replace(/\/api\/?$/, "") || "";
  const url = new URL(`${base}/hubs/musicserver`, api.origin);
  url.protocol = api.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("access_token", token);
  return url.toString();
}

function scheduleReconnect(onCommand) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(onCommand);
  }, RECONNECT_MS);
}

/**
 * @param {() => void} onCommand called when the hub says a command is
 *   waiting; the caller re-polls REST, which stays the source of truth.
 */
function connect(onCommand) {
  const token = getState().agentToken;
  if (!token) return;

  if (typeof WebSocket === "undefined") {
    if (!warnedUnsupported) {
      warnedUnsupported = true;
      log.warn("No global WebSocket in this Node build — using the REST command poll only (Node 21+ adds it).");
    }
    return;
  }

  let ws;
  try {
    ws = new WebSocket(hubUrl(token));
  } catch (err) {
    log.warn("hub connect failed:", err.message);
    return scheduleReconnect(onCommand);
  }
  socket = ws;

  ws.addEventListener("open", () => {
    // SignalR handshake: the server replies with an empty object frame.
    ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
    log("Command hub connected — commands now arrive without waiting for the poll.");
  });

  ws.addEventListener("message", (event) => {
    for (const part of String(event.data).split(RS)) {
      if (!part) continue;
      let msg;
      try {
        msg = JSON.parse(part);
      } catch {
        continue;
      }
      // type 1 = server->client invocation; type 6 = keepalive ping.
      if (msg.type === 6) {
        ws.send(JSON.stringify({ type: 6 }) + RS);
      } else if (msg.type === 1 && msg.target === "ReceiveCommand") {
        onCommand();
      }
    }
  });

  ws.addEventListener("close", () => {
    if (socket === ws) socket = null;
    scheduleReconnect(onCommand);
  });
  ws.addEventListener("error", () => {
    // "close" always follows; reconnect is scheduled there.
  });
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.close();
    } catch {
      /* already closing */
    }
    socket = null;
  }
}

module.exports = { connect, disconnect, isConnected: () => Boolean(socket && socket.readyState === 1) };
