"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { subscriptionApi, type SubscriptionResponse } from "@/components/subscription/api"

const KEY = ["subscription"]

export function useSubscription(enabled: boolean) {
  return useQuery({ queryKey: KEY, queryFn: () => subscriptionApi.get(), enabled })
}

export function useSubscriptionClock(enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, "clock"],
    queryFn: () => subscriptionApi.clock(),
    enabled,
    refetchInterval: 30_000,
  })
}

function useRecordMutation<TInput>(fn: (input: TInput) => Promise<SubscriptionResponse>, success?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => {
      qc.setQueryData(KEY, data)
      qc.invalidateQueries({ queryKey: [...KEY, "clock"] })
      if (success) toast.success(success)
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useSaveSubscriptionNotes() {
  return useRecordMutation((notes: string) => subscriptionApi.saveNotes(notes), "Note saved")
}

export function useSaveSubscriptionReminders() {
  return useRecordMutation((days: number[]) => subscriptionApi.saveReminders(days), "Reminders saved")
}

export function useDismissSubscriptionBanner() {
  return useRecordMutation((days: number) => subscriptionApi.dismissBanner(days))
}

export function useRenewSubscription() {
  return useRecordMutation((confirmEndDate: string) => subscriptionApi.renew(confirmEndDate), "Added 12 months")
}

export function useExportSubscription() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (format: "json" | "text") => subscriptionApi.exportFile(format),
    onSuccess: (file) => {
      const blob = new Blob([file.content], { type: file.contentType })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = file.filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      qc.invalidateQueries({ queryKey: KEY })
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
