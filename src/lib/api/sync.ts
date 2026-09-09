import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { commandsApi } from "@/lib/api/commands"
import type { TrackSyncState } from "@/lib/api/types"

export interface QueueSyncInput {
  trackIds: string[]
  serverIds: string[]
  issuedBy: string
}

export const syncApi = {
  async list(filters?: { serverId?: string }): Promise<TrackSyncState[]> {
    if (isMockMode) {
      await delay()
      const items = filters?.serverId
        ? store.trackSyncStates.filter((s) => s.serverId === filters.serverId)
        : store.trackSyncStates
      return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }
    const qs = filters?.serverId ? `?serverId=${filters.serverId}` : ""
    return apiClient.get<TrackSyncState[]>(`/sync${qs}`)
  },

  /**
   * Queues cloud tracks for download to one or more Windows MusicServers
   * and issues a SYNC_MUSIC remote command per server so the agent wakes
   * up and starts pulling immediately rather than waiting for its next
   * poll interval. Progress moves AVAILABLE_IN_CLOUD -> QUEUED_FOR_SYNC ->
   * SYNCING -> CACHED_ON_SERVER (or FAILED) — see mock/simulate.ts.
   */
  async queue(input: QueueSyncInput): Promise<TrackSyncState[]> {
    if (isMockMode) {
      await delay(400)
      const created: TrackSyncState[] = []
      for (const serverId of input.serverIds) {
        for (const trackId of input.trackIds) {
          const existing = store.trackSyncStates.find((s) => s.trackId === trackId && s.serverId === serverId)
          if (existing) {
            existing.status = "QUEUED_FOR_SYNC"
            existing.progressPercent = 0
            existing.updatedAt = new Date().toISOString()
            existing.errorMessage = null
            created.push(existing)
          } else {
            const state: TrackSyncState = {
              trackId,
              serverId,
              status: "QUEUED_FOR_SYNC",
              progressPercent: 0,
              updatedAt: new Date().toISOString(),
            }
            store.trackSyncStates.push(state)
            created.push(state)
          }
        }
        const server = store.servers.find((s) => s.id === serverId)
        if (server) server.pendingSyncJobs += input.trackIds.length
        await commandsApi.send({ serverId, type: "SYNC_MUSIC", issuedBy: input.issuedBy, payload: { trackIds: input.trackIds } })
        store.pushActivity({
          type: "MUSIC_SYNC_STARTED",
          message: `${input.trackIds.length} track(s) queued for sync to ${server?.name ?? "server"}.`,
          serverId,
        })
      }
      return created
    }
    return apiClient.post<TrackSyncState[]>("/sync/queue", input)
  },

  async retry(trackId: string, serverId: string, issuedBy: string): Promise<TrackSyncState> {
    if (isMockMode) {
      await delay(300)
      const state = store.trackSyncStates.find((s) => s.trackId === trackId && s.serverId === serverId)
      if (!state) throw new Error("Sync state not found")
      state.status = "QUEUED_FOR_SYNC"
      state.progressPercent = 0
      state.errorMessage = null
      state.updatedAt = new Date().toISOString()
      await commandsApi.send({ serverId, type: "SYNC_MUSIC", issuedBy, payload: { trackIds: [trackId] } })
      return state
    }
    return apiClient.post<TrackSyncState>("/sync/retry", { trackId, serverId })
  },

  async syncConfig(serverId: string, issuedBy: string) {
    return commandsApi.send({ serverId, type: "SYNC_CONFIG", issuedBy })
  },
}
