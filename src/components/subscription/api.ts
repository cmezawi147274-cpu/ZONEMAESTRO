import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { addCalendarMonthsUTC, buildSummary } from "@/components/subscription/derive"

export interface SubscriptionTerm {
  index: number
  startedAt: string
  endsAt: string
  reason: "initial" | "renewal"
  confirmedBy: { type: "system"; label: string } | { type: "user"; userId: string; email: string }
}

export interface SubscriptionEvent {
  id: string
  type: string
  at: string
  term: number
  threshold?: string
  crossedAt?: string
  format?: string
  by?: { userId: string; email: string }
  reminderDays?: number[]
  previousEndsAt?: string
  endsAt?: string
}

export interface SubscriptionRecord {
  id: string
  serverLabel: string
  startedAt: string
  endsAt: string
  status: string
  createdByConnection: Record<string, unknown>
  terms: SubscriptionTerm[]
  events: SubscriptionEvent[]
  notes: string
  reminderDays: number[]
  dismissed: { term: number; threshold: number; at: string }[]
  connectionCount: number
  lastConnectionAt: string
}

export interface SubscriptionResponse {
  record: SubscriptionRecord | null
  now: string
}

export interface SubscriptionClock {
  endsAt: string | null
  now: string
}

export interface SubscriptionExport {
  filename: string
  contentType: string
  content: string
}

const DEMO_ACTOR = { userId: "demo", email: "demo@zonemaestro.local" }
let demoRecord: SubscriptionRecord | null = null

function demo(): SubscriptionRecord {
  if (!demoRecord) {
    const startedAt = new Date(Date.now() - 45 * 86_400_000)
    const endsAt = addCalendarMonthsUTC(startedAt, 12)
    demoRecord = {
      id: "demo-subscription",
      serverLabel: "demo.zonemaestro.local",
      startedAt: startedAt.toISOString(),
      endsAt: endsAt.toISOString(),
      status: "active",
      createdByConnection: { source: "hub", serverName: "DEMO-SERVER", at: startedAt.toISOString() },
      terms: [
        {
          index: 1,
          startedAt: startedAt.toISOString(),
          endsAt: endsAt.toISOString(),
          reason: "initial",
          confirmedBy: { type: "system", label: "First venue connection" },
        },
      ],
      events: [{ id: "demo-created", type: "created", at: startedAt.toISOString(), term: 1 }],
      notes: "",
      reminderDays: [90, 30, 7, 1],
      dismissed: [],
      connectionCount: 1,
      lastConnectionAt: startedAt.toISOString(),
    }
  }
  return demoRecord
}

function demoEvent(type: string, extra: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  const record = demo()
  return { id: `demo-${type}-${record.events.length}`, type, at: new Date().toISOString(), term: record.terms.length, ...extra }
}

function demoResponse(): SubscriptionResponse {
  return { record: { ...demo() }, now: new Date().toISOString() }
}

export const subscriptionApi = {
  async get(): Promise<SubscriptionResponse> {
    if (isMockMode) {
      await delay(200)
      return demoResponse()
    }
    return apiClient.get<SubscriptionResponse>("/subscription")
  },

  async clock(): Promise<SubscriptionClock> {
    if (isMockMode) return { endsAt: demo().endsAt, now: new Date().toISOString() }
    return apiClient.get<SubscriptionClock>("/subscription/clock")
  },

  async saveNotes(notes: string): Promise<SubscriptionResponse> {
    if (isMockMode) {
      await delay(200)
      const record = demo()
      record.notes = notes
      record.events = [...record.events, demoEvent("note_saved", { by: DEMO_ACTOR })]
      return demoResponse()
    }
    return apiClient.put<SubscriptionResponse>("/subscription/notes", { notes })
  },

  async saveReminders(reminderDays: number[]): Promise<SubscriptionResponse> {
    if (isMockMode) {
      await delay(200)
      const record = demo()
      record.reminderDays = reminderDays
      record.events = [...record.events, demoEvent("reminders_saved", { by: DEMO_ACTOR, reminderDays })]
      return demoResponse()
    }
    return apiClient.put<SubscriptionResponse>("/subscription/reminders", { reminderDays })
  },

  async dismissBanner(days: number): Promise<SubscriptionResponse> {
    if (isMockMode) {
      await delay(150)
      const record = demo()
      const term = record.terms.length
      if (!record.dismissed.some((d) => d.term === term && d.threshold === days)) {
        record.dismissed = [...record.dismissed, { term, threshold: days, at: new Date().toISOString() }]
      }
      return demoResponse()
    }
    return apiClient.post<SubscriptionResponse>(`/subscription/banners/${days}/dismiss`)
  },

  async exportFile(format: "json" | "text"): Promise<SubscriptionExport> {
    if (isMockMode) {
      await delay(150)
      const record = demo()
      record.events = [...record.events, demoEvent("exported", { by: DEMO_ACTOR, format })]
      const now = new Date()
      const date = now.toISOString().slice(0, 10)
      return format === "json"
        ? { filename: `subscription-${date}.json`, contentType: "application/json", content: JSON.stringify(record, null, 2) + "\n" }
        : { filename: `subscription-${date}.txt`, contentType: "text/plain", content: buildSummary(record, now.toISOString()) }
    }
    return apiClient.post<SubscriptionExport>("/subscription/export", { format })
  },

  async renew(confirmEndDate: string): Promise<SubscriptionResponse> {
    if (isMockMode) {
      await delay(300)
      const record = demo()
      if (record.endsAt.slice(0, 10) !== confirmEndDate) throw new Error("The date you typed does not match the current end date.")
      const now = new Date()
      const start = new Date(record.endsAt) > now ? new Date(record.endsAt) : now
      const end = addCalendarMonthsUTC(start, 12)
      const index = record.terms.length + 1
      record.terms = [
        ...record.terms,
        { index, startedAt: start.toISOString(), endsAt: end.toISOString(), reason: "renewal", confirmedBy: { type: "user", ...DEMO_ACTOR } },
      ]
      record.events = [
        ...record.events,
        { ...demoEvent("renewal_confirmed", { by: DEMO_ACTOR, previousEndsAt: record.endsAt, endsAt: end.toISOString() }), term: index },
      ]
      record.endsAt = end.toISOString()
      return demoResponse()
    }
    return apiClient.post<SubscriptionResponse>("/subscription/renew", { confirmEndDate })
  },
}
