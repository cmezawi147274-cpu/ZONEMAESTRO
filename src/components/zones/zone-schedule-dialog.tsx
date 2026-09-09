"use client"

import { useState } from "react"
import { CalendarClock, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { ScheduleFormDialog } from "@/components/schedules/schedule-form-dialog"
import { useSchedules, useDeleteSchedule } from "@/hooks/use-schedules"
import { usePlaylists } from "@/hooks/use-playlists"
import type { Zone } from "@/lib/api/types"

/** Compact per-zone view of Schedule — the same system /schedules uses
 * (backend/src/routes/schedules.ts), just scoped to one zone so an
 * operator can see and edit its time-of-day playlists without leaving the
 * Zones page. Times are shown exactly as entered, in the zone's own
 * location timezone (the schedule form already says so). */
export function ZoneScheduleDialog({ zone, trigger }: { zone: Zone; trigger: React.ReactElement }) {
  const [open, setOpen] = useState(false)
  const { data: schedules } = useSchedules({ zoneId: zone.id })
  const { data: playlists } = usePlaylists()
  const remove = useDeleteSchedule()

  const playlistName = (id: string) => playlists?.find((p) => p.id === id)?.name ?? id
  const sorted = [...(schedules ?? [])].sort((a, b) => a.startTime.localeCompare(b.startTime))

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{zone.name} — Schedule</DialogTitle>
          <DialogDescription>
            Time-of-day playlists for this zone, in {zone.name}&apos;s own location timezone. Higher priority wins when
            two slots overlap.
          </DialogDescription>
        </DialogHeader>

        {sorted.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No time slots yet" className="border-none py-8" />
        ) : (
          <div className="space-y-1.5">
            {sorted.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {s.startTime}–{s.endTime} · {playlistName(s.playlistId)}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {s.days.map((d) => (
                      <Badge key={d} variant="secondary" className="text-[10px]">
                        {d}
                      </Badge>
                    ))}
                    <span className="text-[11px] text-muted-foreground">Priority {s.priority}</span>
                    {!s.enabled && (
                      <Badge variant="outline" className="text-[10px]">
                        Disabled
                      </Badge>
                    )}
                  </div>
                </div>
                <RoleGate anyOf={["schedule:write", "zone:assign"]}>
                  <div className="flex shrink-0 items-center gap-1">
                    <ScheduleFormDialog schedule={s} zoneId={zone.id} />
                    <Button variant="ghost" size="icon-sm" disabled={remove.isPending} onClick={() => remove.mutate(s.id)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </RoleGate>
              </div>
            ))}
          </div>
        )}

        <RoleGate anyOf={["schedule:write", "zone:assign"]}>
          <ScheduleFormDialog zoneId={zone.id} triggerLabel="Add time slot" />
        </RoleGate>
      </DialogContent>
    </Dialog>
  )
}
