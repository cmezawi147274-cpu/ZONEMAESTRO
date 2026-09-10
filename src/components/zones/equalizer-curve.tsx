"use client"

import { Slider } from "@/components/ui/slider"
import { cn } from "@/lib/utils"
import { EQ_BANDS, EQ_MIN_DB, EQ_MAX_DB, bandLabel } from "@/lib/equalizer/presets"

/** Signed gain with no unit — `formatDb`'s "+3 dB" minus the suffix, for
 * the ten-across per-band readout row. See that row for why. */
function compactDb(gain: number): string {
  const rounded = Math.round(gain)
  return rounded > 0 ? `+${rounded}` : String(rounded)
}

/** Maps a gain (-12..12) to a y% in a 0..100 viewBox, 0 dB at the vertical
 * center — the fill (see `fillPath`) closes back to this same center line
 * rather than the bottom, so a bipolar curve fills correctly whichever way
 * a band leans. */
function yFor(gain: number): number {
  const clamped = Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, gain))
  return 50 - (clamped / EQ_MAX_DB) * 50
}

/** The x% of band `index`'s column *center*.
 *
 * Each band's Slider is a `flex-1` cell in a gapless, padless row (see
 * `rowLayout`), so cell `i` spans `i/n .. (i+1)/n` of the width and its
 * thumb — centered in that cell — sits at `(i + 0.5)/n`. The curve is
 * plotted at those same percentages, so a point lands on its own dot.
 *
 * This was previously `index / (EQ_BANDS.length - 1) * 100`, i.e. the
 * first point pinned to x=0 and the last to x=100. That spacing only
 * matches a row whose outermost items are *centered on the container's
 * own edges*, which this row never was: it carried `gap-1 px-1`, so the
 * thumbs were inset by the padding plus half a cell (~32px at dialog
 * width) while the curve still ran edge to edge. The line therefore
 * started well left of the 31 Hz dot and overshot the 16k dot by the
 * same amount at the other end. Note the fix is in *both* places — the
 * pixel `gap`/`px` are gone from `rowLayout` too, because any padding or
 * gap measured in px cannot be expressed in the SVG's percentage
 * viewBox and would reintroduce exactly this drift. */
function xFor(index: number): number {
  return ((index + 0.5) / EQ_BANDS.length) * 100
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
 * correct.
 *
 * The path also runs flat out to x=0 and x=100 at the first/last band's
 * own gain, the way a hardware EQ display shows the response continuing
 * past its outermost band. Since `xFor` now centers points in their
 * columns, the outermost dots sit at 5% and 95%; without these lead-in/
 * lead-out segments the curve would simply stop short of both edges with
 * a bare gap on each side. */
function linePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ""
  const first = points[0]
  const last = points[points.length - 1]
  const through = points.map((p) => `L ${p.x} ${p.y}`).join(" ")
  return `M 0 ${first.y} ${through} L 100 ${last.y}`
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

  const accent = enabled ? "#5ec8f7" : "rgba(255,255,255,0.25)"

  // Same horizontal distribution on every row (dB labels, the graph body,
  // frequency labels) so a label centers exactly above/below its own
  // band's slider — see the comment on the graph-body div below for why
  // this row split exists at all.
  //
  // Deliberately no `gap`/`px`: ten equal `flex-1` cells and nothing else,
  // so cell `i` is exactly `i/10 .. (i+1)/10` of the width and `xFor` can
  // name its center in plain percent. Any px-sized gap or padding here is
  // invisible to the SVG's percentage viewBox and desynchronises the curve
  // from the dots again (see `xFor`).
  const rowLayout = "flex"

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

        {/* Per-band current value, in its own row above the graph body.
            The number only — no repeated "dB" suffix. A cell is a tenth of
            the graph's width (~26px on a phone, where the dialog is not yet
            at its sm:max-w-2xl), and "+12 dB" does not fit in that; ten
            copies of the unit is also just noise on a control whose whole
            axis is dB. `formatDb` still carries the unit for the single-
            value readouts elsewhere. */}
        <div className={rowLayout} aria-hidden>
          {EQ_BANDS.map((hz, i) => (
            <span
              key={hz}
              className="flex-1 text-center text-[10px] font-medium tabular-nums whitespace-nowrap text-white/60"
            >
              {compactDb(bands[i] ?? 0)}
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
            {/* Band guides + bipolar stems, replacing what the raw Slider
                used to paint. The shared Slider draws a `bg-muted` track
                and a `bg-primary` indicator that fills from the track's
                *minimum* up to the value — fine for a 0..100 volume, but
                on a -12..+12 EQ that put ten near-white bars (dark mode's
                --primary is oklch(0.922)) rising off the bottom of the
                graph, anchored to -12 dB, which is not a meaningful
                reference for a bipolar gain and read as noise across the
                curve. Both are suppressed on the Sliders below and drawn
                here instead: a hairline guide for the band's full travel,
                and a stem anchored at 0 dB — the reference that actually
                means something — running to the band's own value. */}
            {points.map((p, i) => (
              <line
                key={`guide-${EQ_BANDS[i]}`}
                x1={p.x}
                y1={0}
                x2={p.x}
                y2={100}
                stroke="rgba(255,255,255,0.07)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path d={fillD} fill="url(#eq-fill)" />
            {points.map((p, i) =>
              p.y === 50 ? null : (
                <line
                  key={`stem-${EQ_BANDS[i]}`}
                  x1={p.x}
                  y1={50}
                  x2={p.x}
                  y2={p.y}
                  stroke={accent}
                  strokeOpacity={enabled ? 0.45 : 0.6}
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              ),
            )}
            <path
              d={curveD}
              fill="none"
              stroke={accent}
              strokeWidth={1.25}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {/* One accessible vertical Slider per band, one per gapless
              tenth of the same width the curve above spans (so a thumb's
              x is exactly `xFor(i)`), each filling this box's full height
              so its thumb travel matches the SVG's 0..100% exactly.
              thumbAlignment="center" overrides this shared component's
              own default of "edge" (src/components/ui/slider.tsx), just
              for these instances — the actual remaining cause of the
              extremes not matching. With "edge" (Base UI's SliderThumb:
              `inset: thumbAlignment !== 'center'`), the thumb's *center*
              is deliberately kept half the thumb's own size away from
              each end of the track, so the thumb never reaches the true
              0%/100% position the SVG curve's endpoints are drawn at —
              invisible at 0 dB (the inset is symmetric, so it cancels out
              exactly at the midpoint) and growing the further a value
              sits from center, worst at +-12 dB. "center" removes that
              inset entirely, so the thumb's center always sits at the
              exact same percent the curve does, at every value. */}
          <div className={`relative h-full items-stretch ${rowLayout}`}>
            {EQ_BANDS.map((hz, i) => (
              <Slider
                key={hz}
                orientation="vertical"
                thumbAlignment="center"
                value={[bands[i] ?? 0]}
                min={EQ_MIN_DB}
                max={EQ_MAX_DB}
                step={1}
                disabled={!enabled}
                aria-label={`${bandLabel(hz)} Hz band gain`}
                onValueChange={(v: number | readonly number[]) => onBandChange(i, Array.isArray(v) ? v[0] : v)}
                // The track and its min-anchored indicator are hidden, not
                // restyled: the SVG above already draws this band's guide
                // and its 0 dB-anchored stem, in the graph's own geometry.
                // Targeting the shared component's `data-slot` hooks keeps
                // the override local to the EQ — the same Slider still
                // paints normally for volume/module amounts elsewhere. The
                // Slider stays here in full for hit-testing, keyboard, and
                // screen-reader semantics; only its paint is delegated.
                className={cn(
                  "h-full flex-1",
                  "[&_[data-slot=slider-track]]:bg-transparent",
                  "[&_[data-slot=slider-range]]:hidden",
                  "[&_[data-slot=slider-thumb]]:border-2 [&_[data-slot=slider-thumb]]:bg-white",
                  enabled
                    ? "[&_[data-slot=slider-thumb]]:border-[#5ec8f7]"
                    : "[&_[data-slot=slider-thumb]]:border-white/30",
                )}
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
