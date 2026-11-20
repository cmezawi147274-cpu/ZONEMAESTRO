"use client"

import { Activity } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { ActivityFeed } from "@/components/dashboard/activity-feed"
import { AlertsPanel } from "@/components/dashboard/alerts-panel"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useActivityFeed, useAlerts } from "@/hooks/use-monitoring"

export default function MonitoringPage() {
  const { data: activity, isLoading: activityLoading } = useActivityFeed(100)
  const { data: alerts, isLoading: alertsLoading } = useAlerts()

  return (
    <div className="space-y-6">
      <PageHeader
        title="Real-Time Monitoring"
        description="Live fleet activity and alerts."
        actions={<Activity className="size-5 text-muted-foreground" />}
      />

      <Tabs defaultValue="activity">
        <TabsList>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
        </TabsList>

        <TabsContent value="activity" className="pt-4">
          <ActivityFeed events={activity} isLoading={activityLoading} />
        </TabsContent>

        <TabsContent value="alerts" className="pt-4">
          <AlertsPanel alerts={alerts} isLoading={alertsLoading} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
