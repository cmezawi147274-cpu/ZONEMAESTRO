"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { locationsApi, type CreateLocationInput } from "@/lib/api/locations"
import { toast } from "sonner"

export function useLocations(organizationId?: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["locations", organizationId ?? "all"],
    queryFn: () => locationsApi.list(organizationId),
    enabled: options?.enabled ?? true,
  })
}

export function useLocation(id: string | undefined) {
  return useQuery({
    queryKey: ["locations", "detail", id],
    queryFn: () => locationsApi.get(id!),
    enabled: !!id,
  })
}

export function useCreateLocation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateLocationInput) => locationsApi.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["locations"] })
      qc.invalidateQueries({ queryKey: ["organizations"] })
      toast.success("Location created")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdateLocation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Partial<CreateLocationInput>) => locationsApi.update(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["locations"] })
      // A location edit can change what Prayer Mode is synced to — see
      // src/lib/prayer/config-store.ts `resolveEffectivePrayerConfig`.
      qc.invalidateQueries({ queryKey: ["prayer-config"] })
      qc.invalidateQueries({ queryKey: ["prayer-times-today"] })
      toast.success("Location updated")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteLocation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => locationsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["locations"] })
      qc.invalidateQueries({ queryKey: ["organizations"] })
      toast.success("Location deleted")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
