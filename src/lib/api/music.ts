import { env, isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { nextId } from "@/lib/mock/ids"
import { readSession } from "@/lib/auth/session"
import type { Track, TrackSyncState, MusicFolder } from "@/lib/api/types"

export interface TrackFilters {
  search?: string
  genre?: string
}

export interface UpdateTrackInput {
  title?: string
  artist?: string
  album?: string
  genre?: string
  folderId?: string | null
}

const COVER_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"]

export const musicApi = {
  async list(filters?: TrackFilters): Promise<Track[]> {
    if (isMockMode) {
      await delay()
      let items = [...store.tracks]
      if (filters?.search) {
        const q = filters.search.toLowerCase()
        items = items.filter(
          (t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q)
        )
      }
      if (filters?.genre && filters.genre !== "all") items = items.filter((t) => t.genre === filters.genre)
      return items.map((t) => ({ ...t })).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    }
    // `new URLSearchParams({search: undefined, ...})` stringifies the
    // missing value as the literal text "undefined" — the backend then
    // filters for tracks whose title/artist/album contains "undefined"
    // and (correctly) finds none, so the library always looked empty
    // whenever the search box was blank. Only forward params that are
    // actually set.
    const entries = Object.entries(filters ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0
    )
    const params = new URLSearchParams(entries).toString()
    return apiClient.get<Track[]>(`/music${params ? `?${params}` : ""}`)
  },

  async get(id: string): Promise<Track | null> {
    if (isMockMode) {
      await delay(150)
      // A copy, not the live store reference — see locations.ts `get()`.
      const track = store.tracks.find((t) => t.id === id)
      return track ? { ...track } : null
    }
    return apiClient.get<Track>(`/music/${id}`)
  },

  /**
   * Simulates a chunked upload with realistic progress callbacks. In real
   * mode this should be replaced with a multipart POST (or a presigned
   * upload URL flow) to NEXT_PUBLIC_API_URL, still reporting progress via
   * XHR/fetch upload progress events.
   */
  async upload(
    file: File,
    metadata: { title: string; artist: string; album: string; genre: string; uploadedBy: string; folderId?: string | null },
    onProgress?: (percent: number) => void
  ): Promise<Track> {
    if (isMockMode) {
      const steps = 10
      for (let i = 1; i <= steps; i++) {
        await delay(120 + Math.random() * 120)
        onProgress?.(Math.round((i / steps) * 100))
      }
      const track: Track = {
        id: nextId("trk"),
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        genre: metadata.genre,
        durationSec: 150 + Math.floor(Math.random() * 120),
        fileSizeMb: Number((file.size / (1024 * 1024)).toFixed(1)) || Number((3 + Math.random() * 6).toFixed(1)),
        uploadedAt: new Date().toISOString(),
        uploadedBy: metadata.uploadedBy,
        coverColor: COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)],
        folderId: metadata.folderId ?? null,
      }
      store.tracks.unshift(track)
      return track
    }
    // Real mode reference implementation: multipart upload with progress.
    return new Promise((resolve, reject) => {
      const form = new FormData()
      form.append("file", file)
      Object.entries(metadata).forEach(([k, v]) => {
        if (v !== undefined && v !== null) form.append(k, v)
      })
      const xhr = new XMLHttpRequest()
      xhr.open("POST", `${env.apiUrl}/music/upload`)
      // apiClient attaches this on every fetch call; XHR needs it set
      // explicitly. Without it, /music/upload's requireAuth preHandler
      // rejects the request with 401 before a track row is ever created —
      // the library then just silently fails to update.
      const session = readSession()
      if (session) xhr.setRequestHeader("Authorization", `Bearer ${session.tokens.accessToken}`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100))
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText))
        else {
          let message = `Upload failed (${xhr.status})`
          try {
            const body = JSON.parse(xhr.responseText)
            if (body?.message) message = body.message
          } catch {
            /* non-JSON error body */
          }
          reject(new Error(message))
        }
      }
      xhr.onerror = () => reject(new Error("Upload failed"))
      xhr.send(form)
    })
  },

  async update(id: string, input: UpdateTrackInput): Promise<Track> {
    if (isMockMode) {
      await delay(300)
      const track = store.tracks.find((t) => t.id === id)
      if (!track) throw new Error("Track not found")
      Object.assign(track, input)
      return { ...track }
    }
    return apiClient.patch<Track>(`/music/${id}`, input)
  },

  async remove(id: string): Promise<void> {
    if (isMockMode) {
      await delay(300)
      store.tracks = store.tracks.filter((t) => t.id !== id)
      store.trackSyncStates = store.trackSyncStates.filter((s) => s.trackId !== id)
      return
    }
    await apiClient.delete(`/music/${id}`)
  },

  async syncStatesForServer(serverId: string): Promise<TrackSyncState[]> {
    if (isMockMode) {
      await delay(200)
      // Copies, not live store references — see locations.ts `get()`. The
      // simulator mutates these in place as a sync job progresses.
      return store.trackSyncStates.filter((s) => s.serverId === serverId).map((s) => ({ ...s }))
    }
    return apiClient.get<TrackSyncState[]>(`/music/sync-status?serverId=${serverId}`)
  },

  async syncStatesForTrack(trackId: string): Promise<TrackSyncState[]> {
    if (isMockMode) {
      await delay(200)
      return store.trackSyncStates.filter((s) => s.trackId === trackId).map((s) => ({ ...s }))
    }
    return apiClient.get<TrackSyncState[]>(`/music/sync-status?trackId=${trackId}`)
  },
}

/**
 * Cloud library folders. Backed only by the real API — folders are new
 * enough that mock mode never modeled them.
 */
export const musicFoldersApi = {
  list(): Promise<MusicFolder[]> {
    return apiClient.get<MusicFolder[]>("/music/folders")
  },
  create(name: string): Promise<MusicFolder> {
    return apiClient.post<MusicFolder>("/music/folders", { name })
  },
  rename(id: string, name: string): Promise<MusicFolder> {
    return apiClient.patch<MusicFolder>(`/music/folders/${id}`, { name })
  },
  remove(id: string): Promise<void> {
    return apiClient.delete(`/music/folders/${id}`)
  },
}
