"use client"

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
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
import { useAuth } from "@/hooks/use-auth"
import { commandsApi } from "@/lib/api/commands"
import type { MusicServer } from "@/lib/api/types"

export function UpdateAllOutdatedButton({ servers }: { servers: MusicServer[] }) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const outdated = servers.filter((s) => s.status === "ONLINE" && s.remoteUpdateCapable && s.updateAvailable)

  async function onConfirm() {
    setPending(true)
    let sent = 0
    let failed = 0
    for (const server of outdated) {
      try {
        await commandsApi.send({
          serverId: server.id,
          zoneId: null,
          type: "UPDATE_SOFTWARE",
          payload: {},
          issuedBy: user?.email ?? "unknown",
        })
        sent++
      } catch {
        failed++
      }
    }
    qc.invalidateQueries({ queryKey: ["commands"] })
    qc.invalidateQueries({ queryKey: ["servers"] })
    if (failed > 0) toast.error(`Update sent to ${sent}, failed for ${failed}`)
    else toast.success(`Update sent to ${sent}`)
    setPending(false)
    setOpen(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <AlertDialogTrigger
        render={
          <Button variant="outline" size="sm" disabled={outdated.length === 0 || pending}>
            <Download className="size-4" /> Update all outdated ({outdated.length})
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Update {outdated.length} servers?</AlertDialogTitle>
          <AlertDialogDescription>
            Each update starts right away, even while music is playing. An agent update restarts only the
            cloud agent (a few seconds). A Music Server update stops the music for about 1-2 minutes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-60 list-disc space-y-0.5 overflow-y-auto pl-5 text-sm">
          {outdated.map((s) => (
            <li key={s.id}>{s.name}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending || outdated.length === 0} onClick={onConfirm}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Update all
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
