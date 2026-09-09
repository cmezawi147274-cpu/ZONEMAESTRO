"use client"

import { use } from "react"
import Link from "next/link"
import { ArrowLeft, Cpu, MemoryStick, HardDrive, ServerCog, Trash2 } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { ServerStatusBadge } from "@/components/common/status-badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { ServerQuickActions } from "@/components/servers/server-quick-actions"
import { LogViewer } from "@/components/servers/log-viewer"
import { CommandHistory } from "@/components/servers/command-history"
import { ServerSyncTable } from "@/components/servers/server-sync-table"
import { ZoneCard } from "@/components/zones/zone-card"
import { useServer, useServerLogs, useDeleteServer } from "@/hooks/use-servers"
import { useZones } from "@/hooks/use-zones"
import { useLocation } from "@/hooks/use-locations"
import { useCommands } from "@/hooks/use-commands"
import { useSyncStates } from "@/hooks/use-sync"
import { useSchedules } from "@/hooks/use-schedules"
import { usePlaylists } from "@/hooks/use-playlists"
import { formatRelativeTime, formatDateTime } from "@/lib/format"
import { useRouter } from "next/navigation"

export default function ServerDetailPage(props: PageProps<"/servers/[id]">) {
  const { id } = use(props.params)
  const router = useRouter()
  const { data: server, isLoading } = useServer(id)
  const { data: location } = useLocation(server?.locationId)
  const { data: zones } = useZones({ serverId: id })
  const { data: logs, isLoading: logsLoading } = useServerLogs(id)
  const { data: commands, isLoading: commandsLoading } = useCommands({ serverId: id })
  const { data: syncStates, isLoading: syncLoading } = useSyncStates({ serverId: id })
  const { data: schedules } = useSchedules({ serverId: id })
  const { data: playlists } = usePlaylists()
  const deleteServer = useDeleteServer()

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (!server) return <EmptyState icon={ServerCog} title="Server not found" />

  return (
    <div className="space-y-6">
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="mb-2 -ml-2 text-muted-foreground"
          render={
            <Link href="/servers">
              <ArrowLeft className="size-4" /> Music Servers
            </Link>
          }
        />
        <PageHeader
          title={server.name}
          description={location ? `${location.name} · ${location.city}, ${location.region}` : undefined}
          actions={
            <div className="flex items-center gap-2">
              <ServerStatusBadge status={server.status} className="h-7 px-3" />
              <RoleGate permission="server:write">
                <AlertDialog>
                  <AlertDialogTrigger render={
                    <Button variant="outline" size="icon">
                      <Trash2 className="size-4" />
                    </Button>
                  } />
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove this server?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This unpairs {server.name} from the cloud portal. Its local cache and zones are
                        unaffected on the Windows machine, but it will stop receiving cloud commands and
                        updates until re-registered.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={async () => {
                          await deleteServer.mutateAsync(server.id)
                          router.push("/servers")
                        }}
                      >
                        Remove Server
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </RoleGate>
            </div>
          }
        />
      </div>

      <ServerQuickActions server={server} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="flex items-center gap-3">
            <Cpu className="size-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">CPU</p>
              <p className="text-lg font-semibold tabular-nums">{server.usage.cpuPercent}%</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3">
            <MemoryStick className="size-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">RAM</p>
              <p className="text-lg font-semibold tabular-nums">{server.usage.ramPercent}%</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3">
            <HardDrive className="size-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Disk</p>
              <p className="text-lg font-semibold tabular-nums">
                {server.usage.diskPercent}%{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  ({server.usage.diskFreeGb}GB free)
                </span>
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="text-xs text-muted-foreground">Local cache</p>
            <p className="text-lg font-semibold tabular-nums">
              {server.cachedTracks} tracks <span className="text-xs font-normal text-muted-foreground">({server.cachedSizeGb} GB)</span>
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-muted-foreground">Version</p>
            <p className="font-medium">{server.version}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Operating System</p>
            <p className="font-medium">{server.os}</p>
          </div>
          <div>
            <p className="text-muted-foreground">IP Address</p>
            <p className="font-medium">{server.ipAddress ?? "—"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Last Heartbeat</p>
            <p className="font-medium">{formatRelativeTime(server.lastHeartbeatAt)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Paired</p>
            <p className="font-medium">{server.pairedAt ? formatDateTime(server.pairedAt) : "Not paired"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Pending Sync Jobs</p>
            <p className="font-medium">{server.pendingSyncJobs}</p>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="zones">
        <TabsList>
          <TabsTrigger value="zones">Zones</TabsTrigger>
          <TabsTrigger value="sync">Music Sync</TabsTrigger>
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
          <TabsTrigger value="commands">Commands</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="zones" className="pt-4">
          {!zones || zones.length === 0 ? (
            <EmptyState icon={ServerCog} title="No zones configured on this server" />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {zones.map((zone) => (
                <ZoneCard key={zone.id} zone={zone} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="sync" className="pt-4">
          <Card>
            <CardContent>
              <ServerSyncTable states={syncStates} isLoading={syncLoading} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="schedules" className="pt-4">
          <Card>
            <CardContent className="space-y-2">
              {!schedules || schedules.length === 0 ? (
                <EmptyState icon={ServerCog} title="No schedules for this server's zones" className="border-none py-8" />
              ) : (
                schedules.map((schedule) => (
                  <div key={schedule.id} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                    <div>
                      <p className="font-medium">
                        {schedule.name} · {zones?.find((z) => z.id === schedule.zoneId)?.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {schedule.startTime}–{schedule.endTime} · {schedule.days.join(", ")} ·{" "}
                        {playlists?.find((p) => p.id === schedule.playlistId)?.name}
                      </p>
                    </div>
                    <span className={schedule.enabled ? "text-emerald-600 dark:text-emerald-400 text-xs font-medium" : "text-xs text-muted-foreground"}>
                      {schedule.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="commands" className="pt-4">
          <Card>
            <CardContent>
              <CommandHistory commands={commands} isLoading={commandsLoading} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logs" className="pt-4">
          <LogViewer logs={logs} isLoading={logsLoading} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
