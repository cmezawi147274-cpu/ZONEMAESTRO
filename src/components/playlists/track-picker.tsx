"use client"

import { useMemo, useState } from "react"
import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useTracks, useMusicFolders } from "@/hooks/use-music"
import type { Track } from "@/lib/api/types"

interface TrackGroup {
  id: string | null
  name: string
  tracks: Track[]
}

/**
 * Cloud-library track picker shared by CreatePlaylistDialog and
 * AddTracksDialog. Tracks are grouped by folder (Unfiled last); "select
 * all" and "select folder" only ever touch what's currently visible under
 * the active search. The caller owns `selected` and decides what to do with
 * it (create a playlist, or PATCH one) — this component never writes.
 */
export function TrackPicker({
  selected,
  onChange,
  excludeTrackIds,
}: {
  selected: string[]
  onChange: (ids: string[]) => void
  /** Tracks to hide entirely, e.g. ones already in the target playlist. */
  excludeTrackIds?: string[]
}) {
  const [search, setSearch] = useState("")
  const { data: tracks } = useTracks({ search: search || undefined })
  const { data: folders } = useMusicFolders()

  const groups = useMemo<TrackGroup[]>(() => {
    const exclude = new Set(excludeTrackIds ?? [])
    const byFolder = new Map<string, Track[]>()
    for (const t of tracks ?? []) {
      if (exclude.has(t.id)) continue
      const key = t.folderId ?? "unfiled"
      const list = byFolder.get(key)
      if (list) list.push(t)
      else byFolder.set(key, [t])
    }
    const real = (folders ?? []).map((f) => ({ id: f.id as string | null, name: f.name, tracks: byFolder.get(f.id) ?? [] }))
    const unfiled: TrackGroup = { id: null, name: "Unfiled", tracks: byFolder.get("unfiled") ?? [] }
    return [...real, unfiled].filter((g) => g.tracks.length > 0)
  }, [tracks, folders, excludeTrackIds])

  const visibleIds = useMemo(() => groups.flatMap((g) => g.tracks.map((t) => t.id)), [groups])
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id))
  const someSelected = !allSelected && visibleIds.some((id) => selected.includes(id))

  function toggleAll() {
    onChange(allSelected ? selected.filter((id) => !visibleIds.includes(id)) : Array.from(new Set([...selected, ...visibleIds])))
  }

  function toggleFolder(ids: string[]) {
    const allIn = ids.length > 0 && ids.every((id) => selected.includes(id))
    onChange(allIn ? selected.filter((id) => !ids.includes(id)) : Array.from(new Set([...selected, ...ids])))
  }

  function toggleOne(id: string) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Search tracks…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
      </div>

      {visibleIds.length > 0 && (
        <label className="flex items-center gap-2 px-0.5 text-sm text-muted-foreground select-none">
          <Checkbox checked={allSelected} indeterminate={someSelected} onCheckedChange={toggleAll} />
          Select all ({visibleIds.length})
        </label>
      )}

      <ScrollArea className="h-72 rounded-lg border">
        {groups.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">No matching tracks</p>
        ) : (
          <div className="divide-y">
            {groups.map((group) => {
              const ids = group.tracks.map((t) => t.id)
              const folderAllSelected = ids.every((id) => selected.includes(id))
              const folderSomeSelected = !folderAllSelected && ids.some((id) => selected.includes(id))
              return (
                <div key={group.id ?? "unfiled"}>
                  <div className="sticky top-0 flex items-center gap-2 bg-muted/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur-sm">
                    <Checkbox
                      checked={folderAllSelected}
                      indeterminate={folderSomeSelected}
                      onCheckedChange={() => toggleFolder(ids)}
                    />
                    <span className="truncate">{group.name}</span>
                    <Badge variant="secondary" className="ml-auto">
                      {group.tracks.length}
                    </Badge>
                  </div>
                  {group.tracks.map((track) => (
                    <label key={track.id} className="flex items-center gap-3 p-2.5 text-sm hover:bg-muted/40">
                      <Checkbox checked={selected.includes(track.id)} onCheckedChange={() => toggleOne(track.id)} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{track.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{track.artist}</p>
                      </div>
                    </label>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
