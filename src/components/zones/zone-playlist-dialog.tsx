"use client"

import { useState } from "react"
import { ListMusic, X, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { usePlaylists } from "@/hooks/use-playlists"
import { useTracks } from "@/hooks/use-music"
import { useRemoveTrackFromZone, useRestoreTrackForZone } from "@/hooks/use-zones"
import { formatDuration } from "@/lib/format"
import type { Zone } from "@/lib/api/types"

export function ZonePlaylistDialog({ zone, trigger }: { zone: Zone; trigger: React.ReactElement }) {
  const [open, setOpen] = useState(false)
  const { data: playlists } = usePlaylists()
  const { data: tracks } = useTracks()
  const removeTrack = useRemoveTrackFromZone()
  const restoreTrack = useRestoreTrackForZone()

  const playlist = playlists?.find((p) => p.id === zone.currentPlaylistId)
  const included = (playlist?.trackIds ?? []).filter((id) => !zone.excludedTrackIds.includes(id))
  const excluded = zone.excludedTrackIds.filter((id) => playlist?.trackIds.includes(id))
  const trackById = (id: string) => tracks?.find((t) => t.id === id)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{zone.name} — Playlist</DialogTitle>
          <DialogDescription>
            {playlist ? (
              <>
                {playlist.name} · removing a track here only affects <strong>{zone.name}</strong> — it
                stays in this playlist for every other zone and location, and in the cloud library.
              </>
            ) : (
              "No playlist assigned to this zone."
            )}
          </DialogDescription>
        </DialogHeader>

        {!playlist ? (
          <EmptyState icon={ListMusic} title="No playlist assigned" className="border-none py-8" />
        ) : included.length === 0 && excluded.length === 0 ? (
          <EmptyState icon={ListMusic} title="This playlist has no tracks" className="border-none py-8" />
        ) : (
          <ScrollArea className="h-80 pr-2">
            <div className="space-y-1">
              {included.map((trackId) => {
                const track = trackById(trackId)
                if (!track) return null
                return (
                  <div key={trackId} className="flex items-center gap-2 rounded-md p-1.5 text-sm hover:bg-muted/40">
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: track.coverColor }} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{track.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{track.artist}</p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatDuration(track.durationSec)}</span>
                    <RoleGate permission="zone:control">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        title="Remove from this zone's playlist"
                        disabled={removeTrack.isPending}
                        onClick={() => removeTrack.mutate({ zoneId: zone.id, trackId })}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </RoleGate>
                  </div>
                )
              })}
            </div>

            {excluded.length > 0 && (
              <>
                <Separator className="my-3" />
                <p className="mb-1.5 px-1.5 text-xs font-medium text-muted-foreground">
                  Removed from {zone.name} only
                </p>
                <div className="space-y-1">
                  {excluded.map((trackId) => {
                    const track = trackById(trackId)
                    if (!track) return null
                    return (
                      <div key={trackId} className="flex items-center gap-2 rounded-md p-1.5 text-sm opacity-60">
                        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: track.coverColor }} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium line-through">{track.title}</p>
                          <p className="truncate text-xs text-muted-foreground">{track.artist}</p>
                        </div>
                        <RoleGate permission="zone:control">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            title="Add back to this zone's playlist"
                            disabled={restoreTrack.isPending}
                            onClick={() => restoreTrack.mutate({ zoneId: zone.id, trackId })}
                          >
                            <Undo2 className="size-3.5" />
                          </Button>
                        </RoleGate>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}
