"use client"

import { PageHeader } from "@/components/common/page-header"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { useAuth } from "@/hooks/use-auth"
import { useOrganization } from "@/hooks/use-organizations"
import { isMockMode, env } from "@/lib/config"
import { ROLE_LABELS } from "@/lib/constants"
import { formatDateTime, initials } from "@/lib/format"

export default function SettingsPage() {
  const { user } = useAuth()
  const { data: org } = useOrganization(user?.organizationId ?? undefined)

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Settings" description="Your profile and portal configuration." />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Profile</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <Avatar className="size-14">
            <AvatarFallback>{user ? initials(user.name) : "?"}</AvatarFallback>
          </Avatar>
          <div className="space-y-1">
            <p className="font-medium">{user?.name}</p>
            <p className="text-sm text-muted-foreground">{user?.email}</p>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{user ? ROLE_LABELS[user.role] : ""}</Badge>
              {org && <Badge variant="outline">{org.name}</Badge>}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Member since</span>
            <span>{user ? formatDateTime(user.createdAt) : "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Last login</span>
            <span>{user?.lastLoginAt ? formatDateTime(user.lastLoginAt) : "—"}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Portal Configuration</CardTitle>
          <CardDescription>Read-only — configured via environment variables at deployment time.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">API mode</span>
            <Badge variant={isMockMode ? "secondary" : "outline"}>{isMockMode ? "Mock" : "Live"}</Badge>
          </div>
          {!isMockMode && (
            <>
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">API URL</span>
                <span className="font-mono text-xs">{env.apiUrl}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Realtime URL</span>
                <span className="font-mono text-xs">{env.wsUrl}</span>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
