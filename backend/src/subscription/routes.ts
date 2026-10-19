import type { FastifyInstance, FastifyRequest } from "fastify"
import { requireAuth, requireUser } from "../lib/auth-context.js"
import { badRequest, forbidden, notFound, HttpError } from "../lib/http-error.js"
import * as store from "./store.js"
import { logFailure, recordRestart } from "./hooks.js"
import {
  REMINDER_DAYS,
  STATUS_LABEL,
  compareFleet,
  formatSpan,
  formatUTC,
  spanBetween,
  statusFor,
  type FleetStatus,
} from "./time.js"

const MAX_NOTES = 10_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MIN_MONTHS = 1
const MAX_MONTHS = 60

type Params = { serverId: string }

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

async function requireServer(serverId: string): Promise<store.ServerInfo> {
  const server = await store.readServer(serverId)
  if (!server) throw notFound("Server")
  return server
}

async function requireRecord(serverId: string, record: store.SubscriptionRecord | null): Promise<store.SubscriptionRecord> {
  if (record) return record
  const current = await store.readRecord(serverId)
  if (!current) throw notFound("Subscription")
  return current
}

interface FleetRow {
  serverId: string
  name: string
  organizationId: string
  organizationName: string | null
  serverStatus: string
  status: FleetStatus
  startedAt: string | null
  endsAt: string | null
  connectionCount: number
  lastConnectionAt: string | null
}

function summarize(rows: FleetRow[]) {
  const count = (s: FleetStatus) => rows.filter((r) => r.status === s).length
  return {
    total: rows.length,
    notStarted: count("not_started"),
    active: count("active"),
    attention: count("attention"),
    warning: count("warning"),
    critical: count("critical"),
    ended: count("ended"),
  }
}

async function fleet(now: Date) {
  const [servers, records] = [await store.listServers(), await store.readAllRecords()]
  const byServer = new Map(records.map((r) => [r.serverId, r]))
  const rows: FleetRow[] = servers.map((s) => {
    const record = byServer.get(s.serverId) ?? null
    return {
      ...s,
      status: statusFor(record?.endsAt, now),
      startedAt: record?.startedAt ?? null,
      endsAt: record?.endsAt ?? null,
      connectionCount: record?.connectionCount ?? 0,
      lastConnectionAt: record?.lastConnectionAt ?? null,
    }
  })
  rows.sort(compareFleet)
  return { rows, summary: summarize(rows) }
}

function fleetText(rows: FleetRow[], summary: ReturnType<typeof summarize>, now: Date): string {
  const cell = (v: string | null) => (v ? formatUTC(v) : "-")
  const lines = [
    "Subscription fleet summary",
    `As of: ${formatUTC(now.toISOString())}`,
    "",
    `Total: ${summary.total}`,
    `Not started: ${summary.notStarted}`,
    `Active: ${summary.active}`,
    `Attention: ${summary.attention}`,
    `Warning: ${summary.warning}`,
    `Critical: ${summary.critical}`,
    `Ended: ${summary.ended}`,
    "",
    "Server | Organization | Status | Start | End",
    ...rows.map((r) => [r.name, r.organizationName ?? "-", STATUS_LABEL[r.status], cell(r.startedAt), cell(r.endsAt)].join(" | ")),
  ]
  return lines.join("\n") + "\n"
}

function serverText(server: store.ServerInfo, record: store.SubscriptionRecord, now: Date): string {
  const end = new Date(record.endsAt)
  const remaining = end.getTime() - now.getTime()
  const lines = [
    `Subscription summary: ${server.name}`,
    `Organization: ${server.organizationName ?? "-"}`,
    `Record: ${record.id}`,
    `Status: ${STATUS_LABEL[statusFor(record.endsAt, now)]}`,
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

const fileSafe = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "server"

export default async function subscriptionRoutes(app: FastifyInstance) {
  try {
    setImmediate(() => {
      void recordRestart()
    })

    app.addHook("preHandler", requireAuth)

    app.get("/subscription/servers", async (request, reply) => {
      superAdmin(request)
      const now = new Date()
      const { rows, summary } = await guarded("could not read the fleet", () => fleet(now))
      return reply.send({ now: now.toISOString(), summary, servers: rows })
    })

    app.get("/subscription/export", async (request, reply) => {
      superAdmin(request)
      const now = new Date()
      const { rows, summary } = await guarded("could not export the fleet summary", () => fleet(now))
      return reply.send({
        filename: `subscription-fleet-${now.toISOString().slice(0, 10)}.txt`,
        contentType: "text/plain",
        content: fleetText(rows, summary, now),
      })
    })

    app.get<{ Params: Params }>("/subscription/servers/:serverId", async (request, reply) => {
      superAdmin(request)
      const { server, record } = await guarded("could not read the server subscription", async () => {
        const server = await requireServer(request.params.serverId)
        return { server, record: await store.readRecord(server.serverId) }
      })
      return reply.send({ server, record, now: new Date().toISOString() })
    })

    app.get<{ Params: Params }>("/subscription/servers/:serverId/clock", async (request, reply) => {
      superAdmin(request)
      const endsAt = await guarded("could not read the subscription end", async () => {
        const { serverId } = await requireServer(request.params.serverId)
        return store.readEndsAt(serverId)
      })
      return reply.send({ endsAt, now: new Date().toISOString() })
    })

    app.put<{ Params: Params; Body: { notes?: unknown } }>("/subscription/servers/:serverId/notes", async (request, reply) => {
      const actor = superAdmin(request)
      const notes = request.body?.notes
      if (typeof notes !== "string") throw badRequest("notes must be a string.")
      if (notes.length > MAX_NOTES) throw badRequest(`notes must be at most ${MAX_NOTES} characters.`)
      const record = await guarded("could not save the note", async () => {
        const { serverId } = await requireServer(request.params.serverId)
        return requireRecord(serverId, await store.saveNotes(serverId, notes, actor, new Date()))
      })
      return reply.send({ record, now: new Date().toISOString() })
    })

    app.put<{ Params: Params; Body: { reminderDays?: unknown } }>("/subscription/servers/:serverId/reminders", async (request, reply) => {
      const actor = superAdmin(request)
      const days = request.body?.reminderDays
      if (!Array.isArray(days) || days.some((d) => !REMINDER_DAYS.includes(d as (typeof REMINDER_DAYS)[number]))) {
        throw badRequest(`reminderDays must only contain ${REMINDER_DAYS.join(", ")}.`)
      }
      const reminderDays = REMINDER_DAYS.filter((d) => days.includes(d))
      const record = await guarded("could not save the reminders", async () => {
        const { serverId } = await requireServer(request.params.serverId)
        return requireRecord(serverId, await store.saveReminders(serverId, reminderDays, actor, new Date()))
      })
      return reply.send({ record, now: new Date().toISOString() })
    })

    app.post<{ Params: Params & { days: string } }>("/subscription/servers/:serverId/banners/:days/dismiss", async (request, reply) => {
      superAdmin(request)
      const threshold = Number(request.params.days)
      if (!REMINDER_DAYS.includes(threshold as (typeof REMINDER_DAYS)[number])) {
        throw badRequest(`Only the ${REMINDER_DAYS.join(", ")} day banners can be dismissed.`)
      }
      const record = await guarded("could not dismiss the banner", async () => {
        const { serverId } = await requireServer(request.params.serverId)
        return requireRecord(serverId, await store.dismissBanner(serverId, threshold, new Date()))
      })
      return reply.send({ record, now: new Date().toISOString() })
    })

    app.post<{ Params: Params; Body: { format?: unknown } }>("/subscription/servers/:serverId/export", async (request, reply) => {
      const actor = superAdmin(request)
      const format = request.body?.format
      if (format !== "json" && format !== "text") throw badRequest('format must be "json" or "text".')
      const now = new Date()
      const { server, record } = await guarded("could not export the server subscription", async () => {
        const server = await requireServer(request.params.serverId)
        const record = await store.appendExport(server.serverId, format, actor, now)
        if (!record) throw notFound("Subscription")
        return { server, record }
      })
      const base = `subscription-${fileSafe(server.name)}-${now.toISOString().slice(0, 10)}`
      return reply.send(
        format === "json"
          ? {
              filename: `${base}.json`,
              contentType: "application/json",
              content: JSON.stringify({ server: { serverId: server.serverId, name: server.name, organization: server.organizationName }, record }, null, 2) + "\n",
            }
          : { filename: `${base}.txt`, contentType: "text/plain", content: serverText(server, record, now) }
      )
    })

    app.post<{ Params: Params; Body: { confirmEndDate?: unknown } }>("/subscription/servers/:serverId/renew", async (request, reply) => {
      const actor = superAdmin(request)
      const typed = request.body?.confirmEndDate
      if (typeof typed !== "string" || !DATE_RE.test(typed)) throw badRequest("Type the current end date as YYYY-MM-DD.")
      const record = await guarded("could not renew the subscription", async () => {
        const { serverId } = await requireServer(request.params.serverId)
        const renewed = await store.renew(serverId, typed, actor, new Date())
        if (renewed) return renewed
        const current = await store.readRecord(serverId)
        if (!current) throw notFound("Subscription")
        throw badRequest("The date you typed does not match the current end date.")
      })
      return reply.send({ record, now: new Date().toISOString() })
    })

    app.put<{ Params: Params; Body: { months?: unknown; confirmEndDate?: unknown } }>("/subscription/servers/:serverId/duration", async (request, reply) => {
      const actor = superAdmin(request)
      const months = request.body?.months
      if (typeof months !== "number" || !Number.isInteger(months) || months < MIN_MONTHS || months > MAX_MONTHS) {
        throw badRequest(`months must be a whole number from ${MIN_MONTHS} to ${MAX_MONTHS}.`)
      }
      const typed = request.body?.confirmEndDate
      if (typeof typed !== "string" || !DATE_RE.test(typed)) throw badRequest("Type the current end date as YYYY-MM-DD.")
      const record = await guarded("could not change the duration", async () => {
        const { serverId } = await requireServer(request.params.serverId)
        const changed = await store.changeDuration(serverId, months, typed, actor, new Date())
        if (changed) return changed
        const current = await store.readRecord(serverId)
        if (!current) throw notFound("Subscription")
        throw badRequest("The date you typed does not match the current end date.")
      })
      return reply.send({ record, now: new Date().toISOString() })
    })
  } catch (err) {
    logFailure("could not register routes", err)
  }
}
