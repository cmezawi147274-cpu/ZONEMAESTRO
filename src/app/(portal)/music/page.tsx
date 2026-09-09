"use client"

import { useMemo, useState } from "react"
import { Library, Search, Trash2, CloudUpload, FolderPlus, ChevronDown, ChevronRight, Pencil, Folder, FolderOpen } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { UploadMusicDialog } from "@/components/music/upload-dialog"
import { EditTrackDialog } from "@/components/music/edit-track-dialog"
import { AssignSyncDialog } from "@/components/music/assign-sync-dialog"
import { FolderDialog } from "@/components/music/folder-dialog"
import { useTracks, useDeleteTrack, useMusicFolders, useDeleteMusicFolder } from "@/hooks/use-music"
import { formatDuration, formatFileSize, formatDate } from "@/lib/format"
import { GENRES } from "@/lib/constants"
import type { MusicFolder, Track } from "@/lib/api/types"

interface FolderGroup {
  id: string | null
  name: string
  tracks: Track[]
}

export default function MusicLibraryPage() {
  const [search, setSearch] = useState("")
  const [genre, setGenre] = useState("all")
  const [selected, setSelected] = useState<string[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const { data: tracks, isLoading } = useTracks({ search: search || undefined, genre })
  const { data: folders } = useMusicFolders()
  const deleteTrack = useDeleteTrack()

  const groups = useMemo<FolderGroup[]>(() => {
    const byFolder = new Map<string, Track[]>()
    for (const t of tracks ?? []) {
      const key = t.folderId ?? "unfiled"
      const list = byFolder.get(key)
      if (list) list.push(t)
      else byFolder.set(key, [t])
    }
    const real = (folders ?? []).map((f) => ({ id: f.id, name: f.name, tracks: byFolder.get(f.id) ?? [] }))
    return [...real, { id: null, name: "Unfiled", tracks: byFolder.get("unfiled") ?? [] }]
  }, [tracks, folders])

  const visibleIds = useMemo(() => (tracks ?? []).map((t) => t.id), [tracks])
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id))
  const someSelected = selected.length > 0 && !allSelected

  function toggleAll() {
    setSelected(allSelected ? [] : visibleIds)
  }

  function toggleOne(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function toggleFolder(group: FolderGroup) {
    const ids = group.tracks.map((t) => t.id)
    if (ids.length === 0) return
    const allIn = ids.every((id) => selected.includes(id))
    setSelected((prev) => (allIn ? prev.filter((id) => !ids.includes(id)) : Array.from(new Set([...prev, ...ids]))))
  }

  function toggleCollapsed(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const isEmpty = (!tracks || tracks.length === 0) && (!folders || folders.length === 0)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cloud Music Library"
        description="Upload, organize and manage the music available to every Windows MusicServer."
        actions={
          <div className="flex items-center gap-2">
            <RoleGate permission="music:upload">
              <FolderDialog
                trigger={
                  <Button size="sm" variant="outline">
                    <FolderPlus className="size-4" /> New Folder
                  </Button>
                }
              />
            </RoleGate>
            <RoleGate permission="music:upload">
              <UploadMusicDialog />
            </RoleGate>
          </div>
        }
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-sm">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search title, artist, album…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <Select
          value={genre}
          onValueChange={(v) => setGenre(v ?? "all")}
          items={{ all: "All genres", ...Object.fromEntries(GENRES.map((g) => [g, g])) }}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All genres</SelectItem>
            {GENRES.map((g) => (
              <SelectItem key={g} value={g}>
                {g}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {!!visibleIds.length && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground select-none">
            <Checkbox checked={allSelected} indeterminate={someSelected} onCheckedChange={toggleAll} />
            Select all
          </label>
        )}

        {selected.length > 0 && (
          <div className="flex items-center gap-2 sm:ml-auto">
            <span className="text-sm text-muted-foreground">{selected.length} selected</span>
            <RoleGate permission="sync:trigger">
              <AssignSyncDialog
                trackIds={selected}
                trigger={
                  <Button size="sm" variant="outline">
                    <CloudUpload className="size-4" /> Sync Selected
                  </Button>
                }
              />
            </RoleGate>
          </div>
        )}
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="space-y-3 p-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : isEmpty ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={Library} title="No tracks found" description="Upload music or adjust your search." className="border-none" />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => {
            const key = group.id ?? "unfiled"
            const isCollapsed = collapsed.has(key)
            const ids = group.tracks.map((t) => t.id)
            const folderAllSelected = ids.length > 0 && ids.every((id) => selected.includes(id))
            const folderSomeSelected = ids.some((id) => selected.includes(id)) && !folderAllSelected

            return (
              <Card key={key}>
                <div className="flex items-center gap-2 border-b px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(key)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    {group.id === null ? (
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate font-medium">{group.name}</span>
                    <Badge variant="secondary">{group.tracks.length}</Badge>
                  </button>

                  {ids.length > 0 && (
                    <label className="flex items-center gap-2 pr-1 text-xs text-muted-foreground select-none">
                      <Checkbox
                        checked={folderAllSelected}
                        indeterminate={folderSomeSelected}
                        onCheckedChange={() => toggleFolder(group)}
                      />
                      Select folder
                    </label>
                  )}

                  {group.id !== null && (
                    <div className="flex items-center gap-1">
                      <RoleGate permission="music:upload">
                        <FolderDialog
                          folder={{ id: group.id, name: group.name } as MusicFolder}
                          trigger={
                            <Button variant="ghost" size="icon-sm">
                              <Pencil className="size-3.5" />
                            </Button>
                          }
                        />
                      </RoleGate>
                      <RoleGate permission="music:upload">
                        <DeleteFolderButton folder={{ id: group.id, name: group.name } as MusicFolder} />
                      </RoleGate>
                    </div>
                  )}
                </div>

                {!isCollapsed &&
                  (group.tracks.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">No matching tracks</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10" />
                          <TableHead>Title</TableHead>
                          <TableHead>Artist</TableHead>
                          <TableHead>Album</TableHead>
                          <TableHead>Genre</TableHead>
                          <TableHead>Duration</TableHead>
                          <TableHead>Size</TableHead>
                          <TableHead>Uploaded</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {group.tracks.map((track) => (
                          <TableRow key={track.id}>
                            <TableCell>
                              <Checkbox checked={selected.includes(track.id)} onCheckedChange={() => toggleOne(track.id)} />
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: track.coverColor }} />
                                <span className="font-medium">{track.title}</span>
                              </div>
                            </TableCell>
                            <TableCell>{track.artist}</TableCell>
                            <TableCell className="text-muted-foreground">{track.album}</TableCell>
                            <TableCell>
                              <Badge variant="secondary">{track.genre}</Badge>
                            </TableCell>
                            <TableCell className="tabular-nums text-muted-foreground">{formatDuration(track.durationSec)}</TableCell>
                            <TableCell className="tabular-nums text-muted-foreground">{formatFileSize(track.fileSizeMb)}</TableCell>
                            <TableCell className="text-muted-foreground">{formatDate(track.uploadedAt)}</TableCell>
                            <TableCell>
                              <div className="flex items-center justify-end gap-1">
                                <RoleGate permission="sync:trigger">
                                  <AssignSyncDialog
                                    trackIds={[track.id]}
                                    trigger={
                                      <Button variant="ghost" size="icon-sm">
                                        <CloudUpload className="size-3.5" />
                                      </Button>
                                    }
                                  />
                                </RoleGate>
                                <RoleGate permission="music:upload">
                                  <EditTrackDialog track={track} />
                                </RoleGate>
                                <RoleGate permission="music:delete">
                                  <AlertDialog>
                                    <AlertDialogTrigger render={
                                      <Button variant="ghost" size="icon-sm">
                                        <Trash2 className="size-3.5" />
                                      </Button>
                                    } />
                                    <AlertDialogContent>
                                      <AlertDialogHeader>
                                        <AlertDialogTitle>Delete &quot;{track.title}&quot;?</AlertDialogTitle>
                                        <AlertDialogDescription>
                                          This removes the track from the cloud library and all servers it was
                                          synced to. This cannot be undone.
                                        </AlertDialogDescription>
                                      </AlertDialogHeader>
                                      <AlertDialogFooter>
                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                        <AlertDialogAction onClick={() => deleteTrack.mutate(track.id)}>
                                          Delete
                                        </AlertDialogAction>
                                      </AlertDialogFooter>
                                    </AlertDialogContent>
                                  </AlertDialog>
                                </RoleGate>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ))}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DeleteFolderButton({ folder }: { folder: MusicFolder }) {
  const deleteFolder = useDeleteMusicFolder()
  return (
    <AlertDialog>
      <AlertDialogTrigger render={
        <Button variant="ghost" size="icon-sm">
          <Trash2 className="size-3.5" />
        </Button>
      } />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &quot;{folder.name}&quot;?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the folder only. Its tracks stay in the cloud library and move to Unfiled.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => deleteFolder.mutate(folder.id)}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
