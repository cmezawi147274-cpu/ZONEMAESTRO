import fs from "node:fs"
import path from "node:path"

/**
 * The remote update the cloud offers venue PCs (kit 2026.11.20+, lib/updater.js):
 * <UPDATE_DIR>/manifest.signed.json = {"manifest": "<signed JSON string>", "signature": "<base64 ed25519>"}
 * and the files it names under <UPDATE_DIR>/files/. Published by hand on the
 * host (read-only bind mount), so nothing here needs a restart. The agent
 * checks the signature; the cloud only serves the files.
 */

export const REMOTE_UPDATE_MIN_AGENT_VERSION = "2026.11.20"
export const UPDATE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/
const MAX_MANIFEST_BYTES = 64 * 1024
const VERSION = /^\d+(\.\d+){1,3}$/

export function updateDir(): string {
  return process.env.UPDATE_DIR ?? "/app/data/downloads/updates"
}

const manifestFile = (dir: string) => path.join(dir, "manifest.signed.json")

/** The published {manifest, signature}, "missing" when nothing is published, or "invalid". */
export async function readSignedManifest(dir = updateDir()): Promise<{ manifest: string; signature: string } | "missing" | "invalid"> {
  let text: string
  try {
    const stat = await fs.promises.stat(manifestFile(dir))
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return "invalid"
    const buf = await fs.promises.readFile(manifestFile(dir))
    if (buf.length > MAX_MANIFEST_BYTES) return "invalid"
    text = buf.toString("utf8")
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid"
  }
  try {
    const body = JSON.parse(text) as Record<string, unknown> | null
    if (!body || typeof body.manifest !== "string" || typeof body.signature !== "string" || body.signature.length > 200) return "invalid"
    return { manifest: body.manifest, signature: body.signature }
  } catch {
    return "invalid"
  }
}

/** The versions a manifest.signed.json offers, or null. No signature check (display only). */
export function publishedVersionsOf(text: string): { agentVersion: string | null; musicServerVersion: string | null } | null {
  try {
    const body = JSON.parse(text) as Record<string, unknown> | null
    if (!body || typeof body.manifest !== "string") return null
    const m = JSON.parse(body.manifest) as Record<string, unknown> | null
    if (!m || typeof m !== "object" || m.schema !== 1) return null
    const versionOf = (part: unknown) => {
      const v = part && typeof part === "object" ? (part as Record<string, unknown>).version : undefined
      return typeof v === "string" && VERSION.test(v) ? v : null
    }
    const agentVersion = versionOf(m.agent)
    const musicServerVersion = versionOf(m.musicServer)
    return agentVersion || musicServerVersion ? { agentVersion, musicServerVersion } : null
  } catch {
    return null
  }
}

let cached: { key: string; value: ReturnType<typeof publishedVersionsOf> } | null = null

/** What is published right now, for the portal; re-read only when the file changes. */
export function publishedUpdate(dir = updateDir()): { agentVersion: string | null; musicServerVersion: string | null } | null {
  const file = manifestFile(dir)
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  const key = `${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
  if (cached?.key === key) return cached.value
  let value: ReturnType<typeof publishedVersionsOf> = null
  try {
    if (stat.isFile() && stat.size <= MAX_MANIFEST_BYTES) value = publishedVersionsOf(fs.readFileSync(file, "utf8"))
  } catch {
    value = null
  }
  cached = { key, value }
  return value
}
