import crypto from "node:crypto"
import { env } from "./env.js"

/**
 * Signed, expiring URLs for `/media/music/<storageKey>`.
 *
 * That prefix used to be an open `@fastify/static` mount: any unauthenticated
 * client that could reach the port could download any tenant's audio, and
 * storage keys are `Date.now()-filename` (routes/music.ts), i.e. guessable.
 * For a product that redistributes licensed music to commercial venues that
 * is a rights exposure as much as a security one.
 *
 * The signature covers the exact key *and* the expiry, so it cannot be
 * replayed against a different file or extended by editing the query string.
 * Keys containing a path separator are rejected outright, which also closes
 * the path-traversal advisory against the static handler.
 */

const SIGNED_PREFIX = "/media/music/"

function signingKey(): string {
  // Derived from the JWT secret rather than requiring a new env var, so an
  // existing deployment keeps working after upgrade. Domain-separated so it
  // is never the same value used to sign tokens.
  return crypto.createHash("sha256").update(`${env.jwtAccessSecret}:media-url`).digest("hex")
}

function signature(storageKey: string, expiresAt: number): string {
  return crypto.createHmac("sha256", signingKey()).update(`${storageKey}.${expiresAt}`).digest("hex")
}

/** A storage key is one path segment. Anything else is refused. */
export function isSafeStorageKey(key: string): boolean {
  return key.length > 0 && !key.includes("/") && !key.includes("\\") && !key.includes("..")
}

/**
 * Absolute, signed URL an agent can download from. TTL is generous because a
 * venue on a slow link may take a long time to work through a sync queue.
 */
export function signedMediaUrl(storageKey: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + env.mediaUrlTtlSeconds
  const sig = signature(storageKey, expiresAt)
  return `${env.publicApiUrl}${SIGNED_PREFIX}${encodeURIComponent(storageKey)}?exp=${expiresAt}&sig=${sig}`
}

export type MediaUrlCheck = { ok: true } | { ok: false; status: number; message: string }

/** Verifies a request against `/media/music/<key>?exp=&sig=`. */
export function verifyMediaRequest(rawPath: string, query: Record<string, unknown>): MediaUrlCheck {
  const encodedKey = rawPath.slice(SIGNED_PREFIX.length)
  let storageKey: string
  try {
    storageKey = decodeURIComponent(encodedKey)
  } catch {
    return { ok: false, status: 400, message: "Malformed media path." }
  }
  if (!isSafeStorageKey(storageKey)) return { ok: false, status: 400, message: "Malformed media path." }

  const exp = Number(query.exp)
  const sig = typeof query.sig === "string" ? query.sig : ""
  if (!Number.isFinite(exp) || !sig) return { ok: false, status: 401, message: "This media link is not signed." }
  if (exp * 1000 < Date.now()) return { ok: false, status: 401, message: "This media link has expired." }

  const expected = signature(storageKey, exp)
  const a = Buffer.from(sig, "utf8")
  const b = Buffer.from(expected, "utf8")
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, message: "This media link is not valid." }
  }
  return { ok: true }
}

export { SIGNED_PREFIX }
