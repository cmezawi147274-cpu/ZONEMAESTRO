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

/** "Forget Server" — SUPER_ADMIN only. Waits for the Windows agent to
 * confirm it has shut the player down before the cloud row disappears, so
 * this mutation can stay pending for up to ~30s. Never optimistic: a
 * failure leaves the server exactly where it was. */
export function useForgetServer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => serversApi.forget(id),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["servers"] })
      qc.invalidateQueries({ queryKey: ["zones"] })
      qc.invalidateQueries({ queryKey: ["commands"] })
      qc.invalidateQueries({ queryKey: ["dashboard-stats"] })
      // Offline/never-paired still deletes the row, but the operator needs
      // to know nothing was stopped on site.
      if (result.agentReached) toast.success(result.message)
      else toast.warning(result.message)
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
