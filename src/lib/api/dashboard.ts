import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { getTenantScope } from "@/lib/auth/session"
import type { DashboardStats } from "@/lib/api/types"

export const dashboardApi = {
  async stats(): Promise<DashboardStats> {
    if (isMockMode) {
      await delay()
      store.recomputeCounts()
      const scope = getTenantScope()

      // SUPER_ADMIN gets true fleet-wide totals. Every other role gets
      // totals scoped to its own org — never the whole fleet — and an
      // all-zero snapshot if it has no org at all.
      if (!scope.isSuperAdmin && !scope.organizationId) {
        return {
          totalOrganizations: 0,
          totalLocations: 0,
          serversOnline: 0,
          serversOffline: 0,
          serversWarning: 0,
          activeZones: 0,
          playingZones: 0,
          syncJobsInProgress: 0,
          syncJobsFailed: 0,
          openAlerts: 0,
        }
      }

      const locations = scope.isSuperAdmin
        ? store.locations
        : store.locations.filter((l) => l.organizationId === scope.organizationId)
      const servers = scope.isSuperAdmin
        ? store.servers
        : store.servers.filter((s) => s.organizationId === scope.organizationId)
      const locationIds = new Set(locations.map((l) => l.id))
      const serverIds = new Set(servers.map((s) => s.id))
      const zones = scope.isSuperAdmin ? store.zones : store.zones.filter((z) => locationIds.has(z.locationId))
      const trackSyncStates = scope.isSuperAdmin
        ? store.trackSyncStates
        : store.trackSyncStates.filter((s) => serverIds.has(s.serverId))
      const alerts = scope.isSuperAdmin
        ? store.alerts
        : store.alerts.filter(
            (a) => (a.serverId && serverIds.has(a.serverId)) || (a.locationId && locationIds.has(a.locationId))
          )

      return {
        totalOrganizations: scope.isSuperAdmin ? store.organizations.length : 1,
        totalLocations: locations.length,
        serversOnline: servers.filter((s) => s.status === "ONLINE" || s.status === "UPDATING").length,
        serversOffline: servers.filter((s) => s.status === "OFFLINE").length,
        serversWarning: servers.filter((s) => s.status === "WARNING").length,
        activeZones: zones.filter((z) => z.playbackState !== "OFFLINE").length,
        playingZones: zones.filter((z) => z.playbackState === "PLAYING").length,
        syncJobsInProgress: trackSyncStates.filter((s) => s.status === "SYNCING" || s.status === "QUEUED_FOR_SYNC").length,
        syncJobsFailed: trackSyncStates.filter((s) => s.status === "FAILED").length,
        openAlerts: alerts.filter((a) => !a.acknowledged).length,
      }
    }
    return apiClient.get<DashboardStats>("/dashboard/stats")
  },
}
