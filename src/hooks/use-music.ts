"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { musicApi, musicFoldersApi, type TrackFilters, type UpdateTrackInput } from "@/lib/api/music"
import { toast } from "sonner"

/**
 * GET /music is paginated (100 by default). Several screens use this hook as
 * a whole-library lookup table and then resolve ids against the result, so
 * anything past the first page silently disappeared — an older track showed
 * as missing rather than as an error. When no filters are given, ask for the
 * maximum page the backend allows so that lookup is complete.
 *
 * Prefer useTracksByIds below whenever the exact ids are already known: it is
 * correct at any library size, where this still has the backend's ceiling.
 */
export function useTracks(filters?: TrackFilters, options?: { enabled?: boolean }) {
  const effective: TrackFilters = filters?.search || filters?.genre ? filters : { ...filters, limit: "500" }
  return useQuery({
    queryKey: ["music", effective],
    queryFn: () => musicApi.list(effective),
    enabled: options?.enabled ?? true,
  })
}

/** Resolves exactly `ids`, regardless of how large the library is. */
export function useTracksByIds(ids: string[] | undefined, options?: { enabled?: boolean }) {
  const key = (ids ?? []).join(",")
  return useQuery({
    queryKey: ["music", "by-ids", key],
    queryFn: () => musicApi.list({ ids: key }),
    enabled: (options?.enabled ?? true) && key.length > 0,
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
