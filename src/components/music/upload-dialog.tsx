"use client"

import { useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { UploadCloud, Loader2, X, Music2, CheckCircle2, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { musicApi } from "@/lib/api/music"
import { useAuth } from "@/hooks/use-auth"
import { useMusicFolders, useCreateMusicFolder } from "@/hooks/use-music"
import { GENRES } from "@/lib/constants"
import { toast } from "sonner"

const UNFILED = "__unfiled__"
const NEW_FOLDER = "__new__"

interface PendingUpload {
  id: string
  file: File
  title: string
  artist: string
  album: string
  genre: string
  progress: number
  status: "pending" | "uploading" | "done" | "error"
}

function titleFromFilename(name: string) {
  return name.replace(/\.[^/.]+$/, "").replace(/[-_]+/g, " ")
}

export function UploadMusicDialog() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<PendingUpload[]>([])
  const [uploading, setUploading] = useState(false)
  const [folderChoice, setFolderChoice] = useState<string>(UNFILED)
  const [newFolderName, setNewFolderName] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const { data: folders } = useMusicFolders()
  const createFolder = useCreateMusicFolder()

  function addFiles(files: FileList | null) {
    if (!files) return
    const next: PendingUpload[] = Array.from(files).map((file) => ({
      id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      title: titleFromFilename(file.name),
      artist: "",
      album: "",
      genre: GENRES[0],
      progress: 0,
      status: "pending",
    }))
    setItems((prev) => [...prev, ...next])
  }

  function updateItem(id: string, patch: Partial<PendingUpload>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)))
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  async function uploadAll() {
    setUploading(true)

    // Resolve the one folder this whole batch uploads into: create it first
    // if the admin typed a new name, otherwise use the picked existing
    // folder (or none, for Unfiled).
    let folderId: string | null = null
    if (folderChoice === NEW_FOLDER) {
      const name = newFolderName.trim()
      if (name) {
        try {
          const folder = await createFolder.mutateAsync(name)
          folderId = folder.id
        } catch {
          setUploading(false)
          return
        }
      }
    } else if (folderChoice !== UNFILED) {
      folderId = folderChoice
    }

    for (const item of items) {
      if (item.status === "done") continue
      updateItem(item.id, { status: "uploading" })
      try {
        await musicApi.upload(
          item.file,
          {
            title: item.title || item.file.name,
            artist: item.artist || "Unknown Artist",
            album: item.album || "Unknown Album",
            genre: item.genre,
            uploadedBy: user?.email ?? "unknown",
            folderId,
          },
          (percent) => updateItem(item.id, { progress: percent })
        )
        updateItem(item.id, { status: "done", progress: 100 })
      } catch {
        updateItem(item.id, { status: "error" })
      }
    }
    setUploading(false)
    queryClient.invalidateQueries({ queryKey: ["music"] })
    const failed = items.filter((i) => i.status === "error").length
    if (failed === 0) toast.success(`Uploaded ${items.length} track(s) to the cloud library`)
    else toast.warning(`Uploaded with ${failed} failure(s)`)
  }

  function reset() {
    setItems([])
    setUploading(false)
    setFolderChoice(UNFILED)
    setNewFolderName("")
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <UploadCloud className="size-4" /> Upload Music
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Music</DialogTitle>
          <DialogDescription>
            Add tracks to the cloud library. You can sync them to Music Servers afterward.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label>Folder</Label>
          <Select
            value={folderChoice}
            onValueChange={(v) => v && setFolderChoice(v)}
            items={{
              [UNFILED]: "Unfiled",
              ...Object.fromEntries((folders ?? []).map((f) => [f.id, f.name])),
              [NEW_FOLDER]: "+ New folder…",
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNFILED}>Unfiled</SelectItem>
              {folders?.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
              <SelectItem value={NEW_FOLDER}>+ New folder…</SelectItem>
            </SelectContent>
          </Select>
          {folderChoice === NEW_FOLDER && (
            <Input
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              autoFocus
            />
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          multiple
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors hover:bg-muted/40"
        >
          <UploadCloud className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">Click to select audio files</p>
          <p className="text-xs text-muted-foreground">MP3, WAV, FLAC — multiple files supported</p>
        </button>

        {items.length > 0 && (
          <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
            {items.map((item) => (
              <div key={item.id} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <Music2 className="size-4 shrink-0 text-muted-foreground" />
                  <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.file.name}</p>
                  {item.status === "done" && <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />}
                  {item.status === "error" && <XCircle className="size-4 shrink-0 text-red-500" />}
                  {item.status === "pending" && (
                    <Button variant="ghost" size="icon-xs" onClick={() => removeItem(item.id)}>
                      <X className="size-3.5" />
                    </Button>
                  )}
                </div>
                {item.status === "pending" ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      placeholder="Title"
                      value={item.title}
                      onChange={(e) => updateItem(item.id, { title: e.target.value })}
                    />
                    <Input
                      placeholder="Artist"
                      value={item.artist}
                      onChange={(e) => updateItem(item.id, { artist: e.target.value })}
                    />
                    <Input
                      placeholder="Album"
                      value={item.album}
                      onChange={(e) => updateItem(item.id, { album: e.target.value })}
                    />
                    <Select value={item.genre} onValueChange={(v) => v && updateItem(item.id, { genre: v })}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {GENRES.map((g) => (
                          <SelectItem key={g} value={g}>
                            {g}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <Progress value={item.progress} className="h-1.5" />
                )}
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button
            onClick={uploadAll}
            disabled={items.length === 0 || uploading || (folderChoice === NEW_FOLDER && !newFolderName.trim())}
          >
            {(uploading || createFolder.isPending) && <Loader2 className="size-4 animate-spin" />}
            Upload {items.length > 0 ? `${items.length} track(s)` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
