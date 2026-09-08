"use strict";

/**
 * Client for the CMMP cloud backend's Windows-agent protocol
 * (backend/src/routes/agent.ts): pairing, heartbeat, command poll/ack,
 * track sync, zone sync, zone-playlist sync.
 */

const os = require("node:os");
const { env, getState, saveState, clearLibraryState, cmmpApiUrl, trimSlash } = require("./config");
const { log } = require("./log");

async function request(pathname, { method = "GET", body, auth = true, baseUrl } = {}) {
  // Fastify rejects a request that declares a JSON content-type with an
  // empty body, so only set the header when there actually is one.
  const headers = body !== undefined ? { "Content-Type": "application/json" } : {};
  if (auth) {
    const token = getState().agentToken;
    if (!token) throw new Error("Not paired yet — no agentToken.");
    headers.Authorization = `Bearer ${token}`;
  }
  const base = trimSlash(baseUrl || cmmpApiUrl());
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || res.statusText;
    throw new Error(`CMMP ${method} ${pathname} -> ${res.status}: ${msg}`);
  }
  return data;
}

/**
 * Exchange a CMMP-issued pairing code for this agent's long-lived
 * credential. `apiUrl` lets the control panel pair against a URL the
 * operator typed, which is then persisted so it survives a restart.
 */
async function pair(code, apiUrl) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) throw new Error("A pairing code is required.");
  const base = trimSlash(apiUrl || cmmpApiUrl());
  // The server id this agent was previously paired to, if any. Sent so
  // the cloud releases that old row (POST /pairing/complete already
  // handles it) instead of leaving it behind as a permanently-OFFLINE
  // duplicate the moment this machine re-pairs. Never affects Forget
  // Server, which deletes the row cloud-side before this ever runs.
  const previousServerId = getState().serverId || undefined;

  log(`Pairing with CMMP at ${base} using code ${normalized} ...`);
  const result = await request("/pairing/complete", {
    auth: false,
    baseUrl: base,
    method: "POST",
    body: {
      code: normalized,
      serverVersion: env.agentVersion,
      os: `${os.type()} ${os.release()} (bridge)`,
      ...(previousServerId ? { previousServerId } : {}),
    },
  });

  const state = getState();
  if (state.libraryForServerId && state.libraryForServerId !== result.serverId) {
    // Bound to a different server (or a different cloud): the tracks
    // cached for the old one mean nothing here.
    clearLibraryState();
    log.warn("Paired to a different server than before — local cached-track bookkeeping reset.");
  }
  state.libraryForServerId = result.serverId;
  state.agentToken = result.agentToken;
  state.serverId = result.serverId;
  state.locationId = result.locationId;
  state.cmmpApiUrl = base;
  state.heartbeatIntervalSeconds = result.heartbeatIntervalSeconds || env.defaultHeartbeatSec;
  saveState();
  log(`Paired. serverId=${state.serverId} locationId=${state.locationId}`);
  return result;
}

module.exports = {
  request,
  pair,
  heartbeat: (body) => request("/server/heartbeat", { method: "POST", body }),
  syncZones: (zones) => request("/server/zones/sync", { method: "POST", body: { zones } }),
  pendingCommands: () => request("/server/commands/pending"),
  ackCommand: (body) => request("/server/commands/ack", { method: "POST", body }),
  syncTracks: (cachedTrackIds) => request("/server/tracks/sync", { method: "POST", body: { cachedTrackIds } }),
  syncZonePlaylists: () => request("/server/zone-playlists/sync", { method: "POST" }),
  getSchedules: () => request("/server/schedules"),
};
