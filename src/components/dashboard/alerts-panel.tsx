"use client"

import { AlertTriangle, Info, ShieldAlert, Check } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/common/empty-state"
import { formatRelativeTime } from "@/lib/format"
import { useAcknowledgeAlert } from "@/hooks/use-monitoring"
import type { Alert } from "@/lib/api/types"
import { cn } from "@/lib/utils"

const SEVERITY_CONFIG = {
  info: { icon: Info, className: "text-sky-600 dark:text-sky-400 bg-sky-500/10" },
  warning: { icon: AlertTriangle, className: "text-amber-600 dark:text-amber-400 bg-amber-500/10" },
  critical: { icon: ShieldAlert, className: "text-red-600 dark:text-red-400 bg-red-500/10" },
} as const

export function AlertsPanel({ alerts, isLoading }: { alerts?: Alert[]; isLoading?: boolean }) {
  const acknowledge = useAcknowledgeAlert()
  const open = alerts?.filter((a) => !a.acknowledged) ?? []

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="text-sm font-medium">Alerts</CardTitle>
        {open.length > 0 && (
          <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
            {open.length} open
          </span>
        )}
      </CardHeader>
      <CardContent className="flex-1">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : open.length === 0 ? (
          <EmptyState icon={Check} title="No open alerts" description="Everything looks healthy." className="border-none py-8" />
        ) : (
          <ul className="space-y-3">
            {open.slice(0, 6).map((alert) => {
              const config = SEVERITY_CONFIG[alert.severity]
              const Icon = config.icon
              return (
                <li key={alert.id} className="flex items-start gap-3 text-sm">
                  <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full", config.className)}>
                    <Icon className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium leading-snug">{alert.title}</p>
                    <p className="text-xs text-muted-foreground">{alert.message}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{formatRelativeTime(alert.createdAt)}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 px-2 text-xs"
                    onClick={() => acknowledge.mutate(alert.id)}
                    disabled={acknowledge.isPending}
                  >
                    Ack
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
