# CMMP Backend

Real REST + realtime backend for the Cloud Music Management Portal, replacing
mock mode. Implements every route `src/lib/api/*` calls when
`NEXT_PUBLIC_USE_MOCK_API=false`, using the Prisma schema in
`prisma/schema.prisma` against a dedicated PostgreSQL 16+ database (never the
Music Server's own Postgres on 5433).

**This backend is the cloud.** It runs on Linux and owns Postgres, the music
file storage, the CMMP portal's REST + socket.io API, *and* the Windows
MusicServer agent protocol below — all on one box, reachable from the
internet. The compiled win-x64 `MusicServer.Api` service on each restaurant
PC is a **client** of this backend: it always initiates outbound HTTPS, so no
inbound port is ever opened on the restaurant network. This backend is never
a client of `http://127.0.0.1:5090` — that loopback address is the agent's
*own* local API (used for its bundled phone-app "cloud" link and its local
Setup UI at `:8765`), a separate, optional surface this backend does not
depend on. See `MUSIC_SERVER_AGENT_ALLOWED`/`PUBLIC_API_URL` below and the
top-level README's "Backend & Windows MusicServer integration" section.

Zone transport commands (PLAY/PAUSE/STOP/NEXT/PREVIOUS/SET_VOLUME/MUTE/
UNMUTE) are dispatched to the paired agent and fail immediately with
"`<name> is offline.`" if it isn't connected — never faked, never left
`PENDING`. See "Windows MusicServer agent protocol" below.

## Prerequisites

- Node 22+
- PostgreSQL 16+ reachable at the `DATABASE_URL` in `.env` (default:
  `postgresql://cmmp:cmmp_dev@127.0.0.1:5432/cmmp?schema=public`, a
  dedicated database/role — create them once if they don't exist yet:
  ```sql
  CREATE ROLE cmmp LOGIN PASSWORD 'cmmp_dev';
  CREATE DATABASE cmmp OWNER cmmp;
  ```

## Setup

```bash
cd backend
npm install
npm run db:migrate:dev   # creates the schema (first run) / applies new migrations
npm run db:seed          # seeds SUPER_ADMIN + "Golden Fork" org + Dubai location
npm run dev              # tsx watch src/index.ts, listens on 0.0.0.0:4000
```

For a non-dev deploy: `npm run db:migrate` (applies existing migrations,
no prompts) then `npm run build && npm run start` — `start` runs the compiled
`dist/index.js`, so the build is not optional (`npm run start:tsx` runs the
TypeScript sources directly if you want that instead).

### Docker

`backend/Dockerfile` builds a production image (Prisma client generated,
TypeScript compiled, dev dependencies dropped), and the repo's
`docker-compose.yml` runs it next to the portal and Postgres:

```bash
docker compose --profile full up -d --build
docker compose --profile migrate run --rm backend-migrate            # migrate
docker compose --profile migrate run --rm backend-migrate npm run db:seed
```

Uploaded audio lives in the `music-data` volume (`MUSIC_STORAGE_DIR`), which
is what `/media/music/<storageKey>` serves to each Windows agent.

## Seeded demo login

- Email: `alex.chen@cmmp.example`
- Password: `cmmp-demo-2026`
- Role: `SUPER_ADMIN`
- Also seeds organization **Golden Fork** with one location in Dubai
  (`Asia/Dubai`).

## Portal configuration

In the portal's `.env.local`:

```
NEXT_PUBLIC_USE_MOCK_API=false
NEXT_PUBLIC_API_URL=http://127.0.0.1:4000/api
NEXT_PUBLIC_WS_URL=http://127.0.0.1:4000/realtime
```

## Notes

- REST is mounted at `/api`; socket.io shares the same HTTP server on the
  default engine.io path, serving the `/realtime` namespace the portal's
  `socket.io-client` connects to (event name `"event"`, payload
  `{ type, serverId?, zoneId?, timestamp, data }`). Browsers never touch the
  agent surface below or the `/hubs/musicserver` WebSocket.
- JWT access tokens (15m) + refresh tokens (30d, rotated & revocable, stored
  hashed in `RefreshToken`).
- Uploaded audio files are stored under `backend/data/music/`, served at
  `/media/music/<storageKey>` (the URL the agent downloads tracks from).
- Errors are always `{ status, code, message }`.

## Windows MusicServer agent protocol

Everything below is called **by** the Windows agent, over outbound HTTPS —
this backend never opens a connection to a restaurant PC. Mounted at
`AGENT_API_PREFIX` (default `/api`, matching the paths the compiled agent
was observed calling when black-box probed on this LAN — see
`src/routes/agent.ts` for the exact request/response shapes). Disable the
whole surface with `MUSIC_SERVER_AGENT_ALLOWED=false` without touching the
portal API.

| Route | Purpose |
| --- | --- |
| `POST /api/pairing/complete` | Exchange a CMMP-issued pairing code (`POST /servers` from the portal) for a long-lived agent token. |
| `POST /api/server/token` | Rotate/refresh that token. |
| `POST /api/server/heartbeat` | CPU/RAM/disk + cached-track counters; drives `status`/`lastHeartbeatAt` and `SERVER_CONNECTED`/`HEARTBEAT_RECEIVED`. |
| `GET /api/server/commands/pending` | Poll for queued commands (`PENDING`→`SENT` on read). |
| `POST /api/server/commands/ack` | Report `EXECUTING`/`SUCCESS`/`FAILED`/`TIMEOUT`, optionally with the zone's real state. |
| `POST /api/server/tracks/sync` | Report cached track ids; receive the list still `QUEUED_FOR_SYNC` with download URLs under `/media/music/`. |
| `POST /api/server/zones/sync` | Report local zones; get back stable CMMP zone ids (`Zone.localZoneId` mapping, see `prisma/schema.prisma`). |
| `POST /api/server/zone-playlists/sync` | Pull each zone's assigned playlist + track order to pre-cache. |
| `GET /api/server/schedules` | Pull Prayer Mode / playlist schedules for this server's zones, computed and run locally thereafter. |
| `wss://.../hubs/musicserver` | `MusicServerHub` — a minimal SignalR-JSON-protocol-compatible push channel (`src/agent/signalrHub.ts`) that nudges an already-connected agent instead of waiting for its next poll. The REST routes above stay authoritative; an agent that never opens this socket still works correctly off polling alone. Authenticate with `?access_token=<agentToken>` on the WebSocket URL. |

All agent routes (except `pairing/complete`) require `Authorization: Bearer
<agentToken>` — a different, opaque, long-lived credential from the portal's
JWTs, minted at pairing and never exposed to the browser.

**"Connected"**, for the purpose of the portal's zone transport commands
waiting up to `AGENT_COMMAND_ACK_TIMEOUT_MS` (default 3000ms) for an ack, means
a heartbeat or open `MusicServerHub` socket within
`SERVER_HEARTBEAT_INTERVAL_SECONDS × SERVER_OFFLINE_AFTER_MISSED_BEATS`
seconds (`src/lib/agent-registry.ts`). A background sweep
(`src/lib/agent-sweep.ts`) flips a server to `OFFLINE` and emits
`SERVER_DISCONNECTED` once that window lapses with no heartbeat.

### The Windows-side setting to change

Nothing on the Windows box needs reinstalling — one config value repoints it
at this backend instead of its own loopback API:

```
C:\Program Files\Music Server\Service\appsettings.json
```

```json
{
  "Cloud": {
    "ApiBaseUrl": "https://api.your-domain.com",
    "HeartbeatIntervalSeconds": 15,
    "ReconnectDelaySeconds": 5,
    "Enabled": true
  }
}
```

`ApiBaseUrl` must be a real address for **this Linux backend** — never
`http://127.0.0.1:5090` in production (that only works for the
same-machine test below, where the "Linux backend" and the Windows agent
happen to be reachable via the same PC's LAN IP). Restart the "Music
Server" Windows service after editing. Pair first from the CMMP portal
(`POST /servers` → pairing code → Windows Setup at `:8765` → paste the
code), then the agent starts heartbeating to whatever `ApiBaseUrl` now
points at.

### Today, same-machine test (optional)

If a Windows MusicServer install and this backend are on the same LAN and
Postgres isn't reachable from a real Linux box yet:

1. `npm run dev` here — it already binds `0.0.0.0:${PORT}` (default 4000).
2. Find this PC's LAN IP (`ipconfig`), e.g. `192.168.0.100`.
3. Set `Cloud.ApiBaseUrl` in the Windows `appsettings.json` above to
   `http://192.168.0.100:4000` — **not** `127.0.0.1:5090` (that's the
   agent's own local API, not this backend) and not `127.0.0.1:4000` unless
   the backend and the agent really are the same machine.
4. Create a server from the portal, pair with the code Windows Setup
   requests, then confirm a Play/Pause from the portal reaches the agent
   within the 3s ack window.
