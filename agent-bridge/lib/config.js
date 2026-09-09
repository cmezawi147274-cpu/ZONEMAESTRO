"use strict";

/**
 * Configuration + persisted pairing state.
 *
 * Two layers, in precedence order:
 *  1. `agent-state.json` — written at runtime (pairing from the control
 *     panel writes the CMMP URL here, so a technician never has to edit
 *     a file or restart the process to pair).
 *  2. `.env` / process environment — the pre-pairing defaults.
 *
 * Paths are built with `node:path` and the state file defaults next to
 * this package, so the agent runs unchanged on Windows and Linux.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv(path.join(ROOT, ".env"));

const trimSlash = (u) => String(u || "").replace(/\/+$/, "");

const env = {
  cmmpApiUrl: trimSlash(process.env.CMMP_API_URL || "http://127.0.0.1:4000/api"),
  localApiUrl: trimSlash(process.env.LOCAL_API_URL || "http://127.0.0.1:8765/api"),
  pairingCode: process.env.PAIRING_CODE || "",
  stateFile: process.env.STATE_FILE || path.join(ROOT, "agent-state.json"),
  commandPollMs: Number(process.env.COMMAND_POLL_MS || 1500),
  trackSyncMs: Number(process.env.TRACK_SYNC_MS || 20000),
  defaultHeartbeatSec: Number(process.env.HEARTBEAT_INTERVAL_SECONDS || 15),
  // Control panel (the local Setup/Zones UI this agent serves itself).
  uiPort: Number(process.env.LOCAL_UI_PORT || 8899),
  // Loopback by default: the panel has no authentication, so it must not
  // be reachable from the restaurant's LAN unless explicitly opted into.
  uiHost: process.env.LOCAL_UI_HOST || "127.0.0.1",
  agentVersion: "0.2.0-bridge",
};

const emptyState = () => ({
  agentToken: null,
  serverId: null,
  locationId: null,
  cmmpApiUrl: null,
  cachedTrackIds: [],
  trackIdMap: {},
  // Which CMMP server the cached-track bookkeeping above describes. It
  // survives an unpair (the files are still on this disk), and is only
  // discarded when this machine is paired to a *different* server — see
  // resetState() and cmmp.pair().
  libraryForServerId: null,
  heartbeatIntervalSeconds: env.defaultHeartbeatSec,
});

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(env.stateFile, "utf8"));
    return { ...emptyState(), ...parsed, trackIdMap: parsed.trackIdMap || {}, cachedTrackIds: parsed.cachedTrackIds || [] };
  } catch {
    return emptyState();
  }
}

let state = loadState();

function saveState() {
  fs.mkdirSync(path.dirname(env.stateFile), { recursive: true });
  fs.writeFileSync(env.stateFile, JSON.stringify(state, null, 2));
}

/**
 * Drops the cloud credential but keeps the record of what is already
 * downloaded into the local music folder: unpairing does not delete
 * those files, so forgetting them would make the next pairing
 * re-download every track and litter the library with duplicates.
 */
function resetState() {
  const { cachedTrackIds, trackIdMap, libraryForServerId } = state;
  state = { ...emptyState(), cachedTrackIds, trackIdMap, libraryForServerId };
  saveState();
  return state;
}

/** Forget the local library bookkeeping (a different server's music). */
function clearLibraryState() {
  state.cachedTrackIds = [];
  state.trackIdMap = {};
  state.libraryForServerId = null;
  saveState();
}

/** The CMMP base URL actually in force: whatever pairing used, else env. */
function cmmpApiUrl() {
  return trimSlash(state.cmmpApiUrl || env.cmmpApiUrl);
}

/** Local track GUID -> CMMP track id (reverse of `trackIdMap`). */
function cmmpTrackIdOf(localTrackId) {
  if (!localTrackId) return null;
  for (const [cmmpId, localId] of Object.entries(state.trackIdMap)) {
    if (localId === localTrackId) return cmmpId;
  }
  return null;
}

module.exports = {
  env,
  getState: () => state,
  saveState,
  resetState,
  clearLibraryState,
  cmmpApiUrl,
  cmmpTrackIdOf,
  trimSlash,
};
