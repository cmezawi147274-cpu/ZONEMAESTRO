"use client"

import { useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog"
import { EqualizerCurve } from "@/components/zones/equalizer-curve"
import { EqualizerModule } from "@/components/zones/equalizer-module"
import { EQ_PRESETS, CUSTOM_PRESET_ID, findPreset, defaultEqualizer, clampDb, clampAmount } from "@/lib/equalizer/presets"
import type { Zone, ZoneEqualizerSettings, ZoneEqualizerModule as EqModule } from "@/lib/api/types"

/** The zone card's compact "Equalizer" row shows this as its right-aligned
 * state — same idea as the Schedule row previewing its own contents. */
export function equalizerSummary(equalizer: ZoneEqualizerSettings | null): string {
  if (!equalizer || !equalizer.enabled) return "Off"
  if (equalizer.presetId === CUSTOM_PRESET_ID) return "Custom"
  return findPreset(equalizer.presetId)?.name ?? "Custom"
}

const PRESET_SELECT_ITEMS = Object.fromEntries([
  ...EQ_PRESETS.map((p) => [p.id, p.name] as const),
  [CUSTOM_PRESET_ID, "Custom"] as const,
])

const SAVE_DEBOUNCE_MS = 450

// Scoped token overrides so every shadcn primitive in this dialog (Slider
// fill/thumb-ring, Switch checked track, focus rings) reads the brand
// accent instead of the app's generic --primary, without forking those
// shared components — same technique as the login page's LOGIN_TOKENS.
// Only reaches genuine DOM descendants: Select's popup portals separately
// (see its own explicit dark className below), so this can't reach it.
const DIALOG_TOKENS = {
  "--primary": "#5ec8f7",
  "--ring": "#5ec8f7",
} as CSSProperties

export function ZoneEqualizerDialog({
  zone,
  controls,
  volumeRow,
  trigger,
}: {
  zone: Zone
  /** Just the one method used here — the same useZoneControls(zone.id,
   * zone.serverId) instance zone-card.tsx already owns for play/pause/
   * volume, passed down so this dialog rides the exact same real command
   * path (portal -> /commands -> agent -> local-api) rather than a second,
   * cloud-only write. See src/hooks/use-zones.ts `setEqualizer`. */
  controls: { setEqualizer: (equalizer: ZoneEqualizerSettings) => Promise<unknown> }
  volumeRow: React.ReactElement
  trigger: React.ReactElement
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ZoneEqualizerSettings>(() => zone.equalizer ?? defaultEqualizer())

  // Latest-value refs for the debounced save below, kept in sync after
  // every render (not written during render — refs are for effects/event
  // handlers, per this project's react-hooks/refs lint rule) so the
  // setTimeout callback never closes over a stale `draft` or a stale
  // `controls` from a since-remounted card.
  const draftRef = useRef(draft)
  const setEqualizerRef = useRef(controls.setEqualizer)
  useEffect(() => {
    draftRef.current = draft
    setEqualizerRef.current = controls.setEqualizer
  })
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipNextDebounce = useRef(true)

  // Debounced autosave: local state updates the UI immediately on every
  // change; the actual command fires this long after the last one. Skips
  // the render right after opening/resetting the dialog, which sets
  // `draft` without the user having changed anything.
  useEffect(() => {
    if (skipNextDebounce.current) {
      skipNextDebounce.current = false
      return
    }
    const t = setTimeout(() => {
      setEqualizerRef.current(draftRef.current)
      saveTimerRef.current = null
    }, SAVE_DEBOUNCE_MS)
    saveTimerRef.current = t
    return () => clearTimeout(t)
  }, [draft])

  function flushPendingSave() {
    if (saveTimerRef.current != null) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      setEqualizerRef.current(draftRef.current)
    }
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      skipNextDebounce.current = true
      setDraft(zone.equalizer ?? defaultEqualizer())
    } else {
      flushPendingSave()
    }
    setOpen(next)
  }

  function updateBand(index: number, value: number) {
    setDraft((d) => {
      const bands = [...d.bands]
      bands[index] = clampDb(value)
      return { ...d, bands, presetId: CUSTOM_PRESET_ID }
    })
  }

  function updateModule(key: "bassBoost" | "loudness" | "virtualizer", patch: Partial<EqModule>) {
    setDraft((d) => ({
      ...d,
      [key]: {
        on: patch.on ?? d[key].on,
        amount: patch.amount != null ? clampAmount(patch.amount) : d[key].amount,
      },
    }))
  }

  function selectPreset(id: string | null) {
    if (!id) return
    const preset = findPreset(id)
    setDraft((d) => ({ ...d, presetId: id, bands: preset ? [...preset.bands] : d.bands }))
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={trigger} />
      <DialogContent
        showCloseButton
        className="dark border-white/10 bg-[#0b0d10] text-white sm:max-w-2xl motion-safe:data-open:animate-in motion-safe:data-open:fade-in-0 motion-safe:data-open:zoom-in-95 motion-reduce:data-open:animate-none"
        style={DIALOG_TOKENS}
      >
        <DialogHeader>
          <div className="flex items-center justify-between gap-3 pr-6">
            <div>
              <DialogTitle className="text-white">{zone.name} equalizer</DialogTitle>
              <DialogDescription className="text-white/50">
                Shapes this zone&apos;s own output on its Music Server. Turning it off bypasses every band, flat.
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs font-medium text-white/60">{draft.enabled ? "On" : "Off"}</span>
              <Switch checked={draft.enabled} onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))} />
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <Select value={draft.presetId} onValueChange={selectPreset} items={PRESET_SELECT_ITEMS} disabled={!draft.enabled}>
            <SelectTrigger className="w-48 border-white/10 bg-white/[0.03] text-white" size="sm">
              <SelectValue placeholder="Preset" />
            </SelectTrigger>
            {/* Select portals its popup independently of DialogContent (see
                src/components/ui/select.tsx), so neither the `dark` class
                nor the CSS-variable overrides above reach it — themed
                explicitly here instead. */}
            <SelectContent className="border-white/10 bg-[#101215] text-white">
              {EQ_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_PRESET_ID}>Custom</SelectItem>
            </SelectContent>
          </Select>

          <EqualizerCurve zoneName={zone.name} bands={draft.bands} enabled={draft.enabled} onBandChange={updateBand} />

          <div className="grid grid-cols-3 gap-2.5">
            <EqualizerModule label="Bass Boost" module={draft.bassBoost} disabled={!draft.enabled} onChange={(p) => updateModule("bassBoost", p)} />
            <EqualizerModule label="Loudness" module={draft.loudness} disabled={!draft.enabled} onChange={(p) => updateModule("loudness", p)} />
            <EqualizerModule label="Virtualizer" module={draft.virtualizer} disabled={!draft.enabled} onChange={(p) => updateModule("virtualizer", p)} />
          </div>

          <div className="rounded-xl border border-white/10 bg-black/20 p-3">
            <p className="mb-2 text-xs font-medium text-white/60">Volume</p>
            {volumeRow}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
