"use client"

import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import type { ZoneEqualizerModule } from "@/lib/api/types"

/** A semicircular gauge (0-100), arc drawn accent-colored up to `amount`,
 * the rest a hairline track. Purely decorative — the real, accessible
 * control is the Slider rendered below it. */
function Gauge({ amount, active }: { amount: number; active: boolean }) {
  const r = 34
  const circumference = Math.PI * r // half circle
  const offset = circumference * (1 - amount / 100)
  return (
    <svg aria-hidden viewBox="0 0 84 46" className="mx-auto h-12 w-20 overflow-visible">
      <path d="M 6 42 A 34 34 0 0 1 78 42" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={6} strokeLinecap="round" />
      <path
        d="M 6 42 A 34 34 0 0 1 78 42"
        fill="none"
        stroke={active ? "#5ec8f7" : "rgba(255,255,255,0.35)"}
        strokeWidth={6}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className="transition-[stroke-dashoffset] duration-200 ease-out motion-reduce:transition-none"
      />
    </svg>
  )
}

export function EqualizerModule({
  label,
  module,
  disabled,
  onChange,
}: {
  label: string
  module: ZoneEqualizerModule
  disabled: boolean
  onChange: (patch: Partial<ZoneEqualizerModule>) => void
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-white/80">{label}</span>
        <Switch
          size="sm"
          checked={module.on}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ on: checked })}
          aria-label={`${label} on`}
        />
      </div>
      <Gauge amount={module.amount} active={module.on && !disabled} />
      <div className="flex items-center gap-2">
        <Slider
          value={[module.amount]}
          min={0}
          max={100}
          step={1}
          disabled={disabled}
          aria-label={`${label} amount`}
          onValueChange={(v: number | readonly number[]) => onChange({ amount: Array.isArray(v) ? v[0] : v })}
          className="flex-1"
        />
        <span className="w-8 text-right text-[10px] tabular-nums text-white/50">{module.amount}%</span>
      </div>
    </div>
  )
}
