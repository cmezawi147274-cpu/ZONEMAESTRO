import { SignJWT, jwtVerify, type JWTPayload } from "jose"
import type { Role } from "@/lib/constants"

/**
 * JWT helpers built on `jose` (Web Crypto — works in the browser, Next.js
 * middleware/Edge runtime, and Node identically).
 *
 * IMPORTANT — mock mode only: in mock mode there is no backend, so tokens
 * are signed client-side with a well-known development secret purely to
 * exercise the same access/refresh-token UX the real API will use. This is
 * NOT secure and must never be used as-is in production. A real deployment
 * issues tokens from the server (see src/lib/api/auth.ts real-mode branch)
 * with a secret held only in server environment variables
 * (JWT_ACCESS_SECRET / JWT_REFRESH_SECRET in .env.example) and this file's
 * signing functions are not used in the browser at all.
 */

const MOCK_SECRET = new TextEncoder().encode(
  process.env.NEXT_PUBLIC_MOCK_JWT_SECRET ?? "cmmp-mock-mode-development-secret-do-not-use-in-prod"
)

export interface AccessTokenClaims extends JWTPayload {
  sub: string
  email: string
  role: Role
  organizationId: string | null
  type: "access" | "refresh"
}

export async function signMockAccessToken(claims: Omit<AccessTokenClaims, "type">, expiresIn = "15m") {
  return new SignJWT({ ...claims, type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(MOCK_SECRET)
}

export async function signMockRefreshToken(claims: Omit<AccessTokenClaims, "type">, expiresIn = "30d") {
  return new SignJWT({ ...claims, type: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(MOCK_SECRET)
}

export async function verifyMockToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, MOCK_SECRET)
    return payload as AccessTokenClaims
  } catch {
    return null
  }
}

/** Decode without verifying — used only for non-security-critical UI
 * conveniences (e.g. middleware route redirects based on presence/role hint
 * before a full client-side verification runs). */
export function decodeTokenUnsafe(token: string): AccessTokenClaims | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]))
    return payload as AccessTokenClaims
  } catch {
    return null
  }
}
