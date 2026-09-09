"use client"

import { Volume2, VolumeX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"

/**
 * The zone's volume control — extracted from zone-card.tsx unchanged so it
 * can be rendered a second time inside the equalizer dialog (requirement:
 * "Volume in this panel is the same zone volume as the rest of the app,
 * not a second hidden volume") without duplicating the logic. Both call
 * sites share one `useZoneControls` instance and one local drag-state pair
 * — this component owns no state of its own.
 */
export function ZoneVolumeRow({
  volume,
  muted,
  offline,
  onMuteToggle,
  onValueChange,
  onValueCommitted,
}: {
  volume: number
  muted: boolean
  offline: boolean
  onMuteToggle: () => void
  onValueChange: (value: number) => void
  onValueCommitted: (value: number) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="icon-sm" disabled={offline} onClick={onMuteToggle}>
        {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
      </Button>
      <Slider
        value={[volume]}
        max={100}
        step={1}
        disabled={offline}
        onValueChange={(v: number | readonly number[]) => onValueChange(Array.isArray(v) ? v[0] : v)}
        onValueCommitted={(v: number | readonly number[]) => onValueCommitted(Array.isArray(v) ? v[0] : v)}
        className="flex-1"
      />
      <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{volume}%</span>
    </div>
  )
}
