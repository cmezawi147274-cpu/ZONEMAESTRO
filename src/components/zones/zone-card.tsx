"use client"

import { useEffect, useState } from "react"
import { Play, Pause, Square, SkipBack, SkipForward, Moon, ListMusic, CalendarClock, SlidersHorizontal, Trash2 } from "lucide-react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { ZoneStateBadge } from "@/components/common/status-badge"
import { RoleGate } from "@/components/common/role-gate"
import { useAuth } from "@/hooks/use-auth"
import { useZoneControls, useAssignZonePlaylist, useZonePlaylists, useDeleteZone } from "@/hooks/use-zones"
import { useSetZonePrayerParticipation } from "@/hooks/use-prayer"
import { useSchedules } from "@/hooks/use-schedules"
import { useTracks } from "@/hooks/use-music"
import { ZonePlaylistDialog } from "@/components/zones/zone-playlist-dialog"
import { ZoneScheduleDialog } from "@/components/zones/zone-schedule-dialog"
import { ZoneVolumeRow } from "@/components/zones/zone-volume-row"
import { ZoneEqualizerDialog, equalizerSummary } from "@/components/zones/zone-equalizer-dialog"
import { formatRelativeTime } from "@/lib/format"
import { PRAYER_LABELS, PRAYER_NAMES } from "@/lib/constants"
import type { PrayerTimesToday, Zone } from "@/lib/api/types"

/** Today's prayer times for the zone's own Location, computed by the
 * caller (see src/app/(portal)/zones/page.tsx) — one fetch per unique
 * locationId, never per card. `undefined` means the caller has nothing to
 * report (e.g. it doesn't have Location data at all) and the card renders
 * no prayer-times section, same as before this existed. */
export interface ZonePrayerTimesInfo {
  /** "unresolved" — the Location's city/country never came from the
   * Country → City picker, so no coordinates can be resolved for it.
   * "error" — the lookup itself failed; `message` carries the reason. */
  status: "loading" | "ready" | "unresolved" | "error"
  times?: PrayerTimesToday
  message?: string
}

export function ZoneCard({
  zone,
  showLocation,
  todayPrayerTimes,
}: {
  zone: Zone
  showLocation?: string
  todayPrayerTimes?: ZonePrayerTimesInfo
}) {
  const { can } = useAuth()
  const canAssign = can("zone:assign")
  const canReadMusic = can("music:read")
  const canReadSchedule = can("schedule:read")
  const controls = useZoneControls(zone.id, zone.serverId)
  const assignPlaylist = useAssignZonePlaylist()
  const deleteZone = useDeleteZone()
  const setPrayerParticipation = useSetZonePrayerParticipation()
  // Scoped to what's actually assigned to this zone (Task 2) — never the
  // whole library; see src/lib/api/zones.ts `playlists()`. Gated on
  // zone:read only (which every role that can see this card already has),
  // not zone:assign — a playback-only Viewer still needs playlist names to
  // read the schedule block below.
  const { data: playlists } = useZonePlaylists(zone.id)
  // A playback-only role holds neither playlist:read nor music:read; don't
  // fire queries whose 403 it can do nothing about.
  const { data: tracks } = useTracks(undefined, { enabled: canReadMusic })
  // A playback-only Viewer holds no schedule:read either — same guard as
  // playlists/tracks above, and the block below stays behind the same
  // RoleGate so it's not offered without the data to back it.
  const { data: schedules } = useSchedules({ zoneId: zone.id }, { enabled: canReadSchedule })
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
  const playlistName = (id: string) => playlists?.find((p) => p.id === id)?.name ?? "Playlist"
  const sortedSchedules = [...(schedules ?? [])].sort((a, b) => a.startTime.localeCompare(b.startTime))

  return (
    <Card>
      <CardHeader className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <p className="font-medium">{zone.name}</p>
          </div>
          {showLocation && <p className="text-xs text-muted-foreground">{showLocation}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <RoleGate permission="zone:assign">
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button variant="ghost" size="icon-sm" title="Delete this zone">
                    <Trash2 className="size-3.5" />
                  </Button>
                }
              />
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete &quot;{zone.name}&quot;?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes the zone from the cloud AND from the Windows Music Server. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => deleteZone.mutate(zone.id)}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </RoleGate>
          <ZoneStateBadge state={zone.playbackState} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {zone.pausedByPrayer && (
          <Badge variant="outline" className="gap-1 border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <Moon className="size-3" /> Paused for {PRAYER_LABELS[zone.pausedByPrayer]}
          </Badge>
        )}

        {todayPrayerTimes && (
          <div className="rounded-md border px-2.5 py-1.5 text-[11px]">
            {todayPrayerTimes.status === "ready" && todayPrayerTimes.times ? (
              <div className="grid grid-cols-5 gap-1 text-center">
                {PRAYER_NAMES.map((name) => (
                  <div key={name}>
                    <p className="text-muted-foreground">{PRAYER_LABELS[name]}</p>
                    <p className="tabular-nums font-medium">{todayPrayerTimes.times![name]}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center text-muted-foreground">
                {todayPrayerTimes.status === "loading"
                  ? "Loading prayer times…"
                  : todayPrayerTimes.status === "unresolved"
                    ? "Edit this Location and pick Country → City so prayer times can be calculated."
                    : (todayPrayerTimes.message ?? "Prayer times unavailable")}
              </p>
            )}
          </div>
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

          <ZoneVolumeRow
            volume={localVolume}
            muted={zone.muted}
            offline={offline}
            onMuteToggle={() => (zone.muted ? controls.unmute() : controls.mute())}
            onValueChange={(next) => {
              setDraggingVolume(true)
              setLocalVolume(next)
            }}
            onValueCommitted={(next) => {
              setDraggingVolume(false)
              controls.setVolume(next).catch(() => setLocalVolume(zone.volume))
            }}
          />
        </RoleGate>

        <RoleGate permission="zone:control">
          <ZoneEqualizerDialog
            zone={zone}
            volumeRow={
              <ZoneVolumeRow
                volume={localVolume}
                muted={zone.muted}
                offline={offline}
                onMuteToggle={() => (zone.muted ? controls.unmute() : controls.mute())}
                onValueChange={(next) => {
                  setDraggingVolume(true)
                  setLocalVolume(next)
                }}
                onValueCommitted={(next) => {
                  setDraggingVolume(false)
                  controls.setVolume(next).catch(() => setLocalVolume(zone.volume))
                }}
              />
            }
            trigger={
              // Not gated on `offline`, deliberately — unlike transport/
              // volume/playlist above, the equalizer is plain cloud
              // configuration with no live device to reach right now (see
              // zone-equalizer-dialog.tsx and the Zone.equalizer doc
              // comment in backend/prisma/schema.prisma). Same reasoning
              // as the Schedule trigger below, which isn't offline-gated
              // either.
              <button
                type="button"
                className="flex min-h-11 w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-[11px] transition-colors hover:bg-muted/40"
              >
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <SlidersHorizontal className="size-3" />
                  <span className="font-medium">Equalizer</span>
                </span>
                <span className="text-muted-foreground">{equalizerSummary(zone.equalizer)}</span>
              </button>
            }
          />
        </RoleGate>

        <RoleGate permission="zone:assign">
          {playlists && playlists.length > 0 ? (
            <Select
              value={zone.currentPlaylistId ?? undefined}
              onValueChange={(playlistId) => playlistId && assignPlaylist.mutate({ zoneId: zone.id, playlistId })}
              items={Object.fromEntries(playlists.map((p) => [p.id, p.name]))}
              disabled={offline}
            >
              <SelectTrigger className="w-full" size="sm">
                <SelectValue placeholder="Assign playlist" />
              </SelectTrigger>
              <SelectContent>
                {playlists.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="rounded-md border px-2.5 py-1.5 text-center text-xs text-muted-foreground">
              No playlist assigned
            </p>
          )}
        </RoleGate>

        {/* Time-of-day schedule — merged straight into the zone card
            (Task 4) rather than a separate page: this block IS the trigger
            for ZoneScheduleDialog, so what a slot plays and when is visible
            without a click, and clicking it opens the same add/edit/remove
            surface that /schedules uses (schedule:write / zone:assign). */}
        <RoleGate permission="schedule:read">
          <ZoneScheduleDialog
            zone={zone}
            trigger={
              <button
                type="button"
                className="w-full rounded-md border px-2.5 py-1.5 text-left text-[11px] transition-colors hover:bg-muted/40"
              >
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <CalendarClock className="size-3" />
                  <span className="font-medium">Schedule</span>
                </div>
                {sortedSchedules.length === 0 ? (
                  <p className="mt-1 text-muted-foreground">No time slots — tap to add one</p>
                ) : (
                  <div className="mt-1 space-y-0.5">
                    {sortedSchedules.slice(0, 3).map((s) => (
                      <p key={s.id} className="truncate tabular-nums">
                        {s.startTime}–{s.endTime} · {playlistName(s.playlistId)}
                      </p>
                    ))}
                    {sortedSchedules.length > 3 && (
                      <p className="text-muted-foreground">+{sortedSchedules.length - 3} more</p>
                    )}
                  </div>
                )}
              </button>
            }
          />
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
