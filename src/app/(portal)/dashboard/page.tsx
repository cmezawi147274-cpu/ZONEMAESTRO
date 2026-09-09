"use client"

import Link from "next/link"
import { Building2, MapPin, ServerCog, Speaker, PlayCircle, RefreshCw } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { StatCard } from "@/components/dashboard/stat-card"
import { StatusBreakdown } from "@/components/dashboard/status-breakdown"
import { ActivityFeed } from "@/components/dashboard/activity-feed"
import { AlertsPanel } from "@/components/dashboard/alerts-panel"
import { ServerStatusBadge } from "@/components/common/status-badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { useDashboardStats, useActivityFeed, useAlerts } from "@/hooks/use-monitoring"
import { useServers } from "@/hooks/use-servers"
import { useSyncStates } from "@/hooks/use-sync"
import { formatRelativeTime } from "@/lib/format"
import { SYNC_STATUS_LABELS, type SyncStatus } from "@/lib/constants"

export default function DashboardPage() {
  const { data: stats, isLoading: statsLoading } = useDashboardStats()
  const { data: servers, isLoading: serversLoading } = useServers()
  const { data: syncStates } = useSyncStates()
  const { data: activity, isLoading: activityLoading } = useActivityFeed()
  const { data: alerts, isLoading: alertsLoading } = useAlerts()

  const serverSegments = [
    { key: "ONLINE", label: "Online", count: servers?.filter((s) => s.status === "ONLINE").length ?? 0, barColor: "bg-emerald-500", dotColor: "bg-emerald-500", textColor: "text-emerald-600 dark:text-emerald-400" },
    { key: "WARNING", label: "Warning", count: servers?.filter((s) => s.status === "WARNING").length ?? 0, barColor: "bg-amber-500", dotColor: "bg-amber-500", textColor: "text-amber-600 dark:text-amber-400" },
    { key: "UPDATING", label: "Updating", count: servers?.filter((s) => s.status === "UPDATING").length ?? 0, barColor: "bg-sky-500", dotColor: "bg-sky-500", textColor: "text-sky-600 dark:text-sky-400" },
    { key: "OFFLINE", label: "Offline", count: servers?.filter((s) => s.status === "OFFLINE").length ?? 0, barColor: "bg-red-500", dotColor: "bg-red-500", textColor: "text-red-600 dark:text-red-400" },
    { key: "UNKNOWN", label: "Unknown", count: servers?.filter((s) => s.status === "UNKNOWN").length ?? 0, barColor: "bg-muted-foreground/40", dotColor: "bg-muted-foreground/40", textColor: "text-muted-foreground" },
  ]

  const syncColors: Record<SyncStatus, { bar: string; dot: string; text: string }> = {
    AVAILABLE_IN_CLOUD: { bar: "bg-muted-foreground/40", dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
    QUEUED_FOR_SYNC: { bar: "bg-violet-500", dot: "bg-violet-500", text: "text-violet-600 dark:text-violet-400" },
    SYNCING: { bar: "bg-sky-500", dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400" },
    CACHED_ON_SERVER: { bar: "bg-emerald-500", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
    FAILED: { bar: "bg-red-500", dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
  }
  const syncSegments = (Object.keys(SYNC_STATUS_LABELS) as SyncStatus[]).map((status) => ({
    key: status,
    label: SYNC_STATUS_LABELS[status],
    count: syncStates?.filter((s) => s.status === status).length ?? 0,
    barColor: syncColors[status].bar,
    dotColor: syncColors[status].dot,
    textColor: syncColors[status].text,
  }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Fleet-wide overview of your cloud music library, Windows MusicServers, and live playback."
        actions={
          <Button
            variant="outline"
            size="sm"
            render={
              <Link href="/sync">
                <RefreshCw className="size-4" /> Go to Synchronization
              </Link>
            }
          />
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Organizations" value={statsLoading ? "—" : stats?.totalOrganizations} icon={Building2} />
        <StatCard label="Locations" value={statsLoading ? "—" : stats?.totalLocations} icon={MapPin} />
        <StatCard
          label="Servers Online"
          value={statsLoading ? "—" : stats?.serversOnline}
          icon={ServerCog}
          tone="success"
          hint={statsLoading ? undefined : `${stats?.serversOffline ?? 0} offline`}
        />
        <StatCard
          label="Zones Playing"
          value={statsLoading ? "—" : stats?.playingZones}
          icon={PlayCircle}
          tone="success"
          hint={statsLoading ? undefined : `${stats?.activeZones ?? 0} active total`}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <StatusBreakdown title="Music Server Fleet" segments={serverSegments} />
        <StatusBreakdown title="Music Synchronization" segments={syncSegments} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Server Health Overview</CardTitle>
            <Button variant="ghost" size="sm" className="text-xs" render={<Link href="/servers">View all</Link>} />
          </CardHeader>
          <CardContent className="space-y-4">
            {serversLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              servers
                ?.slice()
                .sort((a, b) => (a.status === "OFFLINE" ? -1 : 1) - (b.status === "OFFLINE" ? -1 : 1))
                .slice(0, 6)
                .map((server) => (
                  <Link
                    key={server.id}
                    href={`/servers/${server.id}`}
                    className="block rounded-lg border p-3 transition-colors hover:bg-muted/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{server.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Heartbeat {formatRelativeTime(server.lastHeartbeatAt)}
                        </p>
                      </div>
                      <ServerStatusBadge status={server.status} />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <div>
                        <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                          <span>CPU</span>
                          <span>{server.usage.cpuPercent}%</span>
                        </div>
                        <Progress value={server.usage.cpuPercent} className="h-1.5" />
                      </div>
                      <div>
                        <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                          <span>RAM</span>
                          <span>{server.usage.ramPercent}%</span>
                        </div>
                        <Progress value={server.usage.ramPercent} className="h-1.5" />
                      </div>
                    </div>
                  </Link>
                ))
            )}
          </CardContent>
        </Card>

        <AlertsPanel alerts={alerts} isLoading={alertsLoading} />
      </div>

      <ActivityFeed events={activity} isLoading={activityLoading} />
    </div>
  )
}
