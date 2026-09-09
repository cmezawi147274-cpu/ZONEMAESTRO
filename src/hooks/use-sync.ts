"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { syncApi, type QueueSyncInput } from "@/lib/api/sync"
import { useAuth } from "@/hooks/use-auth"
import { toast } from "sonner"

export function useSyncStates(filters?: { serverId?: string }) {
  return useQuery({
    queryKey: ["sync", filters ?? {}],
    queryFn: () => syncApi.list(filters),
    refetchInterval: 4_000,
  })
}

export function useQueueSync() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: QueueSyncInput) => syncApi.queue(input),
    onSuccess: (_, input) => {
      qc.invalidateQueries({ queryKey: ["sync"] })
      qc.invalidateQueries({ queryKey: ["servers"] })
      qc.invalidateQueries({ queryKey: ["commands"] })
      toast.success(`Queued ${input.trackIds.length} track(s) for sync to ${input.serverIds.length} server(s)`)
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useRetrySync() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ trackId, serverId }: { trackId: string; serverId: string }) =>
      syncApi.retry(trackId, serverId, user?.email ?? "unknown"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sync"] })
      toast.success("Sync retry queued")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useSyncConfig() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (serverId: string) => syncApi.syncConfig(serverId, user?.email ?? "unknown"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commands"] })
      toast.info("Configuration sync sent — waiting for confirmation")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
