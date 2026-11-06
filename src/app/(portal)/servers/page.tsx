"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { ServerCog, Search } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { ServerStatusBadge } from "@/components/common/status-badge"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
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
  const [search, setSearch] = useState("")

  const locationName = (id: string) => locations?.find((l) => l.id === id)?.name ?? "—"

  const filteredServers = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return servers
    return servers?.filter(
      (server) =>
        server.name.toLowerCase().includes(query) ||
        (locations?.find((l) => l.id === server.locationId)?.name ?? "").toLowerCase().includes(query)
    )
  }, [servers, locations, search])

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

      {!isLoading && servers && servers.length > 0 && (
        <div className="relative sm:max-w-sm">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search servers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
      )}

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
          ) : !filteredServers || filteredServers.length === 0 ? (
            <EmptyState icon={ServerCog} title="No matching servers" className="border-none py-10" />
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
                {filteredServers.map((server) => (
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
                    <TableCell className="text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        {server.version}
                        {/* There is no remote update path — a technician has
                            to visit the venue — so flagging it here is the
                            only control over an outdated fleet there is.
                            "Unknown" is its own state rather than silently
                            passing: a version nobody can parse is not
                            evidence that the venue is fine. The raw string
                            is always rendered above, whatever its shape. */}
                        {server.latestAgentVersion && server.agentVersionStatus === "current" && (
                          <Badge
                            variant="outline"
                            className="border-emerald-500/40 text-emerald-600 dark:text-emerald-500"
                            title={`Latest version (${server.latestAgentVersion})`}
                          >
                            Latest
                          </Badge>
                        )}
                        {server.agentVersionStatus === "outdated" && (
                          <Badge
                            variant="outline"
                            className="border-amber-500/40 text-amber-600 dark:text-amber-500"
                            title={server.latestAgentVersion ? `Latest version is ${server.latestAgentVersion}` : `Below the minimum supported agent version (${server.minSupportedAgentVersion})`}
                          >
                            Outdated
                          </Badge>
                        )}
                        {server.agentVersionStatus === "unknown" && (server.latestAgentVersion || server.minSupportedAgentVersion) && (
                          <Badge
                            variant="outline"
                            className="text-muted-foreground"
                            title={server.latestAgentVersion ? `Cannot be compared against the latest version (${server.latestAgentVersion})` : `Cannot be compared against the minimum supported version (${server.minSupportedAgentVersion})`}
                          >
                            Unknown
                          </Badge>
                        )}
                      </span>
                    </TableCell>
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
