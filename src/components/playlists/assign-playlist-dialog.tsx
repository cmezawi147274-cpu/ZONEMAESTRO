"use client"

import { useState } from "react"
import { Share2, Loader2 } from "lucide-react"
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
import { useOrganizations } from "@/hooks/use-organizations"
import { useLocations } from "@/hooks/use-locations"
import { useServers } from "@/hooks/use-servers"
import { useZones } from "@/hooks/use-zones"
import { useAssignPlaylist } from "@/hooks/use-playlists"
import type { PlaylistAssignment } from "@/lib/api/types"

const TARGET_TYPES: { value: PlaylistAssignment["targetType"]; label: string }[] = [
  { value: "ORGANIZATION", label: "Organization" },
  { value: "LOCATION", label: "Location" },
  { value: "SERVER", label: "Music Server" },
  { value: "ZONE", label: "Zone" },
]

export function AssignPlaylistDialog({ playlistId }: { playlistId: string }) {
  const [open, setOpen] = useState(false)
  const [targetType, setTargetType] = useState<PlaylistAssignment["targetType"]>("ZONE")
  const [targetId, setTargetId] = useState("")
  const { data: organizations } = useOrganizations()
  const { data: locations } = useLocations()
  const { data: servers } = useServers()
  const { data: zones } = useZones()
  const assign = useAssignPlaylist()

  const options =
    targetType === "ORGANIZATION"
      ? organizations?.map((o) => ({ id: o.id, label: o.name }))
      : targetType === "LOCATION"
        ? locations?.map((l) => ({ id: l.id, label: l.name }))
        : targetType === "SERVER"
          ? servers?.map((s) => ({ id: s.id, label: s.name }))
          : zones?.map((z) => ({ id: z.id, label: z.name }))

  async function onConfirm() {
    if (!targetId) return
    await assign.mutateAsync({ playlistId, targetType, targetId })
    setOpen(false)
    setTargetId("")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={
        <Button variant="outline" size="sm">
          <Share2 className="size-4" /> Assign
        </Button>
      } />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign Playlist</DialogTitle>
          <DialogDescription>Choose where this playlist should apply.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select
            value={targetType}
            onValueChange={(v) => {
              if (v) {
                setTargetType(v as PlaylistAssignment["targetType"])
                setTargetId("")
              }
            }}
            items={Object.fromEntries(TARGET_TYPES.map((t) => [t.value, t.label]))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TARGET_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={targetId}
            onValueChange={(v) => v && setTargetId(v)}
            items={Object.fromEntries((options ?? []).map((o) => [o.id, o.label]))}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select target" />
            </SelectTrigger>
            <SelectContent>
              {options?.map((opt) => (
                <SelectItem key={opt.id} value={opt.id}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button onClick={onConfirm} disabled={!targetId || assign.isPending}>
            {assign.isPending && <Loader2 className="size-4 animate-spin" />}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
