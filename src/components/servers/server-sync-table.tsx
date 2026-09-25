"use client"

import { RotateCw, RefreshCw } from "lucide-react"
import { EmptyState } from "@/components/common/empty-state"
import { SyncStatusBadge } from "@/components/common/status-badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { useTracks } from "@/hooks/use-music"
import { useRetrySync } from "@/hooks/use-sync"
import type { TrackSyncState } from "@/lib/api/types"

export function ServerSyncTable({ states, isLoading }: { states?: TrackSyncState[]; isLoading?: boolean }) {
  const { data: tracks } = useTracks()
  const retry = useRetrySync()

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading sync status…</p>
  if (!states || states.length === 0) {
    return <EmptyState icon={RefreshCw} title="No tracks synced to this server" className="border-none py-8" />
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Track</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-40">Progress</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {states.map((state) => {
          const track = tracks?.find((t) => t.id === state.trackId)
          return (
            <TableRow key={`${state.trackId}-${state.serverId}`}>
              <TableCell>
                <p className="font-medium">{track?.title ?? state.trackId}</p>
                <p className="text-xs text-muted-foreground">{track?.artist}</p>
              </TableCell>
              <TableCell>
                <SyncStatusBadge status={state.status} />
                {state.errorMessage && <p className="mt-1 text-xs text-red-500">{state.errorMessage}</p>}
              </TableCell>
              <TableCell>
                <Progress value={state.progressPercent} className="h-1.5" />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {new Date(state.updatedAt).toLocaleTimeString()}
              </TableCell>
              <TableCell>
                {state.status === "FAILED" && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={retry.isPending}
                    onClick={() => retry.mutate({ trackId: state.trackId, serverId: state.serverId })}
                  >
                    <RotateCw className="size-3.5" />
                  </Button>
                )}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
