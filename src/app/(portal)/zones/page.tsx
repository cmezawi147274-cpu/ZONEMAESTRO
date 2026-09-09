"use client"

import { useMemo, useState } from "react"
import { useQueries } from "@tanstack/react-query"
import { Speaker } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ZoneCard, type ZonePrayerTimesInfo } from "@/components/zones/zone-card"
import { useZones } from "@/hooks/use-zones"
import { useLocations } from "@/hooks/use-locations"
import { useServers } from "@/hooks/use-servers"
import { useAuth } from "@/hooks/use-auth"
import { usePrayerConfig } from "@/hooks/use-prayer"
import { prayerApi } from "@/lib/api/prayer"
import { resolveGeoLocation } from "@/lib/geo/locations"
import type { GeoLocation, Location } from "@/lib/api/types"

export default function ZonesPage() {
  const { can } = useAuth()
  // A playback-only role is bound to one venue and holds neither
  // location:read nor server:read — no filter to offer, no queries to fire.
  const canFilterByLocation = can("location:read")
  const [locationFilter, setLocationFilter] = useState("all")
  const { data: locations } = useLocations(undefined, { enabled: canFilterByLocation })
  const { data: servers } = useServers(undefined, { enabled: can("server:read") })
  const { data: zones, isLoading } = useZones(locationFilter === "all" ? undefined : { locationId: locationFilter })
  const { data: prayerConfig } = usePrayerConfig()

  const locationLabel = (id: string) => {
    const loc = locations?.find((l) => l.id === id)
    return loc ? `${loc.name}` : undefined
  }
  const serverLabel = (serverId: string) => servers?.find((s) => s.id === serverId)?.name

  // Each zone's OWN Location — never the global Prayer Mode linked/custom
  // location — drives its prayer times, so two zones in two cities show
  // different times. Deduped to one entry per locationId so a page full of
  // zones sharing a location fires one request for it, not one per card.
  const zoneLocations = useMemo(() => {
    const byId = new Map<string, Location>()
    for (const zone of zones ?? []) {
      if (byId.has(zone.locationId)) continue
      const loc = locations?.find((l) => l.id === zone.locationId)
      if (loc) byId.set(zone.locationId, loc)
    }
    return Array.from(byId.values())
  }, [zones, locations])

  const calculationMethodId = prayerConfig?.calculationMethodId

  // A Location never carries coordinates on this cloud — the table has no
  // lat/lng columns and the API serializes both as null — so they're
  // resolved from the city/country/timezone the Country → City picker
  // saved. `null` means the city was never picked that way and no honest
  // position exists for it.
  const geoByLocationId = useMemo(() => {
    const map = new Map<string, GeoLocation | null>()
    for (const loc of zoneLocations) map.set(loc.id, resolveGeoLocation(loc))
    return map
  }, [zoneLocations])

  const prayerTimesQueries = useQueries({
    queries: zoneLocations.map((loc) => {
      const geo = geoByLocationId.get(loc.id) ?? null
      return {
        // Keyed on the resolved position, not just the id, so editing a
        // Location's city recalculates instead of serving the old city.
        queryKey: [
          "prayer-times-today",
          "zone-location",
          loc.id,
          geo?.latitude,
          geo?.longitude,
          geo?.timezone,
          calculationMethodId,
        ],
        queryFn: () => prayerApi.getTodayTimes(geo!, calculationMethodId!, { rethrow: true }),
        enabled: geo != null && calculationMethodId != null,
        // Surface a real failure promptly rather than sitting on "Loading…"
        // through a retry chain.
        retry: false,
      }
    }),
  })

  const prayerTimesByLocationId = useMemo(() => {
    const map = new Map<string, ZonePrayerTimesInfo>()
    zoneLocations.forEach((loc, i) => {
      if (!geoByLocationId.get(loc.id)) {
        map.set(loc.id, { status: "unresolved" })
        return
      }
      const result = prayerTimesQueries[i]
      if (result.error) map.set(loc.id, { status: "error", message: result.error.message })
      else if (result.data?.times) map.set(loc.id, { status: "ready", times: result.data.times })
      else if (result.isPending) map.set(loc.id, { status: "loading" })
      else map.set(loc.id, { status: "error", message: "No prayer times returned for this location." })
    })
    return map
  }, [zoneLocations, geoByLocationId, prayerTimesQueries])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audio Zones"
        description="Every zone across your Music Server fleet. Controls send remote commands — playback happens on the Windows MusicServer, never in the browser."
      />

      {canFilterByLocation && (
        <Select
          value={locationFilter}
          onValueChange={(v) => setLocationFilter(v ?? "all")}
          items={{ all: "All locations", ...Object.fromEntries((locations ?? []).map((l) => [l.id, l.name])) }}
        >
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All locations</SelectItem>
            {locations?.map((loc) => (
              <SelectItem key={loc.id} value={loc.id}>
                {loc.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-56 w-full" />
          ))}
        </div>
      ) : !zones || zones.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState icon={Speaker} title="No zones found" className="border-none py-10" />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {zones.map((zone) => (
            <ZoneCard
              key={zone.id}
              zone={zone}
              showLocation={[locationLabel(zone.locationId), serverLabel(zone.serverId)].filter(Boolean).join(" · ")}
              todayPrayerTimes={prayerTimesByLocationId.get(zone.locationId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
