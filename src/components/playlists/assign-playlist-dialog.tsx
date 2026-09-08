"use client"

import { useState } from "react"
import { Share2, Loader2, ChevronLeft } from "lucide-react"
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

const STEPS = [
  { field: "organizationId", label: "Organization", placeholder: "Select organization" },
  { field: "locationId", label: "Location", placeholder: "Select location" },
  { field: "serverId", label: "Music Server", placeholder: "Select server" },
  { field: "zoneId", label: "Zone", placeholder: "Select zone" },
] as const

type StepField = (typeof STEPS)[number]["field"]

/** Assign Playlist — org -> location -> server -> zone, one Select per
 * step. A playlist always ends up assigned to a ZONE: the previous
 * "target type + one target" picker let it land on an org/location/server
 * as a whole, which no zone-scoped picker (src/components/zones/zone-card.tsx)
 * could ever resolve back down to an actual playable zone. Each step's
 * options are filtered from the lists already loaded by the hooks below —
 * no new queries per step. */
export function AssignPlaylistDialog({ playlistId }: { playlistId: string }) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)
  const [selection, setSelection] = useState<Record<StepField, string>>({
    organizationId: "",
    locationId: "",
    serverId: "",
    zoneId: "",
  })
  const { data: organizations } = useOrganizations()
  const { data: locations } = useLocations()
  const { data: servers } = useServers()
  const { data: zones } = useZones()
  const assign = useAssignPlaylist()

  const optionsForStep = (field: StepField): { id: string; label: string }[] => {
    switch (field) {
      case "organizationId":
        return (organizations ?? []).map((o) => ({ id: o.id, label: o.name }))
      case "locationId":
        return (locations ?? [])
          .filter((l) => l.organizationId === selection.organizationId)
          .map((l) => ({ id: l.id, label: l.name }))
      case "serverId":
        return (servers ?? [])
          .filter((s) => s.locationId === selection.locationId)
          .map((s) => ({ id: s.id, label: s.name }))
      case "zoneId":
        return (zones ?? [])
          .filter((z) => z.serverId === selection.serverId)
          .map((z) => ({ id: z.id, label: z.name }))
    }
  }

  const current = STEPS[step]
  const options = optionsForStep(current.field)
  const isLastStep = step === STEPS.length - 1

  function reset() {
    setStep(0)
    setSelection({ organizationId: "", locationId: "", serverId: "", zoneId: "" })
  }

  function pick(id: string) {
    setSelection((prev) => ({ ...prev, [current.field]: id }))
  }

  function next() {
    if (!selection[current.field]) return
    if (isLastStep) return
    setStep((s) => s + 1)
  }

  function back() {
    setStep((s) => Math.max(0, s - 1))
  }

  async function onAssign() {
    if (!selection.zoneId) return
    await assign.mutateAsync({ playlistId, targetType: "ZONE", targetId: selection.zoneId })
    setOpen(false)
    reset()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger render={
        <Button variant="outline" size="sm">
          <Share2 className="size-4" /> Assign
        </Button>
      } />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign Playlist</DialogTitle>
          <DialogDescription>
            Step {step + 1} of {STEPS.length} — {current.label}
          </DialogDescription>
        </DialogHeader>

        {/* Steps already completed, shown as a breadcrumb so the operator
            can see (and revisit, via Back) the path taken so far. */}
        {step > 0 && (
          <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            {STEPS.slice(0, step).map((s) => (
              <span key={s.field} className="rounded-md border px-2 py-1">
                {optionsForStep(s.field).find((o) => o.id === selection[s.field])?.label ?? selection[s.field]}
              </span>
            ))}
          </div>
        )}

        <Select
          value={selection[current.field] || undefined}
          onValueChange={(v) => v && pick(v)}
          items={Object.fromEntries(options.map((o) => [o.id, o.label]))}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={current.placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt.id} value={opt.id}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <DialogFooter>
          {step > 0 && (
            <Button variant="outline" onClick={back} disabled={assign.isPending}>
              <ChevronLeft className="size-4" /> Back
            </Button>
          )}
          {isLastStep ? (
            <Button onClick={onAssign} disabled={!selection.zoneId || assign.isPending}>
              {assign.isPending && <Loader2 className="size-4 animate-spin" />}
              Assign
            </Button>
          ) : (
            <Button onClick={next} disabled={!selection[current.field]}>
              Next
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
