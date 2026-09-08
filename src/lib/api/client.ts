import { env } from "@/lib/config"
import { readSession, clearSession, persistSession } from "@/lib/auth/session"
import type { ApiError } from "@/lib/api/types"

export class HttpError extends Error {
  status: number
  code: string
  constructor(error: ApiError) {
    super(error.message)
    this.status = error.status
    this.code = error.code
  }
}

interface RequestOptions extends RequestInit {
  auth?: boolean
  /** Skip the automatic single-retry-after-refresh on a 401. */
  skipRefresh?: boolean
}

/**
 * Thin fetch wrapper used by every src/lib/api/* module in REAL mode
 * (NEXT_PUBLIC_USE_MOCK_API=false). Mock mode never touches this file — see
 * each module's `isMockMode` branch.
 *
 * Responsibilities:
 *  - Prefixes NEXT_PUBLIC_API_URL
 *  - Attaches `Authorization: Bearer <accessToken>`
 *  - Transparently refreshes once on a 401 using the refresh token, then
 *    retries the original request
 *  - Normalizes error responses into HttpError
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { auth = true, skipRefresh = false, headers, ...rest } = options
  const session = auth ? readSession() : null

  const res = await fetch(`${env.apiUrl}${path}`, {
    ...rest,
    headers: {
      // Only set when there's an actual body — Fastify's JSON body parser
      // rejects a request that declares "application/json" but sends none,
      // which every bodyless DELETE (remove track, remove playlist, remove
      // folder, …) does.
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(session ? { Authorization: `Bearer ${session.tokens.accessToken}` } : {}),
      ...headers,
    },
  })

  if (res.status === 401 && auth && session && !skipRefresh) {
    const refreshed = await tryRefresh()
    if (refreshed) {
      return request<T>(path, { ...options, skipRefresh: true })
    }
    clearSession()
    if (typeof window !== "undefined") window.location.href = "/login"
  }

  if (!res.ok) {
    let body: Partial<ApiError> = {}
    try {
      body = await res.json()
    } catch {
      /* non-JSON error body */
    }
    throw new HttpError({
      status: res.status,
      code: body.code ?? "UNKNOWN_ERROR",
      message: body.message ?? res.statusText,
    })
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

async function tryRefresh(): Promise<boolean> {
  const session = readSession()
  if (!session) return false
  try {
    const res = await fetch(`${env.apiUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.tokens.refreshToken }),
    })
    if (!res.ok) return false
    const tokens = await res.json()
    persistSession({ ...session, tokens })
    return true
  } catch {
    return false
  }
}

export const apiClient = {
  get: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: "DELETE" }),
}
