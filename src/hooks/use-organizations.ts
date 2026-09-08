"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { organizationsApi, type CreateOrganizationInput } from "@/lib/api/organizations"
import { toast } from "sonner"

export function useOrganizations(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["organizations"],
    queryFn: () => organizationsApi.list(),
    enabled: options?.enabled ?? true,
  })
}

export function useOrganization(id: string | undefined) {
  return useQuery({
    queryKey: ["organizations", id],
    queryFn: () => organizationsApi.get(id!),
    enabled: !!id,
  })
}

export function useCreateOrganization() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateOrganizationInput) => organizationsApi.create(input),
    onSuccess: (org) => {
      qc.invalidateQueries({ queryKey: ["organizations"] })
      toast.success(`Organization "${org.name}" created`)
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdateOrganization() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Parameters<typeof organizationsApi.update>[1]) =>
      organizationsApi.update(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["organizations"] })
      toast.success("Organization updated")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteOrganization() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => organizationsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["organizations"] })
      toast.success("Organization deleted")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
