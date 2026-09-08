"use client"

import { use } from "react"
import Link from "next/link"
import { ArrowLeft, MapPin, ServerCog } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { CreateLocationDialog } from "@/components/locations/create-location-dialog"
import { useOrganization } from "@/hooks/use-organizations"
import { useLocations } from "@/hooks/use-locations"
import { useServers } from "@/hooks/use-servers"
import { formatDate } from "@/lib/format"

export default function OrganizationDetailPage(props: PageProps<"/organizations/[id]">) {
  const { id } = use(props.params)
  const { data: org, isLoading } = useOrganization(id)
  const { data: locations } = useLocations(id)
  const { data: servers } = useServers({ organizationId: id })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (!org) {
    return <EmptyState icon={ServerCog} title="Organization not found" />
  }

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground" render={<Link href="/organizations"><ArrowLeft className="size-4" /> Organizations</Link>} />
        <PageHeader
          title={org.name}
          description={`${org.contactName} · ${org.contactEmail}`}
          actions={
            <RoleGate permission="location:write">
              <CreateLocationDialog organizationId={org.id} />
            </RoleGate>
          }
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">Plan</p>
            <p className="mt-1 text-lg font-semibold capitalize">{org.plan.toLowerCase()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">Locations</p>
            <p className="mt-1 text-lg font-semibold">{locations?.length ?? org.locationCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">Music Servers</p>
            <p className="mt-1 text-lg font-semibold">{servers?.length ?? org.serverCount}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Locations</CardTitle>
        </CardHeader>
        <CardContent>
          {!locations || locations.length === 0 ? (
            <EmptyState icon={MapPin} title="No locations yet" className="border-none py-8" />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {locations.map((loc) => (
                <Link
                  key={loc.id}
                  href={`/locations/${loc.id}`}
                  className="rounded-lg border p-4 transition-colors hover:bg-muted/40"
                >
                  <p className="font-medium">{loc.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {loc.city}, {loc.region}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Badge variant="outline">{loc.serverCount} servers</Badge>
                    <Badge variant="outline">{loc.zoneCount} zones</Badge>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">Customer since {formatDate(org.createdAt)}</p>
    </div>
  )
}
