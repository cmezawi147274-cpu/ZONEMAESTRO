"use client"

import { env } from "@/lib/config"
import { mockBus } from "@/lib/realtime/bus"
import { startMockSimulation } from "@/lib/mock/simulate"
import type { ConnectionState, RealtimeEvent, RealtimeListener } from "@/lib/realtime/types"

/**
 * Single entry point the UI uses for live updates, regardless of transport.
 *
 * Mock mode: subscribes to the in-browser event bus fed by the mock
 * simulation loop (src/lib/mock/simulate.ts).
 *
 * Real mode: connects to NEXT_PUBLIC_WS_URL with socket.io-client. The
 * Windows MusicServer / cloud gateway is expected to speak the socket.io
 * protocol (or a SignalR bridge in front of it) and emit events matching
 * RealtimeEventType with a RealtimeEvent envelope — see
 * src/lib/realtime/types.ts. No UI code needs to change when this flips.
 */
class RealtimeClient {
  private state: ConnectionState = "disconnected"
  private stateListeners = new Set<(s: ConnectionState) => void>()
  private socket: import("socket.io-client").Socket | null = null
  private unsubscribeMock: (() => void) | null = null

  getState() {
    return this.state
  }

  onStateChange(cb: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  private setState(s: ConnectionState) {
    this.state = s
    this.stateListeners.forEach((cb) => cb(s))
  }

  connect() {
    if (this.state !== "disconnected") return
    this.setState("connecting")

    if (env.useMockApi) {
      startMockSimulation()
      // Simulate a brief connection handshake for a realistic status pill.
      setTimeout(() => this.setState("connected"), 400)
      return
    }

    import("socket.io-client").then(({ io }) => {
      const socket = io(env.wsUrl, { transports: ["websocket"], withCredentials: true })
      this.socket = socket
      socket.on("connect", () => this.setState("connected"))
      socket.on("disconnect", () => this.setState("disconnected"))
      socket.on("event", (payload: RealtimeEvent) => mockBus.emit(payload))
    })
  }

  disconnect() {
    this.unsubscribeMock?.()
    this.socket?.disconnect()
    this.socket = null
    this.setState("disconnected")
  }

  subscribe(listener: RealtimeListener): () => void {
    return mockBus.subscribe(listener)
  }
}

export const realtimeClient = new RealtimeClient()
