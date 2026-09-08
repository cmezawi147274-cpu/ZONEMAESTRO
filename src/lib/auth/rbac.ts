import type { Role } from "@/lib/constants"

/**
 * Central permission matrix. UI components and route guards should call
 * `can()` rather than compare role strings directly, so the rules stay in
 * one place.
 */
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
  /** Transport only: play/pause/stop/skip/volume/mute. Held by VIEWER. */
  | "zone:control"
  /** Changing what a zone plays — assigning a playlist, excluding/restoring
   * tracks. Deliberately separate from "zone:control" so VIEWER can drive
   * transport without being able to reassign content. */
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
  /** Instant, authoritative zone control that overrides Prayer Mode and any
   * other automatic action, and never waits for local-server confirmation.
   * Restricted to SUPER_ADMIN — see src/hooks/use-zones.ts. */
  | "zone:override"
  /** "Forget Server": shuts the venue player down, wipes its local pairing
   * and cache, and deletes the cloud row as if it had never been synced.
   * Strictly more destructive than "server:write" (which only unpairs), so
   * it is restricted to SUPER_ADMIN and enforced again server-side in
   * backend/src/routes/servers.ts and backend/src/routes/commands.ts. */
  | "server:forget"

const MATRIX: Record<Role, Permission[]> = {
  SUPER_ADMIN: [
    "org:read",
    "org:write",
    "location:read",
    "location:write",
    "server:read",
    "server:write",
    "server:pair",
    "server:command",
    "zone:read",
    "zone:control",
    "zone:assign",
    "zone:override",
    "server:forget",
    "music:read",
    "music:upload",
    "music:delete",
    "playlist:read",
    "playlist:write",
    "schedule:read",
    "schedule:write",
    "sync:trigger",
    "users:manage",
    "logs:read",
    "prayer:read",
    "prayer:manage",
  ],
  ORGANIZATION_ADMIN: [
    "org:read",
    "location:read",
    "location:write",
    "server:read",
    "server:write",
    "server:pair",
    "server:command",
    "zone:read",
    "zone:control",
    "zone:assign",
    "music:read",
    "music:upload",
    "music:delete",
    "playlist:read",
    "playlist:write",
    "schedule:read",
    "schedule:write",
    "sync:trigger",
    "users:manage",
    "logs:read",
    "prayer:read",
    "prayer:manage",
  ],
  LOCATION_MANAGER: [
    "location:read",
    "server:read",
    "server:command",
    "zone:read",
    "zone:control",
    "zone:assign",
    "music:read",
    "playlist:read",
    "schedule:read",
    "schedule:write",
    "sync:trigger",
    "users:manage",
    "logs:read",
    "prayer:read",
  ],
  /** Playback only. A Viewer sees Zones and nothing else — no library, no
   * playlists, no schedules, no settings — and cannot change what a zone
   * plays. See backend/src/routes/* for the authoritative enforcement. */
  VIEWER: ["zone:read", "zone:control"],
}

export function can(role: Role | undefined | null, permission: Permission): boolean {
  if (!role) return false
  return MATRIX[role]?.includes(permission) ?? false
}

export function canAny(role: Role | undefined | null, permissions: Permission[]): boolean {
  return permissions.some((p) => can(role, p))
}

/** Where a role lands after login. A Viewer has no dashboard — Zones is the
 * entire portal for them. */
export function landingRoute(role: Role | undefined | null): string {
  return role === "VIEWER" ? "/zones" : "/dashboard"
}
