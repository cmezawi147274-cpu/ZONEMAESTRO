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
  /** Socket.io namespace on this same site (proxied to the backend). */
  wsUrl: "/realtime",
  /** When true, every src/lib/api/* module resolves against the in-browser
   * mock data layer instead of issuing network requests. This lets the
   * portal be built and demoed before the real backend and Windows
   * MusicServer integration exist. */
  useMockApi: readBool(process.env.NEXT_PUBLIC_USE_MOCK_API, false),
  appName: "ZoneMaestro",
  appShortName: "ZoneMaestro",
} as const

export const isMockMode = env.useMockApi
