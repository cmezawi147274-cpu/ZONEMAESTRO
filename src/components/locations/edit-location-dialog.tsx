"use client"

import { useEffect, useState } from "react"
import { Pencil, Loader2 } from "lucide-react"
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
import { useUpdateLocation } from "@/hooks/use-locations"
import type { Location } from "@/lib/api/types"

function locationToFormState(location: Location): LocationFormState {
  return {
    organizationId: location.organizationId,
    name: location.name,
    address: location.address,
    region: location.region,
    geo:
      location.latitude != null && location.longitude != null
        ? {
            country: location.country,
            city: location.city,
            region: location.region,
            latitude: location.latitude,
            longitude: location.longitude,
            timezone: location.timezone,
          }
        : null,
  }
}

export function EditLocationDialog({ location }: { location: Location }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<LocationFormState>(() => locationToFormState(location))
  const [error, setError] = useState<string | null>(null)
  const update = useUpdateLocation()

  useEffect(() => {
    if (open) setState(locationToFormState(location))
  }, [open, location])

  function patch(next: Partial<LocationFormState>) {
    setState((prev) => ({ ...prev, ...next }))
  }

  async function onSubmit() {
    setError(null)
    if (!state.name.trim()) return setError("Enter a location name.")
    if (!state.address.trim()) return setError("Enter an address.")
    if (!state.geo) return setError("Select a country and city.")

    await update.mutateAsync({
      id: location.id,
      name: state.name.trim(),
      address: state.address.trim(),
      ...geoLocationToLocationFields(state.geo),
      region: state.region.trim() || state.geo.region || "",
    })
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
          <Button variant="outline" size="sm">
            <Pencil className="size-3.5" /> Edit
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Location</DialogTitle>
          <DialogDescription>
            Changing the city keeps Prayer Mode in sync automatically if it&apos;s set to follow this
            location.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <LocationFormFields state={state} onChange={patch} showOrgSelect={false} />

        <DialogFooter>
          <Button onClick={onSubmit} disabled={update.isPending}>
            {update.isPending && <Loader2 className="size-4 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
