import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import type { SuperZoneGroup } from "@/lib/api/types"

const mockCopyVolume = new Map<string, boolean>()

export function mockCopiesVolume(leaderZoneId: string): boolean {
  return mockCopyVolume.get(leaderZoneId) ?? false
}

function mockGroups(serverId: string): SuperZoneGroup[] {
  const zones = store.zones.filter((z) => z.serverId === serverId)
  return zones
    .filter((leader) => zones.some((z) => z.leaderZoneId === leader.id))
    .map((leader) => ({
      leaderZoneId: leader.id,
      leaderName: leader.name,
      followerZoneIds: zones.filter((z) => z.leaderZoneId === leader.id).map((z) => z.id),
      copyVolume: mockCopyVolume.get(leader.id) ?? false,
    }))
    .sort((a, b) => a.leaderName.localeCompare(b.leaderName))
}

export const superZonesApi = {
  async list(serverId: string): Promise<{ groups: SuperZoneGroup[] }> {
    if (isMockMode) {
      await delay(150)
      return { groups: mockGroups(serverId) }
    }
    return apiClient.get<{ groups: SuperZoneGroup[] }>(`/servers/${serverId}/super-zones`)
  },

  async save(
    serverId: string,
    leaderZoneId: string,
    input: { followerZoneIds: string[]; copyVolume: boolean }
  ): Promise<SuperZoneGroup> {
    if (isMockMode) {
      await delay(300)
      const leader = store.zones.find((z) => z.id === leaderZoneId && z.serverId === serverId)
      if (!leader) throw new Error("The super zone must be a zone on this server.")
      if (leader.leaderZoneId) throw new Error(`${leader.name} follows ${leader.leaderZoneName} and cannot lead.`)
      const followers = input.followerZoneIds.map((id) => store.zones.find((z) => z.id === id))
      for (const follower of followers) {
        if (!follower || follower.serverId !== serverId) throw new Error("Followers must be zones on the same server.")
        if (follower.id === leader.id) throw new Error("A super zone cannot follow itself.")
        if (follower.leaderZoneId && follower.leaderZoneId !== leader.id) {
          throw new Error(`${follower.name} already follows ${follower.leaderZoneName}.`)
        }
        if (store.zones.some((z) => z.leaderZoneId === follower.id)) throw new Error(`${follower.name} is a super zone and cannot follow.`)
      }
      store.zones.forEach((z) => {
        if (z.leaderZoneId === leader.id) Object.assign(z, { leaderZoneId: null, leaderZoneName: null })
      })
      followers.forEach((z) => Object.assign(z!, { leaderZoneId: leader.id, leaderZoneName: leader.name }))
      if (followers.length) mockCopyVolume.set(leader.id, input.copyVolume)
      else mockCopyVolume.delete(leader.id)
      return {
        leaderZoneId: leader.id,
        leaderName: leader.name,
        followerZoneIds: [...input.followerZoneIds],
        copyVolume: input.copyVolume,
      }
    }
    return apiClient.put<SuperZoneGroup>(`/servers/${serverId}/super-zones/${leaderZoneId}`, input)
  },

  async remove(serverId: string, leaderZoneId: string): Promise<void> {
    if (isMockMode) {
      await delay(300)
      store.zones.forEach((z) => {
        if (z.serverId === serverId && z.leaderZoneId === leaderZoneId) Object.assign(z, { leaderZoneId: null, leaderZoneName: null })
      })
      mockCopyVolume.delete(leaderZoneId)
      return
    }
    await apiClient.delete(`/servers/${serverId}/super-zones/${leaderZoneId}`)
  },
}
