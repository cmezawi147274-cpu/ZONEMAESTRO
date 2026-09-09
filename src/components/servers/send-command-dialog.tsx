"use client"

import { useState } from "react"
import { Send, Loader2 } from "lucide-react"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useServers } from "@/hooks/use-servers"
import { useZones } from "@/hooks/use-zones"
import { useSendCommand } from "@/hooks/use-commands"
import { COMMAND_TYPES, type CommandType } from "@/lib/constants"

export function SendCommandDialog() {
  const [open, setOpen] = useState(false)
  const [serverId, setServerId] = useState("")
  const [zoneId, setZoneId] = useState<string>("")
  const [type, setType] = useState<CommandType>("SYNC_MUSIC")
  const { data: servers } = useServers()
  const { data: zones } = useZones(serverId ? { serverId } : undefined)
  const send = useSendCommand()

  const ZONE_SCOPED: CommandType[] = ["PLAY", "PAUSE", "STOP", "NEXT", "PREVIOUS", "MUTE", "UNMUTE", "SET_VOLUME"]

  async function onConfirm() {
    if (!serverId) return
    await send.mutateAsync({ serverId, zoneId: ZONE_SCOPED.includes(type) ? zoneId || null : null, type })
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Send className="size-4" /> Send Command
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send Remote Command</DialogTitle>
          <DialogDescription>
            Dispatched asynchronously — status updates as the Windows MusicServer confirms execution.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select
            value={serverId}
            onValueChange={(v) => {
              if (!v) return
              setServerId(v)
              setZoneId("")
            }}
            items={Object.fromEntries((servers ?? []).map((s) => [s.id, s.name]))}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select server" />
            </SelectTrigger>
            <SelectContent>
              {servers?.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={type}
            onValueChange={(v) => v && setType(v as CommandType)}
            items={Object.fromEntries(COMMAND_TYPES.map((t) => [t, t.replaceAll("_", " ")]))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMMAND_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t.replaceAll("_", " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {ZONE_SCOPED.includes(type) && (
            <Select
              value={zoneId}
              onValueChange={(v) => v && setZoneId(v)}
              disabled={!serverId}
              items={Object.fromEntries((zones ?? []).map((z) => [z.id, z.name]))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select zone" />
              </SelectTrigger>
              <SelectContent>
                {zones?.map((z) => (
                  <SelectItem key={z.id} value={z.id}>
                    {z.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <DialogFooter>
          <Button onClick={onConfirm} disabled={!serverId || send.isPending}>
            {send.isPending && <Loader2 className="size-4 animate-spin" />}
            Send Command
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
