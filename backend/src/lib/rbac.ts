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
  | "music:library"
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
  /** "Forget Server" — shut down the venue player, wipe its local pairing
   * and cache, and delete the cloud row. Strictly more destructive than
   * "server:write" (cloud unpair only), so SUPER_ADMIN only. */
  | "server:forget"

const MATRIX: Record<Role, Permission[]> = {
  SUPER_ADMIN: [
    "org:read", "org:write", "location:read", "location:write", "server:read", "server:write",
    "server:pair", "server:command", "server:forget", "zone:read", "zone:control", "zone:assign", "zone:override", "music:read",
    "music:library", "music:upload", "music:delete", "playlist:read", "playlist:write", "schedule:read", "schedule:write",
    "sync:trigger", "users:manage", "logs:read", "prayer:read", "prayer:manage",
  ],
  // Music library: *reading* it follows "playlist:read", because a playlist
  // is a list of tracks and is unreadable without the track metadata behind
  // it. Withholding "music:read" from these roles while granting
  // "playlist:read" produced a playlist that reported "29 tracks" and then
  // rendered an empty list — the detail page resolves playlist.trackIds
  // against GET /api/music (src/app/(portal)/playlists/[id]/page.tsx), which
  // answered 403, so every track silently vanished. What a role can see is
  // still scoped to its own tenant plus the shared catalogue by
  // lib/tenant.ts libraryReadWhere, so this grants no cross-tenant reach.
  //
  // *Changing* the library stays SUPER_ADMIN-only: "music:upload" and
  // "music:delete" remain deliberately absent below.
  ORGANIZATION_ADMIN: [
    "org:read", "location:read", "location:write", "server:read", "server:write", "server:pair",
    "server:command", "zone:read", "zone:control", "zone:assign", "music:read",
    "playlist:read", "schedule:read", "schedule:write", "sync:trigger", "users:manage",
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
