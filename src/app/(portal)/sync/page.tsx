"use client"

import { useState } from "react"
import { RefreshCw } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { StatusBreakdown } from "@/components/dashboard/status-breakdown"
import { SyncStatusBadge } from "@/components/common/status-badge"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { QueueSyncDialog } from "@/components/sync/queue-sync-dialog"
import { useSyncStates, useRetrySync } from "@/hooks/use-sync"
import { useServers } from "@/hooks/use-servers"
import { useTracks } from "@/hooks/use-music"
import { SYNC_STATUS_LABELS, type SyncStatus } from "@/lib/constants"

export default function SyncPage() {
  const [serverFilter, setServerFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const { data: servers } = useServers()
  const { data: tracks } = useTracks()
  const { data: syncStates, isLoading } = useSyncStates(serverFilter === "all" ? undefined : { serverId: serverFilter })
  const retry = useRetrySync()

  const filtered = (syncStates ?? []).filter((s) => statusFilter === "all" || s.status === statusFilter)

  const colors: Record<SyncStatus, { bar: string; dot: string; text: string }> = {
    AVAILABLE_IN_CLOUD: { bar: "bg-muted-foreground/40", dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
    QUEUED_FOR_SYNC: { bar: "bg-violet-500", dot: "bg-violet-500", text: "text-violet-600 dark:text-violet-400" },
    SYNCING: { bar: "bg-sky-500", dot: "bg-sky-500", text: "text-sky-600 dark:text-sky-400" },
    CACHED_ON_SERVER: { bar: "bg-emerald-500", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
    FAILED: { bar: "bg-red-500", dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
  }
  const segments = (Object.keys(SYNC_STATUS_LABELS) as SyncStatus[]).map((status) => ({
    key: status,
    label: SYNC_STATUS_LABELS[status],
    count: (syncStates ?? []).filter((s) => s.status === status).length,
    barColor: colors[status].bar,
    dotColor: colors[status].dot,
    textColor: colors[status].text,
  }))

  const serverName = (id: string) => servers?.find((s) => s.id === id)?.name ?? id
  const trackName = (id: string) => tracks?.find((t) => t.id === id)?.title ?? id

  return (
    <div className="space-y-6">
      <PageHeader
        title="Music Synchronization"
        description="Cloud-to-local download status for every Windows MusicServer."
        actions={
          <RoleGate permission="sync:trigger">
            <QueueSyncDialog />
          </RoleGate>
        }
      />

      <StatusBreakdown title="Sync Status Across Fleet" segments={segments} />

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={serverFilter}
          onValueChange={(v) => setServerFilter(v ?? "all")}
          items={{ all: "All servers", ...Object.fromEntries((servers ?? []).map((s) => [s.id, s.name])) }}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All servers</SelectItem>
            {servers?.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v ?? "all")}
          items={{ all: "All statuses", ...SYNC_STATUS_LABELS }}
        >
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {(Object.keys(SYNC_STATUS_LABELS) as SyncStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {SYNC_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState icon={RefreshCw} title="No sync jobs match this filter" className="border-none" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Track</TableHead>
                  <TableHead>Server</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-40">Progress</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((state) => (
                  <TableRow key={`${state.trackId}-${state.serverId}`}>
                    <TableCell className="font-medium">{trackName(state.trackId)}</TableCell>
                    <TableCell className="text-muted-foreground">{serverName(state.serverId)}</TableCell>
                    <TableCell>
                      <SyncStatusBadge status={state.status} />
                      {state.errorMessage && <p className="mt-1 text-xs text-red-500">{state.errorMessage}</p>}
                    </TableCell>
                    <TableCell>
                      <Progress value={state.progressPercent} className="h-1.5" />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(state.updatedAt).toLocaleTimeString()}</TableCell>
                    <TableCell>
                      {state.status === "FAILED" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={retry.isPending}
                          onClick={() => retry.mutate({ trackId: state.trackId, serverId: state.serverId })}
                        >
                          Retry
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
