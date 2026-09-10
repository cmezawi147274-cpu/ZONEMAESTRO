import type { Server as HttpServer } from "node:http"
import { Server as SocketIOServer } from "socket.io"
import { env } from "./lib/env.js"

/** Mirrors src/lib/realtime/types.ts RealtimeEvent — the browser's socket.io
 * client listens for event name "event" with this exact envelope. */
export interface RealtimeEvent<T = unknown> {
  type:
    | "SERVER_CONNECTED"
    | "SERVER_DISCONNECTED"
    | "HEARTBEAT_RECEIVED"
    | "ZONE_STATUS_CHANGED"
    | "PLAYBACK_CHANGED"
    | "MUSIC_SYNC_STARTED"
    | "MUSIC_SYNC_COMPLETED"
    | "MUSIC_SYNC_FAILED"
    | "COMMAND_COMPLETED"
    | "PRAYER_STARTED"
    | "PRAYER_ENDED"
    | "SUPER_ADMIN_OVERRIDE"
    | "ERROR"
  serverId?: string | null
  zoneId?: string | null
  timestamp: string
  data: T
}

let io: SocketIOServer | null = null

/**
 * The portal's client (src/lib/realtime/client.ts) does
 * `io(env.wsUrl, ...)` with `NEXT_PUBLIC_WS_URL=http://127.0.0.1:4000/realtime`
 * — socket.io-client parses the URL's path as a *namespace*, not the
 * engine.io transport path, so the server keeps the default `/socket.io`
 * transport path and serves the "/realtime" namespace.
 */
export function initRealtime(httpServer: HttpServer) {
  io = new SocketIOServer(httpServer, {
    cors: {
      // Same allowlist as the REST API (src/index.ts) — see the comment
      // there. Unrestricted `origin: true` + credentials:true let any page
      // on the web open an authenticated realtime connection.
      origin: env.corsAllowedOrigins,
      credentials: true,
    },
  })
  const nsp = io.of("/realtime")
  nsp.on("connection", (socket) => {
    socket.emit("connected", { ok: true })
  })
  return io
}

export function emitEvent(event: Omit<RealtimeEvent, "timestamp"> & { timestamp?: string }) {
  if (!io) return
  io.of("/realtime").emit("event", { ...event, timestamp: event.timestamp ?? new Date().toISOString() })
}
