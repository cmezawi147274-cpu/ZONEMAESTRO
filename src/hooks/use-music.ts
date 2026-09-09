"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { musicApi, musicFoldersApi, type TrackFilters, type UpdateTrackInput } from "@/lib/api/music"
import { toast } from "sonner"

export function useTracks(filters?: TrackFilters, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["music", filters ?? {}],
    queryFn: () => musicApi.list(filters),
    enabled: options?.enabled ?? true,
  })
}

export function useMusicFolders() {
  return useQuery({ queryKey: ["music-folders"], queryFn: () => musicFoldersApi.list() })
}

export function useCreateMusicFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => musicFoldersApi.create(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["music-folders"] })
      toast.success("Folder created")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useRenameMusicFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => musicFoldersApi.rename(id, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["music-folders"] })
      toast.success("Folder renamed")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteMusicFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => musicFoldersApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["music-folders"] })
      qc.invalidateQueries({ queryKey: ["music"] })
      toast.success("Folder deleted — its tracks moved to Unfiled")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useTrackSyncStates(trackId: string | undefined) {
  return useQuery({
    queryKey: ["sync", "track", trackId],
    queryFn: () => musicApi.syncStatesForTrack(trackId!),
    enabled: !!trackId,
    refetchInterval: 5_000,
  })
}

export function useUpdateTrack() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & UpdateTrackInput) => musicApi.update(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["music"] })
      toast.success("Track updated")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteTrack() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => musicApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["music"] })
      toast.success("Track deleted")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
