"use client"

import { use } from "react"
import Link from "next/link"
import { ArrowLeft, ArrowUp, ArrowDown, X, ListMusic } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { AddTracksDialog } from "@/components/playlists/add-tracks-dialog"
import { AssignPlaylistDialog } from "@/components/playlists/assign-playlist-dialog"
import { usePlaylist, useUpdatePlaylistTracks, useRemoveTrackFromPlaylist } from "@/hooks/use-playlists"
import { useTracks } from "@/hooks/use-music"
import { formatDuration } from "@/lib/format"

export default function PlaylistDetailPage(props: PageProps<"/playlists/[id]">) {
  const { id } = use(props.params)
  const { data: playlist, isLoading } = usePlaylist(id)
  const { data: tracks } = useTracks()
  const reorder = useUpdatePlaylistTracks()
  const removeTrack = useRemoveTrackFromPlaylist()

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  if (!playlist) return <EmptyState icon={ListMusic} title="Playlist not found" />

  const trackList = playlist.trackIds.map((tid) => tracks?.find((t) => t.id === tid)).filter(Boolean)
  const totalDuration = trackList.reduce((sum, t) => sum + (t?.durationSec ?? 0), 0)

  function move(index: number, delta: number) {
    const newIndex = index + delta
    if (newIndex < 0 || newIndex >= playlist!.trackIds.length) return
    const next = [...playlist!.trackIds]
    ;[next[index], next[newIndex]] = [next[newIndex], next[index]]
    reorder.mutate({ id: playlist!.id, trackIds: next })
  }

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground" render={<Link href="/playlists"><ArrowLeft className="size-4" /> Playlists</Link>} />
        <PageHeader
          title={playlist.name}
          description={`${playlist.description || "No description"} · ${trackList.length} tracks · ${formatDuration(totalDuration)}`}
          actions={
            <RoleGate permission="playlist:write">
              <div className="flex gap-2">
                <AssignPlaylistDialog playlistId={playlist.id} />
                <AddTracksDialog playlist={playlist} />
              </div>
            </RoleGate>
          }
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {trackList.length === 0 ? (
            <EmptyState icon={ListMusic} title="No tracks yet" description="Add tracks from the cloud library." className="border-none" />
          ) : (
            <div className="divide-y">
              {trackList.map((track, index) => (
                <div key={track!.id} className="flex items-center gap-3 p-3">
                  <span className="w-5 text-center text-sm text-muted-foreground tabular-nums">{index + 1}</span>
                  <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: track!.coverColor }} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{track!.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {track!.artist} · {track!.album}
                    </p>
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground">{formatDuration(track!.durationSec)}</span>
                  <RoleGate permission="playlist:write">
                    <div className="flex items-center gap-0.5">
                      <Button variant="ghost" size="icon-xs" disabled={index === 0} onClick={() => move(index, -1)}>
                        <ArrowUp className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={index === trackList.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => removeTrack.mutate({ id: playlist.id, trackId: track!.id })}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  </RoleGate>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
