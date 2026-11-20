import crypto from "node:crypto"
import { promisify } from "node:util"

/**
 * The venue screen lock's password (kit 7-SCREEN-LOCK, kiosk.json). The
 * portal sends the plaintext once; it is hashed here before the
 * SET_LOCK_PASSWORD command row exists, so only the hash is ever stored or
 * delivered. The lock verifies with PBKDF2-HMAC-SHA256 over the UTF-8 bytes.
 */

const pbkdf2 = promisify(crypto.pbkdf2)

export const LOCK_PASSWORD_ALGORITHM = "pbkdf2-sha256"
export const LOCK_PASSWORD_ITERATIONS = 150000

export type LockPasswordPayload = { algorithm: typeof LOCK_PASSWORD_ALGORITHM; iterations: number; salt: string; hash: string }

export function isValidLockPassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= 4 && password.length <= 128
}

export async function hashLockPassword(password: string): Promise<LockPasswordPayload> {
  const salt = crypto.randomBytes(16)
  const hash = await pbkdf2(password, salt, LOCK_PASSWORD_ITERATIONS, 32, "sha256")
  return { algorithm: LOCK_PASSWORD_ALGORITHM, iterations: LOCK_PASSWORD_ITERATIONS, salt: salt.toString("base64"), hash: hash.toString("base64") }
}

/** What people see of a command's payload: a lock password's salt and hash never leave the cloud except to the agent. */
export function redactCommandPayload(type: string, payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (type !== "SET_LOCK_PASSWORD" || !payload) return payload
  return { algorithm: payload.algorithm, iterations: payload.iterations, redacted: true }
}
