"use client"

import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { realtimeClient } from "@/lib/realtime/client"
import type { RealtimeEvent, ConnectionState } from "@/lib/realtime/types"

/** Query keys invalidated per event type — kept together so it's obvious
 * at a glance what live data each real-time event affects. */
const INVALIDATIONS: Partial<Record<RealtimeEvent["type"], string[][]>> = {
  HEARTBEAT_RECEIVED: [["servers"], ["dashboard-stats"]],
  SERVER_CONNECTED: [["servers"], ["dashboard-stats"], ["activity"]],
  SERVER_DISCONNECTED: [["servers"], ["dashboard-stats"], ["activity"], ["alerts"]],
  ZONE_STATUS_CHANGED: [["zones"]],
  PLAYBACK_CHANGED: [["zones"]],
  MUSIC_SYNC_STARTED: [["sync"], ["servers"]],
  MUSIC_SYNC_COMPLETED: [["sync"], ["servers"], ["activity"], ["dashboard-stats"]],
  MUSIC_SYNC_FAILED: [["sync"], ["activity"], ["alerts"], ["dashboard-stats"]],
  COMMAND_COMPLETED: [["commands"], ["zones"], ["activity"]],
  PRAYER_STARTED: [["zones"], ["activity"], ["logs"]],
  PRAYER_ENDED: [["zones"], ["activity"], ["logs"]],
  SUPER_ADMIN_OVERRIDE: [["zones"], ["commands"], ["activity"]],
  ERROR: [["activity"], ["alerts"]],
}

/**
 * Mounts the live-update connection once per app shell and keeps
 * TanStack Query in sync with server-pushed events. Returns the connection
 * state so the UI can show a status pill.
 */
export function useRealtimeConnection() {
  const queryClient = useQueryClient()
  const [state, setState] = useState<ConnectionState>("disconnected")

  useEffect(() => {
    realtimeClient.connect()
    const offState = realtimeClient.onStateChange(setState)
    const offEvents = realtimeClient.subscribe((event) => {
      const keys = INVALIDATIONS[event.type]
      keys?.forEach((key) => queryClient.invalidateQueries({ queryKey: key }))

      if (event.type === "SERVER_DISCONNECTED") {
        toast.warning("A Music Server went offline", { description: String(event.data ?? "") || undefined })
      }
      if (event.type === "MUSIC_SYNC_FAILED") {
        toast.error("Music sync failed", { description: "Check the Synchronization page for details." })
      }
      if (event.type === "PRAYER_STARTED" || event.type === "PRAYER_ENDED") {
        toast.info(event.type === "PRAYER_STARTED" ? "Prayer Mode paused eligible zones" : "Prayer Mode resumed eligible zones")
      }
    })

    return () => {
      offState()
      offEvents()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return state
}
