"use client"

import { useState } from "react"
import { CloudUpload, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { EmptyState } from "@/components/common/empty-state"
import { ServerStatusBadge } from "@/components/common/status-badge"
import { ServerCog } from "lucide-react"
import { useServers } from "@/hooks/use-servers"
import { useQueueSync } from "@/hooks/use-sync"
import { useAuth } from "@/hooks/use-auth"

export function AssignSyncDialog({
  trackIds,
  trigger,
}: {
  trackIds: string[]
  trigger: React.ReactElement
}) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const { data: servers } = useServers()
  const { user } = useAuth()
  const queue = useQueueSync()

  async function onConfirm() {
    if (selected.length === 0) return
    await queue.mutateAsync({ trackIds, serverIds: selected, issuedBy: user?.email ?? "unknown" })
    setOpen(false)
    setSelected([])
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sync to Music Servers</DialogTitle>
          <DialogDescription>
            Queue {trackIds.length} track{trackIds.length === 1 ? "" : "s"} for download to the selected
            Windows MusicServers. Each server downloads and caches independently.
          </DialogDescription>
        </DialogHeader>

        {!servers || servers.length === 0 ? (
          <EmptyState icon={ServerCog} title="No servers available" className="border-none py-8" />
        ) : (
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {servers.map((server) => (
              <label
                key={server.id}
                className="flex items-center gap-3 rounded-lg border p-2.5 text-sm hover:bg-muted/40"
              >
                <Checkbox
                  checked={selected.includes(server.id)}
                  onCheckedChange={(checked) =>
                    setSelected((prev) => (checked ? [...prev, server.id] : prev.filter((id) => id !== server.id)))
                  }
                />
                <span className="min-w-0 flex-1 truncate">{server.name}</span>
                <ServerStatusBadge status={server.status} />
              </label>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button onClick={onConfirm} disabled={selected.length === 0 || queue.isPending}>
            {queue.isPending ? <Loader2 className="size-4 animate-spin" /> : <CloudUpload className="size-4" />}
            Queue Sync to {selected.length} Server{selected.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
