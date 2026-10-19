import type { SubscriptionRecord } from "@/components/subscription/api"

export const DAY_MS = 86_400_000
export const REMINDER_DAYS = [90, 30, 7, 1] as const

export type Band = "active" | "attention" | "warning" | "critical" | "ended"

export const BAND_LABEL: Record<Band, string> = {
  active: "Active",
  attention: "Attention",
  warning: "Warning",
  critical: "Critical",
  ended: "Ended",
}

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

export function formatSpan(span: Span): string {
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`
  return [part(span.months, "month"), part(span.days, "day"), part(span.hours, "hour"), part(span.minutes, "minute")].join(", ")
}

export function bandFor(remainingMs: number): Band {
  if (remainingMs <= 0) return "ended"
  const days = Math.ceil(remainingMs / DAY_MS)
  if (days <= 7) return "critical"
  if (days <= 30) return "warning"
  if (days <= 90) return "attention"
  return "active"
}

export function formatUTC(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

export interface Mark {
  label: string
  percent: number
}

export interface Derived {
  band: Band
  remainingMs: number
  countdown: Span
  elapsed: Span
  percent: number
  marks: Mark[]
  clockBehind: boolean
  banner: number | null
}

export function derive(startedAt: string, endsAt: string, now: string, record?: Pick<SubscriptionRecord, "reminderDays" | "dismissed" | "terms">): Derived {
  const start = new Date(startedAt).getTime()
  const end = new Date(endsAt).getTime()
  const at = new Date(now).getTime()
  const total = Math.max(end - start, 1)
  const remainingMs = end - at
  const position = (t: number) => Math.min(100, Math.max(0, ((t - start) / total) * 100))
  const clockBehind = at < start

  let banner: number | null = null
  if (record && remainingMs > 0) {
    const term = record.terms.length
    const open = REMINDER_DAYS.filter(
      (d) =>
        record.reminderDays.includes(d) &&
        remainingMs <= d * DAY_MS &&
        !record.dismissed.some((x) => x.term === term && x.threshold === d)
    )
    if (open.length) banner = open[open.length - 1]
  }

  return {
    band: bandFor(remainingMs),
    remainingMs,
    countdown: spanBetween(new Date(at), new Date(end)),
    elapsed: clockBehind ? { months: 0, days: 0, hours: 0, minutes: 0 } : spanBetween(new Date(start), new Date(Math.min(at, end))),
    percent: clockBehind ? 0 : position(at),
    marks: [
      { label: "25%", percent: 25 },
      { label: "50%", percent: 50 },
      { label: "75%", percent: 75 },
      { label: "30 days left", percent: position(end - 30 * DAY_MS) },
      { label: "7 days left", percent: position(end - 7 * DAY_MS) },
      { label: "End", percent: 100 },
    ],
    clockBehind,
    banner,
  }
}

export function buildSummary(record: SubscriptionRecord, now: string): string {
  const d = derive(record.startedAt, record.endsAt, now)
  const lines = [
    `Subscription summary: ${record.serverLabel}`,
    `Record: ${record.id}`,
    `Status: ${BAND_LABEL[d.band]}`,
    `Start: ${formatUTC(record.startedAt)}`,
    `End: ${formatUTC(record.endsAt)}`,
    `Time left: ${d.remainingMs > 0 ? formatSpan(d.countdown) : "Ended"}`,
    `As of: ${formatUTC(now)}`,
    "",
    "Term history",
    ...record.terms.map((t) => {
      const by = t.confirmedBy.type === "user" ? t.confirmedBy.email : t.confirmedBy.label
      return `${t.index}. ${formatUTC(t.startedAt)} to ${formatUTC(t.endsAt)} (${t.reason}), confirmed by ${by}`
    }),
  ]
  return lines.join("\n") + "\n"
}
