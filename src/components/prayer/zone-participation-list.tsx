"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { EmptyState } from "@/components/common/empty-state"
import { Speaker } from "lucide-react"
import { useZones } from "@/hooks/use-zones"
import { useServers } from "@/hooks/use-servers"
import { useSetZonePrayerParticipation } from "@/hooks/use-prayer"
import { useAuth } from "@/hooks/use-auth"

/** Per-zone Prayer Mode participation, independent of the global on/off
 * switch — matches the "Main Dining ON / VIP OFF" style overview called for
 * alongside the main Prayer Mode settings. */
export function ZoneParticipationList() {
  const { data: zones, isLoading } = useZones()
  const { data: servers } = useServers()
  const setParticipation = useSetZonePrayerParticipation()
  const { can } = useAuth()
  const canManage = can("prayer:manage")

  const serverName = (id: string) => servers?.find((s) => s.id === id)?.name ?? "—"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Zone Participation</CardTitle>
        <CardDescription>
          Each zone can opt in or out of Prayer Mode independently of the global switch above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading zones…</p>
        ) : !zones || zones.length === 0 ? (
          <EmptyState icon={Speaker} title="No zones configured" className="border-none py-8" />
        ) : (
          zones.map((zone) => (
            <div key={zone.id} className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-muted/40">
              <div>
                <p className="text-sm font-medium">{zone.name}</p>
                <p className="text-xs text-muted-foreground">{serverName(zone.serverId)}</p>
              </div>
              <Switch
                checked={zone.prayerModeEnabled}
                disabled={!canManage}
                onCheckedChange={(enabled) => setParticipation.mutate({ zoneId: zone.id, enabled })}
              />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
