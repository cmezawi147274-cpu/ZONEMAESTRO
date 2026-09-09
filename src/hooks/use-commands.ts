"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { commandsApi, type SendCommandInput } from "@/lib/api/commands"
import { useAuth } from "@/hooks/use-auth"
import { toast } from "sonner"

export function useCommands(filters?: { serverId?: string }) {
  return useQuery({
    queryKey: ["commands", filters ?? {}],
    queryFn: () => commandsApi.list(filters),
    refetchInterval: 4_000,
  })
}

/** Ad-hoc command dispatch (e.g. the Commands page "Send Command" dialog).
 * `source` is never set here — src/lib/api/commands.ts `send()` derives it
 * from the acting session itself; it's never trusted from the client. */
export function useSendCommand() {
  const { user } = useAuth()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Omit<SendCommandInput, "issuedBy" | "source">) =>
      commandsApi.send({ ...input, issuedBy: user?.email ?? "unknown" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commands"] })
      qc.invalidateQueries({ queryKey: ["zones"] })
      toast.success("Command sent")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
