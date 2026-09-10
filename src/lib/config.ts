/**
 * Centralized, typed access to public runtime configuration.
 * Never read process.env directly outside this file — this is the single
 * seam that lets the mock/real API split and deployment targets stay sane.
 */

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value.toLowerCase() === "true" || value === "1"
}

export const env = {
  /** Same-origin `/api` so the browser never calls :4000 (avoids CORS /
   * Failed to fetch on a public http://IP). Next.js rewrites proxy to the
   * backend. NEXT_PUBLIC_API_URL is only used if you set an absolute URL. */
  apiUrl: "/api",
  /**
   * Realtime endpoint.
   *
   * This was `"/realtime"` — same-origin, on the assumption that Next.js
   * rewrites proxy it to the backend like `/api` does. They do not: a
   * rewrite cannot proxy a WebSocket upgrade, and `/socket.io/` also
   * 308-redirects to a path the rewrite no longer matches. Since the client
   * connects with `transports: ["websocket"]` and no polling fallback, the
   * connection simply timed out and browser realtime never worked at all —
   * the live-status indicator was decorative.
   *
   * So this points straight at the backend's own origin instead.
   * NEXT_PUBLIC_WS_URL is baked in at build time (see Dockerfile); the
   * backend's CORS allowlist and the socket handshake's token check are what
   * make a cross-origin connection safe. Falls back to same-origin only when
   * unset, which is correct for local dev where the portal and backend share
   * a host.
   */
  wsUrl: process.env.NEXT_PUBLIC_WS_URL || "/realtime",
  /** When true, every src/lib/api/* module resolves against the in-browser
   * mock data layer instead of issuing network requests. This lets the
   * portal be built and demoed before the real backend and Windows
   * MusicServer integration exist. */
  useMockApi: readBool(process.env.NEXT_PUBLIC_USE_MOCK_API, false),
  appName: "ZoneMaestro",
  appShortName: "ZoneMaestro",
} as const

export const isMockMode = env.useMockApi
