# Cloud Server Sell-Readiness Audit

**Repo:** `cmezawi147274-cpu/ZONEMAESTRO` (branch `equalizer-saved-presets-and-gauge-fix`, HEAD `e687e25`)
**Scope:** cloud server only — `backend/` (Fastify API) + the Next.js portal. `agent-bridge/` mapped for coupling, not audited.
**Date:** 2026-09-10 · Read-only. Nothing was edited, committed, or deployed.

---

## Verdict

**No. Not sellable in its current state.**

The product design is sound and large parts of the code are genuinely well built — the Windows agent protocol, the RBAC matrix, the user-management route and the zone/location scoping helpers are the work of someone who understands the domain. But the deployment that is live right now on `181.214.100.148` is running with the **JWT signing secrets copied verbatim from `.env.example`, a file that is committed and pushed to GitHub**. Anyone who can read the repo can mint a valid `SUPER_ADMIN` token for production. That single fact makes every other control decorative. Underneath it sits a second structural problem: the music library has no tenant column at all, and three route files plus the entire realtime channel apply no tenant filter, so a second paying client would be able to read, modify and delete the first client's data — and push audio onto their physical venue players. You cannot sell this to two customers until that is fixed.

**Top 5 blockers**

1. **Live JWT secrets are the published placeholders** — `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` in `/opt/CMMP/.env` are byte-identical to the values in the git-tracked `.env.example`. Full authentication bypass, in production, today. `POSTGRES_PASSWORD` and `DATABASE_URL` are the same story.
2. **No TLS.** `PUBLIC_API_URL=http://181.214.100.148:4000`. Every agent bearer token, portal login and music download crosses the public internet in plaintext.
3. **Cross-tenant data access.** `Track` and `MusicFolder` carry no `organizationId` (`backend/prisma/schema.prisma:367,399`); `music.ts`, `schedules.ts` and `sync.ts` filter on nothing. `POST /sync/queue` accepts arbitrary `serverIds` — a cross-tenant *write to someone else's hardware*.
4. **Unauthenticated realtime firehose.** `backend/src/realtime.ts` accepts any socket with no handshake and `emit`s every event to every connection. An anonymous client gets a live feed of all tenants' servers, zones and playback.
5. **Zero tests, zero CI, no backups, no graceful shutdown.** Nothing gates a bad deploy, and nothing recovers from one.

Fixing #1 and #2 is roughly a day. #3 and #4 are about a week. That is the honest distance to "first client".

---

## System map

### Runtime & entrypoints

| Piece | Stack | Entrypoint | Port |
|---|---|---|---|
| Portal | Next.js 16 (App Router, standalone output), React 19, TanStack Query, Tailwind + Radix/Base UI | `src/app/`, route protection in `src/proxy.ts` | 3000 |
| Backend API | Fastify 5, Prisma 6, socket.io 4, `ws` | `backend/src/index.ts` | 4000 |
| Database | PostgreSQL 16 (`postgres:16-alpine`) | `backend/prisma/schema.prisma` | 5432 (bound `127.0.0.1`) |
| Object storage | **Local filesystem**, served by `@fastify/static` | `backend/src/index.ts:36`, `MUSIC_STORAGE_DIR=/app/data/music` | via 4000 |
| Local agent | Node, in this same repo | `agent-bridge/bridge.js` | 8899 (loopback UI) |

No queue, no cache, no Redis, no external object store, no third-party services of any kind. `city-timezones` and the Aladhan prayer-time API (`backend/src/lib/aladhan.ts`) are the only outbound dependencies.

### Background workers (all in-process, all single-instance)

- `startAgentHeartbeatSweep()` — every 15s, flips stale servers to `OFFLINE` (`backend/src/lib/agent-sweep.ts:12`)
- `startUnpairedRetentionSweep()` — every 5min, deletes abandoned unpaired server rows
- `startPrayerScheduler()` — runs Prayer Mode pauses server-side (`backend/src/lib/prayer-scheduler.ts`)

### Architecture

```
Browser ──HTTP──▶ Portal :3000 ──rewrite /api/*──▶ Backend :4000 ──▶ Postgres :5432
   │              (next.config.ts:16-21)                │
   │                                                    ├──▶ /media/music/* (local disk, UNAUTHENTICATED)
   └──socket.io /realtime──────────────────────────────▶│    (NO AUTH, broadcasts to all)
                                                        │
Windows venue PC                                        │
  agent-bridge (Node) ──outbound HTTP only─────────────▶│  POST /api/pairing/complete
    └─▶ MusicServer.Api (compiled C#, :8765) ──────────▶│  POST /api/server/heartbeat   (4/min)
                                                        │  GET  /api/server/commands/pending (40/min)
                                                        │  POST /api/server/tracks/sync (3/min)
                                                        │  WS   MusicServerHub
                                                        └──▶ Aladhan API (prayer times)
```

### Repos and the GitHub connection to the local/web server

**There is only one repo.** The "two codebases" are two directories inside `ZONEMAESTRO`:

- Cloud = `backend/` + `src/` + `prisma/`
- Local/web server = `agent-bridge/` (the Node bridge) which in turn drives **`MusicServer.Api`**, a *compiled, third-party win-x64 C# service* that is deliberately not in any repo (`backend/src/routes/agent.ts:1-13` calls this "the freeze").

There is **no** submodule (`.gitmodules` absent), **no** GitHub Actions (`.github/` absent), no deploy hook, no webhook, no version pinning between the halves, and no env sync. The contract between cloud and agent is **implicit and undocumented as a schema** — `backend/src/routes/agent.ts:35-54` defines `field()`/`str()`/`num()` helpers that look field names up *case-insensitively against alias lists* precisely because the agent's JSON casing was never known. That works, but it means there is no versioned API contract to hold either side to.

Deploy path is manual: `git pull` → `docker compose --profile full up -d --build` (`go-real.sh`, README §6).

### Environments

**One.** Production is `/opt/CMMP` on `181.214.100.148`, deployed from a working directory that is *on a feature branch* (`equalizer-saved-presets-and-gauge-fix`, not `master`). There is no staging, and `.env.local` (tracked in git) points at `127.0.0.1` for local dev. `NEXT_PUBLIC_USE_MOCK_API` toggles an entire in-browser mock data layer (`src/lib/mock/`) — a good demo asset, but it means "does it work" has two very different answers.

---

## What is working

Credit where it is due — these are real strengths and should not be rewritten:

- **The Windows agent protocol is the best code in the repo.** Opaque `serverId.secret` tokens with 32 random bytes, SHA-256 hashed at rest (`backend/src/lib/agent-auth.ts`), every route scoped to `ctx.serverId`, terminal-state ack guarding against late/duplicate acks (`routes/agent.ts:308`), and a zone-prune path that correctly distinguishes "reported zero zones" from "failed to report" (`routes/agent.ts:487`). The comments explain *why*, with the bug that motivated them.
- **Pairing is done properly** — codes are hashed (`hashPairingCode`), expiring, single-use, and cleared on completion. `crypto.randomInt` over an unambiguous alphabet.
- **RBAC is enforced server-side, not just in the UI** (`backend/src/lib/rbac.ts`), and `users.ts` is textbook: rank checks prevent minting a peer or superior, `visibilityWhere()` scopes every read, and the location's organization always overrides a client-supplied `organizationId`.
- **Tenant scoping is correctly implemented where it exists** — `zones.ts` (`scopedZone`, `allowedLocationIds`), `monitoring.ts`, `servers.ts`, `locations.ts`, `equalizer-presets.ts`. The pattern to copy already exists in this codebase.
- **Refresh-token rotation with hashed storage and revocation** (`routes/auth.ts:62-68`).
- **Both Dockerfiles are production-grade** — multi-stage, non-root `USER`, healthchecks, Next standalone output, and `GIT_COMMIT` baked in so `/health` reports the deployed commit.
- **Postgres is not internet-exposed** (`127.0.0.1:5432` in `docker-compose.yml`) — correct, and notably better than the backend's own binding.
- **All 136 production dependencies are permissively licensed** (MIT/ISC/BSD/Apache/BlueOak). No GPL/AGPL contamination.
- **The README is unusually honest and thorough**, including a Security Notes section that correctly names several of the gaps below.

---

## Efficiency findings

| Finding | Evidence | Impact | Suggested alteration |
|---|---|---|---|
| **Agent polls commands every 1.5s even when the push socket is open** | `agent-bridge/lib/config.js:48`; `agent-bridge/lib/agent.js:699`; `agent-bridge/lib/hub.js:6` admits the poll is the fallback | **~40 req/min/venue of pure idle polling**, each a `findMany` + `updateMany`. 100 venues ≈ 83 req/s and ~5.8M requests/day before any user does anything | Back the poll off to 20–30s while `hasOpenHubSocket()` is true; keep 1.5s only as the disconnected fallback. ~90% cut in cloud request volume |
| **Heartbeat writes a full row UPDATE every 15s per venue** | `routes/agent.ts:203-231` | 4 row writes/min/venue forever (~576k writes/day at 100 venues) plus WAL and vacuum churn, to store liveness | Write `lastHeartbeatAt` + metrics on change or every Nth beat; keep liveness in the existing in-memory registry |
| **`GET /music` is N+1 and unpaginated** | `routes/music.ts:71-72` — `displayNameFor()` runs one `user.findUnique` per track | A 5,000-track library = **5,001 queries and a 5,000-row JSON payload** on every library open | `include: { uploadedBy: { select: { name, email } } }` + `take`/`cursor` pagination |
| Same N+1 shape in 6 more list endpoints | `commands.ts:48`, `playlists.ts:39`, `zones.ts:81`, `locations.ts:32`, `servers.ts:39`, `organizations.ts:28` | Every list page cost scales with row count | Replace per-row `await` with a Prisma `include`/`select` join |
| **Only 5 of 46 `findMany` calls have any limit** | `grep take:` → `commands.ts:47`, `servers.ts:198`, `monitoring.ts:18,27,76` | Unbounded payloads and memory as any tenant grows | Default `take` on every list route; cursor pagination on music/playlists/commands |
| **`POST /sync/queue` is a sequential nested loop** | `routes/sync.ts:32-48` — `upsert` per (track × server), plus a `findUnique` per server inside the loop | 500 tracks × 10 servers = **5,000 sequential round-trips in one request**, no transaction, no batching | `createMany`/`updateMany` per server inside a `$transaction`; hoist the server lookup |
| **Agent sync loads every cached row just to sum a float** | `routes/agent.ts:456-458` — `findMany({ include: { track: true } })` then `.reduce()` | Loads the venue's entire cached library (with joined tracks) **every 20s**, per venue | `prisma.trackSyncState.aggregate({ _sum })` with a join, or denormalise the running total |
| **Unbounded `Promise.all` over agent-supplied array** | `routes/agent.ts:434-443` — one `upsert` per `cachedTrackIds` entry, no length cap | A venue reporting 10k cached tracks fires 10k concurrent DB ops → connection-pool exhaustion for every other tenant | Cap the array, chunk it, and use `$transaction` batches |
| **Per-command DB query when serving pending commands** | `routes/agent.ts:261-270` — `localZoneIdOf()` queries per command | N+1 on the single hottest agent endpoint | One `zone.findMany({ where: { id: { in } } })`, map in memory |
| **Sequential zone upserts** | `routes/agent.ts:491-523` — `findUnique` then `update`/`create` per zone in a `for` loop | 2 round-trips per zone per sync, every 20s | `upsert` on the existing `serverId_localZoneId` unique, batched |
| **No Prisma connection-pool tuning** | `backend/src/lib/db.ts` is `new PrismaClient()`; no `connection_limit` in `DATABASE_URL` | Default pool (`cpus*2+1`) collides with the unbounded concurrency above | Set `connection_limit` and `pool_timeout` explicitly in `DATABASE_URL` |
| **`logger: true` with no rotation and no redaction** | `backend/src/index.ts:29`; no `logging:` block anywhere in `docker-compose.yml` | Every one of those ~5.8M daily requests writes a log line to an unbounded json-file driver. **This fills the disk and takes the server down** | `logging: { driver: json-file, options: { max-size: 10m, max-file: 3 } }`; drop successful-request logs to `warn`; add pino `redact` for `authorization` |
| **No retention on any growth table** | No `deleteMany` for `LogEntry`, `ActivityEvent`, `RemoteCommand`, `Alert`, `RefreshToken` | Every command, event, log line and login row is kept forever | Add a nightly retention sweep alongside the two existing sweeps |
| **Restart marks every venue offline** | `agent-sweep.ts:16-21` trusts only the in-memory `lastSeen`, which is empty after restart | Each deploy emits a spurious `SERVER_DISCONNECTED` + `SERVER_CONNECTED` per venue, poisoning the activity feed and any future alerting | Seed the sweep from `lastHeartbeatAt` in the DB, or skip the first sweep tick after boot |
| **No resource limits on any container** | `docker-compose.yml` has no `deploy.resources` / `mem_limit` | One runaway query can OOM the host and take the database with it | Set memory limits per service |
| Portal request blocks up to 3s on agent ack | `routes/commands.ts:148`, `env.agentCommandAckTimeoutMs` | Every transport button holds a connection for up to 3s | Acceptable for now; consider optimistic response + realtime confirmation |

---

## Commercial readiness scorecard

| Area | Score | Evidence | Gap |
|---|---|---|---|
| **Security** | **1 / 5** | Live `.env` secrets identical to git-tracked `.env.example`; `PUBLIC_API_URL=http://…:4000`; `cors { origin: true, credentials: true }` (`index.ts:31-34`) while `env.corsAllowedOrigins` is parsed and **never used**; no rate limiting anywhere (no `@fastify/rate-limit`, no `helmet`); tokens in `localStorage` (`src/lib/auth/session.ts:20-22`); `/media/music/*` unauthenticated; 4 high-severity CVEs incl. **path traversal in `@fastify/static`**, which is exactly what serves that route | Rotate secrets, terminate TLS, wire the CORS allowlist that already exists, add rate limits, move to httpOnly+Secure cookies, sign or auth media URLs, patch deps |
| **Reliability** | **2 / 5** | Healthchecks + `restart: unless-stopped` + idempotent acks + defensive sweeps are all present. But: **no `SIGTERM` handler anywhere** (grep: zero hits), `/health` doesn't check the DB, **zero tests**, **no CI**, no backups of `postgres-data` or `music-data`, migrations are a manual one-shot, no rollback path | Graceful shutdown, readiness probe, a smoke-test suite, automated `pg_dump` + volume backup with a documented restore |
| **Multi-tenant / packaging** | **1 / 5** | `Track` and `MusicFolder` have **no `organizationId`** (`schema.prisma:367,399`); `music.ts`, `schedules.ts`, `sync.ts` have zero tenant filtering; `realtime.ts` broadcasts every event to every socket with no auth; `ActivityEvent` has no org column | Add the tenant column + migration for music, apply the `scopedZone` pattern to the three unscoped route files, room-scope socket.io per org |
| **Ops** | **1 / 5** | No `.github/`, no CI, no metrics endpoint, no alerting, no log rotation, no backup job, no runbook beyond the README, single environment, deployed from a feature branch | CI on push (typecheck + lint + tests + build), backups, log limits, a staging environment, `master` as the deploy branch |
| **Legal / compliance** | **1 / 5** | No `LICENSE` file — README says "Proprietary — internal project scaffold"; no ToS/privacy/DPA hooks; **no audit log** (`ActivityEvent` has no actor, IP, or before/after); no data export or delete path for a departing client; no retention policy; user emails written into activity messages (`servers.ts:175`); the product distributes copyrighted audio with no licence metadata or play reporting | EULA + DPA, an `AuditLog` model with actor/IP/diff, per-tenant export + hard delete, retention policy, a position on performance-rights reporting |
| **Customer-facing quality** | **2 / 5** | README and `.env.example` are genuinely good; error handling is structured (`HttpError`); `/health` reports the deployed commit. But **there is no password reset and no email sending of any kind** — `users.ts:119` invites a user with `crypto.randomBytes(12)` as their password *and never tells anyone what it is*, so an invited user can never log in. No client-facing docs, no upgrade path, no onboarding flow | Password reset + transactional email, an admin "set password" fallback, client-facing setup docs |

---

## Suggested alterations

### Must fix before first sale (P0)

**P0-1 · Rotate every production secret; make placeholders fail at boot**
*Problem:* `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `POSTGRES_PASSWORD` in the live `/opt/CMMP/.env` are byte-identical to the values published in the git-tracked `.env.example`. Anyone with repo access can forge a `SUPER_ADMIN` access token against production.
*Evidence:* `/opt/CMMP/.env` vs `.env.example:73-75,60`; `go-real.sh:9-10` actively writes the placeholder password as a default.
*Change:* Generate new values (`openssl rand -base64 48`), restart, invalidate all sessions. Extend the `publicApiUrlProblem()` pattern in `backend/src/lib/env.ts:65` to **refuse to boot** on any placeholder secret. Remove the placeholder defaults from `go-real.sh`.
*Why it matters:* Every other security control is void while this holds. A single client security questionnaire ends the deal here.
*Effort:* **S** · *Risk if ignored:* Total compromise of every tenant, silently.

**P0-2 · Terminate TLS; stop shipping bearer tokens in plaintext**
*Problem:* `PUBLIC_API_URL=http://181.214.100.148:4000`. Agent tokens, portal logins and audio all cross the internet unencrypted. The session cookie is set without `Secure` (`src/lib/auth/session.ts:22`).
*Evidence:* live `.env`; no reverse-proxy service in `docker-compose.yml`; README §5 documents the intent but it was never done.
*Change:* Caddy or nginx in front of both containers with a real hostname and automatic certs; move the backend's published port off `0.0.0.0`; set `Secure` on the cookie.
*Why it matters:* No B2B buyer will accept plaintext auth. It is also the cheapest fix on this list.
*Effort:* **S** · *Risk if ignored:* Passive network capture yields permanent agent tokens.

**P0-3 · Give music a tenant and scope the three unscoped route files**
*Problem:* `Track`/`MusicFolder` have no `organizationId`. `music.ts` (10 routes), `schedules.ts` (4) and `sync.ts` (3) apply no tenant filter. Client A can list, edit and **delete** client B's tracks and schedules.
*Evidence:* `schema.prisma:367,399`; `music.ts:26,71,141,154,167`; `schedules.ts:39,48,59,68`; `sync.ts:21-22`.
*Change:* Add `organizationId` to `Track` and `MusicFolder` with a backfill migration; apply the `scopedZone`/`allowedLocationIds` pattern already in `zones.ts:11-33` to all three files. Validate `zoneId`/`playlistId` ownership on `POST /schedules` instead of passing `request.body` straight to Prisma.
*Why it matters:* This is the definition of multi-tenant. Client two cannot be onboarded until it is true.
*Effort:* **M** · *Risk if ignored:* One customer deletes another's music library. Contract-ending, possibly reportable.

**P0-4 · Stop cross-tenant writes to physical hardware**
*Problem:* `POST /sync/queue` accepts any `serverIds[]` and queues a `SYNC_MUSIC` command to each with no ownership check.
*Evidence:* `sync.ts:26-49`; `sync.ts:52` (`/sync/retry`) is the same.
*Change:* Resolve each `serverId` through the caller's tenant scope before enqueuing; reject the whole request on any foreign id.
*Why it matters:* This is worse than a data leak — it is unauthorised control of another company's in-venue equipment.
*Effort:* **S** · *Risk if ignored:* A tenant pushes arbitrary audio to a competitor's restaurant speakers.

**P0-5 · Authenticate and room-scope the realtime channel**
*Problem:* `initRealtime` accepts any connection with no handshake and `emitEvent` broadcasts to every socket. Anonymous clients receive all tenants' server, zone, playback and sync events.
*Evidence:* `backend/src/realtime.ts:37-53` — `nsp.on("connection")` has no auth middleware; `io.of("/realtime").emit(...)` has no room.
*Change:* `nsp.use()` middleware verifying the access token, `socket.join('org:'+organizationId)`, and emit to the room derived from the event's `serverId`.
*Why it matters:* A live cross-tenant feed is trivially demonstrable in a pen test and needs no credentials at all.
*Effort:* **M** · *Risk if ignored:* Continuous passive leak of operational data.

**P0-6 · Fix CORS and add rate limiting**
*Problem:* `cors({ origin: true, credentials: true })` reflects any origin. `env.corsAllowedOrigins` is parsed, documented in `.env.example`, and never referenced. No rate limiting on `/auth/login` or `/api/pairing/complete`.
*Evidence:* `index.ts:31-34`; `env.ts:17-20` (dead config); `realtime.ts:39-42` (same); no `@fastify/rate-limit` in `backend/package.json`.
*Change:* Pass `env.corsAllowedOrigins` to both. Register `@fastify/rate-limit` globally, tighter on login and pairing. Add `@fastify/helmet`.
*Why it matters:* Unlimited password guessing against an admin portal is a standard finding that fails any security review.
*Effort:* **S** · *Risk if ignored:* Credential stuffing; pairing-code brute force.

**P0-7 · Patch the 4 high-severity CVEs — `@fastify/static` first**
*Problem:* `npm audit --omit=dev` reports 4 high on both the backend and the portal. `@fastify/static` has a **path-traversal** advisory, and it serves `/media/music/` from an unauthenticated route.
*Evidence:* audit run in the `cmmp-backend:latest` image; `index.ts:36`.
*Change:* Upgrade `@fastify/static`, `prisma`/`@prisma/config`. Add `npm audit` to CI (P1-3).
*Why it matters:* A known-CVE scan is the first thing an enterprise buyer runs.
*Effort:* **S** · *Risk if ignored:* Arbitrary file read from the backend container.

**P0-8 · Put the media route behind authorisation**
*Problem:* `/media/music/<storageKey>` is served with no auth to anyone who can reach port 4000. Storage keys are `Date.now()-filename`, i.e. guessable.
*Evidence:* `index.ts:36`; key generation at `music.ts:102`; URL handed to agents at `agent.ts:467`.
*Change:* Signed, expiring URLs (HMAC over key + expiry), or an authenticated streaming route that checks agent token or portal scope.
*Why it matters:* You are redistributing licensed music over an open directory. This is a licensing exposure as much as a security one.
*Effort:* **M** · *Risk if ignored:* Public redistribution of client catalogues; rights-holder liability.

### Fix soon — before the first client depends on it (P1)

**P1-1 · Ship a password reset, or invited users cannot log in**
`users.ts:119` hashes `crypto.randomBytes(12)` as the new user's password and no one is ever told it; there is no reset route and no mailer dependency anywhere in the repo. Add transactional email + reset tokens, or at minimum a SUPER_ADMIN "set password" action. **Effort: M.** *Risk: onboarding is impossible for every role below SUPER_ADMIN.*

**P1-2 · Move tokens out of `localStorage` into httpOnly, Secure cookies**
`src/lib/auth/session.ts:20-22` stores both tokens — including the **30-day refresh token** — in `localStorage` with a non-httpOnly cookie. The file's own comment says a real backend should do otherwise; the backend now exists. Any XSS is a month-long account takeover. **Effort: M.** *Risk: single XSS → full tenant compromise.*

**P1-3 · Add CI and a smoke-test suite**
No `.github/`, no test files, no test runner. Minimum: typecheck + lint + `npm audit` + build on every push, plus tests for the tenant-scoping helpers and the auth/pairing paths — exactly the code where a regression is a breach. **Effort: M.** *Risk: nothing prevents a repeat of P0-3.*

**P1-4 · Graceful shutdown and a real readiness probe**
Zero `SIGTERM`/`SIGINT` handlers; `/health` returns `{ok:true}` without touching the DB, so the container reports healthy while Postgres is down. Add `app.close()` on signals and a `/ready` that runs `SELECT 1`. **Effort: S.** *Risk: every deploy drops in-flight commands mid-write.*

**P1-5 · Backups and a tested restore**
`postgres-data` and `music-data` are named volumes with no backup job and no documented restore. Nightly `pg_dump` + volume snapshot, offsite, **with a restore actually rehearsed**. **Effort: M.** *Risk: one disk failure ends the business.*

**P1-6 · Cap log volume and redact**
`logger: true` + no `logging:` limits in compose + ~5.8M req/day at 100 venues. Set json-file `max-size`/`max-file`, drop 2xx request logs, add pino `redact` for `authorization`. **Effort: S.** *Risk: disk exhaustion takes down production.*

**P1-7 · Add an audit log**
`ActivityEvent` is an operational feed with no actor, no IP, no before/after. "Who deleted our playlist?" is unanswerable. Add an `AuditLog` model written on every mutating route. **Effort: M.** *Risk: fails enterprise procurement; no incident forensics.*

**P1-8 · Retention sweeps for the growth tables**
Nothing ever deletes `LogEntry`, `ActivityEvent`, `RemoteCommand`, `Alert` or `RefreshToken`. Add a nightly sweep beside the two in `agent-sweep.ts`. **Effort: S.** *Risk: unbounded storage cost and query degradation.*

**P1-9 · Validate request bodies**
`schedules.ts:48` and `:59` pass `request.body` directly into Prisma (mass assignment). Fastify JSON schemas or Zod on every mutating route — this also gives you free OpenAPI. **Effort: M.** *Risk: unvalidated writes; no API documentation to hand a client.*

**P1-10 · Commercial paperwork**
No `LICENSE`, no ToS, no privacy policy, no DPA, no per-tenant data export or hard delete. **Effort: M (mostly legal, not engineering).** *Risk: cannot legally close a B2B contract.*

### Later (P2)

- **P2-1** Back the agent command poll off while the hub socket is open (`agent-bridge/lib/agent.js:699`) — the single biggest efficiency win available. **S**
- **P2-2** Fix the N+1s in the seven list endpoints and add pagination. **M**
- **P2-3** Batch `POST /sync/queue` and the agent zone/track sync loops into transactions. **M**
- **P2-4** Replace `agent.ts:456-458`'s full-table load with `aggregate({_sum})`. **S**
- **P2-5** Seed the heartbeat sweep from `lastHeartbeatAt` so restarts stop faking a fleet-wide outage. **S**
- **P2-6** Move the in-memory `agent-registry` to Redis or Postgres `LISTEN/NOTIFY` so more than one backend instance can run (`lib/agent-registry.ts:8-10` documents this as a known constraint). Prerequisite for zero-downtime deploys and horizontal scale. **L**
- **P2-7** Set explicit Prisma `connection_limit` and container resource limits. **S**
- **P2-8** Add `/metrics` (Prometheus) and alerting on venue-offline, command-failure rate and disk. **M**
- **P2-9** Stand up staging; deploy from `master`, not a feature branch. **M**
- **P2-10** Remove the 8 tracked `.bak` files and untrack `.env.local`. **S**

### Do not change

- The Windows agent protocol in `backend/src/routes/agent.ts` and `lib/agent-auth.ts` — token scheme, hashing, ack idempotency and the zone-prune guard are correct. Scope changes to adding rate limits and array caps.
- The pairing-code design (`lib/pairing.ts`).
- `users.ts`'s rank/visibility model — use it as the template for P0-3.
- `zones.ts`'s `scopedZone`/`allowedLocationIds` helpers — copy, don't redesign.
- Both Dockerfiles.
- The mock-data layer (`src/lib/mock/`) — a genuine sales asset for demos.
- `proxy.ts`'s optimistic-redirect design — correctly documented as non-authoritative.

---

## Cloud ↔ local/web coupling

**How they talk today.** Outbound-only from the venue, which is the right call and worth saying out loud in a sales conversation: no inbound ports open on the restaurant network. `agent-bridge` (Node, in this repo) pairs once via `POST /api/pairing/complete`, caches an opaque token in `agent-state.json`, then runs four independent timers (`agent-bridge/lib/agent.js:698-706`): heartbeat 15s, **command poll 1.5s**, track sync 20s, zone-playlist sync 20s. A `MusicServerHub` WebSocket (`lib/hub.js`) exists to push commands immediately, with the REST poll as fallback. `agent-bridge` in turn drives the compiled `MusicServer.Api` C# service on `127.0.0.1:8765`, which is not in any repo.

**Efficiency issues.**

1. **The poll and the push socket are fully redundant.** `hub.js:6` says so. Yet the 1.5s poll runs unconditionally, producing ~40 idle requests/min/venue — over 90% of all cloud traffic.
2. **No backoff.** Every loop is a fixed `setInterval`; a cloud outage means every venue hammers at full rate until it returns, and they all reconnect simultaneously.
3. **Chatty, not batched.** Four separate endpoints on three cadences. Heartbeat already returns `pendingCommands` (`agent.ts:241`) — the agent could use that instead of polling.
4. **No cap on agent-supplied arrays** (`agent.ts:434`) — the local side can DoS the cloud by reporting a large `cachedTrackIds`.
5. **No version negotiation.** Nothing prevents an old agent from talking to a new cloud; the case-insensitive alias helpers (`agent.ts:35-54`) exist because the contract was reverse-engineered rather than specified.

**Suggested contract / deploy changes.**

- **Adaptive polling:** poll every 1.5s only when `hasOpenHubSocket()` is false; otherwise 20–30s. One-line change in the agent, ~90% traffic reduction.
- **Exponential backoff with jitter** on every loop when the cloud errors.
- **Publish a versioned agent contract** — `X-Agent-Protocol-Version` header, an OpenAPI document for the `/api/server/*` surface, and a documented minimum supported agent version. This is what lets you ship cloud changes without breaking venues you cannot reach.
- **Cap and chunk** every agent-supplied array server-side.
- **Decide the repo split deliberately:** either keep the monorepo and tag releases that pin cloud+agent together, or split `agent-bridge/` into its own repo with a pinned protocol version. Today it is a monorepo by accident, with no CI in either half.

*(The local server has not been audited in depth, per the brief.)*

---

## Open questions

| Question | Why it matters | How to verify |
|---|---|---|
| Is `181.214.100.148` serving real customer data today, or is it a demo? | Determines whether P0-1 is an incident (rotate + notify) or just a fix | Check `User`/`Organization` row counts and `lastLoginAt` in Postgres |
| Has the repo ever been public, or shared with contractors? | With P0-1, repo read access = production SUPER_ADMIN | GitHub repo settings → visibility history and collaborator list |
| Was any real `.env` ever committed and later removed? | `git ls-files` is clean now, but history was not scanned | `git log --all --full-history -- .env` and a `gitleaks`/`trufflehog` pass over full history |
| Where did `MusicServer.Api` (compiled C#) come from, and what licence governs it? | It is the core playback engine and is in no repo. A third-party licence could block resale outright | Vendor contract; `C:\Program Files\Music Server\` file metadata |
| Who holds the music performance/distribution rights? | The product distributes audio to commercial venues; currently over an open URL (P0-8) | Commercial/legal, not the repo |
| What is the target venue count for the first client? | Decides whether P2-6 (multi-instance) is "later" or a P1 | Sales |
| Is `equalizer-saved-presets-and-gauge-fix` intended as the production branch? | Production is deployed from a feature branch, not `master` | Confirm intent, then merge and redeploy from `master` |
| Are `postgres-data` / `music-data` backed up by anything outside Docker (host snapshots)? | Changes P1-5 from critical to merely important | Ask the host provider; check for any cron on the box |

---

## Next Claude Code run

### Prompt 1 — implement the P0s only

```
Implement ONLY the P0 items from CLOUD-SELL-READINESS-AUDIT.md in this repo. Do not touch P1/P2.

Work in a new branch off master. Commit each P0 separately with its ID in the subject.

P0-1  Rotate secrets: generate new JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, POSTGRES_PASSWORD
      into /opt/CMMP/.env (never into git). Extend publicApiUrlProblem() in
      backend/src/lib/env.ts into a startup validator that THROWS on any value still
      matching .env.example. Remove the placeholder defaults from go-real.sh.
P0-2  Add a Caddy (or nginx) reverse-proxy service to docker-compose.yml terminating TLS
      for portal and backend; stop publishing backend :4000 on 0.0.0.0; set Secure on the
      session cookie in src/lib/auth/session.ts.
P0-3  Add organizationId to Track and MusicFolder in backend/prisma/schema.prisma with a
      backfill migration. Apply the scopedZone/allowedLocationIds pattern from
      backend/src/routes/zones.ts:11-33 to every route in music.ts, schedules.ts and
      sync.ts. Stop passing request.body straight into Prisma in schedules.ts.
P0-4  Validate every serverId in sync.ts POST /sync/queue and /sync/retry against the
      caller's tenant scope; reject the request on any foreign id.
P0-5  Add socket.io auth middleware + per-org rooms in backend/src/realtime.ts; emit to
      the room implied by the event's serverId instead of broadcasting.
P0-6  Pass env.corsAllowedOrigins to both @fastify/cors and the socket.io cors config.
      Add @fastify/rate-limit (global + stricter on /auth/login and /api/pairing/complete)
      and @fastify/helmet.
P0-7  Upgrade @fastify/static and prisma/@prisma/config to clear the 4 high-severity
      advisories. Re-run npm audit --omit=dev in both packages and report the result.
P0-8  Replace the open @fastify/static mount of /media/music/ with signed expiring URLs
      (HMAC over storageKey + expiry), and update agent.ts:467 to hand agents signed URLs.

Rules: no rewrites — smallest change that closes each item. Add a regression test for
P0-3 and P0-4 proving a foreign-tenant id returns 404/403 (stand up a test runner if
none exists). Run `npm run typecheck` in both / and /backend before each commit. Do not
deploy; when done, print the exact deploy + migration commands for me to run.
```

### Prompt 2 — audit the local/web server the same way

```
You are a principal backend engineer and security reviewer. Audit the LOCAL/WEB SERVER
half of this system — agent-bridge/ in this repo, plus however it drives the compiled
MusicServer.Api service on 127.0.0.1:8765 — using the same method and output format as
CLOUD-SELL-READINESS-AUDIT.md (read that first for the cloud-side conclusions and the
contract between the halves).

Read-only. Evidence only — cite file paths and config keys; say "unknown" plus how to
verify when you cannot confirm something. Suggest, do not implement.

Focus on:
- The local control panel on 127.0.0.1:8899 — agent-bridge/.env.example says it has NO
  authentication. Establish exactly what it exposes and what LOCAL_UI_HOST=0.0.0.0 would
  mean on a restaurant LAN.
- agent-state.json: what credentials it holds, file permissions, and what an attacker with
  filesystem access on the venue PC gets.
- The four polling loops in agent-bridge/lib/agent.js:698-706 — backoff, jitter, thundering
  herd on cloud recovery, and the redundancy between the 1.5s command poll and the hub
  socket.
- Offline behaviour: what actually keeps playing with no internet, and for how long.
- eq-apo.js / local-api.js — the EqualizerAPO config.txt write path, its EBUSY retry, and
  whether concurrent writes can corrupt it.
- Installation, update and support: how a technician installs, upgrades and recovers this
  on a venue PC, and whether that is sellable at scale.
- The trust boundary: what a compromised venue PC can do to the cloud with its agent token.

Same output sections as the cloud report, including a scorecard and a ranked P0/P1/P2
backlog, plus a "Cloud ↔ local contract" section proposing the versioned API contract the
cloud report recommends.
```
