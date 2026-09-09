"use client"

import { useEffect, useState } from "react"
import { Loader2, Save, Sunrise, MapPin, Building2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CountryCityPicker } from "@/components/common/country-city-picker"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { cn } from "@/lib/utils"
import {
  usePrayerConfig,
  useUpdatePrayerConfig,
  useTodayPrayerTimes,
} from "@/hooks/use-prayer"
import { useLocations } from "@/hooks/use-locations"
import { useAuth } from "@/hooks/use-auth"
import { CALCULATION_METHODS, PRAYER_LABELS, PRAYER_NAMES } from "@/lib/constants"
import { formatTimezoneLabel } from "@/lib/geo/locations"
import { defaultPrayerConfig } from "@/lib/prayer/config-store"
import type { GeoLocation, PrayerConfig } from "@/lib/api/types"

export function PrayerModeForm() {
  const { can } = useAuth()
  const canManage = can("prayer:manage")
  const { data: savedConfig, isLoading } = usePrayerConfig()
  const update = useUpdatePrayerConfig()
  const { data: allLocations } = useLocations()
  const locationsWithGeo = (allLocations ?? []).filter((l) => l.latitude != null && l.longitude != null)

  const [config, setConfig] = useState<PrayerConfig>(defaultPrayerConfig())

  useEffect(() => {
    if (savedConfig) setConfig(savedConfig)
  }, [savedConfig])

  const { data: todayTimes, isFetching: timesLoading } = useTodayPrayerTimes(config.location, config.calculationMethodId)

  function selectExistingLocation(locationId: string) {
    const loc = locationsWithGeo.find((l) => l.id === locationId)
    if (!loc) return
    const geo: GeoLocation = {
      country: loc.country,
      city: loc.city,
      region: loc.region,
      latitude: loc.latitude!,
      longitude: loc.longitude!,
      timezone: loc.timezone,
    }
    setConfig((prev) => ({ ...prev, linkedLocationId: loc.id, location: geo }))
  }

  function useCustomLocation() {
    setConfig((prev) => ({ ...prev, linkedLocationId: null }))
  }

  function save() {
    update.mutate(config)
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading Prayer Mode configuration…</p>

  const isLinked = !!config.linkedLocationId

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm font-medium">Prayer Mode</CardTitle>
            <CardDescription>Automatically pause eligible zones during prayer times.</CardDescription>
          </div>
          <Switch
            checked={config.enabled}
            disabled={!canManage}
            onCheckedChange={(enabled) => setConfig((prev) => ({ ...prev, enabled }))}
          />
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Location</CardTitle>
          <CardDescription>Used only to calculate prayer times — never shown or shared elsewhere.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="inline-flex rounded-lg border p-1">
            <button
              type="button"
              disabled={!canManage}
              onClick={useCustomLocation}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                !isLinked ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <MapPin className="size-3.5" /> Custom location
            </button>
            <button
              type="button"
              disabled={!canManage}
              onClick={() => locationsWithGeo[0] && selectExistingLocation(config.linkedLocationId ?? locationsWithGeo[0].id)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                isLinked ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Building2 className="size-3.5" /> Use an existing location
            </button>
          </div>

          {isLinked ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Location</Label>
                <Select
                  value={config.linkedLocationId ?? undefined}
                  onValueChange={(v) => v && selectExistingLocation(v)}
                  disabled={!canManage}
                  items={Object.fromEntries(locationsWithGeo.map((l) => [l.id, `${l.name} — ${l.city}, ${l.country}`]))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a location" />
                  </SelectTrigger>
                  <SelectContent>
                    {locationsWithGeo.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name} — {l.city}, {l.country}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Editing this location&apos;s city on the Locations page updates Prayer Mode automatically.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Timezone</Label>
                <Input readOnly value={config.location ? formatTimezoneLabel(config.location) : "—"} className="bg-muted/40" />
              </div>
            </div>
          ) : (
            <CountryCityPicker
              location={config.location}
              onChange={(location) => setConfig((prev) => ({ ...prev, location, linkedLocationId: null }))}
              disabled={!canManage}
            />
          )}

          <div className="space-y-1.5">
            <Label>Calculation Method</Label>
            <Select
              value={String(config.calculationMethodId)}
              onValueChange={(v) => v && setConfig((prev) => ({ ...prev, calculationMethodId: Number(v) }))}
              items={Object.fromEntries(CALCULATION_METHODS.map((m) => [String(m.id), m.name]))}
              disabled={!canManage}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CALCULATION_METHODS.map((m) => (
                  <SelectItem key={m.id} value={String(m.id)}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {config.location && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Today's Prayer Times</CardTitle>
            <CardDescription>
              Verify the configuration — all times shown in {formatTimezoneLabel(config.location)}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {timesLoading ? (
              <p className="text-sm text-muted-foreground">Calculating…</p>
            ) : !todayTimes ? (
              <Alert variant="destructive">
                <AlertDescription>
                  Couldn&apos;t reach the prayer times service and no cached times are available yet for this location.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {PRAYER_NAMES.map((p) => (
                  <div key={p} className="rounded-lg border p-3 text-center">
                    <p className="text-xs text-muted-foreground">{PRAYER_LABELS[p]}</p>
                    <p className="text-lg font-semibold tabular-nums">{todayTimes[p]}</p>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Sunrise className="size-3.5" /> Sunrise is never used to pause music.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Prayers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {PRAYER_NAMES.map((p) => {
            const settings = config.prayers[p]
            return (
              <div key={p} className="flex flex-wrap items-center gap-3 rounded-lg border p-3 sm:flex-nowrap">
                <div className="flex w-28 items-center gap-2 shrink-0">
                  <Switch
                    checked={settings.enabled}
                    disabled={!canManage}
                    onCheckedChange={(enabled) =>
                      setConfig((prev) => ({ ...prev, prayers: { ...prev.prayers, [p]: { ...prev.prayers[p], enabled } } }))
                    }
                  />
                  <span className="text-sm font-medium">{PRAYER_LABELS[p]}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground">Offset (min)</Label>
                  <Input
                    type="number"
                    className="w-20"
                    value={settings.offsetMinutes}
                    disabled={!settings.enabled || !canManage}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        prayers: { ...prev.prayers, [p]: { ...prev.prayers[p], offsetMinutes: Number(e.target.value) || 0 } },
                      }))
                    }
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs text-muted-foreground">Pause (min)</Label>
                  <Input
                    type="number"
                    min={1}
                    className="w-20"
                    value={settings.pauseDurationMinutes}
                    disabled={!settings.enabled || !canManage}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        prayers: {
                          ...prev.prayers,
                          [p]: { ...prev.prayers[p], pauseDurationMinutes: Math.max(1, Number(e.target.value) || 1) },
                        },
                      }))
                    }
                  />
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {canManage && (
        <div className="flex justify-end">
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save Prayer Mode Settings
          </Button>
        </div>
      )}
    </div>
  )
}
