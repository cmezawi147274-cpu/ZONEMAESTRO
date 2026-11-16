import { sendSubscriptionReminderEmail } from "../lib/mailer.js"
import { logFailure } from "./hooks.js"
import { listServers, readAllRecords, recordReminderEmailed, type SubscriptionRecord } from "./store.js"
import { DAY_MS, REMINDER_DAYS, formatSpan, formatUTC, spanBetween } from "./time.js"

export const REMINDER_EMAIL_TO = "accounts@smartsolutionsme.com"
const SWEEP_MS = 15 * 60_000

/**
 * The reminder to email for this record right now, if any: the most urgent
 * enabled threshold (90/30/7/1 days) already reached and not yet emailed for
 * the current end date. `thresholds` is every reached one, all marked sent
 * together so a late start never emails 90, 30 and 7 in one go.
 */
export function dueReminder(
  record: Pick<SubscriptionRecord, "endsAt" | "reminderDays" | "events">,
  now: number
): { threshold: number; thresholds: number[] } | null {
  const remainingMs = new Date(record.endsAt).getTime() - now
  if (remainingMs <= 0) return null
  const crossed = REMINDER_DAYS.filter((d) => record.reminderDays.includes(d) && remainingMs <= d * DAY_MS)
  if (!crossed.length) return null
  const threshold = crossed[crossed.length - 1]
  const sent = record.events.some(
    (e) => e.type === "reminder_emailed" && e.endsAt === record.endsAt && Array.isArray(e.thresholds) && e.thresholds.includes(threshold)
  )
  return sent ? null : { threshold, thresholds: [...crossed] }
}

async function sweep(now: Date): Promise<void> {
  const [records, servers] = await Promise.all([readAllRecords(), listServers()])
  const byId = new Map(servers.map((s) => [s.serverId, s]))
  for (const record of records) {
    const server = byId.get(record.serverId)
    if (!server) continue
    const due = dueReminder(record, now.getTime())
    if (!due) continue
    const sent = await sendSubscriptionReminderEmail({
      to: REMINDER_EMAIL_TO,
      threshold: due.threshold,
      serverName: server.name,
      organizationName: server.organizationName,
      endsAt: formatUTC(record.endsAt),
      timeLeft: formatSpan(spanBetween(now, new Date(record.endsAt))),
      link: `/subscription/${encodeURIComponent(record.serverId)}`,
    })
    if (!sent) {
      logFailure(`could not email the ${due.threshold} day reminder for ${record.serverId}`, "send failed")
      continue
    }
    await recordReminderEmailed(record.serverId, due.thresholds, REMINDER_EMAIL_TO, record.endsAt, now)
  }
}

export function startSubscriptionReminderEmailSweep() {
  let busy = false
  const timer = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      await sweep(new Date())
    } catch (err) {
      logFailure("reminder email sweep failed", err)
    } finally {
      busy = false
    }
  }, SWEEP_MS)
  timer.unref()
  return timer
}
