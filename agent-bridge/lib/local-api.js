"use strict";

/**
 * Client for the local MusicServer's own REST API (default
 * http://127.0.0.1:8765/api) — the same surface its built-in Setup UI
 * drives, so every action here produces genuine LibVLC playback on this
 * machine.
 *
 * The local API's per-zone transport action set is fixed by the compiled
 * service and is, verbatim: play, resume, pause, stop, skip, volume,
 * mute, unmute. There is **no** `previous` (it 404s with `Unknown
 * action: previous`) and `skip` 503s with "No next song in this zone's
 * playlist." once the zone reaches the end of its queue. Both gaps are
 * closed here, in the agent, by driving `play` with an explicit trackId
 * chosen from the zone's own ordered playlist — see `previous()` /
 * `next()` below.
 *
 * Zone lifecycle (`POST /zones`, `DELETE /zones/:id`) and `GET /devices`
 * are real endpoints too — confirmed by reading the local service's own
 * Setup UI (its "Create zone" form and per-zone Delete button call
 * exactly these) — see `createZone()` / `deleteZone()` below.
 */

const { env } = require("./config");
const eqApo = require("./eq-apo");

async function request(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${env.localApiUrl}${pathname}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
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
    const msg = (data && (data.error || data.message)) || res.statusText;
    const err = new Error(`local ${method} ${pathname} -> ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const zonePath = (zoneId, suffix = "") => `/zones/${encodeURIComponent(zoneId)}${suffix}`;

async function getZones() {
  const data = await request("/zones");
  return Array.isArray(data.zones) ? data.zones : [];
}

async function getZone(zoneId) {
  const zones = await getZones();
  return zones.find((z) => z.zoneId === zoneId) || null;
}

async function getTracks(limit = 1000) {
  const tracks = await request(`/tracks?limit=${limit}`);
  return Array.isArray(tracks) ? tracks : [];
}

async function getTrackIds() {
  return new Set((await getTracks()).map((t) => t.id));
}

/** A zone's own local queue, ordered by the local API's `position`. */
async function getZonePlaylist(zoneId) {
  const playlist = await request(zonePath(zoneId, "/playlist"));
  const tracks = (playlist.tracks || []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return { ...playlist, tracks };
}

async function getZonePlaylistTrackIds(zoneId) {
  return new Set((await getZonePlaylist(zoneId)).tracks.map((t) => t.trackId));
}

const getLibrary = () => request("/library");
const getHealth = () => request("/health");
const getDevices = () => request("/devices").then((d) => (Array.isArray(d.devices) ? d.devices : []));
const scanLibrary = () => request("/library/scan", { method: "POST" });

/** Creates a zone on the local service — the same call its own Setup UI
 * makes from "Create zone". `audioDeviceId` may be omitted/null to use
 * the machine's default output device. */
const createZone = (zoneId, name, audioDeviceId) =>
  request("/zones", { method: "POST", body: { zoneId, name, audioDeviceId: audioDeviceId || null } });

/** Deletes a zone and its local playlist. Irreversible on the local side —
 * callers should confirm with the operator before calling this. */
const deleteZone = (zoneId) => request(zonePath(zoneId), { method: "DELETE" });

const action = (zoneId, name, body) => request(zonePath(zoneId, `/${name}`), { method: "POST", body });

const pause = (zoneId) => action(zoneId, "pause");
const stop = (zoneId) => action(zoneId, "stop");
const mute = (zoneId) => action(zoneId, "mute");
const unmute = (zoneId) => action(zoneId, "unmute");
const setVolume = (zoneId, volume) => action(zoneId, "volume", { volume });
const playTrack = (zoneId, trackId) => action(zoneId, "play", { trackId });
/**
 * Applies a 10-band equalizer curve to this zone's own output.
 *
 * The compiled MusicServer has no audio-processing surface: `POST
 * /zones/:id/eq` answers 404, as do equalizer/dsp/effects. So the curve is
 * applied one layer down, at the Windows output device this zone is bound
 * to, via Equalizer APO (see lib/eq-apo.js). The local `eq` action is still
 * tried first so the very next MusicServer build that adds one takes over
 * automatically, with no change here.
 */
async function setEqualizer(zoneId, settings) {
  try {
    return await action(zoneId, "eq", settings);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  const zones = await getZones();
  const zone = zones.find((z) => z.zoneId === zoneId);
  const applied = await eqApo.applyZoneEqualizer(zone, settings);
  const pruned = await eqApo.pruneStaleZones(zones.map((z) => z.zoneId));
  return { applied: "equalizer-apo", ...applied, ...(pruned.length ? { pruned } : {}) };
}

const queueTrack = (zoneId, trackId) => request(zonePath(zoneId, "/playlist/tracks"), { method: "POST", body: { trackId, zoneName: zoneId } });

/** Removes one entry from a zone's own queue. Keyed by the queue entry's
 * `id` (not its `trackId`) — the same call the local Setup UI's per-track
 * remove button makes. */
const unqueueTrack = (zoneId, itemId) =>
  request(zonePath(zoneId, `/playlist/tracks/${encodeURIComponent(itemId)}`), { method: "DELETE" });

/**
 * Index of the zone's current track within its own queue, or -1.
 * `zone` may be omitted (it is then read).
 */
async function positionInQueue(zoneId, zone) {
  const [z, playlist] = await Promise.all([zone ? Promise.resolve(zone) : getZone(zoneId), getZonePlaylist(zoneId)]);
  const tracks = playlist.tracks;
  const index = z && z.currentTrackId ? tracks.findIndex((t) => t.trackId === z.currentTrackId) : -1;
  return { tracks, index, zone: z };
}

/**
 * PLAY. Four real outcomes against the local API:
 *  1. a track from this zone's *current* queue is loaded (paused
 *     mid-track) -> `resume`
 *  2. a track is loaded but is no longer in the queue — the zone was
 *     reassigned to another playlist while that track sat loaded -> play
 *     the new queue's first track explicitly, never resume the old one
 *  3. nothing loaded but the zone's queue has tracks -> `play` (the local
 *     player starts from its own queue); if the service still refuses a
 *     bare play, fall back to an explicit first-track play
 *  4. nothing loaded and an empty queue -> a real, actionable failure
 */
async function play(zoneId) {
  const zone = await getZone(zoneId);
  const { tracks } = await positionInQueue(zoneId, zone);
  const loaded = zone && zone.currentTrackId;
  if (loaded && tracks.some((t) => t.trackId === zone.currentTrackId)) return action(zoneId, "resume");

  if (tracks.length === 0) {
    throw new Error(
      "No track assigned to this zone yet — assign a playlist in CMMP and wait for it to sync to this server."
    );
  }
  if (loaded) return playTrack(zoneId, tracks[0].trackId);
  try {
    return await action(zoneId, "play");
  } catch {
    return playTrack(zoneId, tracks[0].trackId);
  }
}

/**
 * NEXT. Prefers the local `skip` action so the service's own queue
 * bookkeeping stays authoritative, and falls back to an explicit
 * play of the following queue entry (wrapping at the end) when `skip`
 * refuses — which it does with 503 "No next song in this zone's
 * playlist." on the last track, and whenever nothing is loaded.
 */
async function next(zoneId) {
  try {
    return await action(zoneId, "skip");
  } catch (skipErr) {
    const { tracks, index } = await positionInQueue(zoneId);
    if (tracks.length === 0) throw skipErr;
    const target = tracks[index === -1 ? 0 : (index + 1) % tracks.length];
    return playTrack(zoneId, target.trackId);
  }
}

/**
 * PREVIOUS. The local service has no `previous` action at all, so this
 * is resolved entirely from the zone's ordered queue: step back one
 * entry from the current track (wrapping to the last entry when the
 * current track is the first, or is unknown) and play it explicitly.
 */
async function previous(zoneId) {
  const { tracks, index } = await positionInQueue(zoneId);
  if (tracks.length === 0) {
    throw new Error(
      "No track assigned to this zone yet — assign a playlist in CMMP and wait for it to sync to this server."
    );
  }
  const target = tracks[index <= 0 ? tracks.length - 1 : index - 1];
  return playTrack(zoneId, target.trackId);
}

/** Local status strings -> CMMP `ZonePlaybackState`. */
function toCmmpPlaybackState(status) {
  switch (String(status || "").toLowerCase()) {
    // "Buffering"/"Opening" are transient states the local player reports
    // while a track is loading — the zone is starting, not stopped.
    case "playing":
    case "buffering":
    case "opening":
      return "PLAYING";
    case "paused":
      return "PAUSED";
    case "idle":
    case "stopped":
      return "STOPPED";
    case "deviceunavailable":
      return "OFFLINE";
    default:
      return "STOPPED";
  }
}

module.exports = {
  request,
  getZones,
  getZone,
  getTracks,
  getTrackIds,
  getZonePlaylist,
  getZonePlaylistTrackIds,
  unqueueTrack,
  getLibrary,
  getHealth,
  getDevices,
  scanLibrary,
  createZone,
  deleteZone,
  queueTrack,
  play,
  pause,
  stop,
  next,
  previous,
  mute,
  unmute,
  setVolume,
  setEqualizer,
  playTrack,
  toCmmpPlaybackState,
};
