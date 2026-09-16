/**
 * Agent version comparison.
 *
 * This is the only visibility there is into an outdated fleet: there is no
 * inbound path to a venue, so nothing here can update anything — a
 * technician has to run SETUP.cmd on the PC. A bug in this file is silent,
 * because its failure mode is "no server is ever flagged" and the fleet
 * view just reads as healthy.
 *
 * The reported string has already changed shape once — venues shipped
 * "0.2.0-bridge", the v1.0.0 release reports plain semver — and it is read
 * from the agent's package.json, so it will keep moving. Parse defensively
 * and never guess.
 */

export type AgentVersionStatus =
  | "current" // parseable, and at or above the configured minimum
  | "outdated" // parseable, and below it — this venue needs a site visit
  | "unknown" // not reported, not parseable, or no minimum configured

/**
 * Numeric core of a version, dropping any `-suffix`. Field agents report
 * shapes like "0.2.0-bridge" and cannot be upgraded remotely, so the cloud
 * has to be able to read what they already send: without this the suffix
 * parsed as NaN and every such venue was silently treated as fine, which
 * defeated the entire point of having a minimum.
 */
function numericParts(version: string): number[] | null {
  const core = version.trim().split("-")[0].trim()
  if (!core) return null
  const parts = core.split(".").map((p) => (p.trim() === "" ? NaN : Number(p)))
  if (parts.length === 0) return null
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null
  return parts
}

/**
 * Three-way, deliberately. An unreadable version is *not* the same claim as
 * "up to date" — collapsing the two is how a fleet of unparseable versions
 * reads as healthy. Callers that want to warn someone can tell the
 * difference between "this venue is behind" and "nobody can tell what this
 * venue is running", which need different responses.
 */
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

/** Convenience for the common "should this be flagged" question. Strictly
 * derived from the status above so the two can never disagree — an unknown
 * version is never reported as outdated. */
export function isVersionBelow(
  version: string | null | undefined,
  minVersion: string | null | undefined
): boolean {
  return agentVersionStatus(version, minVersion) === "outdated"
}
