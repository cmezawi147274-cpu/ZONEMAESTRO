"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { serversApi, type RegisterServerInput } from "@/lib/api/servers"
import { toast } from "sonner"

export function useServers(filters?: { organizationId?: string; locationId?: string }, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["servers", filters ?? {}],
    queryFn: () => serversApi.list(filters),
    refetchInterval: 10_000,
    enabled: options?.enabled ?? true,
  })
}

export function useServer(id: string | undefined) {
  return useQuery({
    queryKey: ["servers", "detail", id],
    queryFn: () => serversApi.get(id!),
    enabled: !!id,
    refetchInterval: 8_000,
  })
}

export function useServerLogs(id: string | undefined) {
  return useQuery({
    queryKey: ["servers", "logs", id],
    queryFn: () => serversApi.logs(id!),
    enabled: !!id,
    refetchInterval: 15_000,
  })
}

export function useRegisterServer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: RegisterServerInput) => serversApi.register(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["servers"] })
      toast.success("Server registered — share the pairing code with the on-site technician")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useRegeneratePairingCode() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => serversApi.regeneratePairingCode(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["servers"] })
      toast.success("New pairing code generated")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useSimulateAgentConnected() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => serversApi.simulateAgentConnected(id),
    onSuccess: (server) => {
      qc.invalidateQueries({ queryKey: ["servers"] })
      qc.invalidateQueries({ queryKey: ["dashboard-stats"] })
      toast.success(`${server.name} is now connected`)
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteServer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => serversApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["servers"] })
      qc.invalidateQueries({ queryKey: ["zones"] })
      toast.success("Server removed")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
