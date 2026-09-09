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
  /** Only sent when a Super Admin is creating the account with credentials
   * the new user can sign in with immediately. Never stored on the User
   * record and never returned by the API. */
  password?: string
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
      // Split the credential off the profile: it must never end up on the
      // User record (which `list()` hands straight to the UI).
      const { password, ...profile } = input
      const email = profile.email.trim().toLowerCase()
      if (store.users.some((u) => u.email.trim().toLowerCase() === email)) {
        throw new Error("A user with that email already exists.")
      }
      const user: User = { id: nextId("usr"), createdAt: new Date().toISOString(), lastLoginAt: null, ...profile }
      store.users.push(user)
      if (password) store.userPasswords[email] = password
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
