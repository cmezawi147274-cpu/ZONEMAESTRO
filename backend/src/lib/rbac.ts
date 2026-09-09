import type { Role } from "@prisma/client"

/** Server-side mirror of src/lib/auth/rbac.ts — the UI already gates on
 * this matrix client-side; the backend enforces the same rules
 * authoritatively so a scoped role can't bypass it by calling the API
 * directly. */
export type Permission =
  | "org:read"
  | "org:write"
  | "location:read"
  | "location:write"
  | "server:read"
  | "server:write"
  | "server:pair"
  | "server:command"
  | "zone:read"
  | "zone:control"
  | "zone:assign"
  | "music:read"
  | "music:upload"
  | "music:delete"
  | "playlist:read"
  | "playlist:write"
  | "schedule:read"
  | "schedule:write"
  | "sync:trigger"
  | "users:manage"
  | "logs:read"
  | "prayer:read"
  | "prayer:manage"
  | "zone:override"

const MATRIX: Record<Role, Permission[]> = {
  SUPER_ADMIN: [
    "org:read", "org:write", "location:read", "location:write", "server:read", "server:write",
    "server:pair", "server:command", "zone:read", "zone:control", "zone:assign", "zone:override", "music:read",
    "music:upload", "music:delete", "playlist:read", "playlist:write", "schedule:read", "schedule:write",
    "sync:trigger", "users:manage", "logs:read", "prayer:read", "prayer:manage",
  ],
  ORGANIZATION_ADMIN: [
    "org:read", "location:read", "location:write", "server:read", "server:write", "server:pair",
    "server:command", "zone:read", "zone:control", "zone:assign", "music:read", "music:upload", "music:delete",
    "playlist:read", "playlist:write", "schedule:read", "schedule:write", "sync:trigger", "users:manage",
    "logs:read", "prayer:read", "prayer:manage",
  ],
  LOCATION_MANAGER: [
    "location:read", "server:read", "server:command", "zone:read", "zone:control", "zone:assign", "music:read",
    "playlist:read", "schedule:read", "schedule:write", "sync:trigger", "users:manage", "logs:read", "prayer:read",
  ],
  VIEWER: ["zone:read", "zone:control"],
}

export function can(role: Role | undefined | null, permission: Permission): boolean {
  if (!role) return false
  return MATRIX[role]?.includes(permission) ?? false
}
