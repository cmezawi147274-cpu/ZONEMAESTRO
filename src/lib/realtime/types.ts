import type { RealtimeEventType } from "@/lib/constants"

/** Envelope for every real-time event, whether it arrives over the mock bus
 * or a real WebSocket/SignalR hub. Mirrors what the Windows MusicServer
 * agent and cloud gateway are expected to emit. */
export interface RealtimeEvent<T = unknown> {
  type: RealtimeEventType
  serverId?: string | null
  zoneId?: string | null
  timestamp: string
  data: T
}

export type RealtimeListener = (event: RealtimeEvent) => void

export type ConnectionState = "connecting" | "connected" | "disconnected"
