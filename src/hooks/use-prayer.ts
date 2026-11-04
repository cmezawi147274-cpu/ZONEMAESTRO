"use client"

import { useEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { prayerApi } from "@/lib/api/prayer"
import { prayerScheduler } from "@/lib/prayer/scheduler"
import { toast } from "sonner"
import type { PrayerName } from "@/lib/constants"
import type { PrayerConfig, PrayerLocation, PrayerSettings, ServerPrayerSettings } from "@/lib/api/types"

/** Mounted once, near the app root, so the central scheduler starts as soon
 * as an authenticated session exists — see src/components/layout/app-shell.tsx.
 * Starting it is idempotent (see PrayerScheduler.start). */
export function usePrayerSchedulerBootstrap() {
  useEffect(() => {
    prayerScheduler.start()
  }, [])
}

export function usePrayerConfig() {
  return useQuery({ queryKey: ["prayer-config"], queryFn: () => prayerApi.getConfig() })
}

export function useUpdatePrayerConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (config: PrayerConfig) => prayerApi.updateConfig(config),
    onSuccess: (config) => {
      qc.setQueryData(["prayer-config"], config)
      qc.invalidateQueries({ queryKey: ["server-prayer"] })
      toast.success("Prayer Mode configuration saved")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useServerPrayer(serverId: string) {
  return useQuery({ queryKey: ["server-prayer", serverId], queryFn: () => prayerApi.getServerPrayer(serverId) })
}

export function useUpdateServerPrayer(serverId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (prayers: Record<PrayerName, PrayerSettings>) => prayerApi.updateServerPrayer(serverId, prayers),
    onSuccess: (settings) => {
      qc.setQueryData(["server-prayer", serverId], settings)
      qc.invalidateQueries({ queryKey: ["prayer-server-overrides"] })
      toast.success("This server's Prayer Mode settings saved")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useResetServerPrayer(serverId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => prayerApi.resetServerPrayer(serverId),
    onSuccess: () => {
      qc.setQueryData<ServerPrayerSettings>(["server-prayer", serverId], (prev) =>
        prev ? { ...prev, custom: false, prayers: prev.organizationPrayers, updatedAt: null } : prev
      )
      qc.invalidateQueries({ queryKey: ["server-prayer", serverId] })
      qc.invalidateQueries({ queryKey: ["prayer-server-overrides"] })
      toast.success("This server now follows the organization's Prayer Mode settings")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useServerPrayerOverrides() {
  return useQuery({ queryKey: ["prayer-server-overrides"], queryFn: () => prayerApi.listServerOverrides() })
}

export function useTodayPrayerTimes(location: PrayerLocation | null | undefined, calculationMethodId: number) {
  return useQuery({
    queryKey: ["prayer-times-today", location?.city, location?.country, calculationMethodId],
    queryFn: () => prayerApi.getTodayTimes(location!, calculationMethodId),
    enabled: !!location,
  })
}

export function useSetZonePrayerParticipation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ zoneId, enabled }: { zoneId: string; enabled: boolean }) =>
      prayerApi.setZonePrayerParticipation(zoneId, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["zones"] }),
    onError: (e: Error) => toast.error(e.message),
  })
}
