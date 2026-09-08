"use client"

import { cn } from "@/lib/utils"
import type { ConnectionState } from "@/lib/realtime/types"

const CONFIG: Record<ConnectionState, { label: string; dot: string; text: string }> = {
  connected: { label: "Live", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  connecting: { label: "Connecting…", dot: "bg-amber-500 animate-pulse", text: "text-amber-600 dark:text-amber-400" },
  disconnected: { label: "Offline", dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
}

export function ConnectionPill({ state }: { state: ConnectionState }) {
  const config = CONFIG[state]
  return (
    <div className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium", config.text)}>
      <span className={cn("size-1.5 rounded-full", config.dot)} />
      {config.label}
    </div>
  )
}
