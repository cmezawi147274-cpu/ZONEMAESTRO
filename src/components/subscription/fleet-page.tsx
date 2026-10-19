"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { AlertTriangle, CalendarClock, Download, Loader2, Search } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useAuth } from "@/hooks/use-auth"
import type { FleetSummary } from "@/components/subscription/api"
import { useExportFleet, useSubscriptionFleet } from "@/components/subscription/hooks"
import { BAND_CLASS } from "@/components/subscription/server-page"
import {
  STATUS_LABEL,
  STATUS_ORDER,
  ageLabel,
  filterFleet,
  formatUTC,
  spanBetween,
  type FleetStatus,
  type Span,
} from "@/components/subscription/derive"

function shortSpan(span: Span): string {
  if (span.months > 0) return `${span.months} mo ${span.days} d`
  if (span.days > 0) return `${span.days} d ${span.hours} h`
  return `${span.hours} h ${span.minutes} min`
}

const SUMMARY: { key: keyof FleetSummary; label: string }[] = [
  { key: "total", label: "Total" },
  { key: "notStarted", label: "Not started" },
  { key: "active", label: "Active" },
  { key: "attention", label: "Attention" },
  { key: "warning", label: "Warning" },
  { key: "critical", label: "Critical" },
  { key: "ended", label: "Ended" },
]

export function SubscriptionFleetPage() {
  const { user } = useAuth()
  const isSuperAdmin = user?.role === "SUPER_ADMIN"
  const { data, isLoading, isError } = useSubscriptionFleet(isSuperAdmin)
  const exportFleet = useExportFleet()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<FleetStatus | "all">("all")

  const rows = useMemo(() => filterFleet(data?.servers ?? [], search, statusFilter), [data, search, statusFilter])

  if (!isSuperAdmin) return null

  const now = data?.now

  return (
    <div className="space-y-6">
      <PageHeader
        title="Subscription"
        description="Each server's subscription term, from its own first venue connection."
        actions={
          <Button variant="outline" size="sm" disabled={!data || exportFleet.isPending} onClick={() => exportFleet.mutate()}>
            {exportFleet.isPending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Export fleet summary
          </Button>
        }
      />

      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {SUMMARY.map((s) => (
            <Card key={s.key}>
              <CardContent className="space-y-1">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="text-2xl font-semibold tabular-nums">{data.summary[s.key]}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search server or organization…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter((v as FleetStatus | "all" | null) ?? "all")}
          items={{ all: "All statuses", ...STATUS_LABEL }}
        >
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUS_ORDER.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : isError && !data ? (
            <EmptyState icon={CalendarClock} title="Could not load the subscriptions" description="Try again in a moment." className="border-none" />
          ) : !now || rows.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title={data?.servers.length ? "No matching servers" : "No servers yet"}
              className="border-none"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Server</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>End</TableHead>
                  <TableHead>Time left</TableHead>
                  <TableHead className="text-center">Connections</TableHead>
                  <TableHead>Last connection</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const behind = !!r.startedAt && new Date(now).getTime() < new Date(r.startedAt).getTime()
                  const left = r.endsAt && r.status !== "ended" ? shortSpan(spanBetween(new Date(now), new Date(r.endsAt))) : "-"
                  return (
                    <TableRow key={r.serverId}>
                      <TableCell>
                        <Link href={`/subscription/${encodeURIComponent(r.serverId)}`} className="font-medium hover:underline">
                          {r.name}
                        </Link>
                        {behind && (
                          <p className="flex items-center gap-1 text-xs text-destructive">
                            <AlertTriangle className="size-3" /> Server clock is behind the subscription start
                          </p>
                        )}
                      </TableCell>
                      <TableCell>{r.organizationName ?? "-"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={BAND_CLASS[r.status]}>
                          {STATUS_LABEL[r.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.startedAt ? formatUTC(r.startedAt) : "-"}</TableCell>
                      <TableCell className="text-muted-foreground">{r.endsAt ? formatUTC(r.endsAt) : "-"}</TableCell>
                      <TableCell className="text-muted-foreground">{left}</TableCell>
                      <TableCell className="text-center tabular-nums">{r.startedAt ? r.connectionCount : "-"}</TableCell>
                      <TableCell className="text-muted-foreground">{ageLabel(r.lastConnectionAt, now)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
