"use client"

import { useState } from "react"
import Link from "next/link"
import { Building2, Loader2, Save, ServerCog } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { PrayerSettingsRows } from "@/components/prayer/prayer-settings-rows"
import { useServerPrayer, useUpdateServerPrayer, useResetServerPrayer } from "@/hooks/use-prayer"
import { useOrganization } from "@/hooks/use-organizations"
import { useAuth } from "@/hooks/use-auth"
import { cn } from "@/lib/utils"
import type { PrayerName } from "@/lib/constants"
import type { PrayerSettings } from "@/lib/api/types"

const LIMITS = { offsetMin: -30, offsetMax: 60, pauseMax: 60 }

type Mode = "organization" | "custom"

function withinLimits(prayers: Record<PrayerName, PrayerSettings>): Record<PrayerName, PrayerSettings> {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)))
  return Object.fromEntries(
    Object.entries(prayers).map(([p, s]) => [
      p,
      {
        ...s,
        offsetMinutes: clamp(s.offsetMinutes, LIMITS.offsetMin, LIMITS.offsetMax),
        pauseDurationMinutes: clamp(s.pauseDurationMinutes, 1, LIMITS.pauseMax),
      },
    ])
  ) as Record<PrayerName, PrayerSettings>
}

export function ServerPrayerCard({ serverId, organizationId }: { serverId: string; organizationId: string }) {
  const { can, role } = useAuth()
  const canManage = can("prayer:manage")
  const { data, isLoading } = useServerPrayer(serverId)
  const { data: organization } = useOrganization(role === "SUPER_ADMIN" ? organizationId : undefined)
  const save = useUpdateServerPrayer(serverId)
  const reset = useResetServerPrayer(serverId)

  const [mode, setMode] = useState<Mode | null>(null)
  const [draft, setDraft] = useState<Record<PrayerName, PrayerSettings> | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading Prayer Mode settings…</p>
  if (!data) return <p className="text-sm text-muted-foreground">Prayer Mode settings are unavailable right now.</p>

  const savedMode: Mode = data.custom ? "custom" : "organization"
  const shown = mode ?? savedMode
  const rows =
    shown === "custom" ? (draft ?? (data.custom ? data.prayers : withinLimits(data.organizationPrayers))) : data.organizationPrayers
  const dirty = shown !== savedMode || draft !== null
  const busy = save.isPending || reset.isPending

  function choose(next: Mode) {
    if (next === shown) return
    if (next === "organization" && data!.custom) {
      setConfirmReset(true)
      return
    }
    setMode(next === savedMode ? null : next)
    setDraft(null)
  }

  function edit(prayer: PrayerName, patch: Partial<PrayerSettings>) {
    setDraft({ ...rows, [prayer]: { ...rows[prayer], ...patch } })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Prayer Mode</CardTitle>
          <CardDescription>
            {shown === "organization" ? (
              role === "SUPER_ADMIN" ? (
                `Following ${organization ? `${organization.name}'s` : "its organization's"} Prayer Mode settings.`
              ) : (
                <>
                  Following the organization&apos;s settings on the{" "}
                  <Link href="/prayer" className="underline-offset-4 hover:underline">
                    Prayer Mode
                  </Link>{" "}
                  page.
                </>
              )
            ) : data.custom ? (
              "This server uses its own settings. Changes on the Prayer Mode page do not apply to it."
            ) : (
              "Starting from the organization's settings. Not used until you save."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="inline-flex rounded-lg border p-1">
            {(
              [
                ["organization", Building2, "Organization settings"],
                ["custom", ServerCog, "Custom for this server"],
              ] as const
            ).map(([value, Icon, label]) => (
              <button
                key={value}
                type="button"
                disabled={!canManage || busy}
                onClick={() => choose(value)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  shown === value ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
          <PrayerSettingsRows
            prayers={rows}
            onChange={edit}
            disabled={!canManage || busy || shown === "organization"}
            limits={LIMITS}
          />
        </CardContent>
      </Card>

      {canManage && shown === "custom" && (
        <div className="flex justify-end">
          <Button
            onClick={() =>
              save.mutate(rows, {
                onSuccess: () => {
                  setMode(null)
                  setDraft(null)
                },
              })
            }
            disabled={!dirty || busy}
          >
            {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save Server Prayer Settings
          </Button>
        </div>
      )}

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Use the organization&apos;s settings?</AlertDialogTitle>
            <AlertDialogDescription>
              This server&apos;s own Prayer Mode settings will be removed, and it will follow the
              organization&apos;s Prayer Mode settings again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() =>
                reset.mutate(undefined, {
                  onSuccess: () => {
                    setConfirmReset(false)
                    setMode(null)
                    setDraft(null)
                  },
                })
              }
            >
              {reset.isPending && <Loader2 className="size-4 animate-spin" />}
              Use Organization Settings
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
