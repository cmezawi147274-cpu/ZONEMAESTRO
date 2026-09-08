"use client"

import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { authApi, type LoginInput } from "@/lib/api/auth"
import { readSession } from "@/lib/auth/session"
import { can, canAny, landingRoute, type Permission } from "@/lib/auth/rbac"

const SESSION_QUERY_KEY = ["session"] as const

export function useSession() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async () => {
      const cached = readSession()
      if (!cached) return null
      const user = await authApi.me()
      return user ? { ...cached, user } : null
    },
    staleTime: 60_000,
    retry: false,
  })
}

export function useAuth() {
  const queryClient = useQueryClient()
  const router = useRouter()
  const { data: session, isLoading } = useSession()

  const loginMutation = useMutation({
    mutationFn: (input: LoginInput) => authApi.login(input),
    onSuccess: (session) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, session)
      router.push(landingRoute(session.user.role))
    },
  })

  const logoutMutation = useMutation({
    mutationFn: () => authApi.logout(),
    onSuccess: () => {
      queryClient.setQueryData(SESSION_QUERY_KEY, null)
      queryClient.clear()
      router.push("/login")
    },
  })

  const user = session?.user ?? null

  return {
    user,
    role: user?.role ?? null,
    isAuthenticated: !!user,
    isLoading,
    login: loginMutation.mutateAsync,
    isLoggingIn: loginMutation.isPending,
    loginError: loginMutation.error as Error | null,
    logout: logoutMutation.mutateAsync,
    can: (permission: Permission) => can(user?.role, permission),
    canAny: (permissions: Permission[]) => canAny(user?.role, permissions),
  }
}
