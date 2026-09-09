"use client"

import type { RealtimeEvent, RealtimeListener } from "@/lib/realtime/types"

/** Minimal typed pub/sub used by the mock realtime simulation. A real
 * deployment replaces the emitter side with a WebSocket/SignalR client
 * (see src/lib/realtime/client.ts) — subscribers never know the difference. */
class EventBus {
  private listeners = new Set<RealtimeListener>()

  subscribe(listener: RealtimeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: RealtimeEvent) {
    this.listeners.forEach((listener) => listener(event))
  }
}

export const mockBus = new EventBus()
