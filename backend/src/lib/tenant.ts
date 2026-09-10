/**
 * Shared tenant-isolation primitives.
 *
 * The pattern here is the one `routes/zones.ts` already established
 * (`scopedZone` / `allowedLocationIds`); it lives in its own module because
 * `routes/music.ts`, `routes/schedules.ts` and `routes/sync.ts` all needed
 * it and each had none — every route in those three files queried by id
 * with no organization filter at all, so any authenticated user could read,
 * edit and delete another organization's rows, and `POST /sync/queue` would
 * happily push audio onto another organization's venue hardware.
 *
 * Two shapes of ownership exist in this schema and they are handled
 * differently:
 *
 *  - **Directly owned** rows carry `organizationId` themselves (Location,
 *    MusicServer, EqPreset, Playlist, and now Track / MusicFolder).
 *  - **Indirectly owned** rows reach an organization through a parent
 *    (Zone -> Location -> Organization; Schedule -> Zone -> ...).
 *
 * For directly-owned *library* rows (Track, MusicFolder, Playlist) a null
 * `organizationId` is meaningful: it is the operator's shared catalogue,
 * readable by every tenant and mutable only by a SUPER_ADMIN. That mirrors
 * the pre-existing `Playlist.organizationId String?` and is what keeps the
 * 38 tracks already uploaded by super-admins visible to everyone after the
 * migration that added the column.
 */
import { prisma } from "./db.js"
import type { TenantScope } from "./auth-context.js"
import { notFound, forbidden } from "./http-error.js"

/**
 * Prisma `where` fragment limiting a library resource to what this caller
 * may *see*: their own organization's rows plus the shared catalogue.
 * SUPER_ADMIN gets `{}` — no restriction.
 */
export function libraryReadWhere(scope: TenantScope): Record<string, unknown> {
  if (scope.isSuperAdmin) return {}
  if (!scope.organizationId) return { organizationId: null }
  return { OR: [{ organizationId: scope.organizationId }, { organizationId: null }] }
}

/**
 * Whether this caller may *mutate* a library row owned by `ownerOrgId`.
 * Deliberately stricter than reading: a tenant may read the shared
 * catalogue (`ownerOrgId === null`) but may not edit or delete it, or
 * anything belonging to another tenant.
 */
export function canMutateOwned(scope: TenantScope, ownerOrgId: string | null): boolean {
  if (scope.isSuperAdmin) return true
  if (ownerOrgId === null) return false
  return ownerOrgId === scope.organizationId
}

/**
 * The `organizationId` a row this caller is creating must carry. A
 * SUPER_ADMIN is the operator, so their uploads join the shared catalogue
 * (null); everyone else's are private to their own organization. Never
 * taken from the request body — that would be the mass-assignment hole
 * `routes/users.ts` already avoids via `resolveScope`.
 */
export function owningOrganizationId(scope: TenantScope): string | null {
  return scope.isSuperAdmin ? null : scope.organizationId
}

/** Location ids inside this caller's organization. */
export async function allowedLocationIds(organizationId: string): Promise<string[]> {
  const locs = await prisma.location.findMany({ where: { organizationId }, select: { id: true } })
  return locs.map((l) => l.id)
}

/**
 * Loads a Zone the caller is entitled to, or 404s. Mirrors
 * `routes/zones.ts#scopedZone` — 404 rather than 403 so the response never
 * confirms that an id belonging to someone else exists.
 */
export async function scopedZone(scope: TenantScope, zoneId: string) {
  const zone = await prisma.zone.findUnique({ where: { id: zoneId } })
  if (!zone) throw notFound("Zone")
  if (scope.isSuperAdmin) return zone
  if (scope.locationId) {
    if (zone.locationId !== scope.locationId) throw notFound("Zone")
    return zone
  }
  if (!scope.organizationId) throw notFound("Zone")
  const loc = await prisma.location.findUnique({ where: { id: zone.locationId } })
  if (!loc || loc.organizationId !== scope.organizationId) throw notFound("Zone")
  return zone
}

/** Loads a MusicServer the caller is entitled to, or 404s. */
export async function scopedServer(scope: TenantScope, serverId: string) {
  const server = await prisma.musicServer.findUnique({ where: { id: serverId } })
  if (!server) throw notFound("Server")
  if (scope.isSuperAdmin) return server
  if (scope.locationId) {
    if (server.locationId !== scope.locationId) throw notFound("Server")
    return server
  }
  if (!scope.organizationId || server.organizationId !== scope.organizationId) throw notFound("Server")
  return server
}

/**
 * Loads a Playlist the caller is entitled to read, or 404s. Playlists use
 * the same shared-catalogue rule as tracks.
 */
export async function scopedPlaylist(scope: TenantScope, playlistId: string) {
  const playlist = await prisma.playlist.findUnique({ where: { id: playlistId } })
  if (!playlist) throw notFound("Playlist")
  if (scope.isSuperAdmin) return playlist
  if (playlist.organizationId !== null && playlist.organizationId !== scope.organizationId) {
    throw notFound("Playlist")
  }
  return playlist
}

/**
 * Validates every id in `serverIds` against this caller's scope in one
 * query, returning them in the same order. Throws on the first foreign or
 * unknown id rather than silently dropping it — a partially-applied fleet
 * command is worse than a rejected one.
 */
export async function scopedServerIds(scope: TenantScope, serverIds: string[]): Promise<string[]> {
  const unique = Array.from(new Set(serverIds))
  if (unique.length === 0) return []

  const where: Record<string, unknown> = { id: { in: unique } }
  if (!scope.isSuperAdmin) {
    if (scope.locationId) where.locationId = scope.locationId
    else if (scope.organizationId) where.organizationId = scope.organizationId
    else throw forbidden("This account is not attached to an organization.")
  }

  const found = await prisma.musicServer.findMany({ where, select: { id: true } })
  const allowed = new Set(found.map((s) => s.id))
  const rejected = unique.filter((id) => !allowed.has(id))
  if (rejected.length > 0) throw notFound(rejected.length === 1 ? "Server" : "One or more servers")
  return unique
}

/**
 * Validates every id in `trackIds` is readable by this caller (own org or
 * shared catalogue). Same all-or-nothing contract as `scopedServerIds`.
 */
export async function scopedTrackIds(scope: TenantScope, trackIds: string[]): Promise<string[]> {
  const unique = Array.from(new Set(trackIds))
  if (unique.length === 0) return []

  const found = await prisma.track.findMany({
    where: { AND: [{ id: { in: unique } }, libraryReadWhere(scope)] },
    select: { id: true },
  })
  const allowed = new Set(found.map((t) => t.id))
  const rejected = unique.filter((id) => !allowed.has(id))
  if (rejected.length > 0) throw notFound(rejected.length === 1 ? "Track" : "One or more tracks")
  return unique
}
