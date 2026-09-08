import type { ZoneEqualizerSettings } from "@/lib/api/types"

/** The 10 ISO-standard graphic-EQ centers this product exposes, in the
 * fixed order every `bands` array uses everywhere (UI, API payload, DB). */
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const

export function bandLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz)
}

export function formatDb(n: number): string {
  const rounded = Math.round(n)
  return rounded === 0 ? "0 dB" : `${rounded > 0 ? "+" : ""}${rounded} dB`
}

export const EQ_MIN_DB = -12
export const EQ_MAX_DB = 12

export const CUSTOM_PRESET_ID = "custom"

export interface EqPreset {
  id: string
  name: string
  /** Exactly EQ_BANDS.length gains, in dB, same order as EQ_BANDS. */
  bands: number[]
}

/** Flat first (the true off/reference curve), then venue-useful shapes.
 * "Custom" is deliberately not in this list — it's not a curve you pick,
 * it's what `presetId` becomes the moment a band is hand-edited off one of
 * these (see zone-equalizer-dialog.tsx). */
export const EQ_PRESETS: EqPreset[] = [
  { id: "flat", name: "Flat", bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  {
    id: "dinner",
    name: "Dinner",
    // Gentle: a little low/high air, a slight dip through the vocal mids
    // so conversation still carries over the music.
    bands: [2, 2, 1, 0, -1, -1, 0, 1, 2, 2],
  },
  {
    id: "bar",
    name: "Bar",
    // Classic smile curve — more energy at close range, holds up under
    // room noise.
    bands: [4, 3, 1, 0, -1, 0, 1, 2, 3, 4],
  },
  {
    id: "speech",
    name: "Speech",
    // Rolls off the extremes and lifts 500-2k so announcements/paging cut
    // through clearly.
    bands: [-4, -3, -1, 2, 4, 4, 3, 0, -2, -3],
  },
  {
    id: "outdoor",
    name: "Outdoor",
    // Bigger low/high push to fight open-air absorption and ambient noise.
    bands: [5, 4, 2, 0, -1, 0, 1, 3, 5, 6],
  },
]

export function findPreset(id: string): EqPreset | undefined {
  return EQ_PRESETS.find((p) => p.id === id)
}

export function clampDb(n: number): number {
  return Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, n))
}

export function clampAmount(n: number): number {
  return Math.min(100, Math.max(0, n))
}

/** What a zone whose `equalizer` is still null renders as — flat curve,
 * master off, every module off. Never persisted implicitly; only written
 * once the operator actually changes something (see
 * zone-equalizer-dialog.tsx `useState(() => zone.equalizer ?? defaultEqualizer())`). */
export function defaultEqualizer(): ZoneEqualizerSettings {
  return {
    enabled: false,
    presetId: "flat",
    bands: [...(findPreset("flat")?.bands ?? EQ_BANDS.map(() => 0))],
    bassBoost: { on: false, amount: 50 },
    loudness: { on: false, amount: 50 },
    virtualizer: { on: false, amount: 50 },
  }
}
