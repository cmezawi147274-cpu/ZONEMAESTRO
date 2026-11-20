"use client"

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Download, KeyRound, Loader2, Unlock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { RoleGate } from "@/components/common/role-gate"
import { useAuth } from "@/hooks/use-auth"
import { useSendCommand } from "@/hooks/use-commands"
import { commandsApi } from "@/lib/api/commands"
import { agentVersionStatus } from "@/lib/version"
import type { MusicServer } from "@/lib/api/types"

/** True when nothing is published for this part, or the PC is known to run it (or newer). */
function isCurrent(current: string | null | undefined, published: string | null | undefined): boolean {
  return !published || agentVersionStatus(current, published) === "current"
}

function UpdateSoftwareButton({ server }: { server: MusicServer }) {
  const [open, setOpen] = useState(false)
  const sendCommand = useSendCommand()
  const published = server.publishedUpdate ?? null
  const msVersion = server.health?.musicServerVersion ?? null
  const upToDate =
    Boolean(published) && isCurrent(server.version, published?.agentVersion) && isCurrent(msVersion, published?.musicServerVersion)

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button variant="outline" size="sm" disabled={server.status !== "ONLINE" || !server.remoteUpdateCapable}>
            <Download className="size-4" /> Update software
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Update {server.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The update starts right away, even while music is playing. An agent update restarts only the
            cloud agent (a few seconds). A Music Server update stops the music for about 1-2 minutes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1 text-sm">
          <p>
            Agent: <span className="font-medium">{server.version}</span>
            {" → "}
            <span className="font-medium">{published?.agentVersion ?? "nothing published"}</span>
          </p>
          <p>
            Music Server: <span className="font-medium">{msVersion ?? "not reported"}</span>
            {" → "}
            <span className="font-medium">{published?.musicServerVersion ?? "nothing published"}</span>
          </p>
          {!published && <p className="text-muted-foreground">No update is published.</p>}
          {upToDate && (
            <p className="text-muted-foreground">
              This PC is already up to date. You can still send it; the PC will report that it is up to date.
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={sendCommand.isPending}
            onClick={async () => {
              try {
                await sendCommand.mutateAsync({ serverId: server.id, zoneId: null, type: "UPDATE_SOFTWARE", payload: {} })
                setOpen(false)
              } catch {
                /* useSendCommand's onError already toasted */
              }
            }}
          >
            {sendCommand.isPending && <Loader2 className="size-4 animate-spin" />}
            Update now
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function UnlockScreenButton({ server, disabled }: { server: MusicServer; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const sendCommand = useSendCommand()

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button variant="outline" size="sm" disabled={disabled}>
            <Unlock className="size-4" /> Unlock screen
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unlock the screen of {server.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            The screen lock on this PC opens without its password, so anyone at the PC can use Windows.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={sendCommand.isPending}
            onClick={async () => {
              try {
                await sendCommand.mutateAsync({ serverId: server.id, zoneId: null, type: "UNLOCK_SCREEN", payload: {} })
                setOpen(false)
              } catch {
                /* useSendCommand's onError already toasted */
              }
            }}
          >
            {sendCommand.isPending && <Loader2 className="size-4 animate-spin" />}
            Unlock
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ChangeLockPasswordButton({ server, disabled }: { server: MusicServer; disabled: boolean }) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [pending, setPending] = useState(false)

  const lengthOk = password.length >= 4 && password.length <= 128
  const matches = password === confirm
  const error = password && !lengthOk ? "Use 4 to 128 characters." : confirm && !matches ? "The passwords do not match." : null

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setPassword("")
      setConfirm("")
    }
  }

  async function onSubmit() {
    if (!lengthOk || !matches) return
    setPending(true)
    try {
      // Sent directly (not via useSendCommand) so the password is not kept in the mutation cache.
      await commandsApi.send({
        serverId: server.id,
        zoneId: null,
        type: "SET_LOCK_PASSWORD",
        payload: { password },
        issuedBy: user?.email ?? "unknown",
      })
      qc.invalidateQueries({ queryKey: ["commands"] })
      qc.invalidateQueries({ queryKey: ["servers"] })
      toast.success("Command sent")
      onOpenChange(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" disabled={disabled}>
            <KeyRound className="size-4" /> Change lock password
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change the screen lock password</DialogTitle>
          <DialogDescription>
            The PC keeps a hash of this password in a file that local users can read, so use a long password.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void onSubmit()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="lock-password">New password</Label>
            <Input
              id="lock-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lock-password-confirm">Confirm password</Label>
            <Input
              id="lock-password-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={!lengthOk || !matches || pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Change password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Super Admin only: remote software update and the venue screen lock. */
export function ServerRemoteActions({ server }: { server: MusicServer }) {
  const lockDisabled = server.status !== "ONLINE" || !server.remoteUpdateCapable || server.screenLockInstalled !== true

  return (
    <RoleGate permission="server:forget">
      <div className="space-y-1">
        <div className="flex flex-wrap gap-2">
          <UpdateSoftwareButton server={server} />
          <UnlockScreenButton server={server} disabled={lockDisabled} />
          <ChangeLockPasswordButton server={server} disabled={lockDisabled} />
        </div>
        {!server.remoteUpdateCapable && (
          <p className="text-xs text-muted-foreground">Needs the new installer once (2026.11.20 or newer)</p>
        )}
      </div>
    </RoleGate>
  )
}
