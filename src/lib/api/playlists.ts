import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { nextId } from "@/lib/mock/ids"
import { getTenantScope } from "@/lib/auth/session"
import type { Playlist, PlaylistAssignment } from "@/lib/api/types"

export interface CreatePlaylistInput {
  name: string
  description: string
  organizationId: string | null
  trackIds?: string[]
}

export const playlistsApi = {
  async list(organizationId?: string | null): Promise<Playlist[]> {
    if (isMockMode) {
      await delay()
      // SUPER_ADMIN can filter by any org (or see all). Every other role
      // only ever sees its own org's playlists plus org-less "global"
      // playlists (organizationId === null), which are shared by design —
      // never another org's playlists, regardless of what was requested.
      const scope = getTenantScope()
      let items: Playlist[]
      if (scope.isSuperAdmin) {
        items = organizationId
          ? store.playlists.filter((p) => p.organizationId === organizationId || p.organizationId === null)
          : store.playlists
      } else {
        items = store.playlists.filter((p) => p.organizationId === scope.organizationId || p.organizationId === null)
      }
      return items.map((p) => ({ ...p })).sort((a, b) => a.name.localeCompare(b.name))
    }
    const qs = organizationId ? `?organizationId=${organizationId}` : ""
    return apiClient.get<Playlist[]>(`/playlists${qs}`)
  },

  async get(id: string): Promise<Playlist | null> {
    if (isMockMode) {
      await delay(150)
      // A copy, not the live store reference — see locations.ts `get()`.
      const playlist = store.playlists.find((p) => p.id === id)
      if (!playlist) return null
      const scope = getTenantScope()
      if (!scope.isSuperAdmin && playlist.organizationId !== null && playlist.organizationId !== scope.organizationId) {
        return null
      }
      return { ...playlist }
    }
    return apiClient.get<Playlist>(`/playlists/${id}`)
  },

  async create(input: CreatePlaylistInput): Promise<Playlist> {
    if (isMockMode) {
      await delay(400)
      const playlist: Playlist = {
        id: nextId("pl"),
        name: input.name,
        description: input.description,
        organizationId: input.organizationId,
        trackIds: input.trackIds ?? [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      store.playlists.push(playlist)
      return playlist
    }
    return apiClient.post<Playlist>("/playlists", input)
  },

  async duplicate(id: string): Promise<Playlist> {
    if (isMockMode) {
      await delay(400)
      const source = store.playlists.find((p) => p.id === id)
      if (!source) throw new Error("Playlist not found")
      const copy: Playlist = {
        ...source,
        id: nextId("pl"),
        name: `${source.name} (Copy)`,
        trackIds: [...source.trackIds],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      store.playlists.push(copy)
      return copy
    }
    return apiClient.post<Playlist>(`/playlists/${id}/duplicate`)
  },

  async update(id: string, input: Partial<CreatePlaylistInput> & { trackIds?: string[] }): Promise<Playlist> {
    if (isMockMode) {
      await delay(300)
      const playlist = store.playlists.find((p) => p.id === id)
      if (!playlist) throw new Error("Playlist not found")
      Object.assign(playlist, input)
      playlist.updatedAt = new Date().toISOString()
      return { ...playlist }
    }
    return apiClient.patch<Playlist>(`/playlists/${id}`, input)
  },

  async reorderTracks(id: string, trackIds: string[]): Promise<Playlist> {
    return playlistsApi.update(id, { trackIds })
  },

  async addTrack(id: string, trackId: string): Promise<Playlist> {
    if (isMockMode) {
      await delay(200)
      const playlist = store.playlists.find((p) => p.id === id)
      if (!playlist) throw new Error("Playlist not found")
      if (!playlist.trackIds.includes(trackId)) playlist.trackIds.push(trackId)
      playlist.updatedAt = new Date().toISOString()
      return { ...playlist }
    }
    return apiClient.post<Playlist>(`/playlists/${id}/tracks`, { trackId })
  },

  async removeTrack(id: string, trackId: string): Promise<Playlist> {
    if (isMockMode) {
      await delay(200)
      const playlist = store.playlists.find((p) => p.id === id)
      if (!playlist) throw new Error("Playlist not found")
      playlist.trackIds = playlist.trackIds.filter((t) => t !== trackId)
      playlist.updatedAt = new Date().toISOString()
      return { ...playlist }
    }
    return apiClient.delete<Playlist>(`/playlists/${id}/tracks/${trackId}`)
  },

  async remove(id: string): Promise<void> {
    if (isMockMode) {
      await delay(300)
      store.playlists = store.playlists.filter((p) => p.id !== id)
      return
    }
    await apiClient.delete(`/playlists/${id}`)
  },

  async assign(
    playlistId: string,
    target: { targetType: PlaylistAssignment["targetType"]; targetId: string }
  ): Promise<PlaylistAssignment> {
    if (isMockMode) {
      await delay(400)
      const assignment: PlaylistAssignment = {
        id: nextId("asg"),
        playlistId,
        ...target,
        assignedAt: new Date().toISOString(),
      }
      if (target.targetType === "ZONE") {
        const zone = store.zones.find((z) => z.id === target.targetId)
        if (zone) {
          zone.currentPlaylistId = playlistId
          const playlist = store.playlists.find((p) => p.id === playlistId)
          zone.currentTrackId = playlist?.trackIds[0] ?? null
        }
      }
      return assignment
    }
    return apiClient.post<PlaylistAssignment>(`/playlists/${playlistId}/assign`, target)
  },
}
