"use client"

import { useState } from "react"
import { Speaker } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ZoneCard } from "@/components/zones/zone-card"
import { useZones } from "@/hooks/use-zones"
import { useLocations } from "@/hooks/use-locations"
import { useServers } from "@/hooks/use-servers"
import { useAuth } from "@/hooks/use-auth"

export default function ZonesPage() {
  const { can } = useAuth()
  // A playback-only role is bound to one venue and holds neither
  // location:read nor server:read — no filter to offer, no queries to fire.
  const canFilterByLocation = can("location:read")
  const [locationFilter, setLocationFilter] = useState("all")
  const { data: locations } = useLocations(undefined, { enabled: canFilterByLocation })
  const { data: servers } = useServers(undefined, { enabled: can("server:read") })
  const { data: zones, isLoading } = useZones(locationFilter === "all" ? undefined : { locationId: locationFilter })

  const locationLabel = (id: string) => {
    const loc = locations?.find((l) => l.id === id)
    return loc ? `${loc.name}` : undefined
  }
  const serverLabel = (serverId: string) => servers?.find((s) => s.id === serverId)?.name

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
            />
          ))}
        </div>
      )}
    </div>
  )
}
