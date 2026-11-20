"use client"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { formatDateTime, formatRelativeTime } from "@/lib/format"
import type { MusicServer } from "@/lib/api/types"

function formatUptime(totalSec: number): string {
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <div className="font-medium">{children}</div>
    </div>
  )
}

export function ServerHealthCard({ server }: { server: MusicServer }) {
  const health = server.health ?? null
  const update = server.updateStatus ?? null

  if (!health && !update) {
    return (
      <Card>
        <CardContent className="text-sm text-muted-foreground">
          No health report yet. This PC needs the 2026.11.20 installer.
        </CardContent>
      </Card>
    )
  }

  const last = update?.lastResult

  return (
    <Card>
      <CardContent className="space-y-4 text-sm">
        {health && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">PC health · Reported {formatRelativeTime(server.healthReportedAt)}</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Uptime">
                {typeof health.uptimeSeconds === "number" ? formatUptime(health.uptimeSeconds) : "Not reported"}
              </Field>
              <Field label="Boot">
                {health.bootTime ? formatDateTime(health.bootTime) : "Not reported"}
                {typeof health.bootReason === "string" && health.bootReason && (
                  <p className="text-xs font-normal text-muted-foreground">{health.bootReason}</p>
                )}
              </Field>
              <Field label="Last sleep">
                {health.lastSleep ? formatDateTime(health.lastSleep.at) : "None reported"}
                {health.lastSleep?.reason && (
                  <p className="text-xs font-normal text-muted-foreground">{health.lastSleep.reason}</p>
                )}
              </Field>
              <Field label="Dante Virtual Soundcard">
                {health.dvs ? (
                  <>
                    {health.dvs.ok ? (
                      <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-500">OK</Badge>
                    ) : (
                      <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-500">Problem</Badge>
                    )}
                    {health.dvs.devices.map((d, i) => (
                      <p key={i} className="text-xs font-normal text-muted-foreground">{d}</p>
                    ))}
                  </>
                ) : health.dvs === null ? (
                  "No Dante device found"
                ) : (
                  "Not reported"
                )}
              </Field>
              <Field label={health.disk ? `Disk ${health.disk.drive}` : "Disk"}>
                {health.disk ? (
                  <span className="inline-flex items-center gap-1.5">
                    {formatGb(health.disk.freeBytes)} free of {formatGb(health.disk.totalBytes)}
                    {health.disk.low && (
                      <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-500">Low</Badge>
                    )}
                  </span>
                ) : (
                  "Not reported"
                )}
              </Field>
              <Field label="Music Server version">{health.musicServerVersion ?? "Not reported"}</Field>
              <Field label="Screen lock">
                {health.screenLock ? (health.screenLock.installed ? "Installed" : "Not installed") : "Not reported"}
              </Field>
            </div>
          </div>
        )}
        {update && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Software update · Reported {formatRelativeTime(server.updateStatusAt)}</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="State">
                {update.state}
                {!update.enabled && <p className="text-xs font-normal text-muted-foreground">Updates disabled on this PC</p>}
              </Field>
              <Field label="Available">
                {update.available && (update.available.agent || update.available.musicServer) ? (
                  <>
                    {update.available.agent && <p>Agent {update.available.agent}</p>}
                    {update.available.musicServer && <p>Music Server {update.available.musicServer}</p>}
                  </>
                ) : (
                  "Nothing new"
                )}
              </Field>
              <Field label="Checked">{update.checkedAt ? formatRelativeTime(update.checkedAt) : "Never"}</Field>
              <Field label="Last result">
                {last ? (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      {last.version}
                      {last.outcome === "committed" ? (
                        <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-500">Installed</Badge>
                      ) : (
                        <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-500">Rolled back</Badge>
                      )}
                    </span>
                    <p className="text-xs font-normal text-muted-foreground">
                      From {last.fromVersion ?? "unknown"} · {formatDateTime(last.at)}
                    </p>
                    {last.reason && <p className="text-xs font-normal text-muted-foreground">{last.reason}</p>}
                  </>
                ) : (
                  "None"
                )}
              </Field>
            </div>
            {update.error && <p className="text-sm text-destructive">{update.error}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
