import fs from "node:fs"
import path from "node:path"
import { agentVersionStatus } from "./version.js"
import { repairOf, watchRun } from "./repeat-once-watch.js"

/**
 * Repeat off with a single song: play it once, then stop.
 *
 * The venue agent (kit lib/playback.js advanceZone) always replays a queue
 * that holds one song, whatever the schedule's Repeat setting says; with two
 * or more entries and Repeat off it plays to the last one and stops. So a
 * Repeat-off schedule whose playlist has exactly one playable song is served
 * to the venue with a short silent "end marker" after the song:
 * song -> silence -> stopped. What keeps that working every day (all found
 * on the agent, kit 2026.11.4):
 *
 *  - The agent starts a slot where it last left it (schedule cursors, keyed
 *    by the slot id). After a play-through that is the marker, so the next
 *    day would play only the silence. Each occurrence of the slot is
 *    therefore served as its own copy, with its own id and only its own
 *    weekday: a start has no saved position and begins at the song. One copy
 *    per weekday (a weekday can only be served once), so a venue that cannot
 *    reach the cloud keeps playing from its saved copies for 6 days. Copies
 *    move on in the middle of the slot's quiet hours.
 *  - The venue keeps queue entries between slots and starts from a loaded
 *    or queued-first track when it has no saved position. So each of a
 *    zone's runs gets the next of four markers in a fixed cycle (the run
 *    before always had another), and keeps it for its whole window. See
 *    expandZoneSlots.
 *  - With crossfade on, the song would fade into the marker. Crossfade is
 *    held off for that zone around such a run (see crossfadeHeld).
 *  - A slot keeps the id it had at its start until its end, so an edit
 *    during the slot (removing a silent track, Repeat toggled) does not make
 *    the venue start it again; one that becomes one-song mid-slot still gets
 *    the end marker, so its song does not go round again.
 *
 * lib/repeat-once-watch.ts watches each run, repairs a start that did not
 * happen, and raises Alerts. The markers are not Track rows (never in the
 * library, playlists, sync pages or counts); their audio is generated here.
 */

export const REPEAT_ONCE_MIN_AGENT_VERSION = "2026.11.4"

/** Same format as the operators' own working "Silence Short Wav" (44.1 kHz stereo 16-bit PCM). */
export const END_MARKERS = [
  { id: "cmmp-end-marker-a", storageKey: "cmmp-end-marker-a.wav", title: "End of schedule (silence) A", seconds: 1 },
  { id: "cmmp-end-marker-b", storageKey: "cmmp-end-marker-b.wav", title: "End of schedule (silence) B", seconds: 1.5 },
  { id: "cmmp-end-marker-c", storageKey: "cmmp-end-marker-c.wav", title: "End of schedule (silence) C", seconds: 1.25 },
  { id: "cmmp-end-marker-d", storageKey: "cmmp-end-marker-d.wav", title: "End of schedule (silence) D", seconds: 1.75 },
] as const

const MARKER_IDS = new Set<string>(END_MARKERS.map((m) => m.id))
const MARKER_KEYS = new Set<string>(END_MARKERS.map((m) => m.storageKey))
/** A zone's runs take these in a fixed cycle, in time order. */
const START_MARKERS: string[] = END_MARKERS.map((m) => m.id)
const startMarkerAt = (index: number) => START_MARKERS[((index % START_MARKERS.length) + START_MARKERS.length) % START_MARKERS.length]
const afterInCycle = (m: string) => START_MARKERS[(START_MARKERS.indexOf(m) + 1) % START_MARKERS.length]

const DAY_MINUTES = 24 * 60
/** One copy per weekday: two copies of one weekday would both be active on it. */
const COPIES_DAYS = 7
/** A run counts as in its window until this long after its end. */
const KEEP_AFTER_END_MIN = 2
/** Crossfade is held off from this long before a run until this long after it. */
const CROSSFADE_MARGIN_MIN = 2
/** A run is watched (lib/repeat-once-watch.ts) from this long before its start. */
const WATCH_LEAD_MIN = 20
const MEMO_TTL_MS = 3 * 24 * 60 * 60 * 1000
/** 1970-01-01 was a Thursday. */
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const
const weekdayOf = (day: number) => WEEKDAYS[(((day % 7) + 7 + 4) % 7)]

export function isEndMarkerTrackId(id: string | null | undefined): boolean {
  return !!id && MARKER_IDS.has(id)
}

export function isEndMarkerStorageKey(name: string): boolean {
  return MARKER_KEYS.has(name)
}

/** The agent behaviour this was worked out against is kit 2026.11.4; later kits inherit it. */
export function agentSupportsRepeatOnce(version: string | null | undefined): boolean {
  return agentVersionStatus(version, REPEAT_ONCE_MIN_AGENT_VERSION) === "current"
}

// ---------------------------------------------------------------------------
// Marker audio and download
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 44100
const CHANNELS = 2

/**
 * A silent 16-bit PCM WAV of exactly `seconds`, with a LIST/INFO comment
 * naming it (`name`), so no two markers - and no operator's own silence
 * file - are ever the same bytes.
 */
export function silentWav(seconds: number, name = ""): Buffer {
  const frames = Math.round(seconds * SAMPLE_RATE)
  const blockAlign = CHANNELS * 2
  const dataBytes = frames * blockAlign
  const text = Buffer.from(`CMMP end of schedule ${name}`.trim() + "\0", "ascii")
  const textLen = text.length + (text.length % 2) // chunks are word-aligned
  const listBytes = 4 + 8 + textLen // "INFO" + "ICMT" sub-chunk
  const fmtAndData = 4 + 8 + 16 + 8 + listBytes + 8 + dataBytes
  const buf = Buffer.alloc(8 + fmtAndData)
  let o = 0
  const str = (v: string) => { buf.write(v, o, "ascii"); o += v.length }
  const u32 = (v: number) => { buf.writeUInt32LE(v, o); o += 4 }
  const u16 = (v: number) => { buf.writeUInt16LE(v, o); o += 2 }
  str("RIFF"); u32(fmtAndData); str("WAVE")
  str("fmt "); u32(16); u16(1); u16(CHANNELS); u32(SAMPLE_RATE); u32(SAMPLE_RATE * blockAlign); u16(blockAlign); u16(16)
  str("LIST"); u32(listBytes); str("INFO"); str("ICMT"); u32(text.length); text.copy(buf, o); o += textLen
  str("data"); u32(dataBytes)
  return buf
}

/** Writes the marker files into music storage when missing or not as expected. Never throws. */
export function ensureEndMarkerFiles(dir: string): void {
  for (const m of END_MARKERS) {
    try {
      const want = silentWav(m.seconds, m.id)
      const file = path.join(dir, m.storageKey)
      const have = fs.existsSync(file) ? fs.readFileSync(file) : null
      if (have && have.equals(want)) continue
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, want)
    } catch (err) {
      console.warn(`[repeat-once] could not write ${m.storageKey}:`, err)
    }
  }
}

/** serverId -> how many markers its last tracks/sync reported cached (to keep them out of its track count). */
const markersCached = new Map<string, number>()

/** Tracks/sync entries for the markers a venue has not reported cached yet. */
export function endMarkersToOffer(serverId: string, reportedTrackIds: readonly string[], signedUrl: (storageKey: string) => string) {
  const have = new Set(reportedTrackIds)
  markersCached.set(serverId, END_MARKERS.filter((m) => have.has(m.id)).length)
  return END_MARKERS.filter((m) => !have.has(m.id)).map((m) => ({
    trackId: m.id,
    title: m.title,
    artist: "CMMP",
    fileSizeMb: silentWav(m.seconds, m.id).length / (1024 * 1024),
    url: signedUrl(m.storageKey),
  }))
}

/** The venue's own count of cached tracks (heartbeat) without the markers. */
export function withoutEndMarkers(serverId: string, cachedTracks: number): number {
  return Math.max(0, cachedTracks - (markersCached.get(serverId) ?? 0))
}

// ---------------------------------------------------------------------------
// The venue's clock
// ---------------------------------------------------------------------------

/** "HH:mm" -> minutes after midnight ("24:00" = 1440), or null. */
function minutesOf(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null
  return h * 60 + min
}

/** Wall-clock ms since 1970-01-01 00:00 in `timeZone` (as if it were UTC), or null for an unknown zone. */
function localWallMs(timeZone: string, now: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(now))
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
    const ms = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) + (now % 1000)
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

export type RepeatOnceContext = {
  serverId: string
  /** The venue's wall clock now, in minutes (fractional). */
  wall: number
  now: number
  /** venue wall ms - epoch ms */
  wallOffsetMs: number
  /** The venue's own clock was measured (lib/pc-clock.ts), not assumed. */
  clockMeasured: boolean
}

/**
 * Null when this venue's agent is not one this applies to, or its time zone
 * is unknown. `measuredWallMs` is the venue's own wall clock when the cloud
 * has measured it (pcClockFor), so the venue's own day and time are used.
 */
export function repeatOnceContext(serverId: string, version: string | null | undefined, timeZone: string | null | undefined, now: number, measuredWallMs: number | null = null): RepeatOnceContext | null {
  if (!agentSupportsRepeatOnce(version) || !timeZone) return null
  const assumed = localWallMs(timeZone, now)
  if (assumed === null) return null
  const wallMs = measuredWallMs ?? assumed
  return { serverId, wall: wallMs / 60000, now, wallOffsetMs: wallMs - now, clockMeasured: measuredWallMs !== null }
}

// ---------------------------------------------------------------------------
// Windows, occurrences, winners (as kit agent.js slotActiveAt / activeScheduleWinners)
// ---------------------------------------------------------------------------

type Window = { start: number; end: number; activeMinutes: number; flip: number }

function windowOf(startTime: string, endTime: string): Window | null {
  const start = minutesOf(startTime)
  const end = minutesOf(endTime)
  if (start === null || end === null || start === end) return null
  const activeMinutes = start < end ? end - start : DAY_MINUTES - start + end
  const quiet = DAY_MINUTES - activeMinutes
  return { start, end, activeMinutes, flip: (start + activeMinutes + Math.floor(quiet / 2)) % DAY_MINUTES }
}

type Occurrence = { startWall: number; endWall: number; day: number; weekday: string }

/** The slot's next occurrences on its days, from the one after the most recent quiet-hours midpoint. */
function occurrences(w: Window, days: readonly string[], wall: number, count: number): Occurrence[] {
  const base = Math.floor((wall - w.flip) / DAY_MINUTES)
  const out: Occurrence[] = []
  for (let k = 0; k < count; k++) {
    const startWall = (base + k) * DAY_MINUTES + w.flip + ((w.start - w.flip + DAY_MINUTES) % DAY_MINUTES)
    const day = Math.floor(startWall / DAY_MINUTES)
    const weekday = weekdayOf(day)
    if (days.includes(weekday)) out.push({ startWall, endWall: startWall + w.activeMinutes, day, weekday })
  }
  return out
}

/** kit agent.js slotActiveAt, at minute `m` of local day `day`. */
function activeAt(slot: { startTime: string; endTime: string; days: string[] | null }, day: number, m: number): boolean {
  if (!Array.isArray(slot.days)) return false
  const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
  const today = weekdayOf(day)
  const yesterday = weekdayOf(day - 1)
  if (slot.startTime < slot.endTime) return slot.days.includes(today) && slot.startTime <= hhmm && hhmm < slot.endTime
  if (slot.endTime < slot.startTime) return (slot.days.includes(today) && slot.startTime <= hhmm) || (slot.days.includes(yesterday) && hhmm < slot.endTime)
  return false
}


/** Minutes into its occurrence at which `target` first wins its zone (the winner only changes at a slot's start or end), or null. */
function firstWin(zoneSlots: readonly ServedSlot[], target: ServedSlot, o: Occurrence, w: Window): number | null {
  const offsets = new Set<number>([0])
  for (const s of zoneSlots) {
    for (const t of [minutesOf(s.startTime), minutesOf(s.endTime)]) {
      if (t === null) continue
      const off = (t - w.start + DAY_MINUTES) % DAY_MINUTES
      if (off < w.activeMinutes) offsets.add(off)
    }
  }
  for (const off of [...offsets].sort((a, b) => a - b)) {
    const m = w.start + off
    const day = o.day + Math.floor(m / DAY_MINUTES)
    let winner: ServedSlot | null = null
    for (const s of zoneSlots) {
      if (!s.startTime || !s.endTime || !activeAt(s, day, m % DAY_MINUTES)) continue
      if (!winner || (s.priority ?? 0) > (winner.priority ?? 0)) winner = s
    }
    if (winner === target) return off
  }
  return null
}

const WEEKDAY_INDEX: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }

/** How many days d in [0, end) (day 0 = 1970-01-01, a Thursday) fall on weekday `w`. */
function daysOnWeekdayBefore(w: number, end: number): number {
  const first = (w - 4 + 7) % 7
  return end > first ? Math.floor((end - first - 1) / 7) + 1 : 0
}

// ---------------------------------------------------------------------------
// The served schedule
// ---------------------------------------------------------------------------

export type ZoneNow = { currentTrackId: string | null; playbackState: string }

/** zoneId -> the start marker of its most recently started run (in memory): the next run never takes it. */
const lastStarted = new Map<string, { markerId: string; playAt: number; at: number }>()
/** Whether a slot was served as a one-song run at its start or as it is, for its window (in memory). */
const forms = new Map<string, { once: boolean; at: number }>()
/** The start marker a run was served with while it was the zone's next run (in memory; falls back safely). */
const runMarker = new Map<string, { markerId: string; at: number; started?: boolean }>()

/** Test seam. */
export function _resetRepeatOnce() {
  forms.clear()
  runMarker.clear()
  lastStarted.clear()
  markersCached.clear()
}

export type ServedSlot = {
  id: string
  zoneId: string
  trackIds: string[]
  excludedTrackIds: string[]
  startTime: string
  endTime: string
  days: string[] | null
  repeat: boolean
  priority: number | null
}

/** The one playable song of a Repeat-off slot that has exactly one, else null. */
export function onceSongOf(slot: ServedSlot): string | null {
  if (slot.repeat !== false || !Array.isArray(slot.days) || slot.days.length === 0) return null
  if (slot.trackIds.some((id) => isEndMarkerTrackId(id))) return null
  const excluded = new Set(slot.excludedTrackIds)
  const playable = [...new Set(slot.trackIds.filter((id) => !excluded.has(id)))]
  if (playable.length !== 1) return null
  return windowOf(slot.startTime, slot.endTime) ? playable[0] : null
}

export type RunInfo = { title: string; songSec: number | null }

type Run = { slot: ServedSlot; o: Occurrence; token: string; isFirst: boolean; index: number; win: number | null; marker: string }

/**
 * One zone's slots as served to the venue, in the same order: each slot is
 * unchanged, or - Repeat off with exactly one playable song - one copy per
 * upcoming occurrence, each with its own id, its own weekday and an end
 * marker. `slots` must be all of the zone's served slots, in served order
 * (the winner of a time is decided the way the agent decides it).
 *
 * Markers. All of a zone's one-song runs that can play are numbered in time
 * order (a fixed count from 1970, so every request agrees) and take A, B, C,
 * D in turn: the run before always had another one, so whatever the venue
 * still has loaded or queued from it is not this run's marker, and the start
 * is the song. If the zone is loaded with a run's turn anyway (runs that did
 * not play), that next run takes another, and the saved copies after it
 * follow it in a chain. A run keeps its marker for its whole window: like
 * every Repeat-off slot after its last song, a Play inside the rest of the
 * slot resumes the end (silence), and an agent restart there finds silence
 * too - the song is never played twice by itself.
 */
export function expandZoneSlots<T extends ServedSlot>(ctx: RepeatOnceContext | null, slots: T[], zone: ZoneNow | undefined, infoOf: (slot: T) => RunInfo): T[][] {
  if (!ctx) return slots.map((s) => [s])
  for (const m of [forms, runMarker, lastStarted]) for (const [k, v] of m) if (ctx.now - v.at > MEMO_TTL_MS) m.delete(k)
  const loaded = zone?.currentTrackId ?? null
  const loadedMarker = loaded !== null && isEndMarkerTrackId(loaded) ? loaded : null

  // Which slots are served as one-song runs: as they qualify now, except that a
  // slot keeps the form it had when its current window started.
  const once = new Map<T, { song: string; w: Window; list: Occurrence[]; plays: Set<number> }>()
  /** One-song now, but served as it was when its window started: same id, just an end marker added. */
  const markerOnly = new Set<T>()
  for (const slot of slots) {
    const w = windowOf(slot.startTime, slot.endTime)
    if (!w || !Array.isArray(slot.days) || slot.days.length === 0) continue
    const list = occurrences(w, slot.days, ctx.wall, COPIES_DAYS)
    const first = list[0]
    const song = onceSongOf(slot)
    let qualifies = song !== null
    if (first && ctx.wall >= first.startWall && ctx.wall < first.endWall + KEEP_AFTER_END_MIN) {
      const formKey = `${slot.id}|${slot.zoneId}|${first.day}|${w.start}-${w.end}`
      const had = forms.get(formKey)
      if (had) qualifies = had.once
      else forms.set(formKey, { once: qualifies, at: ctx.now })
    }
    const playable = song ?? slot.trackIds.find((id) => !slot.excludedTrackIds.includes(id) && !isEndMarkerTrackId(id)) ?? null
    if (qualifies && playable && list.length > 0) once.set(slot, { song: playable, w, list, plays: new Set() })
    else if (!qualifies && song !== null) markerOnly.add(slot)
  }
  // Already running when it became one-song: its start is behind it; any marker it is not loaded with ends it.
  const playingMarker = loadedMarker !== null && zone?.playbackState === "PLAYING" ? loadedMarker : null
  const withMarker = (slot: T): T[] => [{ ...slot, trackIds: [...slot.trackIds, playingMarker ?? START_MARKERS.find((m) => m !== loadedMarker)!] }]
  if (once.size === 0) return slots.map((s) => (markerOnly.has(s) ? withMarker(s) : [s]))

  // The weekdays on which each one-song slot can play (wins its zone at some time in its window).
  for (const [slot, info] of once) {
    for (const wd of slot.days!) {
      const wi = WEEKDAY_INDEX[wd]
      if (wi === undefined) continue
      const day = ((wi - 4 + 7) % 7) + 7
      if (firstWin(slots, slot, { startWall: day * DAY_MINUTES + info.w.start, endWall: day * DAY_MINUTES + info.w.start + info.w.activeMinutes, day, weekday: wd }, info.w) !== null) info.plays.add(wi)
    }
  }
  const order = new Map<ServedSlot, number>(slots.map((s, i) => [s, i]))
  /** How many of the zone's playable one-song runs start before `r` (ties: served order). */
  const indexOf = (r: { slot: ServedSlot; o: Occurrence }) => {
    let n = 0
    for (const [s, info] of once) {
      const before = Math.ceil((r.o.startWall - info.w.start) / DAY_MINUTES)
      for (const wi of info.plays) n += daysOnWeekdayBefore(wi, before)
      const sameDay = (r.o.startWall - info.w.start) / DAY_MINUTES
      if (s !== r.slot && Number.isInteger(sameDay) && info.plays.has(WEEKDAY_INDEX[weekdayOf(sameDay)]) && order.get(s)! < order.get(r.slot)!) n++
    }
    return n
  }

  const runs: Run[] = []
  for (const [slot, { w, list }] of once) {
    list.forEach((o, i) => {
      const win = firstWin(slots, slot, o, w)
      // The run's identity includes its times: a slot moved to new times is a new run (no saved position).
      runs.push({ slot, o, token: `${o.day}w${w.start}-${w.end}`, isFirst: i === 0, index: indexOf({ slot, o }), win, marker: startMarkerAt(0) })
    })
  }
  // In the order they start playing (a run that takes over later starts then); ties: served order.
  const playAt = (r: Run) => r.o.startWall + (r.win ?? 0)
  runs.sort((a, b) => playAt(a) - playAt(b) || order.get(a.slot)! - order.get(b.slot)!)
  const keyOf = (r: Run) => `${r.slot.id}|${r.slot.zoneId}|${r.token}`
  /** The next run's marker: its turn, unless the zone is loaded with it or a started run is served it. */
  const startMarkerFor = (r: Run, taken: string[]) => {
    const nominal = startMarkerAt(r.index)
    const own = runMarker.get(keyOf(r))?.markerId
    const last = lastStarted.get(r.slot.zoneId)?.markerId ?? null
    if ((loadedMarker !== nominal || (playingMarker === nominal && own === nominal)) && !taken.includes(nominal) && last !== nominal) return nominal
    const avoid = [loadedMarker, last, startMarkerAt(r.index - 1), ...taken]
    return START_MARKERS.find((m) => !avoid.includes(m)) ?? START_MARKERS.find((m) => m !== loadedMarker && !taken.includes(m)) ?? START_MARKERS.find((m) => m !== loadedMarker)!
  }

  // Started runs keep the marker they started with for their whole window (remembered from when they
  // were the next run; after a cloud restart, the marker the zone sits on, else their turn). Nothing in
  // their list changes after the start, so an agent restart in the rest of the slot only finds the
  // silence again - the song is not played twice.
  const active: string[] = []
  const started = (r: Run) => runMarker.get(keyOf(r))?.started === true || (r.win !== null && ctx.wall >= playAt(r))
  for (const r of runs) {
    if (!started(r)) continue
    const key = keyOf(r)
    const repair = r.isFirst ? repairOf(r.slot.id, r.slot.zoneId, r.token) : null
    let held = runMarker.get(key)
    if (repair && (!held || held.at < repair.repairedAt)) {
      held = { markerId: START_MARKERS.find((m) => m !== loadedMarker && m !== held?.markerId && !active.includes(m)) ?? startMarkerAt(r.index), at: ctx.now }
      runMarker.set(key, held)
    }
    if (!held) {
      // Not seen as the next run (a cloud restart). Once its song should be over, the marker the zone is
      // on is its own (keep it: its list does not change); before that, as if its song is still to come.
      const songSec = infoOf(r.slot as T).songSec
      const songOver = songSec !== null && ctx.wall >= playAt(r) + songSec / 60
      held = { markerId: (songOver && loadedMarker) || START_MARKERS.find((m) => m !== loadedMarker && !active.includes(m)) || startMarkerAt(r.index), at: ctx.now }
    }
    held = { ...held, started: true }
    runMarker.set(key, held)
    r.marker = held.markerId
    if (ctx.wall < r.o.endWall + KEEP_AFTER_END_MIN) active.push(r.marker)
    const prevStart = lastStarted.get(r.slot.zoneId)
    if (!prevStart || prevStart.playAt <= playAt(r)) lastStarted.set(r.slot.zoneId, { markerId: r.marker, playAt: playAt(r), at: ctx.now })
  }
  // The next run that can play: decided at every request until it starts. Later runs follow it in a
  // chain, each a different marker from the one before, so saved copies never repeat a marker twice in
  // a row (a venue that goes offline plays them as they are).
  let prev: string | null = null
  for (const r of runs) {
    if (started(r)) continue
    if (r.win === null) {
      r.marker = startMarkerAt(r.index)
      continue
    }
    if (prev === null) {
      r.marker = startMarkerFor(r, active)
      runMarker.set(keyOf(r), { markerId: r.marker, at: ctx.now })
    } else r.marker = afterInCycle(prev)
    prev = r.marker
  }

  // Watch each slot's current run while it is near, from the moment it wins its zone.
  for (const r of runs) {
    if (!r.isFirst || r.win === null) continue
    const startWall = r.o.startWall + r.win
    if (ctx.wall < startWall - WATCH_LEAD_MIN || ctx.wall > r.o.endWall) continue
    const { song, w } = once.get(r.slot as T)!
    const startAt = startWall * 60000 - ctx.wallOffsetMs
    const info = infoOf(r.slot as T)
    watchRun(
      { slotId: r.slot.id, zoneId: r.slot.zoneId, token: r.token, serverId: ctx.serverId, title: info.title, songId: song, songSec: info.songSec, startAt, endAt: r.o.startWall * 60000 - ctx.wallOffsetMs + w.activeMinutes * 60000, clockMeasured: ctx.clockMeasured, servedMarker: r.marker },
      ctx.now
    )
  }

  const runsOf = new Map<ServedSlot, Run[]>()
  for (const r of runs) runsOf.set(r.slot, [...(runsOf.get(r.slot) ?? []), r])
  return slots.map((slot) => {
    if (markerOnly.has(slot)) return withMarker(slot)
    const mine = once.has(slot) ? runsOf.get(slot) ?? [] : null
    if (!mine) return [slot]
    return mine.map((r) => ({
      ...slot,
      id: `${slot.id}~once${r.token}${r.isFirst && repairOf(slot.id, slot.zoneId, r.token) ? "r1" : ""}`,
      days: [r.o.weekday],
      trackIds: [...slot.trackIds, r.marker],
    }))
  })
}

/**
 * True while one of this zone's one-song runs that wins its zone is about to
 * run, running or just over: the zone is served with crossfade off then, so
 * its song is not faded into the end marker.
 */
export function crossfadeHeld(ctx: RepeatOnceContext | null, zoneSlots: readonly ServedSlot[]): boolean {
  if (!ctx) return false
  for (let off = -CROSSFADE_MARGIN_MIN; off <= CROSSFADE_MARGIN_MIN; off++) {
    const at = Math.floor(ctx.wall) + off
    const d = Math.floor(at / DAY_MINUTES)
    const m = ((at % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES
    let winner: ServedSlot | null = null
    for (const s of zoneSlots) {
      if (!s.startTime || !s.endTime || !activeAt(s, d, m)) continue
      if (!winner || (s.priority ?? 0) > (winner.priority ?? 0)) winner = s
    }
    if (winner && onceSongOf(winner)) return true
  }
  return false
}
