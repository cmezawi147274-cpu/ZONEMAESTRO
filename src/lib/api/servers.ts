import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { nextId, randomId } from "@/lib/mock/ids"
import { getTenantScope } from "@/lib/auth/session"
import type { LogEntry, MusicServer } from "@/lib/api/types"

export interface RegisterServerInput {
  name: string
  organizationId: string
  locationId: string
}

/** Outcome of "Forget Server". `agentReached` is false when the Windows
 * machine was offline or never paired — the cloud row is still gone, but
 * nothing was shut down on site. */
export interface ForgetServerResult {
  deleted: boolean
  agentReached: boolean
  message: string
}

function generatePairingCode(): string {
  // Human-typeable, unambiguous alphabet (no 0/O/1/I) — matches what a
  // Windows MusicServer installer would ask an on-site tech to key in.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const group = () =>
    Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("")
  return `${group()}-${group()}`
}

export const serversApi = {
  async list(filters?: { organizationId?: string; locationId?: string }): Promise<MusicServer[]> {
    if (isMockMode) {
      await delay()
      // SUPER_ADMIN can filter by any org (or see all); every other role is
      // confined to its own org regardless of what was requested.
      const scope = getTenantScope()
      let items: MusicServer[]
      if (scope.isSuperAdmin) {
        items = filters?.organizationId
          ? store.servers.filter((s) => s.organizationId === filters.organizationId)
          : [...store.servers]
      } else {
        items = scope.organizationId ? store.servers.filter((s) => s.organizationId === scope.organizationId) : []
      }
      if (filters?.locationId) items = items.filter((s) => s.locationId === filters.locationId)
      return items.map((s) => ({ ...s })).sort((a, b) => a.name.localeCompare(b.name))
    }
    const params = new URLSearchParams(filters as Record<string, string>).toString()
    return apiClient.get<MusicServer[]>(`/servers${params ? `?${params}` : ""}`)
  },

  async get(id: string): Promise<MusicServer | null> {
    if (isMockMode) {
      await delay(200)
      // A copy, not the live store reference — see locations.ts `get()`.
      const server = store.servers.find((s) => s.id === id)
      if (!server) return null
      const scope = getTenantScope()
      if (!scope.isSuperAdmin && server.organizationId !== scope.organizationId) return null
      return { ...server }
    }
    return apiClient.get<MusicServer>(`/servers/${id}`)
  },

  /** Registers a server record and returns a one-time pairing code the
   * Windows MusicServer installer prompts the on-site technician to enter.
   * The server stays UNKNOWN/OFFLINE until the agent completes the
   * outbound pairing handshake (simulated by `confirmPairing` here). */
  async register(input: RegisterServerInput): Promise<MusicServer> {
    if (isMockMode) {
      await delay(500)
      const server: MusicServer = {
        id: nextId("srv"),
        name: input.name,
        organizationId: input.organizationId,
        locationId: input.locationId,
        status: "UNKNOWN",
        version: "—",
        pairingCode: generatePairingCode(),
        pairedAt: null,
        lastHeartbeatAt: null,
        ipAddress: null,
        os: "Windows (pending)",
        usage: { cpuPercent: 0, ramPercent: 0, diskPercent: 0, diskFreeGb: 0, diskTotalGb: 0 },
        zoneCount: 0,
        cachedTracks: 0,
        cachedSizeGb: 0,
        pendingSyncJobs: 0,
        createdAt: new Date().toISOString(),
        autoBootEnabled: true,
        reportedTimezone: null,
        reportedLocationAt: null,
      }
      store.servers.push(server)
      store.recomputeCounts()
      return server
    }
    return apiClient.post<MusicServer>("/servers", input)
  },

  async regeneratePairingCode(id: string): Promise<MusicServer> {
    if (isMockMode) {
      await delay(300)
      const server = store.servers.find((s) => s.id === id)
      if (!server) throw new Error("Server not found")
      server.pairingCode = generatePairingCode()
      return { ...server }
    }
    return apiClient.post<MusicServer>(`/servers/${id}/pairing-code`)
  },

  /** Demo-only: simulates the Windows agent completing the outbound pairing
   * handshake and coming online, exactly as a real agent would after the
   * technician enters the pairing code. */
  async simulateAgentConnected(id: string): Promise<MusicServer> {
    if (!isMockMode) throw new Error("Only available in mock mode")
    await delay(800)
    const server = store.servers.find((s) => s.id === id)
    if (!server) throw new Error("Server not found")
    server.status = "ONLINE"
    server.pairingCode = null
    server.pairedAt = new Date().toISOString()
    server.lastHeartbeatAt = new Date().toISOString()
    server.version = "3.4.2"
    server.os = "Windows 11 Pro (64-bit)"
    server.ipAddress = `192.168.${Math.floor(Math.random() * 20) + 1}.${Math.floor(Math.random() * 200) + 10}`
    store.pushActivity({ type: "SERVER_CONNECTED", message: `${server.name} completed pairing and connected.`, serverId: server.id })
    return { ...server }
  },

  async remove(id: string): Promise<void> {
    if (isMockMode) {
      await delay(400)
      store.servers = store.servers.filter((s) => s.id !== id)
      store.zones = store.zones.filter((z) => z.serverId !== id)
      store.recomputeCounts()
      return
    }
    await apiClient.delete(`/servers/${id}`)
  },

  /** "Forget Server" — SUPER_ADMIN only. Unlike `remove()` (cloud unpair
   * only), this first tells the Windows agent to stop the player, turn
   * auto-start off and wipe its local pairing/cache; the cloud row is
   * deleted only once that lands, or immediately when the agent is offline
   * / was never paired. See backend/src/routes/servers.ts. */
  async forget(id: string): Promise<ForgetServerResult> {
    if (isMockMode) {
      await delay(600)
      const server = store.servers.find((s) => s.id === id)
      if (!server) throw new Error("Server not found.")
      const agentReached = server.status !== "OFFLINE" && server.status !== "UNKNOWN"
      store.servers = store.servers.filter((s) => s.id !== id)
      store.zones = store.zones.filter((z) => z.serverId !== id)
      store.commands = store.commands.filter((c) => c.serverId !== id)
      store.trackSyncStates = store.trackSyncStates.filter((t) => t.serverId !== id)
      store.alerts = store.alerts.filter((a) => a.serverId !== id)
      store.logs = store.logs.filter((l) => l.serverId !== id)
      store.recomputeCounts()
      return {
        deleted: true,
        agentReached,
        message: agentReached
          ? `${server.name} was shut down, wiped and removed from the portal.`
          : `${server.name} was removed from the portal, but it is offline — the Windows machine could not be reached, so a player process may still be running there.`,
      }
    }
    return apiClient.post<ForgetServerResult>(`/servers/${id}/forget`)
  },

  async logs(id: string, limit = 100): Promise<LogEntry[]> {
    if (isMockMode) {
      await delay(250)
      return store.logs.filter((l) => l.serverId === id).slice(0, limit)
    }
    return apiClient.get<LogEntry[]>(`/servers/${id}/logs?limit=${limit}`)
  },

  /** Used by tests / storybook-style exploration only. */
  _generatePairingCode: generatePairingCode,
  _mockAgentId: () => randomId("agent"),
}
