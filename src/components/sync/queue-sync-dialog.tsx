"use client"

import { useState } from "react"
import { CloudUpload, Loader2, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ServerStatusBadge } from "@/components/common/status-badge"
import { useServers } from "@/hooks/use-servers"
import { useTracks } from "@/hooks/use-music"
import { useQueueSync } from "@/hooks/use-sync"
import { useAuth } from "@/hooks/use-auth"
import { Plus } from "lucide-react"

export function QueueSyncDialog() {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [selectedTracks, setSelectedTracks] = useState<string[]>([])
  const [selectedServers, setSelectedServers] = useState<string[]>([])
  const { data: servers } = useServers()
  const { data: tracks } = useTracks({ search: search || undefined })
  const { user } = useAuth()
  const queue = useQueueSync()

  async function onConfirm() {
    if (selectedTracks.length === 0 || selectedServers.length === 0) return
    await queue.mutateAsync({ trackIds: selectedTracks, serverIds: selectedServers, issuedBy: user?.email ?? "unknown" })
    setOpen(false)
    setSelectedTracks([])
    setSelectedServers([])
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="size-4" /> Queue Sync
          </Button>
        }
      />
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Queue Music Sync</DialogTitle>
          <DialogDescription>Select tracks and the Windows MusicServers that should download them.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm font-medium">
              Tracks <span className="text-muted-foreground">({selectedTracks.length} selected)</span>
            </p>
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search tracks…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 pl-7 text-sm" />
            </div>
            <ScrollArea className="h-64 rounded-lg border">
              <div className="space-y-0.5 p-1.5">
                {tracks?.map((track) => (
                  <label key={track.id} className="flex items-center gap-2 rounded-md p-1.5 text-sm hover:bg-muted/40">
                    <Checkbox
                      checked={selectedTracks.includes(track.id)}
                      onCheckedChange={(checked) =>
                        setSelectedTracks((prev) => (checked ? [...prev, track.id] : prev.filter((id) => id !== track.id)))
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{track.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{track.artist}</span>
                  </label>
                ))}
              </div>
            </ScrollArea>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">
              Servers <span className="text-muted-foreground">({selectedServers.length} selected)</span>
            </p>
            <ScrollArea className="h-[calc(16rem+2.25rem)] rounded-lg border">
              <div className="space-y-0.5 p-1.5">
                {servers?.map((server) => (
                  <label key={server.id} className="flex items-center gap-2 rounded-md p-1.5 text-sm hover:bg-muted/40">
                    <Checkbox
                      checked={selectedServers.includes(server.id)}
                      onCheckedChange={(checked) =>
                        setSelectedServers((prev) => (checked ? [...prev, server.id] : prev.filter((id) => id !== server.id)))
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{server.name}</span>
                    <ServerStatusBadge status={server.status} />
                  </label>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={onConfirm} disabled={selectedTracks.length === 0 || selectedServers.length === 0 || queue.isPending}>
            {queue.isPending ? <Loader2 className="size-4 animate-spin" /> : <CloudUpload className="size-4" />}
            Queue Sync
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
