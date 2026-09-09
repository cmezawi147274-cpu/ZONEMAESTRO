"use strict";

/**
 * The bridge's running loops: heartbeat + zone sync, command poll and
 * execution, track sync, and zone-playlist sync.
 *
 * Loops are startable/stoppable at runtime so pairing from the local
 * control panel begins syncing immediately, and unpairing stops it,
 * without restarting the process.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { env, getState, saveState, cmmpTrackIdOf } = require("./config");
const { log } = require("./log");
const cmmp = require("./cmmp");
const local = require("./local-api");
const shuffle = require("./shuffle");
const hub = require("./hub");

const status = {
  running: false,
  lastHeartbeatAt: null,
  lastHeartbeatError: null,
  lastTrackSyncAt: null,
  pendingCommands: 0,
  localReachable: null,
  localError: null,
};

let timers = [];

// ---------------------------------------------------------------------------
// Heartbeat + zone sync
// ---------------------------------------------------------------------------

function cpuPercentSnapshot() {
  const cpus = os.cpus();
  if (!cpus || cpus.length === 0) return 0;
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return Math.max(0, Math.min(100, Math.round(100 - (idle / total) * 100)));
}

async function heartbeatOnce() {
  const state = getState();
  const totalMem = os.totalmem();
  const ramPercent = Math.round(((totalMem - os.freemem()) / totalMem) * 100);

  try {
    const result = await cmmp.heartbeat({
      serverVersion: env.agentVersion,
      cpuPercent: cpuPercentSnapshot(),
      ramPercent,
      cachedTracks: state.cachedTrackIds.length,
    });
    status.lastHeartbeatAt = new Date().toISOString();
    status.lastHeartbeatError = null;
    status.pendingCommands = result.pendingCommands ?? 0;
    log(`heartbeat ok, pendingCommands=${result.pendingCommands}`);
  } catch (err) {
    status.lastHeartbeatError = err.message;
    throw err;
  }

  // Piggyback zone sync on every heartbeat: cheap, and it keeps CMMP's
  // zone list matching whatever actually exists on this machine.
  try {
    const localZones = await local.getZones();
    status.localReachable = true;
    status.localError = null;
    const zones = localZones.map((z) => ({
      localZoneId: z.zoneId,
      name: z.zoneName,
      playbackState: local.toCmmpPlaybackState(z.status),
      volume: typeof z.volume === "number" ? z.volume : undefined,
      muted: typeof z.isMuted === "boolean" ? z.isMuted : undefined,
    }));
    const synced = await cmmp.syncZones(zones);
    if (Array.isArray(synced.zones) && synced.zones.length > 0) {
      log(`zone sync ok: ${synced.zones.length} zone(s)`);
    }
  } catch (err) {
    status.localReachable = false;
    status.localError = err.message;
    log.warn("zone sync failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Every CMMP zone transport command maps to a real local action. NEXT
 * and PREVIOUS go through lib/local-api.js's queue-aware
 * implementations, because the compiled local service has no `previous`
 * action and refuses `skip` at the end of a queue.
 */
const HANDLERS = {
  PLAY: (zoneId) => local.play(zoneId),
  PAUSE: (zoneId) => local.pause(zoneId),
  STOP: (zoneId) => local.stop(zoneId),
  NEXT: (zoneId) => local.next(zoneId),
  PREVIOUS: (zoneId) => local.previous(zoneId),
  SET_EQ: (zoneId, payload) => local.setEqualizer(zoneId, payload || {}),
  MUTE: (zoneId) => local.mute(zoneId),
  UNMUTE: (zoneId) => local.unmute(zoneId),
  SET_VOLUME: (zoneId, payload) =>
    local.setVolume(zoneId, payload && typeof payload.volume === "number" ? payload.volume : 50),
};

/**
 * Post-command zone state, in CMMP's own vocabulary. `currentTrackId` is
 * translated back into the **CMMP** track id: the local service works in
 * its own track GUIDs, and reporting one of those to CMMP would corrupt
 * the cloud's idea of where the zone is in its playlist (its NEXT /
 * PREVIOUS bookkeeping matches `currentTrackId` against CMMP track ids).
 * When there's no mapping for the loaded track, the field is omitted
 * rather than sent wrong.
 */
async function readBackZoneState(zoneId) {
  const zone = await local.getZone(zoneId);
  if (!zone) return undefined;
  const cmmpTrackId = cmmpTrackIdOf(zone.currentTrackId);
  return {
    playbackState: local.toCmmpPlaybackState(zone.status),
    volume: zone.volume,
    muted: zone.isMuted,
    ...(cmmpTrackId ? { currentTrackId: cmmpTrackId } : {}),
  };
}

async function ack(commandId, status_, resultMessage, zoneState) {
  await cmmp.ackCommand({ commandId, status: status_, resultMessage: resultMessage || undefined, zoneState });
}

/**
 * Server-scoped (non-zone) commands. `SYNC_MUSIC` matters in particular:
 * the portal's "queue for sync" action creates one, so without a handler
 * every music sync left a FAILED command in the audit trail even though
 * the periodic track-sync loop had done the work.
 *
 * The two restart commands are deliberately *not* faked: this agent runs
 * beside the compiled MusicServer service and cannot restart it or the
 * machine, so it says so instead of acking a success that never happened.
 */
const SERVER_HANDLERS = {
  SYNC_MUSIC: async () => {
    await syncTracksOnce();
    await syncZonePlaylistsOnce();
  },
  SYNC_CONFIG: async () => {
    await syncZonePlaylistsOnce();
    await heartbeatOnce();
  },
  RESTART_SERVICE: async () => {
    throw new Error("This agent cannot restart the local MusicServer service — restart it from Windows Services or Start-MusicServer.cmd on the machine.");
  },
  REBOOT_SERVER: async () => {
    throw new Error("This agent cannot reboot the machine — reboot it locally.");
  },
};

async function executeCommand(cmd) {
  const { commandId, type, zoneId, payload } = cmd;

  const serverHandler = SERVER_HANDLERS[type];
  if (serverHandler) {
    try {
      await serverHandler(payload);
      await ack(commandId, "SUCCESS");
      log(`command ${type} -> SUCCESS`);
    } catch (err) {
      log.warn(`command ${type} -> FAILED:`, err.message);
      await ack(commandId, "FAILED", err.message);
    }
    return;
  }

  if (!zoneId) {
    await ack(commandId, "FAILED", "No zone associated with this command.");
    return;
  }
  const handler = HANDLERS[type];
  if (!handler) {
    await ack(commandId, "FAILED", `Unsupported command type: ${type}`);
    return;
  }

  try {
    await handler(zoneId, payload);
    let zoneState;
    try {
      zoneState = await readBackZoneState(zoneId);
    } catch (err) {
      log.warn("could not read back zone state after command:", err.message);
    }
    await ack(commandId, "SUCCESS", null, zoneState);
    log(`command ${type} on zone ${zoneId} -> SUCCESS`);
  } catch (err) {
    log.warn(`command ${type} on zone ${zoneId} -> FAILED:`, err.message);
    await ack(commandId, "FAILED", err.message);
  }
}

async function pollCommandsOnce() {
  const { commands } = await cmmp.pendingCommands();
  for (const cmd of commands || []) {
    await executeCommand(cmd);
  }
}

// ---------------------------------------------------------------------------
// Zone-playlist sync — makes each zone's own local queue match the
// playlist CMMP assigned to that zone, and only that zone.
//
// This reconciles in both directions. Adding alone is not enough: a zone
// whose assignment changes would otherwise keep every track it was ever
// given and go on playing the previous playlist, so two zones on two
// sound cards drift into playing the same accumulated queue even though
// the portal shows them with different playlists. Zones CMMP has no
// playlist for are left untouched — the cloud has nothing to say about
// them, so their local queue is not the cloud's to clear.
// ---------------------------------------------------------------------------

async function syncZonePlaylistsOnce() {
  const { zonePlaylists } = await cmmp.syncZonePlaylists();
  const state = getState();
  for (const zp of zonePlaylists || []) {
    const localZoneId = zp.localZoneId;
    if (!localZoneId) continue;
    if (!zp.playlistId) continue;

    const wanted = (zp.trackIds || []).filter((id) => !(zp.excludedTrackIds || []).includes(id));
    // CMMP track ids the agent has actually cached locally, as local ids.
    const wantedLocalIds = new Set(
      wanted.map((cmmpTrackId) => state.trackIdMap[cmmpTrackId]).filter(Boolean)
    );

    let queue;
    try {
      queue = (await local.getZonePlaylist(localZoneId)).tracks;
    } catch (err) {
      log.warn(`could not read local playlist for zone ${localZoneId}:`, err.message);
      continue;
    }

    // Drop anything this zone is no longer assigned.
    for (const entry of queue) {
      if (wantedLocalIds.has(entry.trackId)) continue;
      try {
        await local.unqueueTrack(localZoneId, entry.id);
        log(`  unqueued stale track ${entry.trackId} from zone ${localZoneId}`);
      } catch (err) {
        log.warn(`  failed to unqueue ${entry.trackId} from zone ${localZoneId}:`, err.message);
      }
    }

    // Add what it is missing.
    const already = new Set(queue.map((t) => t.trackId));
    for (const cmmpTrackId of wanted) {
      const localTrackId = state.trackIdMap[cmmpTrackId];
      if (!localTrackId || already.has(localTrackId)) continue;
      try {
        await local.queueTrack(localZoneId, localTrackId);
        log(`  queued track ${cmmpTrackId} -> zone ${localZoneId}`);
      } catch (err) {
        log.warn(`  failed to queue track ${cmmpTrackId} on zone ${localZoneId}:`, err.message);
      }
    }

    // A zone playing a track it is no longer assigned keeps playing it
    // until that track ends, so move it onto its new playlist now.
    try {
      const zone = await local.getZone(localZoneId);
      if (zone && zone.currentTrackId && !wantedLocalIds.has(zone.currentTrackId)) {
        const first = (await local.getZonePlaylist(localZoneId)).tracks[0];
        if (first && String(zone.status || "").toLowerCase() === "playing") {
          await local.playTrack(localZoneId, first.trackId);
          log(`  zone ${localZoneId} moved onto its newly assigned playlist`);
        } else if (!first) {
          await local.stop(localZoneId);
          log(`  zone ${localZoneId} stopped — nothing assigned to it any more`);
        }
      }
    } catch (err) {
      log.warn(`  could not re-point zone ${localZoneId} after reassignment:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Track sync — a real download into the local library plus a real
// rescan, not a "mark as cached" flip.
// ---------------------------------------------------------------------------

function extensionFor(contentType, url, fallback = ".mp3") {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("mpeg") || ct.includes("mp3")) return ".mp3";
  if (ct.includes("wav")) return ".wav";
  if (ct.includes("ogg")) return ".ogg";
  if (ct.includes("flac")) return ".flac";
  if (ct.includes("aac")) return ".m4a";
  const fromUrl = path.extname(new URL(url).pathname);
  return /^\.[a-z0-9]{2,4}$/i.test(fromUrl) ? fromUrl : fallback;
}

/**
 * Filenames are the only metadata the local library scan is guaranteed
 * to see (uploads often carry no ID3 tags), so name each file
 * "Artist - Title" rather than the raw CMMP id — otherwise every synced
 * song shows up in the local Setup UI and on the zone queue as an
 * opaque `cmtms0ndc000xtxks08cxij6y`.
 */
function fileNameFor(track, ext) {
  const clean = (s) =>
    String(s || "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
  const title = clean(track.title) || track.trackId;
  const artist = clean(track.artist);
  const base = artist && artist.toLowerCase() !== "unknown artist" ? `${artist} - ${title}` : title;
  return `${base.slice(0, 120)}${ext}`;
}

function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n++})${ext}`);
  }
  return candidate;
}

async function syncTracksOnce() {
  const state = getState();
  const result = await cmmp.syncTracks(state.cachedTrackIds);
  status.lastTrackSyncAt = new Date().toISOString();
  const toSync = Array.isArray(result.tracksToSync) ? result.tracksToSync : [];
  if (toSync.length === 0) return;

  log(`downloading ${toSync.length} track(s) queued for sync...`);
  const lib = await local.getLibrary().catch(() => null);
  const musicFolder = lib && lib.defaultMusicFolder;
  if (!musicFolder) {
    log.warn("could not determine the local music folder from /api/library — skipping downloads this cycle.");
    return;
  }

  let downloadedAny = false;
  for (const t of toSync) {
    try {
      const res = await fetch(t.url);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);

      // A 200 is not proof of audio. When the cloud's PUBLIC_API_URL still
      // holds a placeholder host, that hostname answers with somebody
      // else's page — a parked domain returns an HTML courtesy page with
      // status 200. Writing that to the music folder produces a silent,
      // unplayable "track" that is then reported back to the cloud as
      // successfully cached, so the fault surfaces as "the zone won't play"
      // rather than as the configuration error it is.
      const contentType = String(res.headers.get("content-type") || "").toLowerCase();
      if (contentType && !contentType.startsWith("audio/") && !contentType.startsWith("application/octet-stream")) {
        throw new Error(
          `${t.url.split("/media/")[0]} returned "${contentType}" instead of audio — ` +
            `set PUBLIC_API_URL on the cloud server to its real public address and restart the backend.`
        );
      }

      const ext = extensionFor(res.headers.get("content-type"), t.url);
      const dest = uniquePath(musicFolder, fileNameFor(t, ext));
      const buf = Buffer.from(await res.arrayBuffer());

      // Second guard, for a server that sends audio headers but no audio:
      // no real track is a few hundred bytes.
      if (buf.length < 16 * 1024) {
        throw new Error(`downloaded only ${buf.length} bytes — that is not a playable audio file, refusing to add it to the library.`);
      }

      // Scan once per track (not batched) so the before/after diff of
      // local track ids unambiguously identifies the local GUID this
      // CMMP track became — the local scan reports no such mapping.
      const before = await local.getTrackIds().catch(() => new Set());
      fs.writeFileSync(dest, buf);
      await local.scanLibrary();
      const after = await local.getTrackIds().catch(() => new Set());
      const newIds = [...after].filter((id) => !before.has(id));
      if (newIds.length === 1) {
        state.trackIdMap[t.trackId] = newIds[0];
      } else if (newIds.length > 1) {
        log.warn(`  ambiguous scan result for ${t.trackId} (${newIds.length} new local tracks) — mapping not recorded.`);
      } else {
        log.warn(`  local scan reported no new track for ${t.trackId} — it may already exist locally under another id.`);
      }

      if (!state.cachedTrackIds.includes(t.trackId)) state.cachedTrackIds.push(t.trackId);
      downloadedAny = true;
      log(`  downloaded "${t.title}" by ${t.artist} -> ${dest}`);
    } catch (err) {
      log.warn(`  failed to download track ${t.trackId} (${t.title}):`, err.message);
    }
  }
  saveState();

  if (downloadedAny) {
    // Report what just landed so CMMP shows CACHED_ON_SERVER without
    // waiting a full cycle...
    try {
      await cmmp.syncTracks(state.cachedTrackIds);
    } catch (err) {
      log.warn("follow-up tracks/sync report failed:", err.message);
    }
    // ...then push any playlist assignments that were waiting on them.
    try {
      await syncZonePlaylistsOnce();
    } catch (err) {
      log.warn("zone playlist sync after track sync failed:", err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Loop control
// ---------------------------------------------------------------------------

const tick = (fn, label) => async () => {
  try {
    await fn();
  } catch (err) {
    log.warn(`${label} error:`, err.message);
  }
};

function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
  hub.disconnect();
  status.running = false;
}

/**
 * Real per-zone shuffle.
 *
 * The cloud randomises the order a zone's queue is *built* in, but the
 * compiled MusicServer then auto-advances by index through that fixed
 * order for ever, so every pass sounds the same. There is no local API to
 * reorder its queue and no source to change its advance, so the advance is
 * pre-empted here: just before the playing track ends, the zone is told to
 * play the next track out of its own shuffle bag (lib/shuffle.js) instead.
 *
 * Pre-empting rather than correcting afterwards matters — reacting to the
 * service's advance once it has happened would play a second of the wrong
 * track first, which is exactly what "sounds broken" means to an operator.
 *
 * Zones with fewer than two tracks are left alone: there is nothing to
 * shuffle, and the service's own repeat is already correct.
 */
const SHUFFLE_LEAD_SECONDS = 2;
/** zoneId -> the trackId we have already advanced away from, so a slow
 *  service state update cannot make us fire twice for one track. */
const shuffleAdvanced = new Map();

async function advanceShuffleOnce() {
  const zones = await local.getZones();
  shuffle.prune(zones.map((z) => z.zoneId));

  for (const zone of zones) {
    if (zone.status !== "Playing" || !zone.currentTrackId) {
      shuffleAdvanced.delete(zone.zoneId);
      continue;
    }

    let tracks;
    try {
      tracks = (await local.getZonePlaylist(zone.zoneId)).tracks || [];
    } catch {
      continue; // transient local API error; the next tick retries
    }
    if (tracks.length < 2) continue;

    const current = tracks.find((t) => t.trackId === zone.currentTrackId);
    const duration = Number(current && current.durationSeconds) || 0;
    const position = Number(zone.positionSeconds) || 0;
    if (!current || duration <= 0) continue;

    if (shuffleAdvanced.get(zone.zoneId) === zone.currentTrackId) continue;

    if (position < duration - SHUFFLE_LEAD_SECONDS) {
      // Mid-track. Record what is playing so a bag refill landing on this
      // track does not repeat it across the seam between two passes.
      shuffle.notePlayed(zone.zoneId, zone.currentTrackId);
      continue;
    }

    const pick = shuffle.nextTrackId(
      zone.zoneId,
      tracks.map((t) => t.trackId)
    );
    if (!pick || pick === zone.currentTrackId) continue;

    shuffleAdvanced.set(zone.zoneId, zone.currentTrackId);
    await local.playTrack(zone.zoneId, pick);
    log(`shuffle: zone ${zone.zoneId} -> ${pick}`);
  }
}

async function start() {
  if (status.running) return;
  const state = getState();
  if (!state.agentToken) throw new Error("Not paired — pair this server before starting the sync loops.");

  status.running = true;
  const heartbeatMs = (state.heartbeatIntervalSeconds || env.defaultHeartbeatSec) * 1000;

  await tick(heartbeatOnce, "heartbeat")();
  await tick(syncZonePlaylistsOnce, "zone playlist sync")();

  timers.push(setInterval(tick(heartbeatOnce, "heartbeat"), heartbeatMs));
  timers.push(setInterval(tick(pollCommandsOnce, "command poll"), env.commandPollMs));
  // Best-effort push channel. The poll above stays authoritative; this only
  // removes the poll interval from the cloud's ack-timeout budget.
  hub.connect(tick(pollCommandsOnce, "command push"));
  timers.push(setInterval(tick(syncTracksOnce, "track sync"), env.trackSyncMs));
  // Independent of track sync, so assigning a playlist made of already
  // cached tracks doesn't wait on a new download to be pushed.
  timers.push(setInterval(tick(syncZonePlaylistsOnce, "zone playlist sync"), env.trackSyncMs));
  // Fast, because it has to fire inside the last seconds of a track.
  timers.push(setInterval(tick(advanceShuffleOnce, "shuffle advance"), 1000));

  log(
    `Running. Heartbeat every ${heartbeatMs / 1000}s, command poll every ${env.commandPollMs / 1000}s, track sync every ${env.trackSyncMs / 1000}s.`
  );
}

module.exports = {
  status,
  start,
  stop,
  heartbeatOnce,
  pollCommandsOnce,
  advanceShuffleOnce,
  syncTracksOnce,
  syncZonePlaylistsOnce,
  executeCommand,
};
