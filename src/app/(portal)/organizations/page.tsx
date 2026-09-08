"use client"

import Link from "next/link"
import { Building2 } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { CreateOrganizationDialog } from "@/components/organizations/create-organization-dialog"
import { useOrganizations } from "@/hooks/use-organizations"
import { formatDate } from "@/lib/format"

const PLAN_LABEL: Record<string, string> = { STARTER: "Starter", PROFESSIONAL: "Professional", ENTERPRISE: "Enterprise" }

export default function OrganizationsPage() {
  const { data: organizations, isLoading } = useOrganizations()

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organizations"
        description="Customers using the platform, each with their own locations, Music Servers and content."
        actions={
          <RoleGate permission="org:write">
            <CreateOrganizationDialog />
          </RoleGate>
        }
      />

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !organizations || organizations.length === 0 ? (
            <EmptyState icon={Building2} title="No organizations yet" description="Create your first customer organization to get started." className="border-none" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-center">Locations</TableHead>
                  <TableHead className="text-center">Servers</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {organizations.map((org) => (
                  <TableRow key={org.id} className="cursor-pointer">
                    <TableCell>
                      <Link href={`/organizations/${org.id}`} className="font-medium hover:underline">
                        {org.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <p className="text-sm">{org.contactName}</p>
                      <p className="text-xs text-muted-foreground">{org.contactEmail}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{PLAN_LABEL[org.plan]}</Badge>
                    </TableCell>
                    <TableCell className="text-center tabular-nums">{org.locationCount}</TableCell>
                    <TableCell className="text-center tabular-nums">{org.serverCount}</TableCell>
                    <TableCell>
                      <Badge variant={org.status === "ACTIVE" ? "outline" : "destructive"} className="capitalize">
                        {org.status.toLowerCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(org.createdAt)}</TableCell>
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
