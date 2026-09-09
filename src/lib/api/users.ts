import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { nextId } from "@/lib/mock/ids"
import type { Role } from "@/lib/constants"
import type { User } from "@/lib/api/types"

export interface InviteUserInput {
  name: string
  email: string
  role: Role
  organizationId: string | null
  locationId: string | null
}

export const usersApi = {
  async list(): Promise<User[]> {
    if (isMockMode) {
      await delay()
      return [...store.users].sort((a, b) => a.name.localeCompare(b.name))
    }
    return apiClient.get<User[]>("/users")
  },

  async invite(input: InviteUserInput): Promise<User> {
    if (isMockMode) {
      await delay(400)
      const user: User = { id: nextId("usr"), createdAt: new Date().toISOString(), lastLoginAt: null, ...input }
      store.users.push(user)
      return user
    }
    return apiClient.post<User>("/users/invite", input)
  },

  async update(id: string, input: Partial<InviteUserInput>): Promise<User> {
    if (isMockMode) {
      await delay(300)
      const user = store.users.find((u) => u.id === id)
      if (!user) throw new Error("User not found")
      Object.assign(user, input)
      return user
    }
    return apiClient.patch<User>(`/users/${id}`, input)
  },

  async remove(id: string): Promise<void> {
    if (isMockMode) {
      await delay(300)
      store.users = store.users.filter((u) => u.id !== id)
      return
    }
    await apiClient.delete(`/users/${id}`)
  },
}
