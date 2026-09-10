# CMMP Backend — Deploy Readiness Audit

Scope: `backend/` (this repo's Fastify + Prisma cloud server source) top to
bottom, targeting "ready to hand to real-world clients." Six fixes were
applied directly per your go-ahead to change backend code; nothing in
`src/` under the portal frontend was touched. Method: full read of every
route file, `lib/`, `agent/`, `Dockerfile`, `prisma/schema.prisma`, plus a
live `tsc --noEmit`, `npm run build`, and `prisma migrate status` against
the local dev database to check claims against reality rather than the
source alone.

## Verdict

**Not yet ready for real clients — but closer after this session.** The
RBAC/tenant-scoping pattern used almost everywhere (`tenantScope`,
`scopedZone`, `allowedServerIds`) is well-designed and, where it was
applied, correctly stops one organization from touching another's data.
The problem was that it wasn't applied consistently: three `servers.ts`
routes, all of `schedules.ts`, and one `monitoring.ts` route had **no**
tenant check at all — a real cross-tenant IDOR, not a theoretical one,
fixed in this session. CORS also accepted credentialed requests from any
origin despite an unused allowlist already sitting in `.env` — also fixed.
What's left unfixed and still blocks a confident multi-tenant launch: the
entire music catalog is served from `/media/music/*` with no auth at all
and guessable URLs, and login has only a single-process rate limit (fine
for one instance, not for a scaled deployment).

## System map

```
backend/src/
  index.ts            -- Fastify bootstrap: CORS, static /media/music/,
                          error handler, route registration, GET /health
  realtime.ts          -- Socket.IO, browser-facing, namespace /realtime
  agent/
    signalrHub.ts       -- WebSocket push to Windows agents (auth via
                           agent token in query string, verified)
    musicServerClient.ts
  routes/
    auth.ts             -- login/refresh/logout, bcrypt + rotated refresh
                           tokens in DB (revocable, unlike a bare JWT)
    organizations.ts, locations.ts, servers.ts, zones.ts,
    equalizer-presets.ts, commands.ts, playlists.ts, schedules.ts,
    users.ts, music.ts, dashboard.ts, monitoring.ts, prayer.ts
                        -- portal REST API, JWT bearer auth (auth-context.ts)
    agent.ts            -- Windows MusicServer agent protocol, opaque
                           bearer token auth (agent-auth.ts), separate
                           from the portal's JWT scheme entirely
    sync.ts
  lib/
    jwt.ts, auth-context.ts, rbac.ts   -- auth/authz primitives
    agent-auth.ts, pairing.ts, agent-registry.ts, agent-sweep.ts
    env.ts               -- typed env, fails fast on missing required vars
    zone-effects.ts, prayer-scheduler.ts, prayer-location.ts, ...
prisma/schema.prisma      -- Postgres schema, 11 migrations
Dockerfile                 -- multi-stage; GIT_COMMIT baked in for
                            traceability; migrations run by a separate
                            docker-compose `backend-migrate` service
```

## What's working

- **The tenant-scoping pattern itself is sound** where it's used:
  `zones.ts`'s `scopedZone`, `commands.ts`'s `allowedServerIds`,
  `locations.ts`, `organizations.ts`, `equalizer-presets.ts` and `users.ts`
  (which layers a role-rank check — a Location Manager can never mint a
  peer or superior — on top of visibility scoping) all correctly stop a
  caller from reading or writing another tenant's rows.
- **Refresh tokens are DB-backed and rotated**, not just a longer-lived
  JWT: `auth.ts` hashes and stores each one, revokes it on refresh
  (rotation) and on logout, and checks `revokedAt`/`expiresAt` server-side
  — a stolen refresh token can actually be invalidated, unlike a pure
  stateless scheme.
- **Zone transport commands never fake success.** `commands.ts` requires
  `isAgentConnected()` before even trying, waits for a real ack within
  `AGENT_COMMAND_ACK_TIMEOUT_MS`, and only applies the optimistic zone-state
  effect after a genuine `SUCCESS` comes back from the Windows agent.
- **Windows-agent auth is a separate, sane scheme**: opaque
  `${serverId}.${secret}` token, only ever compared as a SHA-256 hash
  (`agent-auth.ts`), checked identically by the REST `preHandler` and the
  raw WebSocket upgrade handler for the push channel.
- **Deploy traceability exists**: `GET /health` reports the exact git
  commit baked in at image build time (`GIT_COMMIT` build arg) — this is
  what let a previous session catch a fix that was committed but not yet
  in the running image.
- **Env validation fails loudly, not silently**: `env.ts`'s `required()`
  throws at boot for any missing secret, and `publicApiUrlProblem()`
  specifically catches the "forgot to set PUBLIC_API_URL to a real
  address" mistake that would otherwise break every venue's music
  downloads with no obvious symptom.

## Fixed this session (backend-only, verified with `tsc --noEmit` + `npm run build`)

| # | Issue | Fix | File(s) |
|---|---|---|---|
| 1 | `POST /servers/:id/pairing-code`, `DELETE /servers/:id`, `GET /servers/:id/logs` had **no tenant scope check** — any Organization Admin or Location Manager could regenerate another org's pairing code (hijacking a stranger's venue re-pairing), unpair another org's server, or read another org's server logs, just by knowing/guessing the id. | Added `scopedServer()`, mirroring `zones.ts`'s `scopedZone`; all three routes (plus `forget`, for defense-in-depth even though RBAC already restricts it to SUPER_ADMIN) now 404 for an out-of-scope id. | [routes/servers.ts](src/routes/servers.ts) |
| 2 | `GET /schedules` with no query params returned **every schedule for every organization** on the platform; `PATCH`/`DELETE /schedules/:id` had no ownership check at all — any Location Manager could edit or delete another organization's playlist schedule. | Added `allowedZoneIds()`/`scopedSchedule()` (same shape as `commands.ts`'s `allowedServerIds`); list defaults to the caller's own zones, writes 404 outside that set. | [routes/schedules.ts](src/routes/schedules.ts) |
| 3 | `POST /monitoring/alerts/:id/acknowledge` had no scope check — any role with `logs:read` could acknowledge (silence) another organization's alert. | Resolves the alert's owning organization via its `serverId`/`locationId` and 404s if it doesn't match the caller's. | [routes/monitoring.ts](src/routes/monitoring.ts) |
| 4 | CORS was `origin: true, credentials: true` — reflects **any** request Origin and allows credentialed cross-origin requests from it. `env.corsAllowedOrigins` (`CORS_ALLOWED_ORIGINS`) was already defined and already documented in the root `.env.example` for production, but never actually read anywhere — dead config giving a false sense of restriction. | Wired `env.corsAllowedOrigins` into both the REST API's CORS plugin and Socket.IO's realtime CORS. **Action needed before this ships**: confirm `CORS_ALLOWED_ORIGINS` is set to the real portal origin(s) in the production `.env` — the fallback default is `http://localhost:3000`, which would silently break the deployed portal if the production env var isn't already set (it should be, per `.env.example`, but verify before restarting the container). | [src/index.ts](src/index.ts), [src/realtime.ts](src/realtime.ts) |
| 5 | `/auth/login` had **no rate limiting whatsoever** — unlimited password guesses against any known email. | Added a minimal in-memory sliding-window limiter (10 attempts / 15 min per client IP). Explicitly a stopgap: it's per-process, so it stops being meaningful the moment this backend runs as more than one replica behind a load balancer. Swap for `@fastify/rate-limit` with a shared (Redis) store before horizontal scaling. | [routes/auth.ts](src/routes/auth.ts) |

None of these change any response shape or add a new required request field — a legitimate caller (one already only ever requesting ids inside its own tenant) sees no behavior change. An illegitimate cross-tenant request that used to succeed now 404s.

## Not fixed — needs a decision before it's safe to call "ready"

| Priority | Finding | Evidence |
|---|---|---|
| **P0** | **The entire music catalog is unauthenticated and unsigned.** `fastifyStatic` serves `env.musicStorageDir` at `/media/music/*` registered directly on the app, outside `requireAuth`. Anyone who can reach the server on the network can download any track with no login, by guessing/enumerating `storageKey` (`${Date.now()}-${sanitizedOriginalFilename}` — half-guessable, half-enumerable by timestamp). Real fix is either a short-lived signed-URL scheme (HMAC token + expiry appended to the URL, checked in a hook before `fastifyStatic` serves the file) or moving downloads behind an authenticated proxy route. This is a meaningful scope of work (it also has to keep working for the *unauthenticated* Windows agent's own fetch — agent tokens aren't browser-usable the same way) and touches a URL shape multiple things build (`routes/agent.ts:467`), so I did not implement it without your sign-off on the approach. | [src/index.ts:36](src/index.ts), [routes/music.ts](src/routes/music.ts), [routes/agent.ts:467](src/routes/agent.ts) |
| **P0** | **Verify production database migrations are actually applied.** This session's local dev Postgres was **7 migrations behind** `schema.prisma` (`auto_boot`, `forget_server`, `server_timezone_coords`, `rename_reported_venue_location`, `zone_equalizer`, `set_eq_command_type`, `eq_presets` — all unapplied). That's very likely just this dev machine's DB, not production, but it proves the failure mode is real: if `docker-compose`'s `backend-migrate` step is ever skipped on a deploy, the backend boots fine and then throws on the first request touching any of those newer columns/tables/enum values, with no warning at startup. Confirm `prisma migrate status` shows clean against the actual production database before the next deploy, and that `backend-migrate` genuinely runs (and is checked for success) every time, not just the first time. | `npx prisma migrate status` output this session |
| **P1** | **Local dev/build hygiene**: the Prisma client in `node_modules/.prisma` was stale relative to `schema.prisma` at the start of this session (`npm run build` failed with ~25 type errors referencing fields that don't exist on the generated client — `reportedTimezone`, `autoBootEnabled`, `eqPreset`, `SET_EQ`, `FORGET_SERVER`, etc.). Regenerating (`npx prisma generate`) fixed all of it instantly — it was 100% client staleness, not a real code bug, and the Dockerfile already runs `prisma generate` before `npm run build` so a real image build is unaffected. But there's no `postinstall`/pre-build guard catching this for a developer running `npm run build` locally without remembering to regenerate first, and no CI step that would catch a genuine type error before it reaches a deploy. Add `"prebuild": "prisma generate"` to `package.json`'s scripts, and a CI job running `npm run build` on every PR. | `npx tsc -p tsconfig.json --noEmit` output this session, before/after `prisma generate` |
| **P1** | **Two committed `.bak` files sit in git** (`src/index.ts.bak`, `src/lib/env.ts.bak`) — a third (`src/routes/agent.ts.bak`) too. Confirmed genuinely tracked, not just untracked cruft on disk. Dead weight at best; at worst a future editor edits the `.bak` by mistake or a stale copy of a secret-adjacent file (`env.ts.bak`) ships confusion about which env keys are actually required. Delete them — `git log` already preserves the history they'd be "backing up." | `git ls-files backend \| grep bak` |
| **P2** | **`Track`/`MusicFolder` have no `organizationId`** — the music catalog is fully global across every tenant, while `Playlist` is nullable-org-scoped and everything else (`Zone`, `MusicServer`, `Location`, `Schedule` via zone) is strictly org-scoped. This reads like an intentional "shared licensed catalog, org-scoped playlists select from it" design (plausible for this kind of product) rather than an oversight, given how carefully everything else is scoped — but confirm that's actually the intent. If it's not, every org can currently read, rename and **delete** every other org's uploaded tracks (`music.ts` has no scoping on any route). | [prisma/schema.prisma:367-392](prisma/schema.prisma), [routes/music.ts](src/routes/music.ts) |
| **P2** | **JWT secrets are dev-strength in the local `.env`** (32-33 characters — fine for local testing, not verified to be true production secrets since this is a local checkout's own `.env`, gitignored). Not itself a code issue; flagging so whoever manages the production `.env` confirms real high-entropy secrets are set there and were rotated after this repo's history (which never contained `.env`, per `.gitignore`) had any chance of exposure. | `backend/.env` (local), `backend/.gitignore` |

## Efficiency / correctness notes (lower stakes, not blocking)

- `music.ts`'s `displayNameFor()` does one `prisma.user.findUnique` per track on every `GET /music` and `GET /music/sync-status` response — an N+1 that's fine at today's catalog size and will show up in query volume once a venue has a few thousand tracks. Batch with a single `findMany({ where: { id: { in: uploaderIds } } })` if catalog size grows.
- `commands.ts` and `zones.ts` both look up `prisma.musicServer`/`prisma.zone` twice in a few paths (once for scoping, once for the actual operation) — harmless at current traffic, worth collapsing if command volume ever gets heavy.

## Bottom line

The two P0s (unauthenticated media, unverified production migration state)
are the actual gate on "hand this to real clients" — everything else this
session found and fixed was real but containable. Tell me how you want the
signed-media-URL approach to work (or whether it should just move behind
an authenticated proxy route instead) and I'll implement it; it's backend
work like the rest of this, so no frontend sign-off needed for the
implementation itself — only if the URL shape the frontend/agent consume
needs to change.
