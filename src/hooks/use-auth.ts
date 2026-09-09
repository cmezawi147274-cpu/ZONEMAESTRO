"use client"

import { useRef } from "react"
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

  // QA review Option 4: holds an already-validated post-login redirect
  // target (see src/lib/auth/rbac.ts safeRedirectTarget, called by
  // src/app/login/page.tsx) for the *next* login call only — a ref, not
  // component state, because it's read from inside the mutation's onSuccess
  // and must never leak into a redirect on some later, unrelated login.
  const redirectOverrideRef = useRef<string | null>(null)

  const loginMutation = useMutation({
    mutationFn: (input: LoginInput) => authApi.login(input),
    onSuccess: (session) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, session)
      router.push(redirectOverrideRef.current ?? landingRoute(session.user.role))
      redirectOverrideRef.current = null
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
    // `redirectTo` must already be validated by the caller (see
    // safeRedirectTarget) — this hook trusts it as-is.
    login: (input: LoginInput, redirectTo?: string) => {
      redirectOverrideRef.current = redirectTo ?? null
      return loginMutation.mutateAsync(input)
    },
    isLoggingIn: loginMutation.isPending,
    loginError: loginMutation.error as Error | null,
    logout: logoutMutation.mutateAsync,
    can: (permission: Permission) => can(user?.role, permission),
    canAny: (permissions: Permission[]) => canAny(user?.role, permissions),
  }
}
