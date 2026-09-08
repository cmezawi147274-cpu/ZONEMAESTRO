"use client"

import { useState } from "react"
import { Plus, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { TrackPicker } from "@/components/playlists/track-picker"
import { useUpdatePlaylistTracks } from "@/hooks/use-playlists"
import type { Playlist } from "@/lib/api/types"

export function AddTracksDialog({ playlist }: { playlist: Playlist }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const updateTracks = useUpdatePlaylistTracks()

  async function onAdd() {
    // One write: the playlist's existing tracks plus everything newly
    // picked, in a single PATCH — never one addTrack call per track.
    await updateTracks.mutateAsync({ id: playlist.id, trackIds: [...playlist.trackIds, ...selected] })
    setSelected([])
    setOpen(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSelected([])
      }}
    >
      <DialogTrigger render={
        <Button variant="outline" size="sm">
          <Plus className="size-4" /> Add Tracks
        </Button>
      } />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Tracks to &quot;{playlist.name}&quot;</DialogTitle>
          <DialogDescription>Grouped by folder. Pick individual tracks or select a whole folder.</DialogDescription>
        </DialogHeader>

        <TrackPicker selected={selected} onChange={setSelected} excludeTrackIds={playlist.trackIds} />

        <DialogFooter>
          <Button onClick={onAdd} disabled={selected.length === 0 || updateTracks.isPending}>
            {updateTracks.isPending && <Loader2 className="size-4 animate-spin" />}
            Add {selected.length} track{selected.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
