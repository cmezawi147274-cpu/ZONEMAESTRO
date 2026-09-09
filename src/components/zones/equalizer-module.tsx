"use client"

import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { clampAmount } from "@/lib/equalizer/presets"
import type { ZoneEqualizerModule } from "@/lib/api/types"

// The arc's endpoints are 72 units apart, so its radius is 72/2 = 36. It
// was previously drawn as `A 34 34` and dashed against a circumference of
// pi*34: an r=34 semicircle only spans 68 units, which cannot reach the
// given endpoints, so SVG scales the radius up to 36 to make it fit (per
// spec, "out-of-range radii"). The path was therefore pi*36 long while the
// dash array claimed pi*34 — 5.6% short, which left the gauge visibly
// unfilled at 100%. Radius is now stated correctly, and `pathLength`
// normalises the arc to 100 units so the dash math is a plain percentage
// and stays right regardless of any future geometry change.
const ARC = "M 6 42 A 36 36 0 0 1 78 42"

/** A semicircular gauge (0-100), arc drawn accent-colored up to `amount`,
 * the rest a hairline track. Purely decorative — the real, accessible
 * control is the Slider rendered below it. */
function Gauge({ amount, active }: { amount: number; active: boolean }) {
  const filled = clampAmount(amount)
  return (
    <svg aria-hidden viewBox="0 0 84 46" className="mx-auto h-12 w-20 overflow-visible">
      <path d={ARC} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={6} strokeLinecap="round" />
      {/* A zero-length dash still paints a dot under `strokeLinecap="round"`,
          which read as a stuck 1% at the left end — so 0 draws nothing. */}
      {filled > 0 && (
        <path
          d={ARC}
          fill="none"
          stroke={active ? "#5ec8f7" : "rgba(255,255,255,0.35)"}
          strokeWidth={6}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={100}
          strokeDashoffset={100 - filled}
          className="transition-[stroke-dashoffset] duration-200 ease-out motion-reduce:transition-none"
        />
      )}
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
