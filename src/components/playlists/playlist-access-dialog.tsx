"use client"

import { useState } from "react"
import { Users, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useSetPlaylistAccess } from "@/hooks/use-playlists"
import { useOrganizations } from "@/hooks/use-organizations"
import type { Playlist } from "@/lib/api/types"

export function PlaylistAccessDialog({ playlist }: { playlist: Playlist }) {
  const [open, setOpen] = useState(false)
  const [organizationId, setOrganizationId] = useState<string | null>(playlist.organizationId)
  const { data: organizations, isLoading } = useOrganizations()
  const setAccess = useSetPlaylistAccess()
  const narrows = organizationId !== null && organizationId !== playlist.organizationId

  function onSave() {
    setAccess.mutate({ id: playlist.id, organizationId }, { onSuccess: () => setOpen(false) })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setOrganizationId(playlist.organizationId)
      }}
    >
      <DialogTrigger render={
        <Button variant="ghost" size="icon-sm" title="Change access">
          <Users className="size-3.5" />
        </Button>
      } />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change access: {playlist.name}</DialogTitle>
        </DialogHeader>
        <Select
          value={organizationId ?? "shared"}
          onValueChange={(v) => setOrganizationId(v === "shared" ? null : v)}
          disabled={isLoading || setAccess.isPending}
          items={{
            shared: "Shared across all organizations",
            ...Object.fromEntries((organizations ?? []).map((org) => [org.id, org.name])),
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="shared">Shared across all organizations</SelectItem>
            {organizations?.map((org) => (
              <SelectItem key={org.id} value={org.id}>
                {org.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {narrows && (
          <p className="text-sm text-muted-foreground">
            Other organizations lose this playlist. It is removed from their zones and schedules. Within about 20
            seconds, a venue that was playing one of those slots switches to that zone&apos;s own playlist if it has one.
            If the zone has no playlist, the audio already playing keeps going.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={setAccess.isPending}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={organizationId === playlist.organizationId || setAccess.isPending}>
            {setAccess.isPending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
