/**
 * Watches every Repeat-off one-song run (lib/repeat-once.ts) while it runs.
 *
 *  - Repair, once per run: if the song has not been reported playing 8 s
 *    after the start, the run is still being served, the zone is not paused,
 *    held for prayer or offline, nobody pressed Stop/Pause (checked by the
 *    caller), the venue is reporting, its clock has been measured, the zone
 *    is not sitting on this run's own marker after moving onto it (it can
 *    only get there by playing the song), and the whole song still fits
 *    before the slot ends: the run is served under a new id with an end
 *    marker the zone is not loaded with, and the venue is told to sync now
 *    (SYNC_CONFIG). It takes that as a new start and plays from the top -
 *    the song. A repair while the song is in fact just starting changes
 *    nothing: the venue leaves a zone that plays the slot's own track alone.
 *  - Verdict, after the run: an Alert when the song did not play, played
 *    more than once, stopped before its end, started late (repaired), or the
 *    venue sent no report at all during it.
 *
 * Only what the venue itself reports (POST /server/zones/sync: within a
 * couple of seconds of any change, and every heartbeat) is used. A run is
 * judged and repaired only when it was watched from before its start and
 * kept being served, so a cloud restart, an edit or a disabled schedule never
 * raises a false alarm or a second start. In memory only.
 */

type ZoneReport = { playbackState: string | null; currentTrackId: string | null; heldForPrayer: boolean }

export type WatchedRun = {
  key: string
  serverId: string
  zoneId: string
  title: string
  songId: string
  songSec: number | null
  startAt: number
  endAt: number
  clockMeasured: boolean
  servedMarker: string
  watchedFrom: number
  lastServedAt: number
  reports: number
  lastReportAt: number | null
  lastState: ZoneReport | null
  preStartTrackId: string | null
  firstSongAt: number | null
  /** Time the song spent paused (reported PAUSED on it), and when the current pause began. */
  pausedMs: number
  pausedAt: number | null
  playingSong: boolean
  songEndedAt: number | null
  /** The zone moved onto an end marker during the run: the venue only goes there after the song (also a song too short to be seen playing). */
  reachedMarker: boolean
  replayed: boolean
  stoppedEarly: boolean
  repairedAt: number | null
  repairSkipped: boolean
}

export type RunAlert = { severity: "warning" | "critical"; title: string; message: string; serverId: string }

/** A run the cloud is serving, with its window on the venue's own clock (as epoch ms). */
export type ServedRun = {
  slotId: string
  zoneId: string
  token: string
  serverId: string
  title: string
  songId: string
  songSec: number | null
  startAt: number
  endAt: number
  /** The venue's clock was measured, so startAt/endAt are the venue's own times. */
  clockMeasured: boolean
  /** The end marker this run is served with right now. */
  servedMarker: string
}

const runs = new Map<string, WatchedRun>()
/** zoneId -> trackId -> when the venue last reported the zone playing it (any time, not only in a run). */
const lastPlayed = new Map<string, Map<string, number>>()
/** A song reported playing on the zone this recently (before the run) means the run already happened. */
const RECENT_PLAY_MS = 5 * 60_000
const EARLY_MS = 5_000
const LATE_MS = 60_000
/** With the venue's clock not measured, its run may come this much earlier or later. */
const UNMEASURED_MS = 5 * 60_000
/** The song should be playing by then; the venue starts it within a few seconds. */
const REPAIR_AFTER_MS = 8_000
/** A zone that changes nothing reports only with the heartbeat (15 s +-20%). */
const FRESH_MS = 20_000
/** The venue fetches its schedules every ~20 s; a run not served for this long was edited away or disabled. */
const SERVED_MS = 60_000
/** Push (SYNC_CONFIG) and the start itself. */
const REPAIR_PICKUP_MS = 8_000
/** Allowance for report cadence and rounding when judging a play's length. */
const LENGTH_SLACK_MS = 20_000

const keyOf = (slotId: string, zoneId: string, token: string) => `${slotId}|${zoneId}|${token}`
const isMarker = (id: string | null) => !!id && id.startsWith("cmmp-end-marker-")
const leadOf = (r: WatchedRun) => (r.clockMeasured ? EARLY_MS : UNMEASURED_MS)
const lagOf = (r: WatchedRun) => (r.clockMeasured ? LATE_MS : UNMEASURED_MS)

/** Starts watching a run the first time it is served; every later call keeps it current. */
export function watchRun(r: ServedRun, now: number) {
  const key = keyOf(r.slotId, r.zoneId, r.token)
  const had = runs.get(key)
  if (had) {
    had.servedMarker = r.servedMarker
    had.lastServedAt = now
    had.title = r.title
    if (had.songSec === null) had.songSec = r.songSec
    return
  }
  if (now > r.endAt + (r.clockMeasured ? LATE_MS : UNMEASURED_MS)) return
  runs.set(key, {
    key,
    serverId: r.serverId,
    zoneId: r.zoneId,
    title: r.title,
    songId: r.songId,
    songSec: r.songSec,
    startAt: r.startAt,
    endAt: r.endAt,
    clockMeasured: r.clockMeasured,
    servedMarker: r.servedMarker,
    watchedFrom: now,
    lastServedAt: now,
    reports: 0,
    lastReportAt: null,
    lastState: null,
    preStartTrackId: null,
    firstSongAt: null,
    pausedMs: 0,
    pausedAt: null,
    playingSong: false,
    songEndedAt: null,
    reachedMarker: false,
    replayed: false,
    stoppedEarly: false,
    repairedAt: null,
    repairSkipped: false,
  })
}

/** When this run was repaired (serve it under its repair id from then on), or null. */
export function repairOf(slotId: string, zoneId: string, token: string): { repairedAt: number } | null {
  const at = runs.get(keyOf(slotId, zoneId, token))?.repairedAt ?? null
  return at === null ? null : { repairedAt: at }
}

function watchedFromStart(r: WatchedRun) {
  return r.watchedFrom <= r.startAt - leadOf(r)
}

function playedRecently(r: WatchedRun, now: number): boolean {
  const at = lastPlayed.get(r.zoneId)?.get(r.songId)
  return at !== undefined && at >= r.startAt - RECENT_PLAY_MS && at <= now
}

/** Every zone the venue reports, as it was stored. */
export function noteZoneReport(zoneId: string, report: ZoneReport, now: number) {
  if (report.playbackState === "PLAYING" && report.currentTrackId) {
    const mine = lastPlayed.get(zoneId) ?? new Map<string, number>()
    mine.set(report.currentTrackId, now)
    for (const [t, at] of mine) if (now - at > 24 * 60 * 60_000) mine.delete(t)
    lastPlayed.set(zoneId, mine)
  }
  for (const r of runs.values()) {
    if (r.zoneId !== zoneId) continue
    if (now < r.startAt) r.preStartTrackId = report.currentTrackId
    if (now < r.startAt - leadOf(r) || now > r.endAt + lagOf(r)) continue
    r.reports++
    // On a marker, late enough for the song to have played before it (a marker played ahead of the song does not count).
    const minPlayedMs = r.songSec === null ? Infinity : Math.max(r.songSec * 600, r.songSec * 1000 - LENGTH_SLACK_MS)
    if (now >= r.startAt + minPlayedMs && isMarker(report.currentTrackId) && report.currentTrackId !== r.preStartTrackId) r.reachedMarker = true
    const onSong = report.playbackState === "PLAYING" && report.currentTrackId === r.songId
    // How long the song has played: since it was first seen playing, less its pauses.
    const played = () => (r.firstSongAt === null ? 0 : now - r.firstSongAt - r.pausedMs - (r.pausedAt !== null ? now - r.pausedAt : 0))
    if (onSong) {
      if (r.pausedAt !== null) {
        r.pausedMs += now - r.pausedAt
        r.pausedAt = null
      } else if (!r.playingSong && r.songEndedAt !== null) {
        r.replayed = true // playing it again after it had ended
      }
      if (r.firstSongAt === null) r.firstSongAt = now
      // Played for clearly longer than the song is: it went round again.
      if (r.songSec !== null && played() > r.songSec * 1000 + LENGTH_SLACK_MS) r.replayed = true
      r.playingSong = true
    } else if (r.playingSong || r.pausedAt !== null) {
      const wasPlaying = r.playingSong
      r.playingSong = false
      if (report.playbackState === "PAUSED" && report.currentTrackId === r.songId) {
        if (wasPlaying) r.pausedAt = now // a pause (a person, or Prayer Mode): it may resume
      } else {
        if (r.pausedAt !== null) {
          r.pausedMs += now - r.pausedAt
          r.pausedAt = null
        }
        if (isMarker(report.currentTrackId)) r.songEndedAt = now // played to its end; the venue moved on to the marker
        else if (now >= r.endAt - 5_000) r.songEndedAt = now // the slot's own end stopped it
        else if (r.songSec !== null && played() < r.songSec * 1000 - LENGTH_SLACK_MS) r.stoppedEarly = true
        else r.songEndedAt = now
      }
    }
    r.lastReportAt = now
    r.lastState = report
  }
}

export type RepairCandidate = { key: string; serverId: string; zoneId: string; startAt: number }

/** Runs that need a repair now (checked every 2 s). The caller checks for a person's Stop/Pause, then markRepaired / skipRepair. */
export function repairCandidates(now: number): RepairCandidate[] {
  const out: RepairCandidate[] = []
  for (const r of runs.values()) {
    if (r.repairedAt !== null || r.repairSkipped || !r.clockMeasured || !watchedFromStart(r)) continue
    if (r.firstSongAt !== null || r.reachedMarker) continue
    if (now < r.startAt + REPAIR_AFTER_MS || now > r.endAt) continue
    if (now - r.lastServedAt > SERVED_MS) continue
    if (r.songSec === null || r.endAt - now < r.songSec * 1000 + REPAIR_PICKUP_MS) continue
    const s = r.lastState
    if (!s || r.lastReportAt === null || now - r.lastReportAt > FRESH_MS) continue
    if (s.heldForPrayer || s.playbackState === "PAUSED" || s.playbackState === "OFFLINE") continue
    // Loaded with the song itself: it was started (a very short one can end unseen) or stopped by a person.
    if (s.currentTrackId === r.songId) continue
    // The song already played (e.g. the venue's clock is not what the cloud measured, so its run
    // came before the cloud's window): on this run's marker after moving onto it, or the song was
    // reported playing on this zone in the last few minutes. Never start it again.
    if (playedRecently(r, now)) continue
    out.push({ key: r.key, serverId: r.serverId, zoneId: r.zoneId, startAt: r.startAt })
  }
  return out
}

export function markRepaired(key: string, now: number) {
  const r = runs.get(key)
  if (r && r.repairedAt === null) r.repairedAt = now
}

export function skipRepair(key: string) {
  const r = runs.get(key)
  if (r) r.repairSkipped = true
}

/** Runs whose window is over, with their verdict (null: nothing to report). Forget each with forgetRun once handled. */
export function finishedRuns(now: number): { key: string; alert: RunAlert | null; zoneId: string; startAt: number; replayed: boolean }[] {
  const out: { key: string; alert: RunAlert | null; zoneId: string; startAt: number; replayed: boolean }[] = []
  for (const [key, r] of runs) {
    if (now <= r.endAt + lagOf(r)) continue
    // Not watched from its start, or no longer served before it ended (edited, disabled): no verdict.
    if (!watchedFromStart(r) || r.lastServedAt < r.endAt - SERVED_MS) {
      out.push({ key, alert: null, zoneId: r.zoneId, startAt: r.startAt, replayed: false })
      continue
    }
    const when = new Date(r.startAt).toISOString().slice(0, 16).replace("T", " ")
    const alert = (severity: RunAlert["severity"], title: string, message: string): RunAlert => ({ severity, title, message: `${r.title}: ${message}`, serverId: r.serverId })
    let a: RunAlert | null = null
    if (r.reports === 0) {
      a = alert("critical", "Scheduled song not confirmed", `the venue sent no report during the slot starting ${when} UTC, so it cannot be confirmed that the song played. Check that the Music Server PC is on and its player is running.`)
    } else if (r.firstSongAt === null && (r.reachedMarker || playedRecently(r, now))) {
      a = null // it played: too short to be seen playing, or outside the window the cloud expected (the venue's clock differs)
    } else if (r.firstSongAt === null) {
      a = alert("critical", "Scheduled song did not play", `the slot starting ${when} UTC did not play its song${r.repairedAt !== null ? ", even after the cloud restarted it" : r.repairSkipped ? " (a Stop or Pause was pressed)" : ""}.`)
    } else if (r.replayed) {
      a = alert("warning", "Scheduled song played more than once", `the slot starting ${when} UTC played its song more than once although Repeat is off.`)
    } else if (r.stoppedEarly) {
      a = alert("warning", "Scheduled song stopped early", `the song of the slot starting ${when} UTC stopped before its end (a Stop, or the player).`)
    } else if (r.repairedAt !== null) {
      a = alert("warning", "Scheduled song started late", `the slot starting ${when} UTC had not started its song after ${REPAIR_AFTER_MS / 1000} s; the cloud restarted it and it then played, ${Math.max(0, Math.round((r.firstSongAt - r.startAt) / 1000))} s late.`)
    }
    out.push({ key, alert: a, zoneId: r.zoneId, startAt: r.startAt, replayed: a !== null && a.title.includes("more than once") })
  }
  return out
}

export function forgetRun(key: string) {
  runs.delete(key)
}

/** Test seam. */
export function _resetWatch() {
  runs.clear()
  lastPlayed.clear()
}
export function _runs() {
  return runs
}
