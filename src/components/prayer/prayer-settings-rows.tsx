"use client"

import { useState } from "react"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PRAYER_LABELS, PRAYER_NAMES, type PrayerName } from "@/lib/constants"
import type { PrayerSettings } from "@/lib/api/types"

export function PrayerSettingsRows({
  prayers,
  onChange,
  disabled = false,
  limits,
}: {
  prayers: Record<PrayerName, PrayerSettings>
  onChange: (prayer: PrayerName, patch: Partial<PrayerSettings>) => void
  disabled?: boolean
  limits?: { offsetMin: number; offsetMax: number; pauseMax: number }
}) {
  return (
    <>
      {PRAYER_NAMES.map((p) => {
        const settings = prayers[p]
        return (
          <div key={p} className="flex flex-wrap items-center gap-3 rounded-lg border p-3 sm:flex-nowrap">
            <div className="flex w-28 items-center gap-2 shrink-0">
              <Switch
                checked={settings.enabled}
                disabled={disabled}
                onCheckedChange={(enabled) => onChange(p, { enabled })}
              />
              <span className="text-sm font-medium">{PRAYER_LABELS[p]}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Offset (min)</Label>
              {limits ? (
                <MinutesInput
                  value={settings.offsetMinutes}
                  min={limits.offsetMin}
                  max={limits.offsetMax}
                  disabled={!settings.enabled || disabled}
                  onValue={(offsetMinutes) => onChange(p, { offsetMinutes })}
                />
              ) : (
                <Input
                  type="number"
                  className="w-20"
                  value={settings.offsetMinutes}
                  disabled={!settings.enabled || disabled}
                  onChange={(e) => onChange(p, { offsetMinutes: Number(e.target.value) || 0 })}
                />
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Pause (min)</Label>
              {limits ? (
                <MinutesInput
                  value={settings.pauseDurationMinutes}
                  min={1}
                  max={limits.pauseMax}
                  disabled={!settings.enabled || disabled}
                  onValue={(pauseDurationMinutes) => onChange(p, { pauseDurationMinutes })}
                />
              ) : (
                <Input
                  type="number"
                  min={1}
                  className="w-20"
                  value={settings.pauseDurationMinutes}
                  disabled={!settings.enabled || disabled}
                  onChange={(e) => onChange(p, { pauseDurationMinutes: Math.max(1, Number(e.target.value) || 1) })}
                />
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}

/** Keeps partial typing ("-", empty) on screen and passes on only whole
 * minutes inside the bounds; leaving the field commits what was typed,
 * rounded and held to the bounds. */
function MinutesInput({
  value,
  min,
  max,
  disabled,
  onValue,
}: {
  value: number
  min: number
  max: number
  disabled: boolean
  onValue: (minutes: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <Input
      type="number"
      min={min}
      max={max}
      className="w-20"
      value={text ?? value}
      disabled={disabled}
      onChange={(e) => {
        setText(e.target.value)
        const minutes = Number(e.target.value)
        if (e.target.value !== "" && Number.isInteger(minutes) && minutes >= min && minutes <= max) onValue(minutes)
      }}
      onBlur={() => {
        const minutes = Number(text)
        if (text && Number.isFinite(minutes)) onValue(Math.min(max, Math.max(min, Math.round(minutes))))
        setText(null)
      }}
    />
  )
}
