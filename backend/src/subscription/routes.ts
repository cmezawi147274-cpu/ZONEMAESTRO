import type { FastifyInstance, FastifyRequest } from "fastify"
import { requireAuth, requireUser } from "../lib/auth-context.js"
import { badRequest, forbidden, notFound, HttpError } from "../lib/http-error.js"
import * as store from "./store.js"
import { logFailure, recordRestart } from "./hooks.js"
import { BAND_LABEL, REMINDER_DAYS, bandFor, formatSpan, formatUTC, spanBetween } from "./time.js"

const MAX_NOTES = 10_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function superAdmin(request: FastifyRequest): store.Actor {
  const user = requireUser(request)
  if (user.role !== "SUPER_ADMIN") throw forbidden()
  return { userId: user.id, email: user.email }
}

async function guarded<T>(what: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (err) {
    if (err instanceof HttpError) throw err
    logFailure(what, err)
    throw new HttpError(503, "SUBSCRIPTION_UNAVAILABLE", "Subscription data is unavailable right now.")
  }
}

async function requireRecord(record: store.SubscriptionRecord | null): Promise<store.SubscriptionRecord> {
  if (record) return record
  const current = await store.readRecord()
  if (!current) throw notFound("Subscription")
  return current
}

function summary(record: store.SubscriptionRecord, now: Date): string {
  const end = new Date(record.endsAt)
  const remaining = end.getTime() - now.getTime()
  const lines = [
    `Subscription summary: ${record.serverLabel}`,
    `Record: ${record.id}`,
    `Status: ${BAND_LABEL[bandFor(remaining)]}`,
    `Start: ${formatUTC(record.startedAt)}`,
    `End: ${formatUTC(record.endsAt)}`,
    `Time left: ${remaining > 0 ? formatSpan(spanBetween(now, end)) : "Ended"}`,
    `As of: ${formatUTC(now.toISOString())}`,
    "",
    "Term history",
    ...record.terms.map((t) => {
      const by = t.confirmedBy.type === "user" ? t.confirmedBy.email : t.confirmedBy.label
      return `${t.index}. ${formatUTC(t.startedAt)} to ${formatUTC(t.endsAt)} (${t.reason}), confirmed by ${by}`
    }),
  ]
  return lines.join("\n") + "\n"
}

export default async function subscriptionRoutes(app: FastifyInstance) {
  try {
    setImmediate(() => {
      void recordRestart()
    })

    app.addHook("preHandler", requireAuth)

    app.get("/subscription", async (request, reply) => {
      superAdmin(request)
      const record = await guarded("could not read the subscription", () => store.readRecord())
      return reply.send({ record, now: new Date().toISOString() })
    })

    app.get("/subscription/clock", async (request, reply) => {
      superAdmin(request)
      const endsAt = await guarded("could not read the subscription end", () => store.readEndsAt())
      return reply.send({ endsAt, now: new Date().toISOString() })
    })

    app.put<{ Body: { notes?: unknown } }>("/subscription/notes", async (request, reply) => {
      const actor = superAdmin(request)
      const notes = request.body?.notes
      if (typeof notes !== "string") throw badRequest("notes must be a string.")
      if (notes.length > MAX_NOTES) throw badRequest(`notes must be at most ${MAX_NOTES} characters.`)
      const record = await guarded("could not save the note", async () => requireRecord(await store.saveNotes(notes, actor, new Date())))
      return reply.send({ record, now: new Date().toISOString() })
    })

    app.put<{ Body: { reminderDays?: unknown } }>("/subscription/reminders", async (request, reply) => {
      const actor = superAdmin(request)
      const days = request.body?.reminderDays
      if (!Array.isArray(days) || days.some((d) => !REMINDER_DAYS.includes(d as (typeof REMINDER_DAYS)[number]))) {
        throw badRequest(`reminderDays must only contain ${REMINDER_DAYS.join(", ")}.`)
      }
      const reminderDays = REMINDER_DAYS.filter((d) => days.includes(d))
      const record = await guarded("could not save the reminders", async () =>
        requireRecord(await store.saveReminders(reminderDays, actor, new Date()))
      )
      return reply.send({ record, now: new Date().toISOString() })
    })

    app.post<{ Params: { days: string } }>("/subscription/banners/:days/dismiss", async (request, reply) => {
      superAdmin(request)
      const threshold = Number(request.params.days)
      if (!REMINDER_DAYS.includes(threshold as (typeof REMINDER_DAYS)[number])) {
        throw badRequest(`Only the ${REMINDER_DAYS.join(", ")} day banners can be dismissed.`)
      }
      const record = await guarded("could not dismiss the banner", async () =>
        requireRecord(await store.dismissBanner(threshold, new Date()))
      )
      return reply.send({ record, now: new Date().toISOString() })
    })

    app.post<{ Body: { format?: unknown } }>("/subscription/export", async (request, reply) => {
      const actor = superAdmin(request)
      const format = request.body?.format
      if (format !== "json" && format !== "text") throw badRequest('format must be "json" or "text".')
      const now = new Date()
      const record = await guarded("could not export the subscription", async () => {
        const updated = await store.appendExport(format, actor, now)
        if (!updated) throw notFound("Subscription")
        return updated
      })
      const date = now.toISOString().slice(0, 10)
      return reply.send(
        format === "json"
          ? { filename: `subscription-${date}.json`, contentType: "application/json", content: JSON.stringify(record, null, 2) + "\n" }
          : { filename: `subscription-${date}.txt`, contentType: "text/plain", content: summary(record, now) }
      )
    })

    app.post<{ Body: { confirmEndDate?: unknown } }>("/subscription/renew", async (request, reply) => {
      const actor = superAdmin(request)
      const typed = request.body?.confirmEndDate
      if (typeof typed !== "string" || !DATE_RE.test(typed)) throw badRequest("Type the current end date as YYYY-MM-DD.")
      const record = await guarded("could not renew the subscription", async () => {
        const renewed = await store.renew(typed, actor, new Date())
        if (renewed) return renewed
        const current = await store.readRecord()
        if (!current) throw notFound("Subscription")
        throw badRequest("The date you typed does not match the current end date.")
      })
      return reply.send({ record, now: new Date().toISOString() })
    })
  } catch (err) {
    logFailure("could not register routes", err)
  }
}
