import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { nextId } from "@/lib/mock/ids"
import type { DayOfWeek } from "@/lib/constants"
import type { Schedule } from "@/lib/api/types"

export interface CreateScheduleInput {
  zoneId: string
  playlistId: string
  name: string
  startTime: string
  endTime: string
  days: DayOfWeek[]
  priority: number
  enabled: boolean
}

export const schedulesApi = {
  async list(filters?: { zoneId?: string; serverId?: string }): Promise<Schedule[]> {
    if (isMockMode) {
      await delay()
      let items = [...store.schedules]
      if (filters?.zoneId) items = items.filter((s) => s.zoneId === filters.zoneId)
      if (filters?.serverId) {
        const zoneIds = new Set(store.zones.filter((z) => z.serverId === filters.serverId).map((z) => z.id))
        items = items.filter((s) => zoneIds.has(s.zoneId))
      }
      return items.sort((a, b) => a.startTime.localeCompare(b.startTime))
    }
    const params = new URLSearchParams(filters as Record<string, string>).toString()
    return apiClient.get<Schedule[]>(`/schedules${params ? `?${params}` : ""}`)
  },

  async create(input: CreateScheduleInput): Promise<Schedule> {
    if (isMockMode) {
      await delay(400)
      const schedule: Schedule = { id: nextId("sch"), createdAt: new Date().toISOString(), ...input }
      store.schedules.push(schedule)
      return schedule
    }
    return apiClient.post<Schedule>("/schedules", input)
  },

  async update(id: string, input: Partial<CreateScheduleInput>): Promise<Schedule> {
    if (isMockMode) {
      await delay(300)
      const schedule = store.schedules.find((s) => s.id === id)
      if (!schedule) throw new Error("Schedule not found")
      Object.assign(schedule, input)
      return schedule
    }
    return apiClient.patch<Schedule>(`/schedules/${id}`, input)
  },

  async toggle(id: string, enabled: boolean): Promise<Schedule> {
    return schedulesApi.update(id, { enabled })
  },

  async remove(id: string): Promise<void> {
    if (isMockMode) {
      await delay(300)
      store.schedules = store.schedules.filter((s) => s.id !== id)
      return
    }
    await apiClient.delete(`/schedules/${id}`)
  },
}
