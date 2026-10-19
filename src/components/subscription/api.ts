import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { addCalendarMonthsUTC, buildFleetSummary, buildSummary, fleetRows, summarizeFleet, type FleetStatus } from "@/components/subscription/derive"

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
  note?: string
  by?: { userId: string; email: string }
  reminderDays?: number[]
  previousEndsAt?: string
  endsAt?: string
}

export interface SubscriptionRecord {
  serverId: string
  id: string
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

export interface ServerInfo {
  serverId: string
  name: string
  organizationId: string
  organizationName: string | null
  serverStatus: string
}

export interface FleetServer extends ServerInfo {
  status: FleetStatus
  startedAt: string | null
  endsAt: string | null
  connectionCount: number
  lastConnectionAt: string | null
}

export interface FleetSummary {
  total: number
  notStarted: number
  active: number
  attention: number
  warning: number
  critical: number
  ended: number
}

export interface FleetResponse {
  now: string
  summary: FleetSummary
  servers: FleetServer[]
}

export interface ServerResponse {
  server: ServerInfo
  record: SubscriptionRecord | null
  now: string
}

export interface RecordResponse {
  record: SubscriptionRecord
  now: string
}

export interface SubscriptionClock {
  endsAt: string | null
  now: string
}

export interface SubscriptionFile {
  filename: string
  contentType: string
  content: string
}

const DEMO_ACTOR = { userId: "demo", email: "demo@zonemaestro.local" }
const DEMO_SERVERS: ServerInfo[] = [
  { serverId: "demo-1", name: "DEMO-SERVER", organizationId: "demo-org", organizationName: "Demo Org", serverStatus: "ONLINE" },
  { serverId: "demo-2", name: "Lobby Player", organizationId: "demo-org", organizationName: "Demo Org", serverStatus: "ONLINE" },
  { serverId: "demo-3", name: "Rooftop", organizationId: "demo-org-2", organizationName: "Second Demo Org", serverStatus: "OFFLINE" },
]
let demoRecords: Map<string, SubscriptionRecord> | null = null

function demoRecord(serverId: string, daysAgo: number): SubscriptionRecord {
  const startedAt = new Date(Date.now() - daysAgo * 86_400_000)
  const endsAt = addCalendarMonthsUTC(startedAt, 12)
  return {
    serverId,
    id: `demo-subscription-${serverId}`,
    startedAt: startedAt.toISOString(),
    endsAt: endsAt.toISOString(),
    status: "active",
    createdByConnection: { source: "hub", serverId, at: startedAt.toISOString() },
    terms: [
      { index: 1, startedAt: startedAt.toISOString(), endsAt: endsAt.toISOString(), reason: "initial", confirmedBy: { type: "system", label: "First venue connection" } },
    ],
    events: [{ id: `demo-created-${serverId}`, type: "created", at: startedAt.toISOString(), term: 1 }],
    notes: "",
    reminderDays: [90, 30, 7, 1],
    dismissed: [],
    connectionCount: 1,
    lastConnectionAt: startedAt.toISOString(),
  }
}

function demo(): Map<string, SubscriptionRecord> {
  if (!demoRecords) {
    demoRecords = new Map([
      ["demo-1", demoRecord("demo-1", 45)],
      ["demo-2", demoRecord("demo-2", 300)],
    ])
  }
  return demoRecords
}

function demoRequire(serverId: string): SubscriptionRecord {
  const record = demo().get(serverId)
  if (!record) throw new Error("This server has not started a subscription yet.")
  return record
}

function demoEvent(record: SubscriptionRecord, type: string, extra: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  return { id: `demo-${type}-${record.events.length}`, type, at: new Date().toISOString(), term: record.terms.length, ...extra }
}

function demoResponse(record: SubscriptionRecord): RecordResponse {
  return { record: { ...record }, now: new Date().toISOString() }
}

function demoFleet(): FleetResponse {
  const now = new Date().toISOString()
  const servers = fleetRows(DEMO_SERVERS, [...demo().values()], now)
  return { now, summary: summarizeFleet(servers), servers }
}

export const subscriptionApi = {
  async fleet(): Promise<FleetResponse> {
    if (isMockMode) {
      await delay(200)
      return demoFleet()
    }
    return apiClient.get<FleetResponse>("/subscription/servers")
  },

  async exportFleet(): Promise<SubscriptionFile> {
    if (isMockMode) {
      await delay(150)
      const fleet = demoFleet()
      return {
        filename: `subscription-fleet-${fleet.now.slice(0, 10)}.txt`,
        contentType: "text/plain",
        content: buildFleetSummary(fleet.servers, fleet.summary, fleet.now, "demo.zonemaestro.local"),
      }
    }
    return apiClient.get<SubscriptionFile>("/subscription/export")
  },

  async server(serverId: string): Promise<ServerResponse> {
    if (isMockMode) {
      await delay(200)
      const server = DEMO_SERVERS.find((s) => s.serverId === serverId)
      if (!server) throw new Error("Server not found.")
      const record = demo().get(serverId)
      return { server, record: record ? { ...record } : null, now: new Date().toISOString() }
    }
    return apiClient.get<ServerResponse>(`/subscription/servers/${encodeURIComponent(serverId)}`)
  },

  async clock(serverId: string): Promise<SubscriptionClock> {
    if (isMockMode) return { endsAt: demo().get(serverId)?.endsAt ?? null, now: new Date().toISOString() }
    return apiClient.get<SubscriptionClock>(`/subscription/servers/${encodeURIComponent(serverId)}/clock`)
  },

  async saveNotes(serverId: string, notes: string): Promise<RecordResponse> {
    if (isMockMode) {
      await delay(200)
      const record = demoRequire(serverId)
      record.notes = notes
      record.events = [...record.events, demoEvent(record, "note_saved", { by: DEMO_ACTOR })]
      return demoResponse(record)
    }
    return apiClient.put<RecordResponse>(`/subscription/servers/${encodeURIComponent(serverId)}/notes`, { notes })
  },

  async saveReminders(serverId: string, reminderDays: number[]): Promise<RecordResponse> {
    if (isMockMode) {
      await delay(200)
      const record = demoRequire(serverId)
      record.reminderDays = reminderDays
      record.events = [...record.events, demoEvent(record, "reminders_saved", { by: DEMO_ACTOR, reminderDays })]
      return demoResponse(record)
    }
    return apiClient.put<RecordResponse>(`/subscription/servers/${encodeURIComponent(serverId)}/reminders`, { reminderDays })
  },

  async dismissBanner(serverId: string, days: number): Promise<RecordResponse> {
    if (isMockMode) {
      await delay(150)
      const record = demoRequire(serverId)
      const term = record.terms.length
      if (!record.dismissed.some((d) => d.term === term && d.threshold === days)) {
        record.dismissed = [...record.dismissed, { term, threshold: days, at: new Date().toISOString() }]
      }
      return demoResponse(record)
    }
    return apiClient.post<RecordResponse>(`/subscription/servers/${encodeURIComponent(serverId)}/banners/${days}/dismiss`)
  },

  async exportFile(serverId: string, format: "json" | "text"): Promise<SubscriptionFile> {
    if (isMockMode) {
      await delay(150)
      const record = demoRequire(serverId)
      const server = DEMO_SERVERS.find((s) => s.serverId === serverId)!
      record.events = [...record.events, demoEvent(record, "exported", { by: DEMO_ACTOR, format })]
      const now = new Date().toISOString()
      const base = `subscription-${server.name}-${now.slice(0, 10)}`
      return format === "json"
        ? {
            filename: `${base}.json`,
            contentType: "application/json",
            content: JSON.stringify({ server: { serverId, name: server.name, organization: server.organizationName }, record }, null, 2) + "\n",
          }
        : { filename: `${base}.txt`, contentType: "text/plain", content: buildSummary(server, record, now) }
    }
    return apiClient.post<SubscriptionFile>(`/subscription/servers/${encodeURIComponent(serverId)}/export`, { format })
  },

  async renew(serverId: string, confirmEndDate: string): Promise<RecordResponse> {
    if (isMockMode) {
      await delay(300)
      const record = demoRequire(serverId)
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
        { ...demoEvent(record, "renewal_confirmed", { by: DEMO_ACTOR, previousEndsAt: record.endsAt, endsAt: end.toISOString() }), term: index },
      ]
      record.endsAt = end.toISOString()
      return demoResponse(record)
    }
    return apiClient.post<RecordResponse>(`/subscription/servers/${encodeURIComponent(serverId)}/renew`, { confirmEndDate })
  },
}
