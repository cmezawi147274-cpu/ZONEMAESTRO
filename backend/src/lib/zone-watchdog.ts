import { prisma } from "./db.js"
import { isAgentConnected, pushToAgent } from "./agent-registry.js"
import { pcClockFor, zoneOffsetMs } from "./pc-clock.js"
import { pushActivity } from "./activity.js"

export const WATCHDOG_ISSUER = "watchdog"

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
const SWEEP_MS = 15_000
const STARTUP_GRACE_MS = 2 * 60_000
const PLAYER_SILENT_MS = 3 * 60_000
const SETTLE_MS = 30_000
const RETRY_MS = 2 * 60_000
const MAX_ATTEMPTS = 10
const SLOT_HEAD_MS = 5 * 60_000
const SLOT_TAIL_MS = 10 * 60_000
const SILENT_ALERT_MS = 5 * 60_000
const OFFLINE_ALERT_MS = 3 * 60_000
const OFFLINE_ALERT_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const ALERT_REPEAT_MS = 24 * 60 * 60_000
const PERSON_STOP_LOOKBACK_MS = 24 * 60 * 60_000
const COMMAND_EXPIRY_MS = 60_000

type Dropout = { since: number; lastOfflineAt: number; attempts: number; lastAttemptAt: number }
type Slot = { id: string; name: string; startTime: string; endTime: string; days: string[]; priority: number; repeat: boolean }

const bootAt = Date.now()
const lastZoneReportAt = new Map<string, number>()
const stateLossAt = new Map<string, number>()
const dropouts = new Map<string, Dropout>()
const prayerOpenUntil = new Map<string, number>()
const notPlayingSince = new Map<string, { slotId: string; since: number }>()
const lastPlayingAt = new Map<string, number>()
const lastLiveState = new Map<string, string>()
const missingNow = new Set<string>()

function markDropout(zoneId: string, at: number) {
  const d = dropouts.get(zoneId)
  if (d) d.lastOfflineAt = Math.max(d.lastOfflineAt, at)
  else if (lastLiveState.get(zoneId) === "PLAYING") dropouts.set(zoneId, { since: at, lastOfflineAt: at, attempts: 0, lastAttemptAt: 0 })
}

export function noteZoneStates(serverId: string, zones: { id: string; playbackState: string }[], now = Date.now()) {
  lastZoneReportAt.set(serverId, now)
  for (const z of zones) {
    missingNow.delete(z.id)
    if (z.playbackState === "OFFLINE") {
      markDropout(z.id, now)
      continue
    }
    lastLiveState.set(z.id, z.playbackState)
    if (z.playbackState === "PLAYING") {
      dropouts.delete(z.id)
      lastPlayingAt.set(z.id, now)
    }
  }
}

export function noteZonesMissing(zoneIds: string[], now = Date.now()) {
  for (const id of zoneIds) {
    missingNow.add(id)
    markDropout(id, now)
  }
}

export function noteStateLoss(serverId: string, now = Date.now()) {
  stateLossAt.set(serverId, now)
}

export function notePrayerWindow(locationId: string, endAt: number) {
  if ((prayerOpenUntil.get(locationId) ?? 0) < endAt) prayerOpenUntil.set(locationId, endAt)
}

function prayerOpen(locationId: string, now: number): boolean {
  return (prayerOpenUntil.get(locationId) ?? 0) > now
}

function wallOf(serverId: string, timeZone: string | null, now: number): number | null {
  try {
    const measured = pcClockFor(serverId, timeZone, now).wallMs
    if (measured !== null) return measured
  } catch {
    // fall back to the venue's timezone
  }
  const offset = zoneOffsetMs(timeZone, now)
  return offset === null ? null : now + offset
}

const pad = (n: number) => String(n).padStart(2, "0")

function activeAt(s: Slot, wall: number): boolean {
  const d = new Date(wall)
  const hhmm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  const today = DAY_NAMES[d.getUTCDay()]
  const yesterday = DAY_NAMES[(d.getUTCDay() + 6) % 7]
  if (!Array.isArray(s.days)) return false
  if (s.startTime < s.endTime) return s.days.includes(today) && s.startTime <= hhmm && hhmm < s.endTime
  if (s.endTime < s.startTime) return (s.days.includes(today) && s.startTime <= hhmm) || (s.days.includes(yesterday) && hhmm < s.endTime)
  return false
}

function winnerAt(slots: Slot[], wall: number): Slot | null {
  let best: Slot | null = null
  for (const s of slots) {
    if (!activeAt(s, wall)) continue
    if (!best || s.priority > best.priority) best = s
  }
  return best
}

/** The slot running the zone now, only when it has been running for a while and will keep running for a while. */
function settledWinner(slots: Slot[], wall: number): Slot | null {
  const now = winnerAt(slots, wall)
  if (!now) return null
  if (slots.some((s) => s.id !== now.id && s.priority === now.priority && activeAt(s, wall))) return null
  const before = winnerAt(slots, wall - SLOT_HEAD_MS)
  const after = winnerAt(slots, wall + SLOT_TAIL_MS)
  return before?.id === now.id && after?.id === now.id ? now : null
}

async function personStoppedSince(zoneId: string, since: number): Promise<boolean> {
  const last = await prisma.remoteCommand.findFirst({
    where: { zoneId, type: { in: ["PLAY", "STOP", "PAUSE"] }, issuedAt: { gte: new Date(since) } },
    orderBy: { issuedAt: "desc" },
    select: { type: true, source: true },
  })
  return Boolean(last && last.type !== "PLAY" && (last.source === "USER" || last.source === "SUPER_ADMIN"))
}

async function issuePlay(zone: { id: string; serverId: string }) {
  const bumped = await prisma.zone.update({
    where: { id: zone.id },
    data: { commandSequence: { increment: 1 } },
    select: { commandSequence: true, localZoneId: true },
  })
  const payload = {}
  const command = await prisma.remoteCommand.create({
    data: {
      serverId: zone.serverId,
      zoneId: zone.id,
      type: "PLAY",
      payload,
      status: "PENDING",
      source: "SCHEDULE",
      sequence: bumped.commandSequence,
      issuedById: WATCHDOG_ISSUER,
    },
  })
  pushToAgent(zone.serverId, "ReceiveCommand", [
    { commandId: command.id, type: "PLAY", zoneId: bumped.localZoneId ?? zone.id, payload, sequence: bumped.commandSequence },
  ])
}

async function raiseAlert(severity: "warning" | "critical", title: string, message: string, serverId: string, now: number) {
  const recent = await prisma.alert.count({ where: { serverId, title, createdAt: { gte: new Date(now - ALERT_REPEAT_MS) } } })
  if (recent > 0) return
  await prisma.alert.create({ data: { severity, title, message, serverId } })
}

async function sweep(now: number, checkAlerts: boolean) {
  await prisma.remoteCommand.updateMany({
    where: { issuedById: WATCHDOG_ISSUER, status: { in: ["PENDING", "SENT"] }, issuedAt: { lt: new Date(now - COMMAND_EXPIRY_MS) } },
    data: { status: "TIMEOUT", completedAt: new Date(now), resultMessage: "Not acknowledged within 60 s; withdrawn." },
  })
  if (now - bootAt < STARTUP_GRACE_MS) return
  const servers = await prisma.musicServer.findMany({
    where: { status: { not: "UNKNOWN" } },
    select: {
      id: true,
      name: true,
      lastHeartbeatAt: true,
      reportedTimezone: true,
      location: { select: { timezone: true } },
      zones: {
        where: { localZoneId: { not: null } },
        select: {
          id: true,
          serverId: true,
          locationId: true,
          name: true,
          playbackState: true,
          pausedByPrayer: true,
          prayerModeEnabled: true,
          leaderZoneId: true,
          schedules: {
            where: { enabled: true },
            orderBy: { startTime: "asc" },
            select: { id: true, name: true, startTime: true, endTime: true, days: true, priority: true, repeat: true },
          },
        },
      },
    },
  })

  for (const server of servers) {
    const wall = wallOf(server.id, server.reportedTimezone ?? server.location.timezone, now)
    if (wall === null) continue
    const connected = isAgentConnected(server.id)
    const playerDown = connected && now - (lastZoneReportAt.get(server.id) ?? bootAt) > PLAYER_SILENT_MS
    const loss = stateLossAt.get(server.id)
    stateLossAt.delete(server.id)
    const zones = server.zones.filter((z) => !z.leaderZoneId)
    const scheduled = zones.map((zone) => ({ zone, slot: winnerAt(zone.schedules, wall) })).filter((x) => x.slot !== null)

    if (checkAlerts && scheduled.length > 0) {
      const lastSeen = server.lastHeartbeatAt?.getTime() ?? 0
      if (!connected && now - lastSeen > OFFLINE_ALERT_MS && now - lastSeen < OFFLINE_ALERT_MAX_AGE_MS) {
        await raiseAlert(
          "critical",
          `${server.name} is offline`,
          `${server.name} has not been in contact since ${server.lastHeartbeatAt?.toISOString() ?? "unknown"} and has music scheduled now. Check the venue PC's power and internet.`,
          server.id,
          now
        )
      } else if (playerDown) {
        await raiseAlert(
          "critical",
          `Music player not running on ${server.name}`,
          `${server.name} is online but its music player has not reported its zones for over 3 minutes, while music is scheduled. Start Music Server on the venue PC.`,
          server.id,
          now
        )
      }
    }

    for (const zone of zones) {
      if (playerDown) markDropout(zone.id, now)
      if (loss !== undefined) markDropout(zone.id, loss)
    }
    if (!connected || playerDown) continue
    const pcTimeKnown = server.reportedTimezone !== null

    for (const zone of zones) {
      const slot = settledWinner(zone.schedules, wall)
      const prayerHold = zone.pausedByPrayer !== null || (zone.prayerModeEnabled && prayerOpen(zone.locationId, now))

      const d = dropouts.get(zone.id)
      if (
        d &&
        pcTimeKnown &&
        slot &&
        slot.repeat &&
        zone.playbackState === "STOPPED" &&
        !prayerHold &&
        now - d.lastOfflineAt >= SETTLE_MS &&
        d.attempts < MAX_ATTEMPTS &&
        now - d.lastAttemptAt >= RETRY_MS
      ) {
        if (await personStoppedSince(zone.id, Math.min(d.since - 30_000, (lastPlayingAt.get(zone.id) ?? d.since) - 60_000))) {
          dropouts.delete(zone.id)
        } else {
          d.attempts++
          d.lastAttemptAt = now
          await issuePlay(zone)
          if (d.attempts === 1) {
            await pushActivity({
              type: "PLAYBACK_CHANGED",
              message: `${zone.name} on ${server.name} stopped after a drop-out during "${slot.name}" — restarting it.`,
              serverId: server.id,
              zoneId: zone.id,
            })
          }
        }
      }

      if (!checkAlerts) continue
      if (!slot || !slot.repeat || zone.playbackState === "PLAYING" || prayerHold || missingNow.has(zone.id)) {
        notPlayingSince.delete(zone.id)
        continue
      }
      const np = notPlayingSince.get(zone.id)
      if (!np || np.slotId !== slot.id) {
        notPlayingSince.set(zone.id, { slotId: slot.id, since: now })
        continue
      }
      if (now - np.since < SILENT_ALERT_MS) continue
      if (await personStoppedSince(zone.id, (lastPlayingAt.get(zone.id) ?? now - PERSON_STOP_LOOKBACK_MS) - 60_000)) continue
      await raiseAlert(
        "warning",
        `${zone.name} on ${server.name} is silent`,
        `${zone.name} on ${server.name} has not been playing for over 5 minutes during its schedule "${slot.name}" (${slot.startTime}–${slot.endTime}).`,
        server.id,
        now
      )
    }
  }

  for (const [id, d] of dropouts) if (now - d.lastOfflineAt > 24 * 60 * 60_000) dropouts.delete(id)
  for (const [id, at] of lastPlayingAt) if (now - at > 7 * 24 * 60 * 60_000) lastPlayingAt.delete(id)
  const known = new Set(servers.flatMap((sv) => sv.zones.map((z) => z.id)))
  for (const id of lastLiveState.keys()) if (!known.has(id)) lastLiveState.delete(id)
  for (const id of missingNow) if (!known.has(id)) missingNow.delete(id)
}

export function startZoneWatchdogSweep() {
  let busy = false
  let ticks = 0
  const timer = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      await sweep(Date.now(), ++ticks % 4 === 0)
    } catch (err) {
      console.warn("[zone-watchdog] failed:", err)
    } finally {
      busy = false
    }
  }, SWEEP_MS)
  timer.unref()
  return timer
}
