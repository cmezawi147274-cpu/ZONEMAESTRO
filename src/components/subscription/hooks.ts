"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { subscriptionApi, type RecordResponse, type ServerResponse, type SubscriptionFile } from "@/components/subscription/api"

const KEY = ["subscription"]
const serverKey = (serverId: string) => [...KEY, "server", serverId]

function download(file: SubscriptionFile) {
  const blob = new Blob([file.content], { type: file.contentType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = file.filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function useSubscriptionFleet(enabled: boolean) {
  return useQuery({ queryKey: [...KEY, "fleet"], queryFn: () => subscriptionApi.fleet(), enabled, refetchInterval: 60_000 })
}

export function useServerSubscription(serverId: string, enabled: boolean) {
  return useQuery({ queryKey: serverKey(serverId), queryFn: () => subscriptionApi.server(serverId), enabled })
}

export function useServerSubscriptionClock(serverId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...serverKey(serverId), "clock"],
    queryFn: () => subscriptionApi.clock(serverId),
    enabled,
    refetchInterval: 30_000,
  })
}

function useRecordMutation<TInput>(serverId: string, fn: (input: TInput) => Promise<RecordResponse>, success?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.setQueryData<ServerResponse>(serverKey(serverId), (prev) => (prev ? { ...prev, record: data.record, now: data.now } : prev))
      qc.invalidateQueries({ queryKey: [...serverKey(serverId), "clock"] })
      qc.invalidateQueries({ queryKey: [...KEY, "fleet"] })
      if (success) toast.success(success)
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useSaveSubscriptionNotes(serverId: string) {
  return useRecordMutation(serverId, (notes: string) => subscriptionApi.saveNotes(serverId, notes), "Note saved")
}

export function useSaveSubscriptionReminders(serverId: string) {
  return useRecordMutation(serverId, (days: number[]) => subscriptionApi.saveReminders(serverId, days), "Reminders saved")
}

export function useDismissSubscriptionBanner(serverId: string) {
  return useRecordMutation(serverId, (days: number) => subscriptionApi.dismissBanner(serverId, days))
}

export function useRenewSubscription(serverId: string) {
  return useRecordMutation(serverId, (confirmEndDate: string) => subscriptionApi.renew(serverId, confirmEndDate), "Added 12 months")
}

export function useExportSubscription(serverId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (format: "json" | "text") => subscriptionApi.exportFile(serverId, format),
    onSuccess: (file) => {
      download(file)
      qc.invalidateQueries({ queryKey: serverKey(serverId) })
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useExportFleet() {
  return useMutation({
    mutationFn: () => subscriptionApi.exportFleet(),
    onSuccess: download,
    onError: (e: Error) => toast.error(e.message),
  })
}
