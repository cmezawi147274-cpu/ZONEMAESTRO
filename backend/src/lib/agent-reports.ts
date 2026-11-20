/**
 * Whitelist sanitizers for what the venue agent (kit 2026.11.20+) reports on
 * its heartbeat: PC health, remote-update status and its own clock offset.
 * Only the known keys are copied, each with a type and length check, so a
 * broken or hostile agent cannot store anything else.
 */

export type AgentHealth = {
  uptimeSeconds?: number
  musicServerVersion?: string
  bootTime?: string
  bootReason?: string
  lastSleep?: { at: string; reason: string | null } | null
  dvs?: { ok: boolean; devices: string[] } | null
  disk?: { drive: string; freeBytes: number; totalBytes: number; low: boolean }
  screenLock?: { installed: boolean }
}

export const UPDATE_STATES = ["idle", "checking", "downloading", "updating-music-server", "restarting", "error"] as const

export type AgentUpdateStatus = {
  enabled?: boolean
  auto?: boolean
  state?: (typeof UPDATE_STATES)[number]
  available?: { agent: string | null; musicServer: string | null }
  checkedAt?: string
  error?: string
  lastResult?: { version: string; fromVersion: string | null; outcome: "committed" | "rolled-back"; reason?: string; at: string }
}

export type DirectPcClock = { clockOffsetMs: number; rttMs: number; utcOffsetMinutes: number }

const MAX_REPORT_BYTES = 8192
const VERSION = /^\d+(\.\d+){1,3}$/

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0
const strOrNull = (v: unknown, max: number): string | null | undefined => (v === null || v === undefined ? null : isStr(v, max) ? v : undefined)

function finish<T extends object>(out: T): T | null {
  if (Object.keys(out).length === 0) return null
  return Buffer.byteLength(JSON.stringify(out), "utf8") > MAX_REPORT_BYTES ? null : out
}

export function sanitizeHealth(raw: unknown): AgentHealth | null {
  if (!isObject(raw)) return null
  const out: AgentHealth = {}
  if (isCount(raw.uptimeSeconds)) out.uptimeSeconds = raw.uptimeSeconds
  if (isStr(raw.musicServerVersion, 32) && VERSION.test(raw.musicServerVersion)) out.musicServerVersion = raw.musicServerVersion
  if (isStr(raw.bootTime, 40)) out.bootTime = raw.bootTime
  if (isStr(raw.bootReason, 200)) out.bootReason = raw.bootReason
  if (raw.lastSleep === null) out.lastSleep = null
  else if (isObject(raw.lastSleep) && isStr(raw.lastSleep.at, 40)) {
    const reason = strOrNull(raw.lastSleep.reason, 200)
    if (reason !== undefined) out.lastSleep = { at: raw.lastSleep.at, reason }
  }
  if (raw.dvs === null) out.dvs = null
  else if (isObject(raw.dvs) && typeof raw.dvs.ok === "boolean" && Array.isArray(raw.dvs.devices)) {
    const devices = raw.dvs.devices.filter((d): d is string => typeof d === "string").slice(0, 8).map((d) => d.slice(0, 120))
    out.dvs = { ok: raw.dvs.ok, devices }
  }
  const disk = raw.disk
  if (isObject(disk) && isStr(disk.drive, 8) && isCount(disk.freeBytes) && isCount(disk.totalBytes) && typeof disk.low === "boolean") {
    out.disk = { drive: disk.drive, freeBytes: disk.freeBytes, totalBytes: disk.totalBytes, low: disk.low }
  }
  if (isObject(raw.screenLock) && typeof raw.screenLock.installed === "boolean") out.screenLock = { installed: raw.screenLock.installed }
  return finish(out)
}

export function sanitizeUpdate(raw: unknown): AgentUpdateStatus | null {
  if (!isObject(raw)) return null
  const out: AgentUpdateStatus = {}
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled
  if (typeof raw.auto === "boolean") out.auto = raw.auto
  if (typeof raw.state === "string" && (UPDATE_STATES as readonly string[]).includes(raw.state)) out.state = raw.state as AgentUpdateStatus["state"]
  if (isObject(raw.available)) {
    const agent = strOrNull(raw.available.agent, 32)
    const musicServer = strOrNull(raw.available.musicServer, 32)
    if (agent !== undefined && musicServer !== undefined) out.available = { agent, musicServer }
  }
  if (isStr(raw.checkedAt, 40)) out.checkedAt = raw.checkedAt
  if (typeof raw.error === "string") out.error = raw.error.slice(0, 300)
  const r = raw.lastResult
  if (isObject(r) && isStr(r.version, 32) && (r.outcome === "committed" || r.outcome === "rolled-back") && isStr(r.at, 40)) {
    const fromVersion = strOrNull(r.fromVersion, 32)
    if (fromVersion !== undefined) {
      out.lastResult = { version: r.version, fromVersion, outcome: r.outcome, ...(typeof r.reason === "string" ? { reason: r.reason.slice(0, 300) } : {}), at: r.at }
    }
  }
  return finish(out)
}

/** body.pcClock as the agent measured it on its previous heartbeat, or null (absent on the first beat, or invalid). */
export function sanitizePcClock(raw: unknown): DirectPcClock | null {
  if (!isObject(raw)) return null
  const { clockOffsetMs, rttMs, utcOffsetMinutes } = raw
  if (typeof clockOffsetMs !== "number" || !Number.isFinite(clockOffsetMs) || Math.abs(clockOffsetMs) > 366 * 86_400_000) return null
  if (typeof rttMs !== "number" || !Number.isFinite(rttMs) || rttMs < 0 || rttMs > 30_000) return null
  if (typeof utcOffsetMinutes !== "number" || !Number.isInteger(utcOffsetMinutes) || utcOffsetMinutes < -840 || utcOffsetMinutes > 840) return null
  return { clockOffsetMs, rttMs, utcOffsetMinutes }
}
