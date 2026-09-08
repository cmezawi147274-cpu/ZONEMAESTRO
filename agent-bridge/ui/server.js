"use strict";

/**
 * The local control panel this agent serves itself.
 *
 * It exists because the compiled MusicServer's own Setup UI (:8765) has
 * two gaps that cannot be closed in place — there is no source for those
 * binaries:
 *   1. Its only "cloud" section is a *mobile app account* form against
 *      the bundled loopback CloudApi; it has no field for a CMMP pairing
 *      code, so a CMMP-registered server could never be paired from the
 *      machine it runs on.
 *   2. Its Zones page offers Play/Stop/Skip only — no Previous — and its
 *      Skip dies at the end of a queue.
 *
 * This panel fills both: a Setup tab that takes a CMMP pairing code, and
 * a Zones tab with full transport (Previous / Play / Pause / Stop /
 * Next / volume / mute) backed by lib/local-api.js, which implements
 * Previous and end-of-queue Next against the local service's real API.
 *
 * Plain `node:http` and one static HTML file: no dependencies, and it
 * runs identically on Windows and Linux.
 */

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { env, getState, resetState, cmmpApiUrl } = require("../lib/config");
const { log } = require("../lib/log");
const cmmp = require("../lib/cmmp");
const local = require("../lib/local-api");
const agent = require("../lib/agent");

const INDEX_FILE = path.join(__dirname, "index.html");

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

async function buildStatus() {
  const state = getState();
  const out = {
    paired: Boolean(state.agentToken),
    serverId: state.serverId,
    locationId: state.locationId,
    cmmpApiUrl: cmmpApiUrl(),
    localApiUrl: env.localApiUrl,
    agentVersion: env.agentVersion,
    running: agent.status.running,
    lastHeartbeatAt: agent.status.lastHeartbeatAt,
    lastHeartbeatError: agent.status.lastHeartbeatError,
    lastTrackSyncAt: agent.status.lastTrackSyncAt,
    pendingCommands: agent.status.pendingCommands,
    cachedTracks: state.cachedTrackIds.length,
    mappedTracks: Object.keys(state.trackIdMap).length,
    local: null,
    localError: null,
  };
  try {
    const [health, library] = await Promise.all([local.getHealth(), local.getLibrary()]);
    out.local = {
      status: health.status,
      playbackHostOnline: health.playbackHostOnline,
      musicFolder: library.defaultMusicFolder,
      trackCount: library.trackCount,
    };
  } catch (err) {
    out.localError = err.message;
  }
  return out;
}

async function buildZones() {
  const zones = await local.getZones();
  return Promise.all(
    zones.map(async (z) => {
      let queue = [];
      try {
        queue = (await local.getZonePlaylist(z.zoneId)).tracks;
      } catch {
        queue = [];
      }
      const index = z.currentTrackId ? queue.findIndex((t) => t.trackId === z.currentTrackId) : -1;
      return {
        zoneId: z.zoneId,
        name: z.zoneName,
        status: z.status,
        deviceAvailable: z.deviceAvailable,
        volume: z.volume,
        muted: z.isMuted,
        positionSeconds: z.positionSeconds,
        currentTrackId: z.currentTrackId,
        currentTrackTitle: z.currentTrackTitle,
        queue: queue.map((t) => ({ trackId: t.trackId, title: t.title, artist: t.artist, durationSeconds: t.durationSeconds })),
        queueIndex: index,
      };
    })
  );
}

const ZONE_ACTIONS = {
  play: (zoneId) => local.play(zoneId),
  pause: (zoneId) => local.pause(zoneId),
  stop: (zoneId) => local.stop(zoneId),
  next: (zoneId) => local.next(zoneId),
  previous: (zoneId) => local.previous(zoneId),
  mute: (zoneId) => local.mute(zoneId),
  unmute: (zoneId) => local.unmute(zoneId),
  volume: (zoneId, body) => local.setVolume(zoneId, Number(body.volume)),
  playTrack: (zoneId, body) => local.playTrack(zoneId, String(body.trackId)),
};

async function handle(req, res, url) {
  const { pathname } = url;

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    const html = fs.readFileSync(INDEX_FILE);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(html);
  }

  if (req.method === "GET" && pathname === "/api/status") {
    return sendJson(res, 200, await buildStatus());
  }

  if (req.method === "GET" && pathname === "/api/zones") {
    return sendJson(res, 200, { zones: await buildZones() });
  }

  if (req.method === "GET" && pathname === "/api/devices") {
    return sendJson(res, 200, { devices: await local.getDevices() });
  }

  if (req.method === "POST" && pathname === "/api/zones") {
    const body = await readBody(req);
    const zoneId = String(body.zoneId || "").trim();
    const name = String(body.name || "").trim();
    if (!zoneId || !name) return sendJson(res, 400, { error: "Zone ID and display name are required." });
    await local.createZone(zoneId, name, body.audioDeviceId ? String(body.audioDeviceId) : null);
    log(`Zone created locally: ${zoneId} (${name})`);
    return sendJson(res, 200, { ok: true, zones: await buildZones() });
  }

  // /api/zones/<id> — DELETE only; the read/list path above already
  // handles the exact "/api/zones" match.
  if (req.method === "DELETE" && pathname.startsWith("/api/zones/")) {
    const zoneId = decodeURIComponent(pathname.slice("/api/zones/".length));
    if (!zoneId) return sendJson(res, 400, { error: "zoneId is required." });
    await local.deleteZone(zoneId);
    log(`Zone deleted locally: ${zoneId}`);
    return sendJson(res, 200, { ok: true, zones: await buildZones() });
  }

  if (req.method === "GET" && pathname === "/api/log") {
    const since = Number(url.searchParams.get("since") || 0);
    return sendJson(res, 200, { entries: log.since(Number.isFinite(since) ? since : 0) });
  }

  if (req.method === "POST" && pathname === "/api/pair") {
    const body = await readBody(req);
    await cmmp.pair(body.code, body.cmmpApiUrl);
    // Start the loops right away: pairing from here should be the whole
    // action, not "pair, then go restart the process".
    agent.stop();
    await agent.start();
    return sendJson(res, 200, await buildStatus());
  }

  if (req.method === "POST" && pathname === "/api/unpair") {
    agent.stop();
    resetState();
    log("Unpaired from CMMP — sync loops stopped. Pair again with a new code to resume.");
    return sendJson(res, 200, await buildStatus());
  }

  if (req.method === "POST" && pathname === "/api/sync-now") {
    await agent.syncTracksOnce();
    await agent.syncZonePlaylistsOnce();
    await agent.heartbeatOnce();
    return sendJson(res, 200, await buildStatus());
  }

  if (req.method === "POST" && pathname === "/api/library/scan") {
    await local.scanLibrary();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/zone-action") {
    const body = await readBody(req);
    const action = ZONE_ACTIONS[String(body.action)];
    if (!action) return sendJson(res, 400, { error: `Unknown action: ${body.action}` });
    if (!body.zoneId) return sendJson(res, 400, { error: "zoneId is required." });
    await action(String(body.zoneId), body);
    return sendJson(res, 200, { ok: true, zones: await buildZones() });
  }

  return sendJson(res, 404, { error: "Not found" });
}

function startUi() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    handle(req, res, url).catch((err) => {
      // Local-API and CMMP failures are surfaced verbatim: the operator
      // standing at the machine needs the real reason, not "500".
      sendJson(res, 400, { error: err.message });
    });
  });

  server.listen(env.uiPort, env.uiHost, () => {
    log(`Control panel on http://${env.uiHost === "0.0.0.0" ? "127.0.0.1" : env.uiHost}:${env.uiPort}`);
  });
  server.on("error", (err) => {
    log.error(`Control panel could not start on ${env.uiHost}:${env.uiPort} — ${err.message}`);
  });
  return server;
}

module.exports = { startUi };
