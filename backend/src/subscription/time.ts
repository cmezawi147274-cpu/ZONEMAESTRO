export const DAY_MS = 86_400_000
export const REMINDER_DAYS = [90, 30, 7, 1] as const

export type Band = "active" | "attention" | "warning" | "critical" | "ended"

export function addCalendarMonthsUTC(date: Date, months: number): Date {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + months
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  )
}

export interface Span {
  months: number
  days: number
  hours: number
  minutes: number
}

export function spanBetween(from: Date, to: Date): Span {
  if (to.getTime() <= from.getTime()) return { months: 0, days: 0, hours: 0, minutes: 0 }
  let months = 0
  while (addCalendarMonthsUTC(from, months + 1).getTime() <= to.getTime()) months++
  let rest = to.getTime() - addCalendarMonthsUTC(from, months).getTime()
  const days = Math.floor(rest / DAY_MS)
  rest -= days * DAY_MS
  const hours = Math.floor(rest / 3_600_000)
  rest -= hours * 3_600_000
  return { months, days, hours, minutes: Math.floor(rest / 60_000) }
}

export function bandFor(remainingMs: number): Band {
  if (remainingMs <= 0) return "ended"
  const days = Math.ceil(remainingMs / DAY_MS)
  if (days <= 7) return "critical"
  if (days <= 30) return "warning"
  if (days <= 90) return "attention"
  return "active"
}

export const BAND_LABEL: Record<Band, string> = {
  active: "Active",
  attention: "Attention",
  warning: "Warning",
  critical: "Critical",
  ended: "Ended",
}

export type FleetStatus = Band | "not_started"

export const STATUS_ORDER: FleetStatus[] = ["ended", "critical", "warning", "attention", "active", "not_started"]

export const STATUS_LABEL: Record<FleetStatus, string> = { ...BAND_LABEL, not_started: "Not started" }

export function statusFor(endsAt: string | null | undefined, now: Date): FleetStatus {
  return endsAt ? bandFor(new Date(endsAt).getTime() - now.getTime()) : "not_started"
}

export function compareFleet(a: { status: FleetStatus; name: string }, b: { status: FleetStatus; name: string }): number {
  const byStatus = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
  return byStatus !== 0 ? byStatus : a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
}

export function formatSpan(span: Span): string {
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`
  return [part(span.months, "month"), part(span.days, "day"), part(span.hours, "hour"), part(span.minutes, "minute")].join(", ")
}

export function formatUTC(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}
