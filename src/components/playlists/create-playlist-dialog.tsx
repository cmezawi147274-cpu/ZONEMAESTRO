"use client"

import { useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import { Plus, Loader2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { TrackPicker } from "@/components/playlists/track-picker"
import { useCreatePlaylist } from "@/hooks/use-playlists"
import { useOrganizations } from "@/hooks/use-organizations"

const schema = z.object({
  name: z.string().min(2, "Name is required"),
  description: z.string().optional(),
  organizationId: z.string().nullable(),
})

type FormValues = z.infer<typeof schema>

export function CreatePlaylistDialog() {
  const [open, setOpen] = useState(false)
  const [trackIds, setTrackIds] = useState<string[]>([])
  const create = useCreatePlaylist()
  const { data: organizations } = useOrganizations()
  const router = useRouter()
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", description: "", organizationId: null },
  })

  async function onSubmit(values: FormValues) {
    // One write: the playlist and its initial tracks are created together.
    const playlist = await create.mutateAsync({
      name: values.name,
      description: values.description ?? "",
      organizationId: values.organizationId,
      trackIds,
    })
    form.reset()
    setTrackIds([])
    setOpen(false)
    router.push(`/playlists/${playlist.id}`)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setTrackIds([])
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="size-4" /> New Playlist
          </Button>
        }
      />
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Playlist</DialogTitle>
          <DialogDescription>Create a playlist you can assign to organizations, locations, servers or zones.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Playlist name</FormLabel>
                  <FormControl>
                    <Input placeholder="Dinner Lounge" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Warm jazz and lounge for the evening dining room." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="organizationId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Organization (optional)</FormLabel>
                  <Select
                    value={field.value ?? "shared"}
                    onValueChange={(v) => field.onChange(v === "shared" ? null : v)}
                    items={{
                      shared: "Shared across all organizations",
                      ...Object.fromEntries((organizations ?? []).map((org) => [org.id, org.name])),
                    }}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="shared">Shared across all organizations</SelectItem>
                      {organizations?.map((org) => (
                        <SelectItem key={org.id} value={org.id}>
                          {org.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-1.5">
              <FormLabel>Tracks (optional)</FormLabel>
              <TrackPicker compact selected={trackIds} onChange={setTrackIds} />
            </div>

            <DialogFooter>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending && <Loader2 className="size-4 animate-spin" />}
                {trackIds.length > 0 ? `Add ${trackIds.length} track${trackIds.length === 1 ? "" : "s"}` : "Create Playlist"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
