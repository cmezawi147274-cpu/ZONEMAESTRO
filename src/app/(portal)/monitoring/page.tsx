"use client"

import { useState } from "react"
import { Activity } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { ActivityFeed } from "@/components/dashboard/activity-feed"
import { AlertsPanel } from "@/components/dashboard/alerts-panel"
import { LogViewer } from "@/components/servers/log-viewer"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useActivityFeed, useAlerts, useLogs } from "@/hooks/use-monitoring"
import { useServers } from "@/hooks/use-servers"
import type { LogEntry } from "@/lib/api/types"

export default function MonitoringPage() {
  const [serverFilter, setServerFilter] = useState("all")
  const [levelFilter, setLevelFilter] = useState<LogEntry["level"] | "all">("all")
  const { data: activity, isLoading: activityLoading } = useActivityFeed(100)
  const { data: alerts, isLoading: alertsLoading } = useAlerts()
  const { data: servers } = useServers()
  const { data: logs, isLoading: logsLoading } = useLogs(
    {
      serverId: serverFilter === "all" ? undefined : serverFilter,
      level: levelFilter === "all" ? undefined : levelFilter,
    },
    300
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Real-Time Monitoring"
        description="Live fleet activity, alerts and Windows MusicServer logs."
        actions={<Activity className="size-5 text-muted-foreground" />}
      />

      <Tabs defaultValue="activity">
        <TabsList>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="activity" className="pt-4">
          <ActivityFeed events={activity} isLoading={activityLoading} />
        </TabsContent>

        <TabsContent value="alerts" className="pt-4">
          <AlertsPanel alerts={alerts} isLoading={alertsLoading} />
        </TabsContent>

        <TabsContent value="logs" className="space-y-4 pt-4">
          <div className="flex flex-wrap gap-2">
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
              value={levelFilter}
              onValueChange={(v) => setLevelFilter((v as LogEntry["level"]) ?? "all")}
              items={{ all: "All levels", INFO: "Info", WARN: "Warning", ERROR: "Error", DEBUG: "Debug" }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All levels</SelectItem>
                <SelectItem value="INFO">Info</SelectItem>
                <SelectItem value="WARN">Warning</SelectItem>
                <SelectItem value="ERROR">Error</SelectItem>
                <SelectItem value="DEBUG">Debug</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Server Logs</CardTitle>
            </CardHeader>
            <CardContent>
              <LogViewer logs={logs} isLoading={logsLoading} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
