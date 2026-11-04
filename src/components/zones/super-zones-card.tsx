"use client"

import { useState } from "react"
import { Layers, Loader2, Plus, RotateCcw, Save, Trash2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { useAuth } from "@/hooks/use-auth"
import { useDeleteSuperZone, useSaveSuperZone, useSuperZones } from "@/hooks/use-super-zones"
import type { SuperZoneGroup, Zone } from "@/lib/api/types"
import { agentVersionStatus } from "@/lib/version"

type Draft = { leaderZoneId: string | null; followerZoneIds: string[]; copyVolume: boolean }

const EMPTY: Draft = { leaderZoneId: null, followerZoneIds: [], copyVolume: false }

// First venue installer whose followers play the super zone's exact song.
const EXACT_SYNC_VERSION = "2026.11.4"

export function SuperZonesCard({
  serverId,
  serverVersion,
  zones,
}: {
  serverId: string
  serverVersion?: string | null
  zones: Zone[]
}) {
  const { can } = useAuth()
  const canEdit = can("zone:assign")
  const { data, isLoading } = useSuperZones(serverId)
  const save = useSaveSuperZone(serverId)
  const remove = useDeleteSuperZone(serverId)

  const [added, setAdded] = useState<string[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [confirmRemove, setConfirmRemove] = useState<SuperZoneGroup | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading super zones…</p>
  if (!data) return <p className="text-sm text-muted-foreground">Super zones are unavailable right now.</p>

  const rows = [
    ...data.groups.map((group) => ({ key: group.leaderZoneId, saved: group as SuperZoneGroup | null })),
    ...added.map((key) => ({ key, saved: null })),
  ]
  const shown = (row: (typeof rows)[number]): Draft => drafts[row.key] ?? row.saved ?? EMPTY
  // Saved and unsaved picks both count, so a zone moved between groups is
  // only offered once the group giving it up has been saved.
  const usedBy = (rowsToCount: typeof rows) =>
    new Set(
      rowsToCount.flatMap((row) =>
        [row.saved, shown(row)].flatMap((g) => (g ? [g.leaderZoneId, ...g.followerZoneIds] : []))
      )
    )
  const freeZones = zones.filter((z) => !usedBy(rows).has(z.id))
  const busy = save.isPending || remove.isPending
  const exactSync = agentVersionStatus(serverVersion, EXACT_SYNC_VERSION) === "current"

  function dropDraft(key: string) {
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  function clear(key: string) {
    dropDraft(key)
    setAdded((prev) => prev.filter((k) => k !== key))
  }

  const newButton = (
    <RoleGate permission="zone:assign">
      <Button
        variant="outline"
        disabled={busy || freeZones.length < 2}
        onClick={() => setAdded((prev) => [...prev, `new-${Date.now()}`])}
      >
        <Plus className="size-4" /> New super zone
      </Button>
    </RoleGate>
  )

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Layers}
        title="No super zones on this server"
        description={
          zones.length < 2
            ? "A super zone needs at least two zones on this server."
            : "A super zone leads other zones on this server. They play its schedules and playlist instead of their own."
        }
        action={newButton}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {exactSync
            ? "Followers play their super zone's schedules and playlist, the same song at the same moment, and follow its play, pause and stop. A follower that joins mid-song starts with the next song, and songs change with a clean cut instead of a crossfade. Their own schedules are paused while they follow, not deleted."
            : "Followers play their super zone's schedules and playlist and follow its play, pause and stop. They play the same song at the same moment once this server runs venue installer 2026.11.4 or newer. Their own schedules are paused while they follow, not deleted."}
        </p>
        {newButton}
      </div>

      {rows.map((row) => {
        const draft = shown(row)
        const blocked = usedBy(rows.filter((r) => r.key !== row.key))
        const leaderOptions = zones.filter((z) => !blocked.has(z.id))
        const followerOptions = zones.filter((z) => z.id !== draft.leaderZoneId && !blocked.has(z.id))
        const dirty = drafts[row.key] !== undefined
        const edit = (patch: Partial<Draft>) => setDrafts((prev) => ({ ...prev, [row.key]: { ...draft, ...patch } }))

        return (
          <Card key={row.key}>
            <CardHeader>
              <CardTitle className="text-sm font-medium">{row.saved ? row.saved.leaderName : "New super zone"}</CardTitle>
              <CardDescription>
                {row.saved
                  ? `${row.saved.followerZoneIds.length} ${row.saved.followerZoneIds.length === 1 ? "zone follows" : "zones follow"} it.`
                  : "Not used until you save."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <p className="text-sm font-medium">Super zone</p>
                <Select
                  value={draft.leaderZoneId}
                  onValueChange={(leaderZoneId) =>
                    leaderZoneId &&
                    edit({ leaderZoneId, followerZoneIds: draft.followerZoneIds.filter((id) => id !== leaderZoneId) })
                  }
                  items={Object.fromEntries(zones.map((z) => [z.id, z.name]))}
                  disabled={!canEdit || busy || !!row.saved}
                >
                  <SelectTrigger className="w-full sm:w-72">
                    <SelectValue placeholder="Pick a zone" />
                  </SelectTrigger>
                  <SelectContent>
                    {leaderOptions.map((z) => (
                      <SelectItem key={z.id} value={z.id}>
                        {z.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">
                  Followers <span className="text-muted-foreground">({draft.followerZoneIds.length} selected)</span>
                </p>
                {!draft.leaderZoneId ? (
                  <p className="text-sm text-muted-foreground">Pick the super zone first.</p>
                ) : followerOptions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No other zones on this server are free to follow.</p>
                ) : (
                  <div className="grid gap-0.5 rounded-lg border p-1.5 sm:grid-cols-2">
                    {followerOptions.map((z) => (
                      <label key={z.id} className="flex items-center gap-2 rounded-md p-1.5 text-sm hover:bg-muted/40">
                        <Checkbox
                          checked={draft.followerZoneIds.includes(z.id)}
                          disabled={!canEdit || busy}
                          onCheckedChange={(checked) =>
                            edit({
                              followerZoneIds: checked
                                ? [...draft.followerZoneIds, z.id]
                                : draft.followerZoneIds.filter((id) => id !== z.id),
                            })
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">{z.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Copy volume</p>
                  <p className="text-xs text-muted-foreground">
                    Volume and mute changes on the super zone also apply to its followers.
                  </p>
                </div>
                <Switch
                  checked={draft.copyVolume}
                  disabled={!canEdit || busy}
                  aria-label="Copy volume"
                  onCheckedChange={(copyVolume) => edit({ copyVolume })}
                />
              </div>

              <RoleGate permission="zone:assign">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (!row.saved) return clear(row.key)
                      setConfirmRemove(row.saved)
                      setRemoveOpen(true)
                    }}
                  >
                    <Trash2 className="size-4" /> Remove
                  </Button>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      disabled={!dirty || busy}
                      onClick={() => dropDraft(row.key)}
                    >
                      <RotateCcw className="size-4" /> Reset
                    </Button>
                    <Button
                      disabled={!dirty || busy || !draft.leaderZoneId || draft.followerZoneIds.length === 0}
                      onClick={() =>
                        save.mutate(
                          {
                            leaderZoneId: draft.leaderZoneId!,
                            followerZoneIds: draft.followerZoneIds,
                            copyVolume: draft.copyVolume,
                          },
                          { onSuccess: () => clear(row.key) }
                        )
                      }
                    >
                      {save.isPending && save.variables?.leaderZoneId === draft.leaderZoneId ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Save className="size-4" />
                      )}
                      Save
                    </Button>
                  </div>
                </div>
              </RoleGate>
            </CardContent>
          </Card>
        )
      })}

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the {confirmRemove?.leaderName} super zone?</AlertDialogTitle>
            <AlertDialogDescription>
              Its followers stop following {confirmRemove?.leaderName} and go back to their own schedules and playlists.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() =>
                remove.mutate(confirmRemove!.leaderZoneId, {
                  onSuccess: () => {
                    clear(confirmRemove!.leaderZoneId)
                    setRemoveOpen(false)
                  },
                })
              }
            >
              {remove.isPending && <Loader2 className="size-4 animate-spin" />}
              Remove Super Zone
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
