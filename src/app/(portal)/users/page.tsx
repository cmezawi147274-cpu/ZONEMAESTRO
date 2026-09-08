"use client"

import { Users as UsersIcon, Trash2 } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { InviteUserDialog } from "@/components/users/invite-user-dialog"
import { useUsers, useDeleteUser } from "@/hooks/use-users"
import { useOrganizations } from "@/hooks/use-organizations"
import { useLocations } from "@/hooks/use-locations"
import { useAuth } from "@/hooks/use-auth"
import { ROLE_LABELS } from "@/lib/constants"
import { formatRelativeTime, initials } from "@/lib/format"

export default function UsersPage() {
  const { data: users, isLoading } = useUsers()
  const { user: currentUser, can } = useAuth()
  const { data: organizations } = useOrganizations({ enabled: can("org:read") })
  const { data: locations } = useLocations(undefined, { enabled: can("location:read") })
  const remove = useDeleteUser()

  const orgName = (id: string | null) => (id ? organizations?.find((o) => o.id === id)?.name : "All organizations")
  const locationName = (id: string | null | undefined) =>
    id ? locations?.find((l) => l.id === id)?.name ?? "—" : "All locations"

  if (!can("users:manage")) {
    return (
      <EmptyState
        icon={UsersIcon}
        title="You don't have access to user management"
        description="Ask a Super Admin to grant you access."
      />
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Portal administrators and managers, scoped by role and organization."
        actions={<InviteUserDialog />}
      />

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !users || users.length === 0 ? (
            <EmptyState icon={UsersIcon} title="No users found" className="border-none" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Last Login</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <Avatar className="size-8">
                          <AvatarFallback className="text-xs">{initials(user.name)}</AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">{user.name}</p>
                          <p className="text-xs text-muted-foreground">{user.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{ROLE_LABELS[user.role]}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{orgName(user.organizationId)}</TableCell>
                    <TableCell className="text-muted-foreground">{locationName(user.locationId)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatRelativeTime(user.lastLoginAt)}</TableCell>
                    <TableCell className="text-right">
                      {user.id !== currentUser?.id && (
                        <Button variant="ghost" size="icon-sm" onClick={() => remove.mutate(user.id)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </TableCell>
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
