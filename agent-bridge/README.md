# CMMP Agent Bridge

The local half of the system: the process that connects one restaurant's
**MusicServer** PC to the CMMP cloud, and the control panel a technician
uses on that PC.

## Why this exists

The compiled Windows agent shipped in `MusicServer-Full-Setup-Package`
(`MusicServer.Api.exe`, running as the `MusicServer` Windows service plus
`MusicServer.Service.exe` / `MusicServer.PlaybackHost.exe`) does **not**
implement the CMMP cloud-pairing protocol that `backend/README.md`
describes. Confirmed by inspection and live probing, not guesswork:

- The Setup UI at `http://127.0.0.1:8765` has no field to paste a
  CMMP-issued pairing code — its only "cloud" section is **Mobile app
  account**, which links a phone to this PC's own loopback API and
  explicitly says "no pairing codes".
- `MusicServer.Service.exe`'s `appsettings.json` has a `Cloud.ApiBaseUrl`
  setting, but nothing observed calls CMMP's `/api/pairing/complete` —
  pointing it at CMMP does not make the server appear in the portal.
- Its Zones page has Play / Stop / Skip and **no Previous**; the local
  API backing it genuinely has no such action (`POST
  /api/zones/:id/previous` → `404 Unknown action: previous`), and its
  `skip` returns `503 No next song in this zone's playlist.` on the last
  track of a queue.
- There is no C# source for any of these binaries anywhere on this
  machine, so none of that can be fixed in place.

What *is* real and working: the local Setup UI's own REST API on
`:8765/api/*` (zones, tracks, library, playback) genuinely controls
LibVLC playback on this PC. And the CMMP backend's agent protocol
(`backend/src/routes/agent.ts`) is fully implemented.

This process bridges the two, and serves its own control panel that
closes both UI gaps.

## What it gives you

| | |
| --- | --- |
| **Control panel** | `http://127.0.0.1:8899` — Zones, Cloud setup, Activity |
| **Pairing** | Paste a CMMP pairing code in **Cloud setup**; pairing takes effect immediately, no restart, no file editing |
| **Zone transport** | Previous / Play / Pause / Stop / Next / volume / mute, per zone, with the zone's synced queue and current position |
| **Cloud sync** | Heartbeat, zone sync, music download, playlist assignment, remote command execution |

Everything the panel does is the same code path the cloud drives, so a
Next pressed in the portal and a Next pressed on the panel do exactly the
same thing.

### Previous and end-of-queue Next

The local service has no `previous` action at all, and refuses `skip` at
the end of a queue. Both are implemented in `lib/local-api.js` against
the zone's own ordered queue:

- **Previous** — step back one entry from the zone's current track
  (wrapping to the last entry when it is on the first, or when nothing is
  loaded) and play it explicitly by track id.
- **Next** — prefer the local `skip` so the service's own bookkeeping
  stays authoritative, and fall back to an explicit play of the following
  queue entry (wrapping at the end) when `skip` refuses.

## Setup

Requires Node 18+. Runs unchanged on Windows and Linux — plain Node, no
dependencies.

```bash
cd agent-bridge
cp .env.example .env      # optional; the defaults work
node bridge.js
```

Then open <http://127.0.0.1:8899>:

1. **Cloud setup** → enter the Cloud API URL and the pairing code from
   CMMP (Location → **Register Server**), then **Pair with cloud**.
2. The agent starts heartbeating, syncing music and executing commands
   right away. **Zones** shows the zones on this machine with full
   transport.

For unattended installs, put `PAIRING_CODE=XXXX-XXXX` in `.env` and the
agent pairs on first start without anyone opening the panel.

The agent token and cloud URL are cached in `agent-state.json`
(gitignored). **Unpair from cloud** in the panel clears the credential
but deliberately keeps the record of which tracks are already downloaded
— those files are still on disk, and forgetting them would re-download
everything and litter the music folder with duplicates. That record is
discarded only when the machine is paired to a *different* server.

## Keeping it running

The agent must be running for the PC to receive music and commands, so it
should start with the machine — not be launched by hand.

- **Windows** — `Start-Agent.cmd` starts it and opens the panel. Put a
  shortcut to it in `shell:startup`, or register it with Task Scheduler
  ("Run whether user is logged on or not") or NSSM for a real service.
- **Linux** — `cmmp-agent.service` is a ready systemd unit:
  ```bash
  sudo cp cmmp-agent.service /etc/systemd/system/
  sudo systemctl enable --now cmmp-agent
  ```

## What it actually does

| Loop | Interval | Real effect |
| --- | --- | --- |
| Heartbeat | server-specified (default 15s) | `MusicServer.status` flips to `ONLINE` in CMMP |
| Zone sync | every heartbeat | Local zones (from `:8765/api/zones`) appear as CMMP `Zone` rows |
| Command poll + exec | 1.5s | `PLAY/PAUSE/STOP/NEXT/PREVIOUS/SET_VOLUME/MUTE/UNMUTE` from CMMP call the matching local action, then ack CMMP with the real resulting state; `SYNC_MUSIC`/`SYNC_CONFIG` run a sync pass on demand |
| Track sync | 20s | Downloads any track CMMP has queued from `/media/music/<key>` into the local music folder, triggers `:8765/api/library/scan`, reports it cached, and records the CMMP-track-id → local-track-GUID mapping |
| Zone playlist sync | 20s (+ after every track sync) | Pushes each zone's CMMP-assigned playlist into that zone's own local queue, additive only |

Downloaded files are named `Artist - Title.mp3` rather than by CMMP id,
so an untagged upload still shows a readable name in the local library
instead of an opaque `cmtms0ndc000xtxks08cxij6y`.

The state reported back to CMMP after each command translates the local
track GUID into the **CMMP** track id. That matters: the cloud matches
`Zone.currentTrackId` against its own playlist to decide what Next and
Previous mean, so reporting a local GUID would leave it permanently
unable to tell where the zone is.

## Limitations

- `RESTART_SERVICE` and `REBOOT_SERVER` are ack'd `FAILED` with an
  explanation. This agent runs beside the compiled MusicServer service
  and cannot restart it or the machine; acking success would be a lie.
- Schedules (`GET /server/schedules`) are implemented on the CMMP side
  but not yet pulled/enforced here — Prayer Mode and scheduled playlist
  switches issued as explicit commands work, but time-based scheduling
  that keeps running with the cloud unreachable does not.
- Whether a zone produces **audible sound** depends on this machine
  having a working audio output device. When the device a zone is bound
  to is asleep or unplugged, the local service reports
  `DeviceUnavailable` and the panel shows it in red; the cloud sees the
  zone as `OFFLINE`.
- The control panel has no authentication and binds to loopback. Do not
  expose it on the LAN without putting something in front of it.
