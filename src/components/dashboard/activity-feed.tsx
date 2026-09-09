import {
  Wifi,
  WifiOff,
  HeartPulse,
  Speaker,
  PlayCircle,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Terminal,
  AlertTriangle,
  Moon,
  ShieldCheck,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState } from "@/components/common/empty-state"
import { formatRelativeTime } from "@/lib/format"
import type { ActivityEvent } from "@/lib/api/types"
import type { RealtimeEventType } from "@/lib/constants"

const ICONS: Record<RealtimeEventType, LucideIcon> = {
  SERVER_CONNECTED: Wifi,
  SERVER_DISCONNECTED: WifiOff,
  HEARTBEAT_RECEIVED: HeartPulse,
  ZONE_STATUS_CHANGED: Speaker,
  PLAYBACK_CHANGED: PlayCircle,
  MUSIC_SYNC_STARTED: RefreshCw,
  MUSIC_SYNC_COMPLETED: CheckCircle2,
  MUSIC_SYNC_FAILED: XCircle,
  COMMAND_COMPLETED: Terminal,
  PRAYER_STARTED: Moon,
  PRAYER_ENDED: Moon,
  SUPER_ADMIN_OVERRIDE: ShieldCheck,
  ERROR: AlertTriangle,
}

const TONE: Partial<Record<RealtimeEventType, string>> = {
  SERVER_CONNECTED: "text-emerald-600 dark:text-emerald-400",
  SERVER_DISCONNECTED: "text-red-600 dark:text-red-400",
  MUSIC_SYNC_COMPLETED: "text-emerald-600 dark:text-emerald-400",
  MUSIC_SYNC_FAILED: "text-red-600 dark:text-red-400",
  PRAYER_STARTED: "text-violet-600 dark:text-violet-400",
  PRAYER_ENDED: "text-violet-600 dark:text-violet-400",
  SUPER_ADMIN_OVERRIDE: "text-primary",
  ERROR: "text-red-600 dark:text-red-400",
}

export function ActivityFeed({ events, isLoading }: { events?: ActivityEvent[]; isLoading?: boolean }) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="text-sm font-medium">Recent Activity</CardTitle>
      </CardHeader>
      <CardContent className="flex-1">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !events || events.length === 0 ? (
          <EmptyState icon={HeartPulse} title="No recent activity" className="border-none py-8" />
        ) : (
          <ul className="space-y-4">
            {events.slice(0, 10).map((event) => {
              const Icon = ICONS[event.type] ?? HeartPulse
              return (
                <li key={event.id} className="flex items-start gap-3 text-sm">
                  <Icon className={`mt-0.5 size-4 shrink-0 ${TONE[event.type] ?? "text-muted-foreground"}`} />
                  <div className="min-w-0 flex-1">
                    <p className="leading-snug">{event.message}</p>
                    <p className="text-xs text-muted-foreground">{formatRelativeTime(event.timestamp)}</p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
