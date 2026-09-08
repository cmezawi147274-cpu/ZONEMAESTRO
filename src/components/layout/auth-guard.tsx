"use client"

import { useEffect } from "react"
import { useRouter, usePathname } from "next/navigation"
import { Loader2 } from "lucide-react"
import { useAuth } from "@/hooks/use-auth"
import { AppShell } from "@/components/layout/app-shell"
import { requiredPermissionFor } from "@/components/layout/nav-items"
import { landingRoute } from "@/lib/auth/rbac"

/**
 * Client-side safety net behind proxy.ts's optimistic cookie check: if the
 * cookie is present but localStorage session data is missing (cleared
 * storage, different device state), this catches it and bounces to /login.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, role, can } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  // A route the role has no permission for is not reachable by URL either —
  // bounce to whatever that role's home actually is.
  const required = requiredPermissionFor(pathname)
  const permitted = !required || can(required)

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/login")
      return
    }
    if (!isLoading && isAuthenticated && !permitted) {
      router.replace(landingRoute(role))
    }
  }, [isLoading, isAuthenticated, permitted, role, router])

  if (isLoading || !isAuthenticated || !permitted) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return <AppShell>{children}</AppShell>
}
