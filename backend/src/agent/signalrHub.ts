import type { Server as HttpServer, IncomingMessage } from "node:http"
import { WebSocketServer, type WebSocket } from "ws"
import { verifyAgentToken } from "../lib/agent-auth.js"
import { registerHubSocket } from "../lib/agent-registry.js"

const RS = ""
export const MUSIC_SERVER_HUB_PATH = "/hubs/musicserver"

function frame(obj: unknown): string {
  return JSON.stringify(obj) + RS
}

/**
 * Minimal SignalR-JSON-protocol-compatible endpoint standing in for
 * `MusicServerHub`. This is deliberately NOT a full ASP.NET SignalR server
 * (no MessagePack, no groups, no reconnect buffer/backplane) — just enough
 * of the wire protocol (handshake, ping keepalive, server->client
 * invocation) for a real SignalR .NET client to connect, authenticate with
 * its agent token, and receive pushed command notifications with lower
 * latency than the REST poll.
 *
 * The REST surface (GET /api/server/commands/pending, POST
 * /api/server/commands/ack) stays the authoritative transport — an agent
 * that only ever polls REST and never opens this socket still works
 * correctly, it just relies on its poll interval instead of an instant
 * push. Holding an open hub socket is one of the two things that makes
 * lib/agent-registry.ts#isAgentConnected() true (the other being a recent
 * heartbeat), which is what zone transport commands check before deciding
 * to wait for an ack vs. failing "<name> is offline." immediately.
 *
 * Browsers are unaffected — they stay on socket.io at /realtime (see
 * ../realtime.ts). This attaches to the same underlying `http.Server` but
 * filters strictly on `MUSIC_SERVER_HUB_PATH`, so socket.io's own
 * engine.io upgrade handling (scoped to its own path) is untouched.
 */
export function attachMusicServerHub(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on("upgrade", (req, socket, head) => {
    let url: URL
    try {
      url = new URL(req.url ?? "", "http://internal")
    } catch {
      return
    }
    if (url.pathname !== MUSIC_SERVER_HUB_PATH) return // not ours — leave for socket.io / anything else
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleConnection(ws, url)
    })
  })

  return wss
}

async function handleConnection(ws: WebSocket, url: URL) {
  const token = url.searchParams.get("access_token") ?? url.searchParams.get("accessToken")
  const ctx = token ? await verifyAgentToken(token) : null
  if (!ctx) {
    ws.close(1008, "Unauthorized")
    return
  }

  let handshaken = false
  let buffer = ""
  let pingTimer: ReturnType<typeof setInterval> | null = null

  ws.on("message", (data) => {
    buffer += data.toString("utf8")
    const parts = buffer.split(RS)
    buffer = parts.pop() ?? ""
    for (const part of parts) {
      if (!part) continue
      let msg: unknown
      try {
        msg = JSON.parse(part)
      } catch {
        continue
      }
      if (!handshaken) {
        // First frame is always the SignalR handshake request:
        // { protocol: "json", version: 1 }. An empty `{}` response means
        // "handshake accepted".
        handshaken = true
        ws.send(frame({}))
        registerHubSocket(ctx.serverId, ws)
        pingTimer = setInterval(() => {
          if (ws.readyState === ws.OPEN) ws.send(frame({ type: 6 }))
        }, 10_000)
        continue
      }
      // type 6 = client ping (keepalive only, no reply needed). Any other
      // client->server invocation is accepted-and-ignored here — the agent
      // is expected to use the REST endpoints for anything needing a real
      // response (heartbeat, command ack, sync).
      void msg
    }
  })

  ws.on("close", () => {
    if (pingTimer) clearInterval(pingTimer)
  })
  ws.on("error", () => {
    if (pingTimer) clearInterval(pingTimer)
  })
}
