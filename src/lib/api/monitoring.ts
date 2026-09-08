import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { getTenantScope } from "@/lib/auth/session"
import type { Alert, ActivityEvent, LogEntry } from "@/lib/api/types"

export const monitoringApi = {
  async activity(limit = 50): Promise<ActivityEvent[]> {
    if (isMockMode) {
      await delay()
      // Fleet-wide feed — scope to the caller's org via the server it's
      // about. SUPER_ADMIN is unrestricted; a scoped role never sees
      // another org's activity (including org-less/cross-tenant events).
      const scope = getTenantScope()
      if (scope.isSuperAdmin) return store.activity.slice(0, limit)
      if (!scope.organizationId) return []
      const allowedServerIds = new Set(
        store.servers.filter((s) => s.organizationId === scope.organizationId).map((s) => s.id)
      )
      return store.activity.filter((e) => e.serverId != null && allowedServerIds.has(e.serverId)).slice(0, limit)
    }
    return apiClient.get<ActivityEvent[]>(`/monitoring/activity?limit=${limit}`)
  },

  async alerts(): Promise<Alert[]> {
    if (isMockMode) {
      await delay()
      const scope = getTenantScope()
      let items = store.alerts
      if (!scope.isSuperAdmin) {
        if (!scope.organizationId) return []
        const allowedServerIds = new Set(
          store.servers.filter((s) => s.organizationId === scope.organizationId).map((s) => s.id)
        )
        const allowedLocationIds = new Set(
          store.locations.filter((l) => l.organizationId === scope.organizationId).map((l) => l.id)
        )
        items = items.filter(
          (a) => (a.serverId && allowedServerIds.has(a.serverId)) || (a.locationId && allowedLocationIds.has(a.locationId))
        )
      }
      return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    }
    return apiClient.get<Alert[]>("/monitoring/alerts")
  },

  async acknowledgeAlert(id: string): Promise<Alert> {
    if (isMockMode) {
      await delay(200)
      const alert = store.alerts.find((a) => a.id === id)
      if (!alert) throw new Error("Alert not found")
      alert.acknowledged = true
      return alert
    }
    return apiClient.post<Alert>(`/monitoring/alerts/${id}/acknowledge`)
  },

  async logs(filters?: { serverId?: string; level?: LogEntry["level"] }, limit = 200): Promise<LogEntry[]> {
    if (isMockMode) {
      await delay()
      const scope = getTenantScope()
      let items = [...store.logs]
      if (!scope.isSuperAdmin) {
        if (!scope.organizationId) return []
        const allowedServerIds = new Set(
          store.servers.filter((s) => s.organizationId === scope.organizationId).map((s) => s.id)
        )
        items = items.filter((l) => allowedServerIds.has(l.serverId))
      }
      if (filters?.serverId) items = items.filter((l) => l.serverId === filters.serverId)
      if (filters?.level) items = items.filter((l) => l.level === filters.level)
      return items.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit)
    }
    const params = new URLSearchParams({ ...filters, limit: String(limit) } as Record<string, string>).toString()
    return apiClient.get<LogEntry[]>(`/monitoring/logs?${params}`)
  },
}
