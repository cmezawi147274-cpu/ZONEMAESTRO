"use client"

import { Slider } from "@/components/ui/slider"
import { EQ_BANDS, EQ_MIN_DB, EQ_MAX_DB, bandLabel, formatDb } from "@/lib/equalizer/presets"

/** Maps a gain (-12..12) to a y% in a 0..100 viewBox, 0 dB at the vertical
 * center — the fill (see `fillPath`) closes back to this same center line
 * rather than the bottom, so a bipolar curve fills correctly whichever way
 * a band leans. */
function yFor(gain: number): number {
  const clamped = Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, gain))
  return 50 - (clamped / EQ_MAX_DB) * 50
}

function xFor(index: number): number {
  return (index / (EQ_BANDS.length - 1)) * 100
}

/** A light Catmull-Rom -> quadratic smoothing: each segment's control point
 * is the previous point, so the line eases through each node instead of
 * kinking — enough to read as "a smooth curve" without a spline library. */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ""
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const curr = points[i]
    const midX = (prev.x + curr.x) / 2
    d += ` Q ${prev.x} ${prev.y}, ${midX} ${(prev.y + curr.y) / 2}`
    d += ` T ${curr.x} ${curr.y}`
  }
  return d
}

export function EqualizerCurve({
  zoneName,
  bands,
  enabled,
  onBandChange,
}: {
  zoneName: string
  bands: number[]
  enabled: boolean
  onBandChange: (index: number, value: number) => void
}) {
  const points = EQ_BANDS.map((_, i) => ({ x: xFor(i), y: yFor(bands[i] ?? 0) }))
  const curveD = smoothPath(points)
  const fillD = `${curveD} L 100 50 L 0 50 Z`

  return (
    <div className="relative rounded-xl border border-white/10 bg-black/20 p-4">
      <div className="relative h-48 sm:h-56">
        {/* Zone name, centered in the graph — decoration only. */}
        <p
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-lg font-medium tracking-tight text-white/[0.07] select-none sm:text-xl"
        >
          {zoneName}
        </p>

        {/* 0 dB reference line. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-white/10" />

        {/* The curve + fill — purely decorative; the real, accessible
            controls are the vertical Sliders below. aria-hidden and
            pointer-events-none so it never intercepts drag/click. */}
        <svg
          aria-hidden
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          <defs>
            <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#5ec8f7" stopOpacity={enabled ? 0.35 : 0.08} />
              <stop offset="100%" stopColor="#5ec8f7" stopOpacity={enabled ? 0.02 : 0.01} />
            </linearGradient>
          </defs>
          <path d={fillD} fill="url(#eq-fill)" />
          <path
            d={curveD}
            fill="none"
            stroke={enabled ? "#5ec8f7" : "rgba(255,255,255,0.25)"}
            strokeWidth={1.25}
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* The real controls: one accessible vertical Slider per band,
            evenly spaced across the same width the curve above spans. */}
        <div className="relative flex h-full items-stretch justify-between gap-1 px-1">
          {EQ_BANDS.map((hz, i) => (
            <div key={hz} className="flex flex-1 flex-col items-center gap-1.5">
              <span className="text-[10px] font-medium tabular-nums text-white/60">{formatDb(bands[i] ?? 0)}</span>
              <Slider
                orientation="vertical"
                value={[bands[i] ?? 0]}
                min={EQ_MIN_DB}
                max={EQ_MAX_DB}
                step={1}
                disabled={!enabled}
                aria-label={`${bandLabel(hz)} Hz band gain`}
                onValueChange={(v: number | readonly number[]) => onBandChange(i, Array.isArray(v) ? v[0] : v)}
                className="min-h-32 flex-1"
              />
              <span className="text-[10px] text-white/40">{bandLabel(hz)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
