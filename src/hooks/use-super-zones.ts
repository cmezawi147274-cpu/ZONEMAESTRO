"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { superZonesApi } from "@/lib/api/super-zones"
import { toast } from "sonner"
import type { SuperZoneGroup } from "@/lib/api/types"

export function useSuperZones(serverId: string | undefined) {
  return useQuery({
    queryKey: ["super-zones", serverId],
    queryFn: () => superZonesApi.list(serverId!),
    enabled: !!serverId,
    refetchInterval: 6_000,
  })
}

export function useSaveSuperZone(serverId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ leaderZoneId, ...input }: { leaderZoneId: string; followerZoneIds: string[]; copyVolume: boolean }) =>
      superZonesApi.save(serverId, leaderZoneId, input),
    onSuccess: (group) => {
      qc.setQueryData<{ groups: SuperZoneGroup[] }>(["super-zones", serverId], (prev) =>
        prev
          ? {
              groups: [
                ...prev.groups.filter((g) => g.leaderZoneId !== group.leaderZoneId),
                ...(group.followerZoneIds.length ? [group] : []),
              ],
            }
          : prev
      )
      qc.invalidateQueries({ queryKey: ["super-zones", serverId] })
      qc.invalidateQueries({ queryKey: ["zones"] })
      toast.success(`${group.leaderName} super zone saved`)
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteSuperZone(serverId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (leaderZoneId: string) => superZonesApi.remove(serverId, leaderZoneId),
    onSuccess: (_, leaderZoneId) => {
      qc.setQueryData<{ groups: SuperZoneGroup[] }>(["super-zones", serverId], (prev) =>
        prev ? { groups: prev.groups.filter((g) => g.leaderZoneId !== leaderZoneId) } : prev
      )
      qc.invalidateQueries({ queryKey: ["super-zones", serverId] })
      qc.invalidateQueries({ queryKey: ["zones"] })
      toast.success("Super zone removed")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
