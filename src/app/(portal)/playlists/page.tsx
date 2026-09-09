"use client"

import Link from "next/link"
import { ListMusic, Copy, Trash2 } from "lucide-react"
import { PageHeader } from "@/components/common/page-header"
import { EmptyState } from "@/components/common/empty-state"
import { RoleGate } from "@/components/common/role-gate"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
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
import { CreatePlaylistDialog } from "@/components/playlists/create-playlist-dialog"
import { usePlaylists, useDuplicatePlaylist, useDeletePlaylist } from "@/hooks/use-playlists"
import { useOrganizations } from "@/hooks/use-organizations"

export default function PlaylistsPage() {
  const { data: playlists, isLoading } = usePlaylists()
  const { data: organizations } = useOrganizations()
  const duplicate = useDuplicatePlaylist()
  const remove = useDeletePlaylist()

  const orgName = (id: string | null) => (id ? organizations?.find((o) => o.id === id)?.name : "Shared")

  return (
    <div className="space-y-6">
      <PageHeader
        title="Playlists"
        description="Build playlists and assign them to organizations, locations, Music Servers or zones."
        actions={
          <RoleGate permission="playlist:write">
            <CreatePlaylistDialog />
          </RoleGate>
        }
      />

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      ) : !playlists || playlists.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState icon={ListMusic} title="No playlists yet" className="border-none py-10" />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {playlists.map((playlist) => (
            <Card key={playlist.id}>
              <CardContent className="space-y-3">
                <div>
                  <Link href={`/playlists/${playlist.id}`} className="font-medium hover:underline">
                    {playlist.name}
                  </Link>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{playlist.description}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{playlist.trackIds.length} tracks</Badge>
                  <Badge variant="outline">{orgName(playlist.organizationId)}</Badge>
                </div>
                <RoleGate permission="playlist:write">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => duplicate.mutate(playlist.id)}>
                      <Copy className="size-3.5" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger render={
                        <Button variant="ghost" size="icon-sm">
                          <Trash2 className="size-3.5" />
                        </Button>
                      } />
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete &quot;{playlist.name}&quot;?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Zones currently assigned this playlist will keep playing their cached copy
                            until reassigned.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => remove.mutate(playlist.id)}>Delete</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </RoleGate>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
