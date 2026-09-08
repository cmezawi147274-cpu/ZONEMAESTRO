"use client"

import * as seed from "@/lib/mock/seed"
import { nextId } from "@/lib/mock/ids"
import type {
  Alert,
  ActivityEvent,
  LogEntry,
  MusicServer,
  Location,
  Organization,
  Playlist,
  RemoteCommand,
  Schedule,
  Track,
  TrackSyncState,
  User,
  Zone,
} from "@/lib/api/types"

/**
 * A single in-memory "database" for mock mode, seeded once per browser
 * session. State is kept only in memory (no localStorage) so every reload
 * starts from a clean, known-good demo dataset — intentional for a portal
 * whose real state of record will be Postgres, not the browser.
 */
class MockStore {
  organizations: Organization[] = seed.organizations.map((o) => ({ ...o }))
  locations: Location[] = seed.locations.map((l) => ({ ...l }))
  servers: MusicServer[] = seed.servers.map((s) => ({ ...s, usage: { ...s.usage } }))
  zones: Zone[] = seed.zones.map((z) => ({ ...z }))
  tracks: Track[] = seed.tracks.map((t) => ({ ...t }))
  playlists: Playlist[] = seed.playlists.map((p) => ({ ...p, trackIds: [...p.trackIds] }))
  trackSyncStates: TrackSyncState[] = seed.trackSyncStates.map((s) => ({ ...s }))
  schedules: Schedule[] = seed.schedules.map((s) => ({ ...s, days: [...s.days] }))
  commands: RemoteCommand[] = seed.commands.map((c) => ({ ...c }))
  logs: LogEntry[] = seed.logs.map((l) => ({ ...l }))
  alerts: Alert[] = seed.alerts.map((a) => ({ ...a }))
  activity: ActivityEvent[] = seed.activity.map((a) => ({ ...a }))
  users: User[] = seed.users.map((u) => ({ ...u }))
  /** Passwords a Super Admin set when creating an account, keyed by
   * lowercased email. Mock-only and in memory like everything else here, so
   * a user created during a demo can actually sign in. Seeded users are not
   * listed and keep signing in with DEMO_PASSWORD — see src/lib/api/auth.ts. */
  userPasswords: Record<string, string> = {}

  recomputeCounts() {
    this.locations.forEach((loc) => {
      loc.serverCount = this.servers.filter((s) => s.locationId === loc.id).length
      loc.zoneCount = this.zones.filter((z) => z.locationId === loc.id).length
    })
    this.organizations.forEach((org) => {
      org.locationCount = this.locations.filter((l) => l.organizationId === org.id).length
      org.serverCount = this.servers.filter((s) => s.organizationId === org.id).length
    })
  }

  pushActivity(entry: Omit<ActivityEvent, "id" | "timestamp">) {
    const item: ActivityEvent = {
      ...entry,
      id: nextId("act"),
      timestamp: new Date().toISOString(),
    }
    this.activity.unshift(item)
    this.activity = this.activity.slice(0, 200)
    return item
  }

  pushLog(entry: Omit<LogEntry, "id" | "timestamp">) {
    const item: LogEntry = { ...entry, id: nextId("log"), timestamp: new Date().toISOString() }
    this.logs.unshift(item)
    this.logs = this.logs.slice(0, 500)
    return item
  }
}

// Survive Next.js Fast Refresh / module re-evaluation in dev by stashing the
// singleton on globalThis, exactly like the common Prisma-client pattern.
const globalForStore = globalThis as unknown as { __cmmpMockStore?: MockStore }

export const store: MockStore = globalForStore.__cmmpMockStore ?? new MockStore()
if (process.env.NODE_ENV !== "production") {
  globalForStore.__cmmpMockStore = store
}
