"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { playlistsApi, type CreatePlaylistInput } from "@/lib/api/playlists"
import type { PlaylistAssignment } from "@/lib/api/types"
import { toast } from "sonner"

export function usePlaylists(organizationId?: string | null, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["playlists", organizationId ?? "all"],
    queryFn: () => playlistsApi.list(organizationId),
    enabled: options?.enabled ?? true,
  })
}

export function usePlaylist(id: string | undefined) {
  return useQuery({
    queryKey: ["playlists", "detail", id],
    queryFn: () => playlistsApi.get(id!),
    enabled: !!id,
  })
}

export function useCreatePlaylist() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreatePlaylistInput) => playlistsApi.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["playlists"] })
      toast.success("Playlist created")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDuplicatePlaylist() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => playlistsApi.duplicate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["playlists"] })
      toast.success("Playlist duplicated")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdatePlaylistTracks() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, trackIds }: { id: string; trackIds: string[] }) => playlistsApi.reorderTracks(id, trackIds),
    onSuccess: (_, { id }) => qc.invalidateQueries({ queryKey: ["playlists", "detail", id] }),
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useAddTrackToPlaylist() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, trackId }: { id: string; trackId: string }) => playlistsApi.addTrack(id, trackId),
    onSuccess: (_, { id }) => qc.invalidateQueries({ queryKey: ["playlists", "detail", id] }),
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useRemoveTrackFromPlaylist() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, trackId }: { id: string; trackId: string }) => playlistsApi.removeTrack(id, trackId),
    onSuccess: (_, { id }) => qc.invalidateQueries({ queryKey: ["playlists", "detail", id] }),
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeletePlaylist() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => playlistsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["playlists"] })
      toast.success("Playlist deleted")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useAssignPlaylist() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ playlistId, targetType, targetId }: { playlistId: string } & Pick<PlaylistAssignment, "targetType" | "targetId">) =>
      playlistsApi.assign(playlistId, { targetType, targetId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["zones"] })
      toast.success("Playlist assigned")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
