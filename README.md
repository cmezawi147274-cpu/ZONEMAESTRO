# Cloud Music Management Portal (CMMP)

A cloud-based management portal for a commercial, multi-zone music distribution
system. Administrators use this portal to manage a cloud music library,
distribute it to Windows-based **MusicServer** installations at each
restaurant/location, and remotely monitor and control that fleet — zones,
playlists, schedules, sync, and live status — in real time.

> **The cloud manages. The MusicServer plays.**
> This portal never plays audio in the browser. Every playback and zone
> control action is dispatched as an asynchronous remote command that a
> Windows MusicServer executes and confirms.

## Architecture

```
                    CLOUD SERVER (Ubuntu Server 26.04 LTS)
              ┌─────────────────────────────────────────┐
              │        CLOUD WEB PORTAL (this repo)      │
              │  Organizations · Locations · Music       │
              │  Library · Playlists · Scheduling ·      │
              │  Server Management · Monitoring ·        │
              │  Remote Commands                         │
              └───────────────────┬───────────────────────┘
                                  │ HTTPS REST API / WebSocket
                    ┌─────────────┼─────────────┐
                    │                           │
                    ▼                           ▼
        WINDOWS MUSIC SERVER A         WINDOWS MUSIC SERVER B
        MusicServer software           MusicServer software
              │                              │
        Local Music Cache              Local Music Cache
              │                              │
          Audio Zones                    Audio Zones
              │                              │
           Speakers                       Speakers
```

- **Cloud portal responsibilities**: upload & store music, manage metadata,
  build playlists, assign content, synchronize music to servers, monitor
  server health, receive heartbeats, send remote commands, manage server
  connections and pairing.
- **Windows MusicServer responsibilities** (not part of this repo — see
  [Backend & Windows MusicServer Integration](#backend--windows-musicserver-integration)):
  local storage/cache, audio playback, zone management, playback scheduling,
  and continuing to operate fully offline when the internet is unavailable.
- **Security**: the Windows MusicServer always initiates an **outbound**
  connection to the cloud. No inbound ports are opened on the restaurant's
  network.
- **Offline-first**: once music, playlists, zone configs and schedules are
  synced to a server, it keeps playing and following its schedule
  independently. When connectivity returns, it reconnects, sends a heartbeat,
  and synchronizes anything pending.

## Tech stack

- **Next.js 16** (App Router, Turbopack) + **TypeScript** + **React 19**
- **Tailwind CSS v4** + **shadcn/ui** (Base UI primitives)
- **TanStack Query** for all server-state data fetching/caching
- **React Hook Form + Zod** for forms and validation
- **Prisma + PostgreSQL** schema for the real backend (see below)
- **socket.io-client** wiring for the real-time gateway (mocked by an
  in-browser event bus in mock mode)
- **Docker + Docker Compose** for deployment

## Getting started

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). You'll be redirected to
`/login`. Mock mode is on by default (`NEXT_PUBLIC_USE_MOCK_API=true`), so the
portal is immediately usable with no backend — the login screen lists demo
accounts for each role (password shown on-screen).

Useful scripts:

| Command | Description |
|---|---|
| `npm run dev` | Start the dev server (Turbopack) |
| `npm run build` | Production build |
| `npm run start` | Run a production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run db:generate` / `db:migrate` | Prisma client / migrations (real backend only) |

## Mock mode

Every module in `src/lib/api/*` has a mock branch (backed by
`src/lib/mock/store.ts`, seeded from `src/lib/mock/seed.ts`) and a real branch
(backed by `src/lib/api/client.ts`, an authenticated `fetch` wrapper). The
active branch is controlled entirely by `NEXT_PUBLIC_USE_MOCK_API`:

```bash
NEXT_PUBLIC_USE_MOCK_API=true   # in-browser mock data, no backend needed
NEXT_PUBLIC_USE_MOCK_API=false  # calls NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL
```

This lets the entire UI — dashboard, organizations, servers, pairing, music
library, uploads, sync, zones, playlists, scheduling, monitoring, commands,
users — be built, demoed, and iterated on before the real backend and Windows
MusicServer agent exist. `src/lib/mock/simulate.ts` drives a background loop
that advances heartbeats, sync jobs, and command lifecycles so the live
dashboard and monitoring views feel real. No UI code changes when flipping to
`false`; only the two env vars change.

## Project structure

```
src/
  app/
    login/                  Public login page
    (portal)/               Route group behind AuthGuard + AppShell
      dashboard/            Fleet-wide KPIs, health, alerts, activity
      organizations/[id]/   Customers and their locations
      locations/[id]/       Restaurants/venues and their server + zones
      servers/[id]/         Windows MusicServer registration, pairing,
                             health, zones, sync, schedules, commands, logs
      music/                Cloud music library, upload, metadata, sync
      playlists/[id]/       Playlist builder, track ordering, assignment
      schedules/            Time-of-day playlist scheduling per zone
      sync/                 Cloud → local synchronization dashboard
      zones/                Zone transport controls (remote commands only)
      monitoring/           Real-time activity, alerts, logs
      commands/             Remote command history + ad-hoc dispatch
      users/                Role-based user management
      settings/             Profile & portal configuration
  components/               UI building blocks, grouped by feature
  hooks/                    TanStack Query hooks wrapping src/lib/api/*
  lib/
    api/                    One module per resource — client.ts, auth.ts,
                             organizations.ts, locations.ts, servers.ts,
                             zones.ts, music.ts, playlists.ts, schedules.ts,
                             sync.ts, commands.ts, monitoring.ts, dashboard.ts,
                             users.ts, types.ts
    auth/                   JWT helpers, RBAC matrix, session storage
    mock/                   Seed data, in-memory store, background simulator
    realtime/               Real-time client (mock bus / socket.io) + types
    constants.ts            Shared enums (statuses, roles, command types…)
prisma/
  schema.prisma             Data model for the real backend
proxy.ts                    Route protection (Next.js 16's renamed Middleware)
```

## Roles & permissions

| Role | Scope |
|---|---|
| `SUPER_ADMIN` | Full access across all organizations, including user management |
| `ORGANIZATION_ADMIN` | Full management of their own organization's locations, servers, music, playlists, schedules |
| `LOCATION_MANAGER` | Zone control, scheduling and sync for their assigned locations; can also invite/manage **Viewer** accounts scoped to that same location |
| `VIEWER` | Read-only access |

The permission matrix lives in `src/lib/auth/rbac.ts` and is consumed by the
`<RoleGate>` component and `useAuth().can(...)` throughout the UI.

`users:manage` is granted to `LOCATION_MANAGER`, not just `ORGANIZATION_ADMIN`
and `SUPER_ADMIN` — easy to miss reading this table alone, since it reads
like a permission a mid-tier role shouldn't hold. It's intentionally scoped
down, not a broader grant than it looks: `backend/src/routes/users.ts`
restricts a Location Manager to inviting/editing/deleting only accounts at
their own `locationId` (`visibilityWhere`), and only into a role strictly
below their own rank (`RANK`) — in practice, only **Viewer** accounts for
the venue they already manage. A Location Manager can no more create another
Location Manager, or reach a user at a different venue, than they could
before this existed.

## Prayer Mode

A central **Prayer Scheduler** (`src/lib/prayer/scheduler.ts`) can automatically
pause eligible zones for Fajr, Dhuhr, Asr, Maghrib and Isha — configured under
**Prayer Mode** in the sidebar. Sunrise is never a pausable event.

- **Location, not coordinates**: administrators pick Country → City; latitude,
  longitude and the IANA timezone are resolved internally
  (`src/lib/prayer/locations.ts`, backed by the `city-timezones` dataset,
  ~7,300 cities) and never shown in the UI. The timezone field displays a
  human label like `Dubai, United Arab Emirates (GMT+4:00)`, computed live via
  `Intl.DateTimeFormat` so it's automatically correct across DST changes.
- **Times come from AlAdhan**: `src/lib/prayer/aladhan.ts` calls the free
  [AlAdhan Prayer Times API](https://aladhan.com/prayer-times-api) directly
  from the browser (no key needed). Results are cached in `localStorage`
  (`src/lib/prayer/cache.ts`), so the schedule keeps working with zero network
  access, validates its own shape, and self-heals on corruption.
  "Today's Prayer Times" on the settings page always reads through the same
  cache-first path, so what the admin sees is exactly what will trigger a
  pause.
- **Config survives restarts**: unlike the rest of mock data (which
  intentionally resets every reload), Prayer Mode's configuration is
  persisted in `localStorage` (`src/lib/prayer/config-store.ts`) — an explicit
  requirement, since this is the one piece of state that has to outlive a
  page reload to behave like it would on an always-on MusicServer.
- **Event-driven, not polling**: the scheduler sets one `setTimeout` per
  remaining prayer today plus a single midnight-rollover timer — never an
  interval. It recomputes on config change, reconciles any event it missed
  while the tab was backgrounded (on `visibilitychange`), and retries with
  backoff if both the API and the cache come up empty.
- **Per-zone participation, one scheduler**: every zone has an independent
  `prayerModeEnabled` flag (toggle on its card, on the Zones page, or in the
  Prayer Mode zone list) but there is exactly one central scheduler for the
  whole fleet — never one per zone.
- **Pause/resume reuses the existing command system**: at `PRAYER_START` the
  scheduler snapshots each eligible *playing* zone's state and sends an
  ordinary `PAUSE` command tagged `source: "SCHEDULE"`; zones already
  stopped/paused are left untouched. At `PRAYER_END` it restores only what it
  actually paused — and only if a Super Admin hasn't overridden that zone in
  the meantime (see below).
- **Local-first, by architecture**: this scheduler runs in mock mode as the
  stand-in for local execution. In a real deployment, the Windows MusicServer
  receives the resolved configuration and runs this same decision logic
  itself, against its own cached schedule — the cloud is not required for a
  valid cached schedule to keep triggering pauses. See "Backend & Windows
  MusicServer integration" below.

## Zone control commands

Every zone transport/volume command (Play/Pause/Stop/Next/Previous/Volume/
Mute) and playlist assignment resolves **immediately** to success or an
error, for every role — Super Admin is not a special case:

- The effect is applied to the zone right away
  (`src/lib/mock/zone-effects.ts`) and the command is recorded `SUCCESS` or
  `FAILED` for audit — never left `PENDING` for the UI to poll, and there is
  no "waiting for confirmation" toast for anyone.
- If the target server is offline (or was never paired), the action is
  rejected with an error and the zone's playback/playlist is left
  untouched — nothing is queued for later delivery.
- `RemoteCommand.source` is derived server-side from the acting session
  (`src/lib/api/commands.ts`) and is never trusted from the client. It's
  used for audit and for priority against an in-progress Prayer Mode pause
  (a Super Admin action still clears `pausedByPrayer` immediately), not to
  decide whether the action is instant.
- **Stale/out-of-order protection** still applies: every zone carries a
  monotonic `commandSequence`, and an effect whose `sequence` is behind the
  zone's `lastAppliedSequence` is discarded rather than clobbering a newer
  action.

Other server-level actions (`SYNC_MUSIC`, `SYNC_CONFIG`, `RESTART_SERVICE`,
`REBOOT_SERVER`) still use the async `PENDING → SENT → EXECUTING → SUCCESS`
lifecycle described below, confirmed by the simulated agent over time
(`tickCommands` in `src/lib/mock/simulate.ts`).

## Backend & Windows MusicServer integration

This repo is the **cloud web portal**. The real backend service (REST API +
real-time gateway) and the Windows MusicServer agent are separate components
to be built against the contract this portal already assumes:

- **Auth**: `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me` —
  JWT access + refresh tokens (see `src/lib/api/auth.ts`).
- **Server pairing**: register a server (`POST /servers`) to receive a
  short-lived pairing code; the Windows agent exchanges that code for its own
  long-lived credential over an **outbound** HTTPS connection, then starts
  sending heartbeats (`lastHeartbeatAt`, CPU/RAM/disk, cached track count).
- **Sync**: tracks move `AVAILABLE_IN_CLOUD → QUEUED_FOR_SYNC → SYNCING →
  CACHED_ON_SERVER | FAILED` per server (`src/lib/api/sync.ts`,
  `src/lib/api/music.ts`).
- **Remote commands**: zone transport, volume and playlist-assignment
  commands resolve immediately — success or error — for every role, with no
  `PENDING`/`SENT`/`EXECUTING` wait (see "Zone control commands" above).
  Other server actions are created `PENDING` and only reach `SUCCESS` once
  the agent confirms execution — `PENDING → SENT → EXECUTING → SUCCESS |
  FAILED | TIMEOUT` (`src/lib/api/commands.ts`). The UI never assumes
  success on send.
- **Real-time events**: `SERVER_CONNECTED`, `SERVER_DISCONNECTED`,
  `HEARTBEAT_RECEIVED`, `ZONE_STATUS_CHANGED`, `PLAYBACK_CHANGED`,
  `MUSIC_SYNC_STARTED/COMPLETED/FAILED`, `COMMAND_COMPLETED`, `ERROR` — see
  `src/lib/realtime/types.ts`. The portal expects these over a socket.io (or a
  SignalR-to-socket.io bridge) connection at `NEXT_PUBLIC_WS_URL`.
- **Data model**: `prisma/schema.prisma` is the source of truth for the
  Postgres schema the real backend should implement.
- **Prayer Mode delivery**: the resolved `PrayerConfig` (location,
  calculation method, per-prayer offsets/pause durations, per-zone
  participation) should ship to each affected server the same way any other
  configuration change does — a `SYNC_CONFIG` command — after which the
  MusicServer computes and caches its own schedule and pauses/resumes zones
  locally, independent of the cloud connection. It reports `PRAYER_STARTED` /
  `PRAYER_ENDED` back as real-time events for the cloud's activity feed and
  logs, purely for visibility.
- **Command priority**: `RemoteCommand.source` (`USER` | `SUPER_ADMIN` |
  `SCHEDULE`) and `RemoteCommand.sequence` are part of the contract, not UI
  decoration — the backend (and the MusicServer agent) should let a
  `SUPER_ADMIN` command always override an in-flight `SCHEDULE` action, and
  discard a confirmation whose `sequence` is behind what it already applied.
  See "Super Admin Control" above.

The platform-independent transport (HTTPS REST + WebSocket) is a deliberate
choice so the backend can be implemented in any stack, and the Windows
MusicServer integration is not tied to Linux-only local-server technology.

## The local agent (`agent-bridge/`)

The cloud runs on Linux; the MusicServer PC in each restaurant runs Windows.
The compiled MusicServer software that ships in
`MusicServer-Full-Setup-Package` plays audio well but does not speak this
system's cloud protocol — its Setup UI has **no field for a CMMP pairing
code**, and its Zones page has no **Previous** (the local API it drives has no
such action at all, and its Skip fails at the end of a queue).

`agent-bridge/` is the process that closes that gap on the restaurant PC. It
speaks the agent protocol above to the cloud, drives the MusicServer's own
local REST API on `127.0.0.1:8765` to produce real playback, and serves its
own control panel at `http://127.0.0.1:8899`:

- **Cloud setup** — paste the pairing code from **Location → Register
  Server**; pairing takes effect immediately, with no restart.
- **Zones** — Previous / Play / Pause / Stop / Next / volume / mute per zone,
  with the zone's synced queue. Previous and end-of-queue Next are implemented
  in the agent against the zone's ordered queue, since the local service
  cannot do either.
- **Activity** — live log of pairing, heartbeats, commands and music sync.

It is plain Node with no dependencies and runs on Windows and Linux alike.
See `agent-bridge/README.md`.

## Deploying to Ubuntu Server 26.04 LTS

### 1. Prerequisites

```bash
sudo apt update && sudo apt install -y ca-certificates curl gnupg
# Docker Engine + Compose plugin
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

### 2. Get the code onto the server

```bash
git clone <your-repo-url> cmmp
cd cmmp
```

### 3. Configure environment

```bash
cp .env.example .env
nano .env
```

At minimum for a **mock-mode demo deployment**, the defaults work as-is. For a
**production deployment against a real backend**, set:

```bash
NEXT_PUBLIC_USE_MOCK_API=false
NEXT_PUBLIC_API_URL=https://api.your-domain.com/api
NEXT_PUBLIC_WS_URL=wss://api.your-domain.com/realtime
POSTGRES_PASSWORD=<strong random value>
JWT_ACCESS_SECRET=<openssl rand -base64 48>
JWT_REFRESH_SECRET=<openssl rand -base64 48>
STORAGE_SECRET_ACCESS_KEY=<strong random value>
```

### 4. Build and run

```bash
# Portal only, mock data — no backend or database needed
docker compose up -d --build

# The real cloud: portal + backend + Postgres
GIT_COMMIT=$(git rev-parse --short HEAD) docker compose --profile full up -d --build

# Apply database migrations (and, on a fresh database, seed the first admin)
docker compose --profile migrate run --rm backend-migrate
docker compose --profile migrate run --rm backend-migrate npm run db:seed
```

For the `full` profile, set `NEXT_PUBLIC_USE_MOCK_API=false` in `.env` before
building — those `NEXT_PUBLIC_*` values are inlined into the client bundle at
build time, so changing them later requires a rebuild, not just a restart.
The backend image is exactly the same way: a code change (like an edit to
anything under `backend/src`) takes no effect until it's rebuilt into a new
image and the container is recreated — restarting the existing container,
or merely committing the change, does neither. `GIT_COMMIT` above (optional,
defaults to `unknown`) bakes the exact commit into the image so this is
verifiable afterward instead of assumed — see `/health` below.

The portal listens on `3000` and the backend on `4000` by default (`APP_PORT`
and `BACKEND_PORT` in `.env`). Verify — `commit` should match
`git rev-parse --short HEAD` on this checkout; if it doesn't, the container
is stale and needs the build+recreate step above run again:

```bash
docker compose ps
curl -I http://localhost:3000
curl http://localhost:4000/health   # {"ok":true,"commit":"<short sha>"}
```

Uploaded audio lives in the `music-data` volume and is served to each Windows
MusicServer from `<PUBLIC_API_URL>/media/music/<key>`; back that volume up
along with `postgres-data`.

### 5. Put it behind HTTPS

Run a reverse proxy (Caddy, Nginx, or Traefik) in front of the container for
TLS termination and your domain name. Example with Nginx + Certbot:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo tee /etc/nginx/sites-available/cmmp <<'EOF'
server {
  listen 80;
  server_name portal.your-domain.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
EOF
sudo ln -s /etc/nginx/sites-available/cmmp /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d portal.your-domain.com
```

### 6. Keep it updated

```bash
git pull
docker compose up -d --build
```

### 7. Database migrations

`backend/prisma/schema.prisma` is the source of truth for the Postgres schema,
and it belongs to the **backend** service — the portal's production image
bundles no Prisma CLI. Under Docker, migrations run through the one-shot
`backend-migrate` service shown in step 4 (it builds the backend image's
`builder` stage, the only one carrying the CLI). Outside Docker, from a
checkout on the backend host:

```bash
cd backend && npm ci && npm run db:migrate
```

## Security notes

- Never commit a populated `.env`/`.env.local` — only `.env.example` is
  tracked.
- Mock mode signs demo JWTs **client-side** with a well-known development
  secret purely to exercise the access/refresh-token UX; this is explicitly
  not secure and is never used once `NEXT_PUBLIC_USE_MOCK_API=false` (see
  `src/lib/auth/jwt.ts`). A real deployment issues tokens from the server and
  should set them as `httpOnly`, `Secure`, `SameSite` cookies.
- `proxy.ts` performs a fast, optimistic redirect based on session-cookie
  presence — it is not the source of truth for authorization. Every
  data-fetching hook and the RBAC matrix (`src/lib/auth/rbac.ts`) are the
  real enforcement points, and a real backend must re-check permissions
  server-side on every request.
- Windows MusicServer pairing codes are short-lived and single-use by design
  (`src/lib/api/servers.ts`); the real backend should hash and expire them
  server-side, matching `prisma/schema.prisma`'s `pairingCodeHash` /
  `pairingExpiresAt`.

## License

Proprietary — internal project scaffold.
