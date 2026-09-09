"use client"

import { use } from "react"
import Link from "next/link"
import { ArrowLeft, Speaker, ServerCog } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { ServerStatusBadge, ZoneStateBadge } from "@/components/common/status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { EditLocationDialog } from "@/components/locations/edit-location-dialog"
import { useLocation } from "@/hooks/use-locations"
import { useOrganization } from "@/hooks/use-organizations"
import { useServers } from "@/hooks/use-servers"
import { useZones } from "@/hooks/use-zones"
import { formatRelativeTime } from "@/lib/format"
import { formatTimezoneLabel } from "@/lib/geo/locations"

export default function LocationDetailPage(props: PageProps<"/locations/[id]">) {
  const { id } = use(props.params)
  const { data: location, isLoading } = useLocation(id)
  const { data: org } = useOrganization(location?.organizationId)
  const { data: servers } = useServers({ locationId: id })
  const { data: zones } = useZones({ locationId: id })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (!location) {
    return <EmptyState icon={ServerCog} title="Location not found" />
  }

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground" render={<Link href="/locations"><ArrowLeft className="size-4" /> Locations</Link>} />
        <PageHeader
          title={location.name}
          description={`${location.address}, ${location.city}, ${location.region} · ${
            location.latitude != null && location.longitude != null ? formatTimezoneLabel(location) : location.timezone
          } · ${org ? org.name : ""}`}
          actions={
            <RoleGate permission="location:write">
              <EditLocationDialog location={location} />
            </RoleGate>
          }
        />
      </div>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">Windows MusicServer</CardTitle>
          <Button variant="ghost" size="sm" render={<Link href="/servers">Manage servers</Link>} />
        </CardHeader>
        <CardContent>
          {!servers || servers.length === 0 ? (
            <EmptyState
              icon={ServerCog}
              title="No server paired yet"
              description="Register a Windows MusicServer for this location to begin syncing music."
              className="border-none py-8"
              action={
                <Button size="sm" render={<Link href="/servers">Register Server</Link>} />
              }
            />
          ) : (
            <div className="space-y-3">
              {servers.map((server) => (
                <Link
                  key={server.id}
                  href={`/servers/${server.id}`}
                  className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-muted/40"
                >
                  <div>
                    <p className="font-medium">{server.name}</p>
                    <p className="text-xs text-muted-foreground">
                      v{server.version} · Heartbeat {formatRelativeTime(server.lastHeartbeatAt)}
                    </p>
                  </div>
                  <ServerStatusBadge status={server.status} />
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Audio Zones</CardTitle>
        </CardHeader>
        <CardContent>
          {!zones || zones.length === 0 ? (
            <EmptyState icon={Speaker} title="No zones configured" className="border-none py-8" />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {zones.map((zone) => (
                <div key={zone.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <p className="font-medium">{zone.name}</p>
                    <ZoneStateBadge state={zone.playbackState} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">Volume {zone.volume}%</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
