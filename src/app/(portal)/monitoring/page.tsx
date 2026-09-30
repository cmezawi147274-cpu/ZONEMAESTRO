"use client"

import { Activity } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { ActivityFeed } from "@/components/dashboard/activity-feed"
import { AlertsPanel } from "@/components/dashboard/alerts-panel"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useActivityFeed, useAlerts } from "@/hooks/use-monitoring"

export default function MonitoringPage() {
  const { data: activity, isLoading: activityLoading } = useActivityFeed(100)
  const { data: alerts, isLoading: alertsLoading } = useAlerts()

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
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Server Logs</CardTitle>
            </CardHeader>
            <CardContent>
              {/* Nothing writes LogEntry and no agent uploads its logs, so
                  there is no data source to list here yet. */}
              <p className="text-sm text-muted-foreground">Server logs are not available.</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
