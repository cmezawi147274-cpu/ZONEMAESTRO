# CMMP operations runbook

Everything here runs on the cloud host as root, from `/opt/CMMP`.
There is **no Node on this host** — run npm/prisma/node inside the Docker
images, never directly.

## Daily reality

| Thing | Where |
|---|---|
| Portal | `:3000` |
| Backend API | `:4000` |
| Postgres | `127.0.0.1:5432` (not internet-exposed) |
| Liveness | `curl -s localhost:4000/health` → `{ok, commit}` |
| Readiness | `curl -s localhost:4000/ready` → 200, or 503 if the DB is down |
| Secrets | `/opt/CMMP/.env`, mode 600, never in git |
| Backups | `/opt/cmmp-backups/db`, nightly 03:20 UTC |

`commit` in `/health` is the deployed short SHA. If it does not match
`git rev-parse --short HEAD`, the running image is not the code you are
reading — rebuild.

## Deploy

```bash
cd /opt/CMMP
git pull                                   # or merge your branch
GIT_COMMIT=$(git rev-parse --short HEAD) docker compose --profile full build backend
docker compose --profile full up -d backend
curl -s localhost:4000/health              # commit must match
bash ops/test.sh                           # 50 tests, must be green
```

Portal instead of backend: `docker compose build app && docker compose up -d app`.
Both: build each, then `docker compose --profile full up -d`.

The backend drains in-flight requests on SIGTERM (15s ceiling), so
`up -d` is safe mid-traffic.

## Rollback

```bash
git log --oneline -10
GIT_COMMIT=<good-sha> docker compose --profile full build backend
docker compose --profile full up -d backend
```

A **schema** rollback is not automatic. If the bad deploy included a
migration, restore the database (below) rather than trying to reverse it.

## Migrations

```bash
docker compose --profile migrate run --rm backend-migrate npx prisma migrate status
docker compose --profile migrate run --rm backend-migrate            # applies
```

Always `migrate status` first, and take a backup before applying anything
against production data.

## Backup and restore

Nightly via `systemd` (`cmmp-backup.timer`). Both the Postgres dump and the
music volume are verified after they are written; a failed backup exits
non-zero and shows up in `journalctl -u cmmp-backup.service`.

```bash
bash ops/backup.sh                          # manual run
bash ops/restore.sh --list                  # what is available
bash ops/restore.sh <stamp> --rehearse      # SAFE: restores to a scratch DB
bash ops/restore.sh <stamp>                 # DESTRUCTIVE: replaces live data
bash ops/restore.sh <stamp> --db-only
```

**Rehearse after every schema change, and at least monthly.** An untested
restore is not a backup. The rehearsal restores into a throwaway database,
prints the row counts, and drops it — it never touches live data.

## Incidents

**Backend will not start.** Check `docker logs cmmp-backend-1`. If it says
*"Refusing to start with placeholder secrets"*, `.env` still holds the values
published in `.env.example` — generate real ones (`openssl rand -base64 48`)
and recreate. This is intentional, not a bug.

**Portal loads but every request 401s.** Access tokens are 15 min; check the
clock. If `/ready` is 503 the database is down — `docker compose --profile
full up -d postgres`.

**Browser CORS errors.** `CORS_ALLOWED_ORIGINS` in `/opt/CMMP/.env` must
contain the portal's exact public origin, scheme and port included. Note
`backend/.env` also exists but is excluded from the image — editing it does
nothing.

**Venues showing offline after a deploy.** Expected briefly: liveness is
tracked in memory, so a restart clears it until each agent's next heartbeat
(~15s). If it persists, check the agent's own logs on the venue PC.

**Disk filling.** Logs are capped (10 MB × 3 per container). The usual
culprit is Docker build cache: `docker system prune -af --volumes` — but
**never** with `--volumes` on this host, it would delete `postgres-data`
and `music-data`. Use `docker builder prune -af` instead.

**Suspected compromise.** Rotate `JWT_ACCESS_SECRET` and
`JWT_REFRESH_SECRET` in `.env` and recreate the backend: this invalidates
every session and every media URL immediately. Then read the audit trail:
`GET /api/monitoring/audit`, or straight from the database —
`select at, "actorEmail", action, summary, ip from "AuditLog" order by at desc limit 50;`

## Scheduled work inside the backend

All in-process, all single-instance (`lib/agent-registry.ts` is memory-local,
so **do not run more than one backend replica** without moving it to Redis):

- agent heartbeat sweep — 15s, marks silent venues OFFLINE
- unpaired-server retention — 5 min
- data retention — 6 h (activity 90d, commands 90d, logs 30d, alerts 90d, audit 400d)
- orphaned-media reconcile — 24 h, 24 h grace, refuses to run if the Track table reads empty
- prayer scheduler — fires venue pauses server-side
