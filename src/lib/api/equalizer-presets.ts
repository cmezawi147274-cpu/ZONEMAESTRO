import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { nextId } from "@/lib/mock/ids"
import type { SavedEqPreset } from "@/lib/api/types"

/** Mock-mode store. Deliberately module-local rather than added to
 * src/lib/mock/store.ts: saved presets are a real-backend feature, and mock
 * mode only needs them to survive within a session so the dialog's save /
 * delete flows can be exercised without a backend. */
const mockPresets: SavedEqPreset[] = []

export const equalizerPresetsApi = {
  async list(): Promise<SavedEqPreset[]> {
    if (isMockMode) {
      await delay()
      return mockPresets.map((p) => ({ ...p }))
    }
    return apiClient.get<SavedEqPreset[]>("/equalizer-presets")
  },

  /** Saving over an existing name replaces that curve — the backend upserts
   * on (organizationId, name), so the UI can offer one "Save" action
   * instead of separate create/overwrite paths. */
  async save(name: string, bands: number[], locationId?: string): Promise<SavedEqPreset> {
    if (isMockMode) {
      await delay()
      const existing = mockPresets.find((p) => p.name === name)
      if (existing) {
        existing.bands = [...bands]
        return { ...existing }
      }
      const preset: SavedEqPreset = {
        id: nextId("eqp"),
        name,
        bands: [...bands],
        createdAt: new Date().toISOString(),
      }
      mockPresets.push(preset)
      return { ...preset }
    }
    // locationId lets the backend resolve the owning organization for a
    // SUPER_ADMIN, who has no organizationId of their own.
    return apiClient.post<SavedEqPreset>("/equalizer-presets", { name, bands, locationId })
  },

  async remove(id: string): Promise<void> {
    if (isMockMode) {
      await delay()
      const i = mockPresets.findIndex((p) => p.id === id)
      if (i >= 0) mockPresets.splice(i, 1)
      return
    }
    await apiClient.delete(`/equalizer-presets/${id}`)
  },
}
