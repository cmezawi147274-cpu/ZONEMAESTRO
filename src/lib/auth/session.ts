"use client"

import type { Session } from "@/lib/api/types"

export const SESSION_COOKIE = "cmmp_session"
const SESSION_STORAGE_KEY = "cmmp.session"

/**
 * Client-side session persistence.
 *
 * A lightweight (non-httpOnly) cookie carries just the access token so that
 * `middleware.ts` can make a fast, presence-based redirect decision at the
 * edge without a round trip. The full session (user + both tokens) lives in
 * localStorage for the API layer and React state to read back. A real
 * backend should instead set an httpOnly, Secure, SameSite=Strict cookie
 * from the server on login — see README "Security Notes".
 */
export function persistSession(session: Session) {
  if (typeof window === "undefined") return
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
  const maxAge = 60 * 60 * 24 * 30 // 30 days, matches mock refresh token
  document.cookie = `${SESSION_COOKIE}=${session.tokens.accessToken}; path=/; max-age=${maxAge}; SameSite=Lax`
}

export function readSession(): Session | null {
  if (typeof window === "undefined") return null
  const raw = localStorage.getItem(SESSION_STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Session
  } catch {
    return null
  }
}

export function clearSession() {
  if (typeof window === "undefined") return
  localStorage.removeItem(SESSION_STORAGE_KEY)
  document.cookie = `${SESSION_COOKIE}=; path=/; max-age=0`
}

export interface TenantScope {
  isSuperAdmin: boolean
  organizationId: string | null
}

/**
 * Resolves the acting user's tenant scope from the persisted session, for
 * mock-API-layer tenant isolation (see src/lib/api/*.ts). SUPER_ADMIN sees
 * every organization; every other role is confined to its own
 * `organizationId` (or nothing, if that's null). Enforced here — not just
 * hidden in the UI — so it holds even if a scoped user hits another org's
 * id or URL directly.
 */
export function getTenantScope(): TenantScope {
  const user = readSession()?.user
  if (!user) return { isSuperAdmin: false, organizationId: null }
  return { isSuperAdmin: user.role === "SUPER_ADMIN", organizationId: user.organizationId }
}
