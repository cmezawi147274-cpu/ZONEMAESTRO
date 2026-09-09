"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useCreateMusicFolder, useRenameMusicFolder } from "@/hooks/use-music"
import type { MusicFolder } from "@/lib/api/types"

/**
 * Create-or-rename dialog for a cloud library folder. Passing `folder`
 * switches it into rename mode; omitting it creates a new folder.
 */
export function FolderDialog({ folder, trigger }: { folder?: MusicFolder; trigger: React.ReactElement }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(folder?.name ?? "")
  const create = useCreateMusicFolder()
  const rename = useRenameMusicFolder()
  const pending = create.isPending || rename.isPending

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next) setName(folder?.name ?? "")
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    if (folder) await rename.mutateAsync({ id: folder.id, name: trimmed })
    else await create.mutateAsync(trimmed)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{folder ? "Rename Folder" : "New Folder"}</DialogTitle>
          <DialogDescription>
            {folder
              ? "Renaming a folder doesn't move or change its tracks."
              : "Group tracks in the cloud library. You can move tracks into it any time."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="folder-name">Folder name</Label>
            <Input id="folder-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Dinner Lounge" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              {folder ? "Save" : "Create Folder"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
