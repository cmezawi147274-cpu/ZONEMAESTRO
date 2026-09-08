"use client"

import { useEffect, useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { Plus, Loader2, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useCreateSchedule, useUpdateSchedule } from "@/hooks/use-schedules"
import { useZones } from "@/hooks/use-zones"
import { usePlaylists } from "@/hooks/use-playlists"
import { DAYS_OF_WEEK, type DayOfWeek } from "@/lib/constants"
import { cn } from "@/lib/utils"
import type { Schedule } from "@/lib/api/types"

const schema = z.object({
  zoneId: z.string().min(1, "Select a zone"),
  playlistId: z.string().min(1, "Select a playlist"),
  name: z.string().min(1, "Name is required"),
  startTime: z.string().min(1),
  endTime: z.string().min(1),
  days: z.array(z.enum(DAYS_OF_WEEK)).min(1, "Select at least one day"),
  priority: z.coerce.number().int().min(1).max(10),
  enabled: z.boolean(),
})

type FormValues = z.infer<typeof schema>

export function ScheduleFormDialog({
  schedule,
  zoneId,
  triggerLabel,
}: {
  schedule?: Schedule
  /** Locks the zone this slot applies to — used from the zone card's own
   * schedule dialog (src/components/zones/zone-schedule-dialog.tsx), where
   * the zone is already known and re-picking it would be redundant. The
   * Zone dropdown itself is hidden rather than disabled; every other field
   * (and the dropdowns that remain) stay exactly as on /schedules. */
  zoneId?: string
  /** Trigger button text for create mode. Defaults to "New Schedule"
   * (the /schedules page); the zone card's dialog passes "Add time slot". */
  triggerLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const { data: zones } = useZones()
  const { data: playlists } = usePlaylists()
  const create = useCreateSchedule()
  const update = useUpdateSchedule()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: schedule
      ? { ...schedule }
      : {
          zoneId: zoneId ?? "",
          playlistId: "",
          name: "",
          startTime: "08:00",
          endTime: "12:00",
          days: ["MON", "TUE", "WED", "THU", "FRI"],
          priority: 1,
          enabled: true,
        },
  })

  useEffect(() => {
    if (!open) return
    if (schedule) form.reset({ ...schedule })
    else if (zoneId) form.setValue("zoneId", zoneId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, schedule, zoneId])

  async function onSubmit(values: FormValues) {
    if (schedule) await update.mutateAsync({ id: schedule.id, ...values })
    else await create.mutateAsync(values)
    setOpen(false)
  }

  const pending = create.isPending || update.isPending

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          schedule ? (
            <Button variant="ghost" size="icon-sm">
              <Pencil className="size-3.5" />
            </Button>
          ) : (
            <Button size="sm">
              <Plus className="size-4" /> {triggerLabel ?? "New Schedule"}
            </Button>
          )
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{schedule ? "Edit Schedule" : "New Schedule"}</DialogTitle>
          <DialogDescription>Assign a playlist to a zone for a recurring time window.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Schedule name</FormLabel>
                  <FormControl>
                    <Input placeholder="Breakfast" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className={zoneId ? "grid grid-cols-1 gap-3" : "grid grid-cols-2 gap-3"}>
              {!zoneId && (
                <FormField
                  control={form.control}
                  name="zoneId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Zone</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                        items={Object.fromEntries((zones ?? []).map((z) => [z.id, z.name]))}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select zone" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {zones?.map((z) => (
                            <SelectItem key={z.id} value={z.id}>
                              {z.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              <FormField
                control={form.control}
                name="playlistId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Playlist</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      items={Object.fromEntries((playlists ?? []).map((p) => [p.id, p.name]))}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select playlist" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {playlists?.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <FormField
                control={form.control}
                name="startTime"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start</FormLabel>
                    <FormControl>
                      <Input type="time" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="endTime"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>End</FormLabel>
                    <FormControl>
                      <Input type="time" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Priority</FormLabel>
                    <FormControl>
                      <Input type="number" min={1} max={10} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="days"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Days</FormLabel>
                  <div className="flex flex-wrap gap-1.5">
                    {DAYS_OF_WEEK.map((day) => {
                      const active = field.value?.includes(day)
                      return (
                        <button
                          key={day}
                          type="button"
                          onClick={() => {
                            const next: DayOfWeek[] = active
                              ? field.value.filter((d: DayOfWeek) => d !== day)
                              : [...field.value, day]
                            field.onChange(next)
                          }}
                          className={cn(
                            "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                            active ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"
                          )}
                        >
                          {day}
                        </button>
                      )
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                  <FormLabel className="!mt-0">Enabled</FormLabel>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="size-4 animate-spin" />}
                {schedule ? "Save Changes" : "Create Schedule"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
