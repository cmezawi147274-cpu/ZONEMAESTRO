import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { commandsApi } from "@/lib/api/commands"
import { getTenantScope } from "@/lib/auth/session"
import type { CommandSource } from "@/lib/constants"
import type { Playlist, Zone } from "@/lib/api/types"

export const zonesApi = {
  async list(filters?: { serverId?: string; locationId?: string }): Promise<Zone[]> {
    if (isMockMode) {
      await delay()
      // Zones have no organizationId of their own — scope via the org that
      // owns their location. SUPER_ADMIN is unrestricted; every other role
      // only ever sees zones under its own org's locations.
      const scope = getTenantScope()
      let items = store.zones
      if (!scope.isSuperAdmin) {
        if (!scope.organizationId) return []
        const allowedLocationIds = new Set(
          store.locations.filter((l) => l.organizationId === scope.organizationId).map((l) => l.id)
        )
        items = items.filter((z) => allowedLocationIds.has(z.locationId))
      }
      if (filters?.serverId) items = items.filter((z) => z.serverId === filters.serverId)
      if (filters?.locationId) items = items.filter((z) => z.locationId === filters.locationId)
      return items.map((z) => ({ ...z })).sort((a, b) => a.name.localeCompare(b.name))
    }
    const params = new URLSearchParams(filters as Record<string, string>).toString()
    return apiClient.get<Zone[]>(`/zones${params ? `?${params}` : ""}`)
  },

  async get(id: string): Promise<Zone | null> {
    if (isMockMode) {
      await delay(150)
      // A copy, not the live store reference — see locations.ts `get()` for
      // why: otherwise a refetch after an in-place mutation resolves to an
      // object that's `===` the cached one and TanStack Query's structural
      // sharing silently skips re-rendering subscribers.
      const zone = store.zones.find((z) => z.id === id)
      if (!zone) return null
      const scope = getTenantScope()
      if (!scope.isSuperAdmin) {
        const loc = store.locations.find((l) => l.id === zone.locationId)
        if (!loc || loc.organizationId !== scope.organizationId) return null
      }
      return { ...zone }
    }
    return apiClient.get<Zone>(`/zones/${id}`)
  },

  async assignPlaylist(id: string, playlistId: string): Promise<Zone> {
    if (isMockMode) {
      await delay(300)
      const zone = store.zones.find((z) => z.id === id)
      if (!zone) throw new Error("Zone not found")
      // Same apply-now-or-error contract as transport commands — not a
      // silent store write regardless of whether the server can act on it.
      const server = store.servers.find((s) => s.id === zone.serverId)
      if (!server || server.status === "OFFLINE" || server.status === "UNKNOWN") {
        throw new Error(`${server?.name ?? "Server"} is offline — playlist not assigned.`)
      }
      if (zone.currentPlaylistId !== playlistId) {
        // A per-zone removal only makes sense against the playlist it was
        // removed from — assigning a different one starts fresh.
        zone.excludedTrackIds = []
      }
      zone.currentPlaylistId = playlistId
      const playlist = store.playlists.find((p) => p.id === playlistId)
      zone.currentTrackId = playlist?.trackIds.find((t) => !zone.excludedTrackIds.includes(t)) ?? null
      zone.updatedAt = new Date().toISOString()
      return { ...zone }
    }
    return apiClient.post<Zone>(`/zones/${id}/playlist`, { playlistId })
  },

  /** Playlists actually assigned to this zone — a PlaylistAssignment
   * (targetType ZONE) targeting it, or its own currentPlaylistId. Never
   * the whole library; see src/components/zones/zone-card.tsx, which uses
   * this instead of usePlaylists() for its picker. */
  async playlists(id: string): Promise<Playlist[]> {
    if (isMockMode) {
      await delay(150)
      const zone = store.zones.find((z) => z.id === id)
      if (!zone || !zone.currentPlaylistId) return []
      // The mock store has no PlaylistAssignment table of its own — the
      // real backend's richer union (assignment rows + currentPlaylistId)
      // collapses to "whatever this zone is currently playing" here.
      const playlist = store.playlists.find((p) => p.id === zone.currentPlaylistId)
      return playlist ? [{ ...playlist }] : []
    }
    return apiClient.get<Playlist[]>(`/zones/${id}/playlists`)
  },

  /** Removes this zone from the cloud. If it has ever synced from a
   * Windows Music Server (localZoneId set), the backend also queues the
   * deletion to that server — see backend/src/routes/zones.ts. */
  async remove(id: string): Promise<void> {
    if (isMockMode) {
      await delay(300)
      store.zones = store.zones.filter((z) => z.id !== id)
      return
    }
    await apiClient.delete(`/zones/${id}`)
  },

  /**
   * Removes a track from this zone's *view* of its current playlist only.
   * The shared Playlist record is never touched, so every other zone or
   * location assigned the same playlist keeps seeing the full track list —
   * see src/lib/api/types.ts `Zone.excludedTrackIds`.
   */
  async removeTrack(zoneId: string, trackId: string): Promise<Zone> {
    if (isMockMode) {
      await delay(200)
      const zone = store.zones.find((z) => z.id === zoneId)
      if (!zone) throw new Error("Zone not found")
      if (!zone.excludedTrackIds.includes(trackId)) zone.excludedTrackIds = [...zone.excludedTrackIds, trackId]
      if (zone.currentTrackId === trackId) {
        const playlist = store.playlists.find((p) => p.id === zone.currentPlaylistId)
        zone.currentTrackId = playlist?.trackIds.find((t) => !zone.excludedTrackIds.includes(t)) ?? null
      }
      zone.updatedAt = new Date().toISOString()
      return { ...zone }
    }
    return apiClient.post<Zone>(`/zones/${zoneId}/tracks/${trackId}/remove`)
  },

  /** Undoes a per-zone removal — brings the track back into view for this
   * zone only. Has no effect on other zones or the shared playlist, which
   * were never affected in the first place. */
  async restoreTrack(zoneId: string, trackId: string): Promise<Zone> {
    if (isMockMode) {
      await delay(200)
      const zone = store.zones.find((z) => z.id === zoneId)
      if (!zone) throw new Error("Zone not found")
      zone.excludedTrackIds = zone.excludedTrackIds.filter((id) => id !== trackId)
      zone.updatedAt = new Date().toISOString()
      return { ...zone }
    }
    return apiClient.post<Zone>(`/zones/${zoneId}/tracks/${trackId}/restore`)
  },

  /** Every zone-facing transport control is dispatched as a remote command
   * to the zone's Windows MusicServer — the browser never plays or directly
   * mutates audio state. It applies immediately (success or error) for
   * every role — see src/lib/api/commands.ts `send()`. The optional
   * `source` is only ever meaningfully set by the Prayer scheduler
   * ("SCHEDULE"); anything else is derived from the session, not trusted
   * from the caller. */
  play: (zoneId: string, serverId: string, issuedBy: string, source?: CommandSource) =>
    commandsApi.send({ serverId, zoneId, type: "PLAY", issuedBy, source }),
  pause: (zoneId: string, serverId: string, issuedBy: string, source?: CommandSource) =>
    commandsApi.send({ serverId, zoneId, type: "PAUSE", issuedBy, source }),
  stop: (zoneId: string, serverId: string, issuedBy: string, source?: CommandSource) =>
    commandsApi.send({ serverId, zoneId, type: "STOP", issuedBy, source }),
  next: (zoneId: string, serverId: string, issuedBy: string, source?: CommandSource) =>
    commandsApi.send({ serverId, zoneId, type: "NEXT", issuedBy, source }),
  previous: (zoneId: string, serverId: string, issuedBy: string, source?: CommandSource) =>
    commandsApi.send({ serverId, zoneId, type: "PREVIOUS", issuedBy, source }),
  setVolume: (zoneId: string, serverId: string, volume: number, issuedBy: string, source?: CommandSource) =>
    commandsApi.send({ serverId, zoneId, type: "SET_VOLUME", payload: { volume }, issuedBy, source }),
  mute: (zoneId: string, serverId: string, issuedBy: string, source?: CommandSource) =>
    commandsApi.send({ serverId, zoneId, type: "MUTE", issuedBy, source }),
  unmute: (zoneId: string, serverId: string, issuedBy: string, source?: CommandSource) =>
    commandsApi.send({ serverId, zoneId, type: "UNMUTE", issuedBy, source }),
}
