"use client"

import { useState } from "react"
import { Pencil, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useRenamePlaylist } from "@/hooks/use-playlists"
import type { Playlist } from "@/lib/api/types"

export function RenamePlaylistDialog({ playlist }: { playlist: Playlist }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(playlist.name)
  const rename = useRenamePlaylist()
  const trimmed = name.trim()

  function onSave() {
    rename.mutate({ id: playlist.id, name: trimmed }, { onSuccess: () => setOpen(false) })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setName(playlist.name)
      }}
    >
      <DialogTrigger render={
        <Button variant="ghost" size="icon-sm" title="Rename">
          <Pencil className="size-3.5" />
        </Button>
      } />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename: {playlist.name}</DialogTitle>
        </DialogHeader>
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={rename.isPending} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={rename.isPending}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={!trimmed || trimmed === playlist.name || rename.isPending}>
            {rename.isPending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
