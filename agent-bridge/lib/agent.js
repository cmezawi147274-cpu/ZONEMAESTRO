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
const { execFile } = require("node:child_process");

const { env, getState, saveState, resetState, clearLibraryState, cmmpTrackIdOf } = require("./config");
const { log } = require("./log");
const cmmp = require("./cmmp");
const local = require("./local-api");
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

/**
 * Reads C:\ProgramData\MusicServer\auto-boot.json for the heartbeat.
 * Missing/unreadable/malformed -> treated as {"enabled":true}, matching
 * the default-ON behavior SETUP establishes and what Set-AutoBoot.ps1 and
 * the Windows side agree on.
 */
function readAutoBootEnabled() {
  try {
    const parsed = JSON.parse(fs.readFileSync(env.autoBootConfigFile, "utf8"));
    return typeof parsed.enabled === "boolean" ? parsed.enabled : true;
  } catch {
    return true;
  }
}

/**
 * Runs Set-AutoBoot.ps1, the single owner of auto-boot.json's schema and
 * of the elevated changes it drives (service start type, scheduled tasks,
 * startup shortcut) once the SYSTEM "Music Server AutoBoot Apply" task
 * next reconciles it. This agent runs without admin rights, so "On"/"Off"
 * here only ever writes the JSON — never a service or task directly.
 */
function runAutoBootScript(action) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", env.autoBootScript, "-Action", action],
      { windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr && stderr.trim()) || err.message));
        resolve(stdout);
      }
    );
  });
}

/**
 * Starts a SYSTEM scheduled task registered by the (elevated) installer.
 * This is how the non-admin agent reaches privileged work — the same
 * pattern Auto boot uses. A missing task fails loudly rather than being
 * mistaken for success.
 */
function runScheduledTask(taskName) {
  return new Promise((resolve, reject) => {
    execFile("schtasks.exe", ["/Run", "/TN", taskName], { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr && stderr.trim()) || (stdout && stdout.trim()) || err.message;
        return reject(
          new Error(
            `Could not start the "${taskName}" scheduled task — re-run the elevated installer on this PC so it exists. (${detail})`
          )
        );
      }
      resolve(stdout);
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for the local MusicServer API to report its playback host back up.
 * `/health` and `playbackHostOnline` are the same surface the bridge's own
 * control panel reads (ui/server.js), so this asks the machine what really
 * happened instead of assuming the task succeeded.
 */
async function waitForPlaybackHost(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response yet";
  // The service needs a moment to drop before it comes back; polling
  // instantly would see the *old* process still reporting healthy.
  await wait(2000);
  while (Date.now() < deadline) {
    try {
      const health = await local.getHealth();
      if (health && health.playbackHostOnline) return true;
      lastError = "playback host still offline";
    } catch (err) {
      lastError = err.message;
    }
    await wait(1500);
  }
  throw new Error(`Playback did not come back within ${Math.round(timeoutMs / 1000)}s (${lastError}).`);
}

/**
 * This PC's own IANA timezone, e.g. "Asia/Dubai". Prayer Mode fires on the
 * venue's clock, so the cloud needs the venue's zone rather than its own —
 * see backend/src/lib/prayer-scheduler.ts.
 */
function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Coordinates, but only when this machine genuinely knows them (set
 * explicitly in .env by an installer who had a real fix). Nothing is
 * guessed here: with no coordinates the cloud looks the venue's city up
 * instead, and 0,0 is never reported as a location.
 */
function knownCoordinates() {
  const latitude = Number(env.venueLatitude);
  const longitude = Number(env.venueLongitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return {};
  if (latitude === 0 && longitude === 0) return {};
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return {};
  return { latitude, longitude };
}

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
      autoBootEnabled: readAutoBootEnabled(),
      timezone: localTimeZone(),
      ...knownCoordinates(),
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
  SYNC_CONFIG: async (payload) => {
    // Cloud -> local zone delete (Task 1 — no new CommandType, this rides
    // on SYNC_CONFIG's existing payload). Best-effort: a zone already gone
    // locally (or never created here) 404s, which is logged, not thrown —
    // the cloud row is already deleted regardless of what this machine
    // does with it.
    const targets = [];
    if (payload && typeof payload.deleteLocalZoneId === "string") targets.push(payload.deleteLocalZoneId);
    if (payload && Array.isArray(payload.deleteLocalZoneIds)) {
      for (const id of payload.deleteLocalZoneIds) {
        if (typeof id === "string") targets.push(id);
      }
    }
    for (const localZoneId of targets) {
      try {
        await local.deleteZone(localZoneId);
        log(`SYNC_CONFIG: deleted local zone ${localZoneId}`);
      } catch (err) {
        log.warn(`SYNC_CONFIG: could not delete local zone ${localZoneId}:`, err.message);
      }
    }
    await syncZonePlaylistsOnce();
    await heartbeatOnce();
  },
  /**
   * Restart playback only — never the machine.
   *
   * The agent has no admin rights, so the actual work (restart the
   * MusicServer service, restart MusicServer.PlaybackHost.exe) lives in a
   * SYSTEM task the elevated installer registers. This triggers it and then
   * waits for the local API to confirm playback is genuinely back, so a
   * SUCCESS ack means the venue is playing again rather than "the task was
   * launched". postgresql-x64-17 and this bridge process are untouched.
   */
  RESTART_SERVICE: async () => {
    await runScheduledTask(env.restartPlaybackTask);
    await waitForPlaybackHost(env.restartPlaybackTimeoutMs);
  },
  REBOOT_SERVER: async () => {
    throw new Error("This agent cannot reboot the machine — reboot it locally.");
  },
  SET_AUTO_BOOT: async (payload) => {
    const enabled = !payload || typeof payload.enabled !== "boolean" || payload.enabled;
    await runAutoBootScript(enabled ? "On" : "Off");
  },
  /**
   * "Forget Server" — make this PC look like it was never a venue player.
   *
   * The Windows-side half is Set-AutoBoot.ps1 `-Action Forget` (the same
   * script, task names and shortcut Auto Boot already uses — there is no
   * second auto-start mechanism): stop the MusicServer service, kill
   * MusicServer.PlaybackHost / MusicServer.Service / MusicServer.Api, set
   * the service to Manual, disable the three scheduled tasks, remove the
   * All Users Startup shortcut, then delete auto-boot.json. It never
   * reboots the PC, never touches postgresql-x64-17, and never uninstalls
   * Program Files\Music Server.
   *
   * Clearing this agent's own pairing is deferred to the returned callback
   * because CMMP only deletes the cloud row once it has our SUCCESS ack —
   * and that ack still needs the token this callback throws away.
   */
  FORGET_SERVER: async () => {
    await runAutoBootScript("Forget");
    return () => {
      clearLibraryState();
      resetState();
      stop();
      log("FORGET_SERVER: local pairing and cached-track bookkeeping cleared, cloud link stopped.");
    };
  },
};

async function executeCommand(cmd) {
  const { commandId, type, zoneId, payload } = cmd;

  const serverHandler = SERVER_HANDLERS[type];
  if (serverHandler) {
    try {
      const afterAck = await serverHandler(payload);
      await ack(commandId, "SUCCESS");
      log(`command ${type} -> SUCCESS`);
      // A handler may hand back work that can only run once the ack is in —
      // FORGET_SERVER discards the very token `ack` authenticates with. It
      // cannot un-ack the command, so a failure here is logged, not re-acked.
      if (typeof afterAck === "function") {
        try {
          await afterAck();
        } catch (err) {
          log.warn(`command ${type} post-ack step failed:`, err.message);
        }
      }
    } catch (err) {
      log.warn(`command ${type} -> FAILED:`, err.message);
      await ack(commandId, "FAILED", err.message);
    }
    return;
  }

  // Classify before complaining. A server-level command that this build
  // doesn't know must not be reported as a *zone* problem — that misdiagnosis
  // is what made "Forget Server" look like a missing zone rather than a
  // missing handler.
  const handler = HANDLERS[type];
  if (!handler) {
    await ack(commandId, "FAILED", `Unsupported command type: ${type}`);
    return;
  }
  if (!zoneId) {
    await ack(commandId, "FAILED", "No zone associated with this command.");
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
//
// Schedules (Task 4) layer on top of this same reconciliation rather than
// running a second one: when a time slot's window is active for a zone
// right now, its playlist wins over whatever the cloud has as that zone's
// "current" playlist. "Now" is this machine's own wall clock — the venue
// PC genuinely is at the venue, the same assumption the cloud already
// relies on when a heartbeat's reportedTimezone stands in for the venue's
// clock (see backend/src/lib/prayer-location.ts).
// ---------------------------------------------------------------------------

/** MON..SUN, index-matched to Date#getDay() (0 = Sunday), and to exactly
 * the strings backend DAYS_OF_WEEK / Schedule.days use (src/lib/constants.ts) —
 * so a schedule's `days` array can be compared to today with no translation. */
const DAY_ABBREVIATIONS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The winning schedule per localZoneId, right now. A slot competes only
 * when today is one of its `days` and the current time falls in
 * [startTime, endTime); among competitors for the same zone (two
 * overlapping slots), the higher `priority` wins.
 */
function activeScheduleWinners(schedules) {
  const hhmm = nowHHMM();
  const today = DAY_ABBREVIATIONS[new Date().getDay()];
  const winners = new Map();
  for (const s of schedules || []) {
    if (!s.localZoneId || !s.startTime || !s.endTime) continue;
    if (!Array.isArray(s.days) || !s.days.includes(today)) continue;
    if (!(s.startTime <= hhmm && hhmm < s.endTime)) continue;
    const current = winners.get(s.localZoneId);
    if (!current || (s.priority ?? 0) > (current.priority ?? 0)) winners.set(s.localZoneId, s);
  }
  return winners;
}

/** Reconciles one zone's local queue to an exact wanted track list. Shared
 * by both sources that can assign a zone tracks: the cloud's own
 * current-playlist sync, and a schedule slot that has taken over. */
async function applyZoneTrackList(localZoneId, trackIds, excludedTrackIds) {
  const state = getState();
  const wanted = (trackIds || []).filter((id) => !(excludedTrackIds || []).includes(id));
  // CMMP track ids the agent has actually cached locally, as local ids.
  const wantedLocalIds = new Set(wanted.map((cmmpTrackId) => state.trackIdMap[cmmpTrackId]).filter(Boolean));

  let queue;
  try {
    queue = (await local.getZonePlaylist(localZoneId)).tracks;
  } catch (err) {
    log.warn(`could not read local playlist for zone ${localZoneId}:`, err.message);
    return;
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

async function syncZonePlaylistsOnce() {
  const { zonePlaylists } = await cmmp.syncZonePlaylists();

  let scheduleWinners = new Map();
  try {
    const { schedules } = await cmmp.getSchedules();
    scheduleWinners = activeScheduleWinners(schedules);
  } catch (err) {
    log.warn("could not fetch schedules — zones keep their last-known playlist:", err.message);
  }

  const byLocalZoneId = new Map((zonePlaylists || []).filter((zp) => zp.localZoneId).map((zp) => [zp.localZoneId, zp]));
  // Union, not just the cloud's list: a zone assigned nothing but a
  // schedule (never manually given a "current" playlist) still needs to
  // play at its slot's start.
  const allLocalZoneIds = new Set([...byLocalZoneId.keys(), ...scheduleWinners.keys()]);

  for (const localZoneId of allLocalZoneIds) {
    const winner = scheduleWinners.get(localZoneId);
    const base = byLocalZoneId.get(localZoneId);
    if (winner) {
      await applyZoneTrackList(localZoneId, winner.trackIds, winner.excludedTrackIds);
    } else if (base && base.playlistId) {
      await applyZoneTrackList(localZoneId, base.trackIds, base.excludedTrackIds);
    }
    // Neither a winning schedule nor a cloud-assigned playlist: nothing to
    // reconcile, same as the original "continue" — this zone's local
    // queue is not the cloud's to clear.
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
      const ext = extensionFor(res.headers.get("content-type"), t.url);
      const dest = uniquePath(musicFolder, fileNameFor(t, ext));
      const buf = Buffer.from(await res.arrayBuffer());

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
  syncTracksOnce,
  syncZonePlaylistsOnce,
  executeCommand,
};
