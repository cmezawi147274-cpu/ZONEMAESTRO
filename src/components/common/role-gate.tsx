"use client"

import { useAuth } from "@/hooks/use-auth"
import type { Permission } from "@/lib/auth/rbac"

/** Hides children unless the current user has the given permission(s).
 * This is a UX convenience only — every mutating API call must remain safe
 * to attempt without it, since RBAC is enforced server-side in real mode. */
export function RoleGate({
  permission,
  anyOf,
  fallback = null,
  children,
}: {
  permission?: Permission
  anyOf?: Permission[]
  fallback?: React.ReactNode
  children: React.ReactNode
}) {
  const { can, canAny } = useAuth()
  const allowed = permission ? can(permission) : anyOf ? canAny(anyOf) : true
  return allowed ? <>{children}</> : <>{fallback}</>
}
