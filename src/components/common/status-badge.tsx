import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { CommandStatus, ServerStatus, SyncStatus, ZonePlaybackState } from "@/lib/constants"
import { SYNC_STATUS_LABELS } from "@/lib/constants"

const DOT = "mr-1.5 inline-block size-1.5 rounded-full"

const SERVER_STYLES: Record<ServerStatus, string> = {
  ONLINE: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  OFFLINE: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  WARNING: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  UPDATING: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20",
  UNKNOWN: "bg-muted text-muted-foreground border-border",
}

const SERVER_DOT: Record<ServerStatus, string> = {
  ONLINE: "bg-emerald-500",
  OFFLINE: "bg-red-500",
  WARNING: "bg-amber-500",
  UPDATING: "bg-sky-500 animate-pulse",
  UNKNOWN: "bg-muted-foreground",
}

export function ServerStatusBadge({ status, className }: { status: ServerStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn("gap-0 font-medium capitalize", SERVER_STYLES[status], className)}>
      <span className={cn(DOT, SERVER_DOT[status])} />
      {status.toLowerCase()}
    </Badge>
  )
}

const SYNC_STYLES: Record<SyncStatus, string> = {
  AVAILABLE_IN_CLOUD: "bg-muted text-muted-foreground border-border",
  QUEUED_FOR_SYNC: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20",
  SYNCING: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20",
  CACHED_ON_SERVER: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  FAILED: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
}

export function SyncStatusBadge({ status, className }: { status: SyncStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium", SYNC_STYLES[status], className)}>
      {SYNC_STATUS_LABELS[status]}
    </Badge>
  )
}

const COMMAND_STYLES: Record<CommandStatus, string> = {
  PENDING: "bg-muted text-muted-foreground border-border",
  SENT: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20",
  EXECUTING: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20",
  SUCCESS: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  FAILED: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
  TIMEOUT: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20",
}

export function CommandStatusBadge({ status, className }: { status: CommandStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium capitalize", COMMAND_STYLES[status], className)}>
      {status.toLowerCase()}
    </Badge>
  )
}

const ZONE_STYLES: Record<ZonePlaybackState, string> = {
  PLAYING: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  PAUSED: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  STOPPED: "bg-muted text-muted-foreground border-border",
  OFFLINE: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
}

export function ZoneStateBadge({ state, className }: { state: ZonePlaybackState; className?: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium capitalize", ZONE_STYLES[state], className)}>
      {state.toLowerCase()}
    </Badge>
  )
}

/** Whether prayer times are being calculated from the venue PC's own clock
 * (VENUE), from the portal's Location / custom picker (PORTAL), or from
 * nothing usable at all (NONE). */
export type VenueLocationState = "VENUE" | "PORTAL" | "NONE"

const VENUE_LOCATION_STYLES: Record<VenueLocationState, string> = {
  VENUE: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  PORTAL: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  NONE: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
}

const VENUE_LOCATION_DOT: Record<VenueLocationState, string> = {
  VENUE: "bg-emerald-500",
  PORTAL: "bg-amber-500",
  NONE: "bg-red-500",
}

const VENUE_LOCATION_LABELS: Record<VenueLocationState, string> = {
  VENUE: "Venue location received",
  PORTAL: "Using portal location",
  NONE: "No venue location",
}

/**
 * Reports whether the cloud is calculating prayer times on the venue's own
 * clock. Green means the Windows PC's heartbeat supplied the timezone —
 * coordinates falling back to a city lookup does not downgrade it, because
 * the clock is what prayer scheduling actually fires on.
 *
 * `title` carries the detail (zone, city, and where it came from) rather
 * than the label, so raw coordinates never become the headline.
 */
export function VenueLocationBadge({
  state,
  detail,
  className,
}: {
  state: VenueLocationState
  detail?: string
  className?: string
}) {
  return (
    <Badge
      variant="outline"
      title={detail}
      className={cn("gap-0 font-medium", VENUE_LOCATION_STYLES[state], className)}
    >
      <span className={cn(DOT, VENUE_LOCATION_DOT[state])} />
      {VENUE_LOCATION_LABELS[state]}
    </Badge>
  )
}
