"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CountryCityPicker } from "@/components/common/country-city-picker"
import type { GeoLocation, Organization } from "@/lib/api/types"

export interface LocationFormState {
  organizationId: string
  name: string
  address: string
  geo: GeoLocation | null
  region: string
}

/**
 * The fields shared by "New Location" and "Edit Location" — including the
 * same Country → City → GMT-timezone picker Prayer Mode uses
 * (src/components/common/country-city-picker.tsx), so a location's place is
 * only ever entered once, the same way, anywhere in the portal.
 */
export function LocationFormFields({
  state,
  onChange,
  organizations,
  showOrgSelect,
}: {
  state: LocationFormState
  onChange: (patch: Partial<LocationFormState>) => void
  organizations?: Organization[]
  showOrgSelect: boolean
}) {
  return (
    <div className="space-y-4">
      {showOrgSelect && (
        <div className="space-y-1.5">
          <Label>Organization</Label>
          <Select
            value={state.organizationId}
            onValueChange={(v) => v && onChange({ organizationId: v })}
            items={Object.fromEntries((organizations ?? []).map((org) => [org.id, org.name]))}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select organization" />
            </SelectTrigger>
            <SelectContent>
              {organizations?.map((org) => (
                <SelectItem key={org.id} value={org.id}>
                  {org.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-1.5">
        <Label>Location name</Label>
        <Input placeholder="Downtown Bistro" value={state.name} onChange={(e) => onChange({ name: e.target.value })} />
      </div>

      <div className="space-y-1.5">
        <Label>Address</Label>
        <Input
          placeholder="482 Market St"
          value={state.address}
          onChange={(e) => onChange({ address: e.target.value })}
        />
      </div>

      <CountryCityPicker
        location={state.geo}
        onChange={(geo) => onChange({ geo, region: geo.region || state.region })}
        className="grid gap-4 sm:grid-cols-2"
      />

      <div className="space-y-1.5">
        <Label>State / Region</Label>
        <Input
          placeholder="Auto-filled from city — override if needed"
          value={state.region}
          onChange={(e) => onChange({ region: e.target.value })}
        />
      </div>
    </div>
  )
}
