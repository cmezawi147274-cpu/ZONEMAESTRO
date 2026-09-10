import type { Server as HttpServer } from "node:http"
import { Server as SocketIOServer } from "socket.io"
import { env } from "./lib/env.js"
import { prisma } from "./lib/db.js"
import { verifyAccessToken } from "./lib/jwt.js"

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

/** Every SUPER_ADMIN socket. They are not scoped to one organization, so
 * they get their own room rather than an `org:` one. */
const SUPER_ROOM = "role:super"
const orgRoom = (organizationId: string) => `org:${organizationId}`

/**
 * serverId -> organizationId, so routing an event doesn't cost a database
 * round-trip per emit. Heartbeat events alone are one per server every 15
 * seconds, and `emitEvent` is called from hot agent paths.
 *
 * A MusicServer's organizationId never changes after creation (it is set
 * from the location at registration and there is no route that moves one),
 * so entries only ever need adding, never invalidating — but a short TTL is
 * kept anyway so a deleted-and-recreated id can't pin a stale mapping.
 */
const serverOrgCache = new Map<string, { organizationId: string; at: number }>()
const SERVER_ORG_TTL_MS = 5 * 60 * 1000

async function organizationIdForServer(serverId: string): Promise<string | null> {
  const hit = serverOrgCache.get(serverId)
  if (hit && Date.now() - hit.at < SERVER_ORG_TTL_MS) return hit.organizationId
  const server = await prisma.musicServer.findUnique({
    where: { id: serverId },
    select: { organizationId: true },
  })
  if (!server) return null
  serverOrgCache.set(serverId, { organizationId: server.organizationId, at: Date.now() })
  return server.organizationId
}

/**
 * The portal's client (src/lib/realtime/client.ts) does
 * `io(env.wsUrl, ...)` with `NEXT_PUBLIC_WS_URL=http://127.0.0.1:4000/realtime`
 * — socket.io-client parses the URL's path as a *namespace*, not the
 * engine.io transport path, so the server keeps the default `/socket.io`
 * transport path and serves the "/realtime" namespace.
 *
 * Connections are authenticated and placed in a per-organization room.
 * Before this, the namespace accepted any socket with no handshake at all
 * and `emitEvent` broadcast every event to every connection — so an
 * anonymous client that could reach the port received a live feed of every
 * tenant's servers, zones, playback and sync activity, including the
 * serverId/zoneId values needed to attack the REST API.
 */
export function initRealtime(httpServer: HttpServer) {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.corsAllowedOrigins,
      credentials: true,
    },
  })

  const nsp = io.of("/realtime")

  nsp.use((socket, next) => {
    // socket.io-client can carry the token in `auth` (preferred) or, for
    // older clients, the query string.
    const raw =
      (socket.handshake.auth?.token as string | undefined) ??
      (socket.handshake.query?.token as string | undefined)
    const token = typeof raw === "string" && raw.startsWith("Bearer ") ? raw.slice(7) : raw
    if (!token) return next(new Error("UNAUTHORIZED"))

    const claims = verifyAccessToken(token)
    if (!claims) return next(new Error("UNAUTHORIZED"))

    if (claims.role === "SUPER_ADMIN") {
      socket.join(SUPER_ROOM)
    } else if (claims.organizationId) {
      socket.join(orgRoom(claims.organizationId))
    } else {
      // A non-super account with no organization has no events to receive.
      return next(new Error("UNAUTHORIZED"))
    }
    return next()
  })

  nsp.on("connection", (socket) => {
    socket.emit("connected", { ok: true })
  })

  return io
}

/**
 * Emits to the organization that owns `serverId`, plus every SUPER_ADMIN.
 * An event with no resolvable owner goes to SUPER_ADMIN only — failing
 * closed, so a new event type that forgets to carry a serverId leaks to
 * nobody rather than to everybody.
 */
export function emitEvent(event: Omit<RealtimeEvent, "timestamp"> & { timestamp?: string }) {
  if (!io) return
  const envelope = { ...event, timestamp: event.timestamp ?? new Date().toISOString() }
  const nsp = io.of("/realtime")

  if (!event.serverId) {
    nsp.to(SUPER_ROOM).emit("event", envelope)
    return
  }

  // Fire-and-forget: emitEvent is called from request handlers that must not
  // block on this, and a routing failure must never fail the request.
  void organizationIdForServer(event.serverId)
    .then((organizationId) => {
      const rooms = organizationId ? [SUPER_ROOM, orgRoom(organizationId)] : [SUPER_ROOM]
      nsp.to(rooms).emit("event", envelope)
    })
    .catch(() => {
      nsp.to(SUPER_ROOM).emit("event", envelope)
    })
}
