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
const shuffle = require("./shuffle");

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
// Continuous playback state
//
// zoneId -> true while this agent itself just stopped the zone on purpose
// (an explicit STOP command, or applyZoneTrackList clearing an unassigned
// zone's queue). Consumed by the very next advancePlaybackOnce() poll, so a
// genuine end-of-track still advances normally but an operator's Stop is
// never mistaken for one and auto-resumed.
// ---------------------------------------------------------------------------
const expectedStops = new Set();

// zoneId -> whether the previous poll saw this zone actually playing.
// advancePlaybackOnce() only ever fires on a PLAYING -> STOPPED edge.
const wasPlaying = new Map();

// ---------------------------------------------------------------------------
// Schedule repeat state (Schedule.repeat)
//
// localZoneId -> true while the schedule currently winning for that zone
// (or a plain cloud-assigned playlist with no schedule involved at all)
// should keep looping forever once its queue has played through once.
// false means "stop after one full pass" — set only while a non-repeating
// schedule slot is the winner. Populated by syncZonePlaylistsOnce, read by
// advancePlaybackOnce; absent (not yet observed) defaults to looping, the
// same as before this feature existed.
// ---------------------------------------------------------------------------
const zoneRepeatMode = new Map();

// localZoneId -> the Schedule.id currently winning for that zone, or null.
// Exists only to detect a *transition* (a window opening or closing) from
// one syncZonePlaylistsOnce cycle to the next — see its use below for why
// that, and not just "is there a winner right now", is what actually
// triggers a fresh pass count or a forced stop.
const zoneScheduleWinnerId = new Map();

// localZoneId -> { signature, ids: Set<localTrackId> } — which tracks have
// played since the current non-repeating pass began. Reset whenever the
// queue's contents change (a new `signature`) or a new schedule window
// begins (see zoneScheduleWinnerId). Only consulted for zones currently in
// zoneRepeatMode === false; harmless if stale otherwise.
const passHeard = new Map();

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
  // See lib/local-api.js `setEqualizer` for the honest caveat: this 404s
  // against today's compiled builds (no local `eq` action yet), which
  // executeCommand() below acks FAILED with a real error message rather
  // than a fake SUCCESS.
  SET_EQ: (zoneId, payload) => local.setEqualizer(zoneId, payload || {}),
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
  // Keeps the shuffle bag's "what just played" pointer in sync whenever a
  // command lands the zone on a specific track (PLAY/NEXT/PREVIOUS) — so
  // advancePlaybackOnce() never immediately redraws the track an operator
  // (or applyZoneTrackList) just chose by some other path. Harmless no-op
  // for commands that don't change the track (PAUSE, volume, ...).
  shuffle.notePlayed(zoneId, zone.currentTrackId);
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
    // An operator's own Stop — advancePlaybackOnce() must not mistake the
    // STOPPED it causes for a track that just ended and resume playback.
    if (type === "STOP") expectedStops.add(zoneId);
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
 * when the current time falls inside [startTime, endTime) on one of its
 * `days`; among competitors for the same zone (two overlapping slots), the
 * higher `priority` wins.
 *
 * A slot whose endTime is *earlier* than its startTime wraps past midnight
 * — "22:00" to "02:00" is a late-night set, not a typo. Comparing
 * "HH:MM" strings is chronological only within one day, so the old single
 * test (`startTime <= now && now < endTime`) could never be true for such a
 * slot at any instant: at 23:30 the second half fails, at 01:00 the first
 * does. Every overnight schedule silently never played, and nothing on
 * either side rejects one — the portal saves it and shows it as enabled.
 *
 * A wrapping slot's two halves fall on different calendar days, and that
 * matters for the `days` test: the evening half runs on the day the
 * operator actually picked, while the early-morning half is the tail of the
 * *previous* day's slot. So the morning half is matched against yesterday —
 * otherwise a MON 22:00-02:00 slot would also play during Monday's own
 * small hours, which is Sunday night's slot, not Monday's.
 *
 * Equal start and end times are left alone deliberately: they stay in the
 * non-wrapping branch and never match, exactly as before.
 */
function activeScheduleWinners(schedules) {
  const now = new Date();
  const hhmm = nowHHMM();
  const today = DAY_ABBREVIATIONS[now.getDay()];
  const yesterday = DAY_ABBREVIATIONS[(now.getDay() + 6) % 7];
  const winners = new Map();
  for (const s of schedules || []) {
    if (!s.localZoneId || !s.startTime || !s.endTime) continue;
    if (!Array.isArray(s.days)) continue;
    const wraps = s.endTime < s.startTime;
    const active = wraps
      ? (hhmm >= s.startTime && s.days.includes(today)) ||
        (hhmm < s.endTime && s.days.includes(yesterday))
      : hhmm >= s.startTime && hhmm < s.endTime && s.days.includes(today);
    if (!active) continue;
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
        // This bypasses readBackZoneState (no command is being acked here),
        // so tell the shuffle bag directly — otherwise the first natural
        // end-of-track after a reassignment could immediately redraw the
        // very track this reassignment just started.
        shuffle.notePlayed(localZoneId, first.trackId, Array.from(wantedLocalIds));
        log(`  zone ${localZoneId} moved onto its newly assigned playlist`);
      } else if (!first) {
        expectedStops.add(localZoneId);
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
  // play at its slot's start. zoneScheduleWinnerId's own keys are
  // included too — a zone whose only schedule just stopped winning (its
  // window closed) has neither a base playlist nor a current winner, so
  // it would otherwise drop out of this set entirely and never get
  // visited to detect that transition and enforce the end boundary below.
  const allLocalZoneIds = new Set([...byLocalZoneId.keys(), ...scheduleWinners.keys(), ...zoneScheduleWinnerId.keys()]);

  for (const localZoneId of allLocalZoneIds) {
    const winner = scheduleWinners.get(localZoneId);
    const base = byLocalZoneId.get(localZoneId);

    // Two separate *transition* checks, not just "is one winning right
    // now" — syncZonePlaylistsOnce re-applies the same winner every ~20s
    // regardless of whether anything changed, and re-triggering a start or
    // a pass-count reset on every one of those cycles would fight an
    // operator's own Stop/Pause the same way an unconditional restart
    // would.
    //
    //  - enteringWindow: this schedule just became the winner — including
    //    the agent having just started mid-window (previousWinnerId
    //    `undefined`, e.g. after a crash or update), which must still
    //    start a stopped zone rather than waiting for tomorrow's
    //    open/close cycle.
    //  - leavingWindow: a schedule that *was* winning no longer is.
    //    Deliberately excludes `undefined -> null` (never observed before,
    //    still no winner) — with no prior observation there is no way to
    //    tell "a window just closed" from "this zone was never under a
    //    schedule", and the latter must not be force-stopped (its queue is
    //    not the cloud's to clear).
    const winnerId = winner ? winner.id : null;
    const previousWinnerId = zoneScheduleWinnerId.has(localZoneId) ? zoneScheduleWinnerId.get(localZoneId) : undefined;
    const enteringWindow = winnerId !== null && winnerId !== previousWinnerId;
    const leavingWindow = winnerId === null && previousWinnerId !== undefined && previousWinnerId !== null;
    zoneScheduleWinnerId.set(localZoneId, winnerId);
    if (enteringWindow) passHeard.delete(localZoneId);

    if (winner) {
      await applyZoneTrackList(localZoneId, winner.trackIds, winner.excludedTrackIds);
      zoneRepeatMode.set(localZoneId, winner.repeat === true);
      // A slot *starting* must start a stopped zone, not just update its
      // queue and leave it silent until a human presses Play.
      // applyZoneTrackList only ever re-points a zone already playing.
      if (enteringWindow) await startZoneForNewWindow(localZoneId);
    } else if (base && base.playlistId) {
      await applyZoneTrackList(localZoneId, base.trackIds, base.excludedTrackIds);
      zoneRepeatMode.set(localZoneId, true);
    } else if (leavingWindow) {
      // The schedule that just lost the zone was its only assignment: its
      // end time is a real boundary, not a suggestion. Clear the queue and
      // stop rather than leaving the expired slot's tracks playing
      // indefinitely — applyZoneTrackList's own "nothing assigned" branch
      // marks this as an expected stop.
      await applyZoneTrackList(localZoneId, [], []);
      zoneRepeatMode.delete(localZoneId);
    }
    // Neither a winning schedule nor a cloud-assigned playlist, and no
    // window just closed: nothing to reconcile, same as the original
    // "continue" — this zone's local queue was never the cloud's to clear.
  }
}

/** Starts a zone that isn't already playing, for a schedule slot that just
 * became this zone's winner. local.play() picks up whatever
 * applyZoneTrackList just queued; which exact track it lands on is read
 * back so the shuffle bag's bookkeeping is correct from the first track,
 * not just from the first *auto-advanced* one. */
async function startZoneForNewWindow(localZoneId) {
  try {
    const zone = await local.getZone(localZoneId);
    if (!zone || String(zone.status || "").toLowerCase() === "playing") return;
    await local.play(localZoneId);
    const [started, playlist] = await Promise.all([local.getZone(localZoneId), local.getZonePlaylist(localZoneId)]);
    if (started && started.currentTrackId) {
      // The (local) queue, so notePlayed can seed the shuffle bag's
      // `remaining` properly — excluding this track outright, not just
      // deprioritizing it — which is what lets a non-repeating schedule's
      // "every track heard once" check land on exactly one pass. See
      // shuffle.js notePlayed().
      const localTrackIds = playlist.tracks.map((t) => t.trackId);
      shuffle.notePlayed(localZoneId, started.currentTrackId, localTrackIds);
    }
    log(`  zone ${localZoneId} started for its newly active schedule slot`);
  } catch (err) {
    log.warn(`  could not start zone ${localZoneId} for its new schedule slot:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Continuous playback — the compiled MusicServer does not auto-advance its
// own queue: a zone goes idle when a track ends instead of starting the
// next one, so without this every playlist needed a human on NEXT after
// every single song.
//
// One interval for the whole process, never per zone: each tick is one
// cheap local GET (127.0.0.1) per zone, and only a zone whose track just
// ended (a PLAYING -> STOPPED edge this agent did not itself cause — see
// `expectedStops`) does any further work. No cloud call is made here; the
// cloud learns the new current track on the next regular heartbeat/zone
// sync, same as any other locally-driven playback change.
//
// Draws from shuffle.js's per-zone shuffle bag rather than sequential
// order, so an auto-advanced pass matches the shuffle the cloud already
// randomises the queue *build* order with, instead of playing the queue's
// raw position order back-to-back.
// ---------------------------------------------------------------------------

async function advancePlaybackOnce() {
  let zones;
  try {
    zones = await local.getZones();
  } catch (err) {
    log.warn("continuous playback poll failed:", err.message);
    return;
  }

  const liveZoneIds = zones.map((z) => z.zoneId);
  shuffle.prune(liveZoneIds);
  const live = new Set(liveZoneIds);
  for (const zoneId of expectedStops) if (!live.has(zoneId)) expectedStops.delete(zoneId);
  for (const zoneId of wasPlaying.keys()) if (!live.has(zoneId)) wasPlaying.delete(zoneId);
  for (const zoneId of zoneRepeatMode.keys()) if (!live.has(zoneId)) zoneRepeatMode.delete(zoneId);
  for (const zoneId of zoneScheduleWinnerId.keys()) if (!live.has(zoneId)) zoneScheduleWinnerId.delete(zoneId);
  for (const zoneId of passHeard.keys()) if (!live.has(zoneId)) passHeard.delete(zoneId);

  for (const z of zones) {
    const zoneId = z.zoneId;
    const state = local.toCmmpPlaybackState(z.status);
    const previouslyPlaying = wasPlaying.get(zoneId) === true;
    wasPlaying.set(zoneId, state === "PLAYING");

    if (state !== "STOPPED" || !previouslyPlaying) continue;
    // Consume the flag regardless of outcome: an expected stop is expected
    // exactly once, whether or not this zone even has a queue to advance.
    if (expectedStops.delete(zoneId)) continue;

    let queue;
    try {
      queue = (await local.getZonePlaylist(zoneId)).tracks;
    } catch (err) {
      log.warn(`  continuous playback: could not read zone ${zoneId}'s queue:`, err.message);
      continue;
    }
    const trackIds = queue.map((t) => t.trackId);
    if (trackIds.length < 2) continue; // nothing to advance to

    // Schedule.repeat === false: play through the queue once, then stop —
    // never restart the same playlist, and never past the schedule's own
    // end time (that boundary is enforced separately, in
    // syncZonePlaylistsOnce, which still runs on its own ~20s cycle
    // regardless of what this loop does). "Once" is tracked as "every
    // distinct track in the queue has played" rather than a fixed count,
    // so it survives the queue being rebuilt with the same tracks in a
    // different order.
    if (zoneRepeatMode.get(zoneId) === false) {
      const signature = trackIds.slice().sort().join("|");
      let heard = passHeard.get(zoneId);
      if (!heard || heard.signature !== signature) {
        heard = { signature, ids: new Set() };
        passHeard.set(zoneId, heard);
      }
      const justEnded = shuffle.peek(zoneId)?.lastPlayed;
      if (justEnded) heard.ids.add(justEnded);
      if (heard.ids.size >= trackIds.length) {
        log(`  zone ${zoneId}: playlist completed and Repeat is off — left stopped.`);
        continue;
      }
    }

    // Bounded, not infinite: at most one attempt per track in the queue,
    // so one broken file is skipped rather than wedging the zone, but a
    // zone whose whole queue is broken still gives up rather than
    // hammering the local API forever.
    let advanced = false;
    for (let attempt = 0; attempt < trackIds.length && !advanced; attempt++) {
      const candidate = shuffle.nextTrackId(zoneId, trackIds);
      if (!candidate) break;
      try {
        await local.playTrack(zoneId, candidate);
        log(`  zone ${zoneId} auto-advanced to the next track`);
        advanced = true;
      } catch (err) {
        log.warn(`  zone ${zoneId} could not play the next track, skipping it:`, err.message);
      }
    }
    if (!advanced) log.warn(`  zone ${zoneId}: no track in its queue would play — left stopped.`);
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
  // One interval for the whole process (never per zone) — see the
  // "Continuous playback" section above for why this is safe to run this
  // often: a no-op tick is a single local GET.
  timers.push(setInterval(tick(advancePlaybackOnce, "continuous playback"), env.playbackPollMs));

  log(
    `Running. Heartbeat every ${heartbeatMs / 1000}s, command poll every ${env.commandPollMs / 1000}s, track sync every ${env.trackSyncMs / 1000}s, playback poll every ${env.playbackPollMs / 1000}s.`
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
  advancePlaybackOnce,
  executeCommand,
};
