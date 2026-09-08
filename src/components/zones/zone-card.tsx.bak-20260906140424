"use client"

import { useEffect, useState } from "react"
import { Play, Pause, Square, SkipBack, SkipForward, Volume2, VolumeX, Moon, ListMusic } from "lucide-react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { ZoneStateBadge } from "@/components/common/status-badge"
import { RoleGate } from "@/components/common/role-gate"
import { useAuth } from "@/hooks/use-auth"
import { useZoneControls, useAssignZonePlaylist } from "@/hooks/use-zones"
import { useSetZonePrayerParticipation } from "@/hooks/use-prayer"
import { usePlaylists } from "@/hooks/use-playlists"
import { useTracks } from "@/hooks/use-music"
import { ZonePlaylistDialog } from "@/components/zones/zone-playlist-dialog"
import { formatRelativeTime } from "@/lib/format"
import { PRAYER_LABELS } from "@/lib/constants"
import type { Zone } from "@/lib/api/types"

export function ZoneCard({ zone, showLocation }: { zone: Zone; showLocation?: string }) {
  const { can } = useAuth()
  const canAssign = can("zone:assign")
  const canReadMusic = can("music:read")
  const controls = useZoneControls(zone.id, zone.serverId)
  const assignPlaylist = useAssignZonePlaylist()
  const setPrayerParticipation = useSetZonePrayerParticipation()
  // A playback-only role holds neither playlist:read nor music:read; don't
  // fire queries whose 403 it can do nothing about.
  const { data: playlists } = usePlaylists(undefined, { enabled: canAssign })
  const { data: tracks } = useTracks(undefined, { enabled: canReadMusic })
  const [localVolume, setLocalVolume] = useState(zone.volume)
  const [draggingVolume, setDraggingVolume] = useState(false)

  // Follow the applied volume (e.g. a refetch, another user's change, or a
  // Prayer Mode/Super Admin effect) — but never while the user has the
  // slider mid-drag, or their in-progress gesture would jump under them.
  useEffect(() => {
    if (!draggingVolume) setLocalVolume(zone.volume)
  }, [zone.volume, draggingVolume])

  const playlist = playlists?.find((p) => p.id === zone.currentPlaylistId)
  const track = tracks?.find((t) => t.id === zone.currentTrackId)
  const offline = zone.playbackState === "OFFLINE"

  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <p className="font-medium">{zone.name}</p>
          </div>
          {showLocation && <p className="text-xs text-muted-foreground">{showLocation}</p>}
        </div>
        <ZoneStateBadge state={zone.playbackState} />
      </CardHeader>
      <CardContent className="space-y-4">
        {zone.pausedByPrayer && (
          <Badge variant="outline" className="gap-1 border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <Moon className="size-3" /> Paused for {PRAYER_LABELS[zone.pausedByPrayer]}
          </Badge>
        )}

        <div className="flex items-start justify-between gap-2">
          <div className="min-h-10 min-w-0">
            {track ? (
              <>
                <p className="truncate text-sm font-medium">{track.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {track.artist} · {playlist?.name}
                </p>
              </>
            ) : zone.currentTrackId ? (
              <p className="text-sm text-muted-foreground">Playing from the assigned playlist</p>
            ) : (
              <p className="text-sm text-muted-foreground">No playlist assigned</p>
            )}
          </div>
          {playlist && (
            <ZonePlaylistDialog
              zone={zone}
              trigger={
                <Button variant="ghost" size="icon-sm" className="shrink-0" title="View this zone's playlist">
                  <ListMusic className="size-4" />
                </Button>
              }
            />
          )}
        </div>

        <RoleGate permission="zone:control">
          <div className="flex items-center justify-center gap-1.5">
            <Button variant="ghost" size="icon-sm" disabled={offline || controls.isPending} onClick={() => controls.previous()}>
              <SkipBack className="size-4" />
            </Button>
            {zone.playbackState === "PLAYING" ? (
              <Button size="icon" disabled={offline || controls.isPending} onClick={() => controls.pause()}>
                <Pause className="size-4" />
              </Button>
            ) : (
              <Button size="icon" disabled={offline || controls.isPending} onClick={() => controls.play()}>
                <Play className="size-4" />
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" disabled={offline || controls.isPending} onClick={() => controls.stop()}>
              <Square className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" disabled={offline || controls.isPending} onClick={() => controls.next()}>
              <SkipForward className="size-4" />
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon-sm" disabled={offline} onClick={() => (zone.muted ? controls.unmute() : controls.mute())}>
              {zone.muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </Button>
            <Slider
              value={[localVolume]}
              max={100}
              step={1}
              disabled={offline}
              onValueChange={(v: number | readonly number[]) => {
                setDraggingVolume(true)
                setLocalVolume(Array.isArray(v) ? v[0] : v)
              }}
              onValueCommitted={(v: number | readonly number[]) => {
                const next = Array.isArray(v) ? v[0] : v
                setDraggingVolume(false)
                controls.setVolume(next).catch(() => setLocalVolume(zone.volume))
              }}
              className="flex-1"
            />
            <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{localVolume}%</span>
          </div>
        </RoleGate>

        <RoleGate permission="zone:assign">
          <Select
            value={zone.currentPlaylistId ?? undefined}
            onValueChange={(playlistId) => playlistId && assignPlaylist.mutate({ zoneId: zone.id, playlistId })}
            items={Object.fromEntries((playlists ?? []).map((p) => [p.id, p.name]))}
            disabled={offline}
          >
            <SelectTrigger className="w-full" size="sm">
              <SelectValue placeholder="Assign playlist" />
            </SelectTrigger>
            <SelectContent>
              {playlists?.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </RoleGate>

        <RoleGate permission="prayer:manage">
          <div className="flex items-center justify-between rounded-md border px-2.5 py-1.5 text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Moon className="size-3.5" /> Prayer Mode
            </span>
            <Switch
              checked={zone.prayerModeEnabled}
              onCheckedChange={(checked) => setPrayerParticipation.mutate({ zoneId: zone.id, enabled: checked })}
            />
          </div>
        </RoleGate>

        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Updated {formatRelativeTime(zone.updatedAt)}</span>
          {zone.lastOverrideAt && <span>Overridden {formatRelativeTime(zone.lastOverrideAt)}</span>}
        </div>
      </CardContent>
    </Card>
  )
}
