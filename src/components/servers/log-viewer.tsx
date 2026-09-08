"use client"

import { EmptyState } from "@/components/common/empty-state"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { FileText } from "lucide-react"
import { formatDateTime } from "@/lib/format"
import type { LogEntry } from "@/lib/api/types"
import { cn } from "@/lib/utils"

const LEVEL_STYLES: Record<LogEntry["level"], string> = {
  INFO: "text-sky-600 dark:text-sky-400 bg-sky-500/10 border-sky-500/20",
  WARN: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20",
  ERROR: "text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/20",
  DEBUG: "text-muted-foreground bg-muted border-border",
}

export function LogViewer({ logs, isLoading }: { logs?: LogEntry[]; isLoading?: boolean }) {
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading logs…</p>
  if (!logs || logs.length === 0) return <EmptyState icon={FileText} title="No log entries" className="border-none py-8" />

  return (
    <ScrollArea className="h-96 rounded-lg border">
      <div className="divide-y">
        {logs.map((log) => (
          <div key={log.id} className="flex items-start gap-3 p-3 font-mono text-xs">
            <Badge variant="outline" className={cn("shrink-0 font-sans", LEVEL_STYLES[log.level])}>
              {log.level}
            </Badge>
            <span className="shrink-0 text-muted-foreground">{formatDateTime(log.timestamp)}</span>
            <span className="text-muted-foreground">{log.source}</span>
            <span className="min-w-0 flex-1 break-words text-foreground">{log.message}</span>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
