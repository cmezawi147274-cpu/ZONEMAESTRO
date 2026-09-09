"use client"

import { useEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { Check, Loader2, Save, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog"
import { EqualizerCurve } from "@/components/zones/equalizer-curve"
import { EqualizerModule } from "@/components/zones/equalizer-module"
import { EQ_PRESETS, CUSTOM_PRESET_ID, findPreset, defaultEqualizer, clampDb, clampAmount } from "@/lib/equalizer/presets"
import {
  useEqualizerPresets,
  useSaveEqualizerPreset,
  useDeleteEqualizerPreset,
} from "@/hooks/use-equalizer-presets"
import type { Zone, ZoneEqualizerSettings, ZoneEqualizerModule as EqModule, SavedEqPreset } from "@/lib/api/types"

/** Saved presets are addressed as "saved:<id>" in the Select so a user
 * curve called "Flat" can never collide with the built-in `flat`. */
const SAVED_PREFIX = "saved:"

/** The zone card's compact "Equalizer" row shows this as its right-aligned
 * state — same idea as the Schedule row previewing its own contents. */
export function equalizerSummary(equalizer: ZoneEqualizerSettings | null): string {
  if (!equalizer || !equalizer.enabled) return "Off"
  if (equalizer.presetId === CUSTOM_PRESET_ID) return "Custom"
  // A saved (`saved:<id>`) preset resolves to no built-in and reads as
  // "Custom" here: the card deliberately doesn't fetch the org's preset
  // list, since one query per mounted zone card would fan out across the
  // whole zones page. The dialog itself shows the real name.
  return findPreset(equalizer.presetId)?.name ?? "Custom"
}

function presetSelectItems(saved: SavedEqPreset[]) {
  return Object.fromEntries([
    ...EQ_PRESETS.map((p) => [p.id, p.name] as const),
    ...saved.map((p) => [`${SAVED_PREFIX}${p.id}`, p.name] as const),
    [CUSTOM_PRESET_ID, "Custom"] as const,
  ])
}

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

  // Only while open: every zone card mounts one of these dialogs, so an
  // unconditional query would be one request per card on the zones page.
  const { data: savedPresets } = useEqualizerPresets({ enabled: open })
  const saved = savedPresets ?? []
  const savePreset = useSaveEqualizerPreset()
  const deletePreset = useDeleteEqualizerPreset()
  const [nameDraft, setNameDraft] = useState<string | null>(null)

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

  // Visible, persistent save state — not just the transient error toast,
  // which is easy to miss while dragging a slider. This is what lets the
  // operator actually see that "On" (or a band change) reached the server,
  // rather than discovering it reverted the next time the dialog opens.
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")

  function runSave() {
    setSaveStatus("saving")
    setEqualizerRef.current(draftRef.current).then(
      () => setSaveStatus("saved"),
      () => setSaveStatus("error") // useZoneControls already toasts the error; this just keeps it visible.
    )
  }

  // Debounced autosave: local state updates the UI immediately on every
  // change; the actual command fires this long after the last one. Skips
  // the render right after opening/resetting the dialog, which sets
  // `draft` without the user having changed anything.
  useEffect(() => {
    if (skipNextDebounce.current) {
      skipNextDebounce.current = false
      return
    }
    setSaveStatus("idle")
    const t = setTimeout(() => {
      runSave()
      saveTimerRef.current = null
    }, SAVE_DEBOUNCE_MS)
    saveTimerRef.current = t
    return () => clearTimeout(t)
  }, [draft])

  function flushPendingSave() {
    if (saveTimerRef.current != null) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      runSave()
    }
  }

  function handleOpenChange(next: boolean) {
    setNameDraft(null)
    if (next) {
      skipNextDebounce.current = true
      setSaveStatus("idle")
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
    const bands = id.startsWith(SAVED_PREFIX)
      ? saved.find((p) => `${SAVED_PREFIX}${p.id}` === id)?.bands
      : findPreset(id)?.bands
    setDraft((d) => ({ ...d, presetId: id, bands: bands ? [...bands] : d.bands }))
  }

  const activeSaved = draft.presetId.startsWith(SAVED_PREFIX)
    ? saved.find((p) => `${SAVED_PREFIX}${p.id}` === draft.presetId)
    : undefined

  async function commitSave() {
    const name = (nameDraft ?? "").trim()
    if (!name) return
    const preset = await savePreset
      .mutateAsync({ name, bands: draft.bands, locationId: zone.locationId })
      .catch(() => null)
    if (!preset) return
    // Point the draft at the freshly saved curve, so the Select stops
    // reading "Custom" the moment it's been named and stored.
    setDraft((d) => ({ ...d, presetId: `${SAVED_PREFIX}${preset.id}` }))
    setNameDraft(null)
  }

  async function removeActiveSaved() {
    if (!activeSaved) return
    await deletePreset.mutateAsync(activeSaved.id).catch(() => null)
    // Its bands stay exactly as they are — deleting the *name* shouldn't
    // silently re-EQ a live room. The curve simply becomes "Custom" again.
    setDraft((d) => ({ ...d, presetId: CUSTOM_PRESET_ID }))
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
            <div className="flex shrink-0 items-center gap-3">
              {/* Persistent, not a toast that can be missed mid-drag: this
                  is the only thing telling the operator whether "On" (or a
                  band change) actually reached the Music Server, versus
                  just updating this dialog's own local draft. */}
              {saveStatus === "error" ? (
                <button
                  type="button"
                  onClick={runSave}
                  className="text-[11px] font-medium text-red-400 underline underline-offset-2 hover:text-red-300"
                >
                  Not saved — retry
                </button>
              ) : (
                <span className={"text-[11px] font-medium " + (saveStatus === "saving" ? "text-white/40" : "text-white/30")}>
                  {saveStatus === "saving" && "Saving…"}
                  {saveStatus === "saved" && "Saved"}
                </span>
              )}
              <span className="text-xs font-medium text-white/60">{draft.enabled ? "On" : "Off"}</span>
              <Switch checked={draft.enabled} onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))} />
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={draft.presetId}
              onValueChange={selectPreset}
              items={presetSelectItems(saved)}
              disabled={!draft.enabled}
            >
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
                {saved.map((p) => (
                  <SelectItem key={p.id} value={`${SAVED_PREFIX}${p.id}`}>
                    {p.name}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_PRESET_ID}>Custom</SelectItem>
              </SelectContent>
            </Select>

            {nameDraft === null ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!draft.enabled}
                  onClick={() => setNameDraft(activeSaved?.name ?? "")}
                  className="border-white/10 bg-white/[0.03] text-white hover:bg-white/[0.07] hover:text-white"
                >
                  <Save className="size-3.5" />
                  Save preset
                </Button>
                {activeSaved && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={!draft.enabled || deletePreset.isPending}
                    onClick={removeActiveSaved}
                    aria-label={`Delete preset ${activeSaved.name}`}
                    className="text-white/50 hover:bg-white/[0.07] hover:text-white"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </>
            ) : (
              <div className="flex items-center gap-1.5">
                <Input
                  autoFocus
                  value={nameDraft}
                  maxLength={40}
                  placeholder="Preset name"
                  aria-label="Preset name"
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      void commitSave()
                    } else if (e.key === "Escape") {
                      e.preventDefault()
                      setNameDraft(null)
                    }
                  }}
                  className="h-8 w-44 border-white/10 bg-white/[0.03] text-sm text-white placeholder:text-white/30"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={!nameDraft.trim() || savePreset.isPending}
                  onClick={() => void commitSave()}
                >
                  {savePreset.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="Cancel saving preset"
                  onClick={() => setNameDraft(null)}
                  className="text-white/50 hover:bg-white/[0.07] hover:text-white"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            )}
          </div>

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
