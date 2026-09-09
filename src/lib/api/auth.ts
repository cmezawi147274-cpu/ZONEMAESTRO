import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { DEMO_PASSWORD } from "@/lib/mock/seed"
import { signMockAccessToken, signMockRefreshToken } from "@/lib/auth/jwt"
import { persistSession, readSession, clearSession } from "@/lib/auth/session"
import type { AuthTokens, Session, User } from "@/lib/api/types"

export interface LoginInput {
  email: string
  password: string
}

async function mintMockSession(user: User): Promise<Session> {
  const claims = { sub: user.id, email: user.email, role: user.role, organizationId: user.organizationId }
  const [accessToken, refreshToken] = await Promise.all([
    signMockAccessToken(claims),
    signMockRefreshToken(claims),
  ])
  const tokens: AuthTokens = {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  }
  return { user, tokens }
}

export const authApi = {
  async login(input: LoginInput): Promise<Session> {
    if (isMockMode) {
      await delay(500)
      const user = store.users.find((u) => u.email.toLowerCase() === input.email.trim().toLowerCase())
      if (!user || input.password !== DEMO_PASSWORD) {
        throw new Error("Invalid email or password.")
      }
      user.lastLoginAt = new Date().toISOString()
      const session = await mintMockSession(user)
      persistSession(session)
      return session
    }
    const session = await apiClient.post<Session>("/auth/login", input, { auth: false })
    persistSession(session)
    return session
  },

  async logout(): Promise<void> {
    if (!isMockMode) {
      try {
        await apiClient.post("/auth/logout")
      } catch {
        /* best-effort */
      }
    }
    clearSession()
  },

  async refresh(): Promise<Session | null> {
    const session = readSession()
    if (!session) return null
    if (isMockMode) {
      await delay(200)
      const refreshed = await mintMockSession(session.user)
      persistSession(refreshed)
      return refreshed
    }
    const tokens = await apiClient.post<AuthTokens>(
      "/auth/refresh",
      { refreshToken: session.tokens.refreshToken },
      { auth: false }
    )
    const next = { ...session, tokens }
    persistSession(next)
    return next
  },

  async me(): Promise<User | null> {
    const session = readSession()
    if (!session) return null
    if (isMockMode) {
      await delay(150)
      return store.users.find((u) => u.id === session.user.id) ?? session.user
    }
    return apiClient.get<User>("/auth/me")
  },

  getSession: readSession,
}
