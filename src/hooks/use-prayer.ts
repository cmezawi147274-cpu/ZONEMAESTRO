"use client"

import { useEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { prayerApi } from "@/lib/api/prayer"
import { prayerScheduler } from "@/lib/prayer/scheduler"
import { toast } from "sonner"
import type { PrayerConfig, PrayerLocation } from "@/lib/api/types"

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
      toast.success("Prayer Mode configuration saved")
    },
    onError: (e: Error) => toast.error(e.message),
  })
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
