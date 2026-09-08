"use client"

import { useState } from "react"
import Link from "next/link"
import { MapPin } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CreateLocationDialog } from "@/components/locations/create-location-dialog"
import { useLocations } from "@/hooks/use-locations"
import { useOrganizations } from "@/hooks/use-organizations"
import { useAuth } from "@/hooks/use-auth"
import { formatTimezoneLabel } from "@/lib/geo/locations"

export default function LocationsPage() {
  const { role } = useAuth()
  const isSuperAdmin = role === "SUPER_ADMIN"
  const [orgFilter, setOrgFilter] = useState<string>("all")
  const { data: organizations } = useOrganizations()
  // Non-Super Admins are already confined to their own org's locations by
  // locationsApi.list() — there's no "all organizations" to filter across.
  const { data: locations, isLoading } = useLocations(isSuperAdmin && orgFilter !== "all" ? orgFilter : undefined)

  const orgName = (id: string) => organizations?.find((o) => o.id === id)?.name ?? "—"

  return (
    <div className="space-y-6">
      <PageHeader
        title="Locations"
        description="Restaurants and venues across all organizations, each hosting a Windows MusicServer."
        actions={
          <RoleGate permission="location:write">
            <CreateLocationDialog />
          </RoleGate>
        }
      />

      {isSuperAdmin && (
        <div className="flex items-center gap-2">
          <Select
            value={orgFilter}
            onValueChange={(v) => setOrgFilter(v ?? "all")}
            items={{ all: "All organizations", ...Object.fromEntries((organizations ?? []).map((o) => [o.id, o.name])) }}
          >
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All organizations</SelectItem>
              {organizations?.map((org) => (
                <SelectItem key={org.id} value={org.id}>
                  {org.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !locations || locations.length === 0 ? (
            <EmptyState icon={MapPin} title="No locations found" description="Add a location to a customer organization to get started." className="border-none" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>City</TableHead>
                  <TableHead>Timezone</TableHead>
                  <TableHead className="text-center">Servers</TableHead>
                  <TableHead className="text-center">Zones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {locations.map((loc) => (
                  <TableRow key={loc.id}>
                    <TableCell>
                      <Link href={`/locations/${loc.id}`} className="font-medium hover:underline">
                        {loc.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">{loc.address}</p>
                    </TableCell>
                    <TableCell>
                      <Link href={`/organizations/${loc.organizationId}`} className="text-sm hover:underline">
                        {orgName(loc.organizationId)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {loc.city}, {loc.region}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {loc.latitude != null && loc.longitude != null
                        ? formatTimezoneLabel(loc)
                        : loc.timezone}
                    </TableCell>
                    <TableCell className="text-center tabular-nums">{loc.serverCount}</TableCell>
                    <TableCell className="text-center tabular-nums">{loc.zoneCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
