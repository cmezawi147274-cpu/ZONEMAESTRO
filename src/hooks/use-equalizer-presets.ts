"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { equalizerPresetsApi } from "@/lib/api/equalizer-presets"

const KEY = ["equalizer-presets"]

/** Org-shared saved EQ curves. Only fetched while the equalizer dialog is
 * open — every zone card mounts one of these dialogs, so an unconditional
 * query would fan out into one request per card on the zones page. */
export function useEqualizerPresets(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => equalizerPresetsApi.list(),
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
  })
}

export function useSaveEqualizerPreset() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ name, bands }: { name: string; bands: number[] }) => equalizerPresetsApi.save(name, bands),
    onSuccess: (preset) => {
      queryClient.invalidateQueries({ queryKey: KEY })
      toast.success(`Preset “${preset.name}” saved`)
    },
    onError: (error: Error) => toast.error(error.message || "Could not save the preset"),
  })
}

export function useDeleteEqualizerPreset() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => equalizerPresetsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY })
      toast.success("Preset deleted")
    },
    onError: (error: Error) => toast.error(error.message || "Could not delete the preset"),
  })
}
