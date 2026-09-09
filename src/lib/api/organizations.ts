import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { nextId } from "@/lib/mock/ids"
import { getTenantScope } from "@/lib/auth/session"
import type { Organization } from "@/lib/api/types"

export interface CreateOrganizationInput {
  name: string
  contactName: string
  contactEmail: string
  plan: Organization["plan"]
}

export const organizationsApi = {
  async list(): Promise<Organization[]> {
    if (isMockMode) {
      await delay()
      store.recomputeCounts()
      // SUPER_ADMIN sees every organization; every other role is confined
      // to its own (or nothing, if it has none) — see getTenantScope().
      const scope = getTenantScope()
      const items = scope.isSuperAdmin
        ? store.organizations
        : store.organizations.filter((o) => o.id === scope.organizationId)
      return items.map((o) => ({ ...o })).sort((a, b) => a.name.localeCompare(b.name))
    }
    return apiClient.get<Organization[]>("/organizations")
  },

  async get(id: string): Promise<Organization | null> {
    if (isMockMode) {
      await delay(200)
      // A copy, not the live store reference — otherwise a background
      // refetch after an update() would resolve to an object that's `===`
      // the already-cached one (since update() mutates in place), and
      // TanStack Query's structural sharing would treat that as "no
      // change" and never re-render this query's subscribers.
      const scope = getTenantScope()
      if (!scope.isSuperAdmin && id !== scope.organizationId) return null
      const org = store.organizations.find((o) => o.id === id)
      return org ? { ...org } : null
    }
    return apiClient.get<Organization>(`/organizations/${id}`)
  },

  async create(input: CreateOrganizationInput): Promise<Organization> {
    if (isMockMode) {
      await delay(500)
      const org: Organization = {
        id: nextId("org"),
        slug: input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
        locationCount: 0,
        serverCount: 0,
        createdAt: new Date().toISOString(),
        status: "ACTIVE",
        ...input,
      }
      store.organizations.push(org)
      store.pushActivity({ type: "SERVER_CONNECTED", message: `Organization "${org.name}" created.` })
      return org
    }
    return apiClient.post<Organization>("/organizations", input)
  },

  async update(id: string, input: Partial<CreateOrganizationInput> & { status?: Organization["status"] }): Promise<Organization> {
    if (isMockMode) {
      await delay(400)
      const org = store.organizations.find((o) => o.id === id)
      if (!org) throw new Error("Organization not found")
      Object.assign(org, input)
      return { ...org }
    }
    return apiClient.patch<Organization>(`/organizations/${id}`, input)
  },

  async remove(id: string): Promise<void> {
    if (isMockMode) {
      await delay(400)
      store.organizations = store.organizations.filter((o) => o.id !== id)
      return
    }
    await apiClient.delete(`/organizations/${id}`)
  },
}
