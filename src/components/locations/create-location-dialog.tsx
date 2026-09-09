"use client"

import { useState } from "react"
import { Plus, Loader2 } from "lucide-react"
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
import { Alert, AlertDescription } from "@/components/ui/alert"
import { LocationFormFields, type LocationFormState } from "@/components/locations/location-form-fields"
import { geoLocationToLocationFields } from "@/lib/api/locations"
import { useCreateLocation } from "@/hooks/use-locations"
import { useOrganizations } from "@/hooks/use-organizations"

const EMPTY_STATE: LocationFormState = { organizationId: "", name: "", address: "", geo: null, region: "" }

export function CreateLocationDialog({ organizationId }: { organizationId?: string }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<LocationFormState>({ ...EMPTY_STATE, organizationId: organizationId ?? "" })
  const [error, setError] = useState<string | null>(null)
  const { data: organizations } = useOrganizations()
  const create = useCreateLocation()

  function patch(next: Partial<LocationFormState>) {
    setState((prev) => ({ ...prev, ...next }))
  }

  async function onSubmit() {
    setError(null)
    if (!state.organizationId) return setError("Select an organization.")
    if (!state.name.trim()) return setError("Enter a location name.")
    if (!state.address.trim()) return setError("Enter an address.")
    if (!state.geo) return setError("Select a country and city.")

    await create.mutateAsync({
      organizationId: state.organizationId,
      name: state.name.trim(),
      address: state.address.trim(),
      ...geoLocationToLocationFields(state.geo),
      region: state.region.trim() || state.geo.region || "",
    })
    setState({ ...EMPTY_STATE, organizationId: organizationId ?? "" })
    setOpen(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setError(null)
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="size-4" /> New Location
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Location</DialogTitle>
          <DialogDescription>Add a restaurant or venue that will host a Windows MusicServer.</DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <LocationFormFields
          state={state}
          onChange={patch}
          organizations={organizations}
          showOrgSelect={!organizationId}
        />

        <DialogFooter>
          <Button onClick={onSubmit} disabled={create.isPending}>
            {create.isPending && <Loader2 className="size-4 animate-spin" />}
            Create Location
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
