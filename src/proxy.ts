import { NextResponse, type NextRequest } from "next/server"
import { jwtVerify, decodeJwt } from "jose"
import { landingRoute } from "@/lib/auth/rbac"
import type { Role } from "@/lib/constants"

/**
 * Optimistic, edge-cheap route protection (Next.js 16 renamed Middleware to
 * Proxy — see AGENTS.md). This performs a fast presence/signature check on
 * the session cookie so unauthenticated users never see a protected route
 * flash before redirecting. It is NOT the source of truth for
 * authorization: every data-fetching hook in src/lib/api/* independently
 * verifies the session, and RBAC checks (src/lib/auth/rbac.ts) gate
 * individual UI actions. See README "Security Notes".
 */

const PUBLIC_ROUTES = ["/login"]
const SESSION_COOKIE = "cmmp_session"

const MOCK_SECRET = new TextEncoder().encode(
  process.env.NEXT_PUBLIC_MOCK_JWT_SECRET ?? "cmmp-mock-mode-development-secret-do-not-use-in-prod"
)

/** The session cookie carries the access token; its (unverified) role claim
 * is only used to pick a landing route — never to authorize anything. */
function landingFor(token: string | undefined): string {
  if (!token) return "/dashboard"
  try {
    return landingRoute(decodeJwt(token).role as Role | undefined)
  } catch {
    return "/dashboard"
  }
}

async function hasValidSessionCookie(token: string | undefined): Promise<boolean> {
  if (!token) return false
  try {
    await jwtVerify(token, MOCK_SECRET)
    return true
  } catch {
    // In real (non-mock) mode the cookie is a server-issued opaque/real JWT
    // this proxy can't verify with the mock secret — fall back to a
    // presence check and let the API layer's 401 handling take over.
    return token.length > 0
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isPublicRoute = PUBLIC_ROUTES.includes(pathname) || pathname === "/"
  const token = request.cookies.get(SESSION_COOKIE)?.value
  const authenticated = await hasValidSessionCookie(token)

  if (!isPublicRoute && !authenticated) {
    const loginUrl = new URL("/login", request.url)
    loginUrl.searchParams.set("from", pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (authenticated && (pathname === "/login" || pathname === "/")) {
    return NextResponse.redirect(new URL(landingFor(token), request.url))
  }

  return NextResponse.next()
}

export const config = {
  // "branding" added alongside favicon.ico: the login page's own logo
  // (public/branding/*) has to be reachable by a signed-out browser, or
  // the <img>/<Image> request for it gets redirected to /login itself.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|branding/).*)"],
}
