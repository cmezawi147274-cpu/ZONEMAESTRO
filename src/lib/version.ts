/**
 * Agent version comparison for the portal. Deliberately a second copy of
 * backend/src/lib/version.ts — the backend is its own package with
 * `rootDir: src` and the two trees cannot import from each other. The
 * backend's copy is what sets the status on real data; this one serves mock
 * mode. Keep them in step.
 */

export type AgentVersionStatus = "current" | "outdated" | "unknown"

function numericParts(version: string): number[] | null {
  const core = version.trim().split("-")[0].trim()
  if (!core) return null
  const parts = core.split(".").map((p) => (p.trim() === "" ? NaN : Number(p)))
  if (parts.length === 0) return null
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null
  return parts
}

/** Three-way: an unreadable version is not the same claim as "up to date". */
export function agentVersionStatus(
  version: string | null | undefined,
  minVersion: string | null | undefined
): AgentVersionStatus {
  if (!version || !minVersion) return "unknown"
  const a = numericParts(version)
  const b = numericParts(minVersion)
  if (!a || !b) return "unknown"
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av < bv ? "outdated" : "current"
  }
  return "current"
}
