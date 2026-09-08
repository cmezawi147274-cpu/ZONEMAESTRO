"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { monitoringApi } from "@/lib/api/monitoring"
import { dashboardApi } from "@/lib/api/dashboard"
import type { LogEntry } from "@/lib/api/types"
import { toast } from "sonner"

export function useDashboardStats() {
  return useQuery({ queryKey: ["dashboard-stats"], queryFn: () => dashboardApi.stats(), refetchInterval: 8_000 })
}

export function useActivityFeed(limit = 50) {
  return useQuery({ queryKey: ["activity", limit], queryFn: () => monitoringApi.activity(limit), refetchInterval: 6_000 })
}

export function useAlerts(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["alerts"],
    queryFn: () => monitoringApi.alerts(),
    refetchInterval: 10_000,
    enabled: options?.enabled ?? true,
  })
}

export function useAcknowledgeAlert() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => monitoringApi.acknowledgeAlert(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alerts"] })
      qc.invalidateQueries({ queryKey: ["dashboard-stats"] })
      toast.success("Alert acknowledged")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useLogs(filters?: { serverId?: string; level?: LogEntry["level"] }, limit = 200) {
  return useQuery({
    queryKey: ["logs", filters ?? {}, limit],
    queryFn: () => monitoringApi.logs(filters, limit),
    refetchInterval: 8_000,
  })
}
