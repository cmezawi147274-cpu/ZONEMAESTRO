"use client"

import { CalendarClock, Trash2 } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScheduleFormDialog } from "@/components/schedules/schedule-form-dialog"
import { useSchedules, useToggleSchedule, useDeleteSchedule } from "@/hooks/use-schedules"
import { useZones } from "@/hooks/use-zones"
import { usePlaylists } from "@/hooks/use-playlists"

export default function SchedulesPage() {
  const { data: schedules, isLoading } = useSchedules()
  const { data: zones } = useZones()
  const { data: playlists } = usePlaylists()
  const toggle = useToggleSchedule()
  const remove = useDeleteSchedule()

  const zoneName = (id: string) => zones?.find((z) => z.id === id)?.name ?? id
  const playlistName = (id: string) => playlists?.find((p) => p.id === id)?.name ?? id

  return (
    <div className="space-y-6">
      <PageHeader
        title="Scheduling"
        description="Automate which playlist plays in each zone throughout the day. Schedules sync to the Windows MusicServer and keep running even if it loses internet connectivity."
        actions={
          <RoleGate permission="schedule:write">
            <ScheduleFormDialog />
          </RoleGate>
        }
      />

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !schedules || schedules.length === 0 ? (
            <EmptyState icon={CalendarClock} title="No schedules yet" description="Create a schedule to automate playback by time of day." className="border-none" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead>Playlist</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead>Days</TableHead>
                  <TableHead className="text-center">Priority</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((schedule) => (
                  <TableRow key={schedule.id}>
                    <TableCell className="font-medium">{schedule.name}</TableCell>
                    <TableCell>{zoneName(schedule.zoneId)}</TableCell>
                    <TableCell className="text-muted-foreground">{playlistName(schedule.playlistId)}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {schedule.startTime}–{schedule.endTime}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {schedule.days.map((d) => (
                          <Badge key={d} variant="secondary" className="text-[10px]">
                            {d}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-center tabular-nums">{schedule.priority}</TableCell>
                    <TableCell>
                      <RoleGate permission="schedule:write" fallback={<span className="text-xs text-muted-foreground">{schedule.enabled ? "Yes" : "No"}</span>}>
                        <Switch
                          checked={schedule.enabled}
                          onCheckedChange={(checked) => toggle.mutate({ id: schedule.id, enabled: checked })}
                        />
                      </RoleGate>
                    </TableCell>
                    <TableCell>
                      <RoleGate permission="schedule:write">
                        <div className="flex justify-end gap-1">
                          <ScheduleFormDialog schedule={schedule} />
                          <Button variant="ghost" size="icon-sm" onClick={() => remove.mutate(schedule.id)}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </RoleGate>
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
