"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { usersApi, type InviteUserInput } from "@/lib/api/users"
import { toast } from "sonner"

export function useUsers() {
  return useQuery({ queryKey: ["users"], queryFn: () => usersApi.list() })
}

export function useInviteUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: InviteUserInput) => usersApi.invite(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] })
      toast.success("User invited")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useUpdateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Partial<InviteUserInput>) => usersApi.update(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] })
      toast.success("User updated")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

export function useDeleteUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => usersApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] })
      toast.success("User removed")
    },
    onError: (e: Error) => toast.error(e.message),
  })
}
