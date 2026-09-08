"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { schedulesApi, type CreateScheduleInput } from "@/lib/api/schedules"
import { toast } from "sonner"

export function useSchedules(filters?: { zoneId?: string; serverId?: string }, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["schedules", filters ?? {}],
    queryFn: () => schedulesApi.list(filters),
    enabled: options?.enabled ?? true,
  })
}

export function useCreateSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateScheduleInput) => schedulesApi.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] })
      toast.success("Schedule created")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdateSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Partial<CreateScheduleInput>) => schedulesApi.update(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] })
      toast.success("Schedule updated")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useToggleSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => schedulesApi.toggle(id, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => schedulesApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] })
      toast.success("Schedule deleted")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
