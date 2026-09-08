"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { zonesApi } from "@/lib/api/zones"
import { useAuth } from "@/hooks/use-auth"
import { toast } from "sonner"

export function useZones(filters?: { serverId?: string; locationId?: string }) {
  return useQuery({
    queryKey: ["zones", filters ?? {}],
    queryFn: () => zonesApi.list(filters),
    refetchInterval: 6_000,
  })
}

export function useZone(id: string | undefined) {
  return useQuery({
    queryKey: ["zones", "detail", id],
    queryFn: () => zonesApi.get(id!),
    enabled: !!id,
    refetchInterval: 5_000,
  })
}

/** Playlists actually assigned to this zone — see zonesApi.playlists().
 * Drives the zone card's own picker (Task 2): never the whole library. */
export function useZonePlaylists(zoneId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["zones", "detail", zoneId, "playlists"],
    queryFn: () => zonesApi.playlists(zoneId),
    enabled: options?.enabled ?? true,
  })
}

/**
 * Issues transport-control commands for a zone. Every role takes the exact
 * same path: the action is applied right now, or the mutation rejects — see
 * src/lib/api/commands.ts `send()`. There is no optimistic client-side
 * patch and no "waiting for confirmation" state; on success the zones
 * queries are invalidated so the already-applied state shows immediately.
 */
export function useZoneControls(zoneId: string, serverId: string) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const issuedBy = user?.email ?? "unknown"

  const command = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commands"] })
      qc.invalidateQueries({ queryKey: ["zones"] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const send = (label: string, action: () => Promise<unknown>) =>
    command.mutateAsync(action).then(() => toast.success(`${label} applied`))

  return {
    isPending: command.isPending,
    play: () => send("Play", () => zonesApi.play(zoneId, serverId, issuedBy)),
    pause: () => send("Pause", () => zonesApi.pause(zoneId, serverId, issuedBy)),
    stop: () => send("Stop", () => zonesApi.stop(zoneId, serverId, issuedBy)),
    next: () => send("Next track", () => zonesApi.next(zoneId, serverId, issuedBy)),
    previous: () => send("Previous track", () => zonesApi.previous(zoneId, serverId, issuedBy)),
    setVolume: (volume: number) => send("Volume", () => zonesApi.setVolume(zoneId, serverId, volume, issuedBy)),
    mute: () => send("Mute", () => zonesApi.mute(zoneId, serverId, issuedBy)),
    unmute: () => send("Unmute", () => zonesApi.unmute(zoneId, serverId, issuedBy)),
  }
}

export function useAssignZonePlaylist() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ zoneId, playlistId }: { zoneId: string; playlistId: string }) =>
      zonesApi.assignPlaylist(zoneId, playlistId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["zones"] })
      toast.success("Playlist assigned to zone")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

/** Removes a track from only this zone's view of its playlist — the shared
 * Playlist and every other zone/location using it are unaffected. */
export function useRemoveTrackFromZone() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ zoneId, trackId }: { zoneId: string; trackId: string }) => zonesApi.removeTrack(zoneId, trackId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["zones"] })
      toast.success("Removed from this zone's playlist")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useRestoreTrackForZone() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ zoneId, trackId }: { zoneId: string; trackId: string }) => zonesApi.restoreTrack(zoneId, trackId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["zones"] })
      toast.success("Added back to this zone's playlist")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

/** Deletes a zone from the cloud, and — if it has ever synced from a
 * Windows Music Server — queues its deletion there too. */
export function useDeleteZone() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (zoneId: string) => zonesApi.remove(zoneId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["zones"] })
      toast.success("Zone deleted")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
