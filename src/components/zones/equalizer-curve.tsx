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

/** Straight connect-the-dots segments — the same shape every real graphic
 * EQ display uses (FabFilter, iZotope, the classic Winamp EQ), and the
 * only shape guaranteed to actually touch each band's dot exactly rather
 * than ease past it. The previous version (Catmull-Rom-style quadratic
 * smoothing through midpoints) *did* pass through every point too, but the
 * curved segments between them could visibly overshoot past a point on a
 * sharp swing between neighbors — e.g. a deep trough right next to a tall
 * peak, like -12 dB at 1k next to +12 dB at 2k — reading as "the line
 * doesn't match the dots" even though the endpoints were technically
 * correct. */
function linePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ""
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")
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
  const curveD = linePath(points)
  const fillD = `${curveD} L 100 50 L 0 50 Z`

  // Same horizontal distribution on every row (dB labels, the graph body,
  // frequency labels) so a label centers exactly above/below its own
  // band's slider — see the comment on the graph-body div below for why
  // this row split exists at all.
  const rowLayout = "flex justify-between gap-1 px-1"

  return (
    <div className="relative rounded-xl border border-white/10 bg-black/20 p-4">
      {/* h-56/h-64 (not the previous h-48/h-56): the base Slider component
          enforces `min-h-40` (160px) on its vertical Control unconditionally
          (src/components/ui/slider.tsx), so the graph body below — this
          box's height minus both label rows' own height, roughly 35-40px —
          must clear 160px on every breakpoint, or the Slider would be
          forced taller than its flex-1 share and drift out of sync with
          the SVG again, the same class of bug this whole change fixes. */}
      <div className="relative flex h-56 flex-col sm:h-64">
        {/* Zone name, centered across the whole graph — decoration only. */}
        <p
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-lg font-medium tracking-tight text-white/[0.07] select-none sm:text-xl"
        >
          {zoneName}
        </p>

        {/* Per-band current value, in its own row above the graph body. */}
        <div className={rowLayout}>
          {EQ_BANDS.map((hz, i) => (
            <span key={hz} className="flex-1 text-center text-[10px] font-medium tabular-nums text-white/60">
              {formatDb(bands[i] ?? 0)}
            </span>
          ))}
        </div>

        {/* The graph body: the SVG curve and the vertical Sliders' own
            tracks now share this exact box, so a value's y on the curve
            and that same value's slider-thumb y come from the identical
            0..100% span. Previously the SVG spanned the *entire* h-48/
            h-56 container while the Sliders sat inside per-band columns
            that also carried the dB-value and frequency labels above/
            below them — those labels' own height shortened each
            Slider's actual travel range without the SVG knowing, so a
            curve point and its own dot agreed less the closer a value
            sat to +-12 dB (visible in the redesign screenshot: dots for
            the largest swings sat well short of the line's peaks/
            troughs). Splitting the labels into their own rows outside
            this div removes that mismatch instead of only narrowing it. */}
        <div className="relative min-h-0 flex-1">
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

          {/* One accessible vertical Slider per band, evenly spaced
              across the same width the curve above spans, each filling
              this box's full height so its thumb travel matches the
              SVG's 0..100% exactly. */}
          <div className={`relative h-full items-stretch ${rowLayout}`}>
            {EQ_BANDS.map((hz, i) => (
              <Slider
                key={hz}
                orientation="vertical"
                value={[bands[i] ?? 0]}
                min={EQ_MIN_DB}
                max={EQ_MAX_DB}
                step={1}
                disabled={!enabled}
                aria-label={`${bandLabel(hz)} Hz band gain`}
                onValueChange={(v: number | readonly number[]) => onBandChange(i, Array.isArray(v) ? v[0] : v)}
                className="h-full flex-1"
              />
            ))}
          </div>
        </div>

        {/* Frequency labels, in their own row below the graph body. */}
        <div className={`${rowLayout} pt-1.5`}>
          {EQ_BANDS.map((hz) => (
            <span key={hz} className="flex-1 text-center text-[10px] text-white/40">
              {bandLabel(hz)}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
