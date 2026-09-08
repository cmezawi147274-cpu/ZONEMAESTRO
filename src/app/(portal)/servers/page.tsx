"use client"

import Link from "next/link"
import { ServerCog } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { ServerStatusBadge } from "@/components/common/status-badge"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { Progress } from "@/components/ui/progress"
import { RegisterServerDialog } from "@/components/servers/register-server-dialog"
import { useServers } from "@/hooks/use-servers"
import { useLocations } from "@/hooks/use-locations"
import { formatRelativeTime } from "@/lib/format"

export default function ServersPage() {
  const { data: servers, isLoading } = useServers()
  const { data: locations } = useLocations()

  const locationName = (id: string) => locations?.find((l) => l.id === id)?.name ?? "—"

  return (
    <div className="space-y-6">
      <PageHeader
        title="Music Servers"
        description="Windows MusicServer instances connected to the cloud — one per location, each with its own audio zones and local cache."
        actions={
          <RoleGate permission="server:pair">
            <RegisterServerDialog />
          </RoleGate>
        }
      />

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : !servers || servers.length === 0 ? (
            <EmptyState
              icon={ServerCog}
              title="No Music Servers registered"
              description="Register a Windows MusicServer to generate a pairing code for a location."
              className="border-none"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Server</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>CPU / RAM</TableHead>
                  <TableHead>Last Heartbeat</TableHead>
                  <TableHead className="text-center">Zones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servers.map((server) => (
                  <TableRow key={server.id}>
                    <TableCell>
                      <Link href={`/servers/${server.id}`} className="font-medium hover:underline">
                        {server.name}
                      </Link>
                      {server.pairingCode && (
                        <p className="font-mono text-xs text-muted-foreground">Code: {server.pairingCode}</p>
                      )}
                    </TableCell>
                    <TableCell>{locationName(server.locationId)}</TableCell>
                    <TableCell>
                      <ServerStatusBadge status={server.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{server.version}</TableCell>
                    <TableCell className="w-40">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="w-7 text-[11px] text-muted-foreground">CPU</span>
                          <Progress value={server.usage.cpuPercent} className="h-1.5" />
                          <span className="w-8 text-right text-[11px] tabular-nums">{server.usage.cpuPercent}%</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-7 text-[11px] text-muted-foreground">RAM</span>
                          <Progress value={server.usage.ramPercent} className="h-1.5" />
                          <span className="w-8 text-right text-[11px] tabular-nums">{server.usage.ramPercent}%</span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatRelativeTime(server.lastHeartbeatAt)}</TableCell>
                    <TableCell className="text-center tabular-nums">{server.zoneCount}</TableCell>
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
