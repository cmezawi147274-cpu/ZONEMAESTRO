"use client"

import { useEffect, useMemo, useState } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Combobox } from "@/components/common/combobox"
import { useCountries, useCitiesForCountry } from "@/hooks/use-geo"
import { formatTimezoneLabel } from "@/lib/geo/locations"
import type { GeoLocation } from "@/lib/api/types"

function cityOptionValue(city: GeoLocation): string {
  return `${city.city}|${city.latitude}|${city.longitude}`
}

/**
 * The Country → City → (auto-resolved GMT) Timezone picker. Used by both
 * Prayer Mode and Locations so there is exactly one implementation of "the
 * GMT-based timezone system" — latitude, longitude and the IANA timezone id
 * are resolved here and handed back on `onChange`, never entered by hand.
 */
export function CountryCityPicker({
  location,
  onChange,
  disabled,
  countryLabel = "Country",
  cityLabel = "City",
  timezoneLabel = "Timezone",
  className,
}: {
  location: GeoLocation | null
  onChange: (location: GeoLocation) => void
  disabled?: boolean
  countryLabel?: string
  cityLabel?: string
  timezoneLabel?: string
  className?: string
}) {
  const [country, setCountry] = useState<string | null>(location?.country ?? null)

  // Keep the country selector in sync if `location` changes from outside
  // (e.g. switching which existing Location a form is editing).
  useEffect(() => {
    setCountry(location?.country ?? null)
  }, [location?.country])

  const { data: countries } = useCountries()
  const { data: cities } = useCitiesForCountry(country ?? undefined)

  const countryOptions = useMemo(() => (countries ?? []).map((c) => ({ value: c, label: c })), [countries])
  const cityOptions = useMemo(() => (cities ?? []).map((c) => ({ value: cityOptionValue(c), label: c.city })), [cities])
  const selectedCityValue = location && location.country === country ? cityOptionValue(location) : null

  function handleCityChange(value: string) {
    const found = cities?.find((c) => cityOptionValue(c) === value)
    if (found) onChange(found)
  }

  return (
    <div className={className ? className : "grid gap-4 sm:grid-cols-2"}>
      <div className="space-y-1.5">
        <Label>{countryLabel}</Label>
        <Combobox
          value={country}
          onChange={setCountry}
          options={countryOptions}
          placeholder="Select country"
          searchPlaceholder="Search countries…"
          disabled={disabled}
        />
      </div>
      <div className="space-y-1.5">
        <Label>{cityLabel}</Label>
        <Combobox
          value={selectedCityValue}
          onChange={handleCityChange}
          options={cityOptions}
          placeholder={country ? "Select city" : "Select a country first"}
          searchPlaceholder="Search cities…"
          disabled={!country || disabled}
        />
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label>{timezoneLabel}</Label>
        <Input readOnly value={location ? formatTimezoneLabel(location) : "—"} className="bg-muted/40" />
      </div>
    </div>
  )
}
