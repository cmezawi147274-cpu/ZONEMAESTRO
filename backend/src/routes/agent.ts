/**
 * Windows MusicServer agent surface — the outbound-only protocol the
 * compiled win-x64 MusicServer.Api service (never decompiled/rewritten
 * here, per the freeze) calls once its `Cloud.ApiBaseUrl` points at this
 * backend. Mounted at `env.agentApiPrefix` (default "/api", matching the
 * paths observed by black-box probing the installed agent's own local API
 * surface on this LAN — see backend/README.md "Windows agent protocol").
 *
 * Entirely separate from the browser-facing routes in ../routes/*.ts:
 * agents authenticate with a long-lived opaque bearer token
 * (lib/agent-auth.ts), never a portal JWT, and every route here is a
 * no-op (503) when `MUSIC_SERVER_AGENT_ALLOWED=false`.
 */
import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { prisma } from "../lib/db.js"
import { env } from "../lib/env.js"
import { badRequest, notFound, HttpError } from "../lib/http-error.js"
import { requireAgent, generateAgentToken, sha256Hex } from "../lib/agent-auth.js"
import { hashPairingCode, normalizePairingCode } from "../lib/pairing.js"
import { seededShuffle } from "../lib/shuffle.js"
import { markAgentSeen, resolveAck, forgetAgent } from "../lib/agent-registry.js"
import { emitEvent } from "../realtime.js"
import { pushActivity } from "../lib/activity.js"
import { MUSIC_SERVER_HUB_PATH } from "../agent/signalrHub.js"
import { isValidTimeZone } from "../lib/geo.js"
import { signedMediaUrl } from "../lib/media-url.js"
import { ZONE_TRANSPORT_TYPES } from "./commands.js"
import { ZONE_EFFECT_FIELD } from "../lib/zone-effects.js"
import type { CommandStatus, ZonePlaybackState } from "@prisma/client"

/** ASP.NET model binding is case-insensitive; the compiled agent's own
 * JSON casing was never decompiled, so every field this route reads is
 * looked up case-insensitively against a short list of aliases instead of
 * assuming one exact casing. */
function field(body: Record<string, unknown>, ...names: string[]): unknown {
  const lower = new Map(Object.entries(body).map(([k, v]) => [k.toLowerCase(), v]))
  for (const name of names) {
    const v = lower.get(name.toLowerCase())
    if (v !== undefined) return v
  }
  return undefined
}
function str(body: Record<string, unknown>, ...names: string[]): string | undefined {
  const v = field(body, ...names)
  return typeof v === "string" && v.length > 0 ? v : undefined
}
function num(body: Record<string, unknown>, ...names: string[]): number | undefined {
  const v = field(body, ...names)
  return typeof v === "number" ? v : undefined
}
function bool(body: Record<string, unknown>, ...names: string[]): boolean | undefined {
  const v = field(body, ...names)
  return typeof v === "boolean" ? v : undefined
}

/** Only a timezone Intl actually accepts is stored — a typo or a Windows
 * zone name that slipped through must not poison prayer calculations. */
function validTimeZoneOrNull(value: string | undefined): string | null {
  return isValidTimeZone(value) ? value : null
}

/**
 * Latitude/longitude are optional and only honored as a matched, in-range
 * pair. 0,0 is rejected outright: it is the classic "unset GPS" reading,
 * and treating it as a real fix is exactly the bug that had prayer times
 * being calculated for a point in the Atlantic.
 */
function coordinateUpdate(
  body: Record<string, unknown>,
  server: { reportedLatitude: number | null; reportedLongitude: number | null }
): { reportedLatitude?: number; reportedLongitude?: number } {
  const latitude = num(body, "latitude", "lat")
  const longitude = num(body, "longitude", "lng", "lon")
  if (latitude === undefined || longitude === undefined) return {}
  if (latitude === 0 && longitude === 0) return {}
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return {}
  if (latitude === server.reportedLatitude && longitude === server.reportedLongitude) return {}
  return { reportedLatitude: latitude, reportedLongitude: longitude }
}

async function localZoneIdOf(zoneId: string | null): Promise<string | null> {
  if (!zoneId) return null
  const zone = await prisma.zone.findUnique({ where: { id: zoneId }, select: { localZoneId: true } })
  return zone?.localZoneId ?? zoneId
}

const ZONE_STATE_MAP: Record<string, ZonePlaybackState> = {
  PLAYING: "PLAYING",
  PAUSED: "PAUSED",
  STOPPED: "STOPPED",
  OFFLINE: "OFFLINE",
}

export default async function agentRoutes(app: FastifyInstance) {
  const p = env.agentApiPrefix.replace(/\/$/, "")

  app.addHook("preHandler", async () => {
    if (!env.musicServerAgentAllowed) throw new HttpError(503, "AGENT_DISABLED", "Windows MusicServer agent integration is disabled on this backend.")
  })

  // --------------------------------------------------------------------
  // Pairing: technician types a CMMP-issued code (POST /servers) into
  // Windows Setup at :8765; the agent exchanges it here for its
  // long-lived credential. Outbound-only — no inbound port ever opens on
  // the restaurant network.
  // --------------------------------------------------------------------
  app.post<{ Body: Record<string, unknown> }>(
    `${p}/pairing/complete`,
    // A pairing code is 8 characters from a 32-symbol alphabet. Brute force
    // over HTTP was never practical, but nothing capped attempts either —
    // which also made this a free denial-of-service surface.
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
    const body = request.body ?? {}
    const code = str(body, "code")
    if (!code) throw badRequest("The Code field is required.")
    const agentServerGuid = str(body, "serverGuid", "agentServerGuid") ?? randomUUID()
    const serverVersion = str(body, "serverVersion", "version")
    const os = str(body, "os", "operatingSystem") ?? "Windows"
    const siteId = str(body, "siteId")
    const ipAddress = (request.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? request.ip

    const server = await prisma.musicServer.findFirst({
      where: { pairingCodeHash: hashPairingCode(normalizePairingCode(code)), pairingExpiresAt: { gt: new Date() } },
    })
    if (!server) throw badRequest("Invalid or expired pairing code.")

    const agentToken = generateAgentToken(server.id)
    const now = new Date()
    const updated = await prisma.musicServer.update({
      where: { id: server.id },
      data: {
        agentTokenHash: sha256Hex(agentToken),
        pairedAt: now,
        lastHeartbeatAt: now,
        status: "ONLINE",
        version: serverVersion ?? server.version,
        os,
        ipAddress,
        pairingCode: null,
        pairingCodeHash: null,
        pairingExpiresAt: null,
      },
    })
    await prisma.agentLink.upsert({
      where: { cmmpServerId: server.id },
      create: { cmmpServerId: server.id, agentServerGuid, siteId: siteId ?? null, lastSeenAt: now },
      update: { agentServerGuid, siteId: siteId ?? null, lastSeenAt: now },
    })

    // An agent re-pairing to a different server row leaves its old row
    // holding a token nothing will use again — a permanently OFFLINE
    // duplicate in the portal. Release it here.
    const previousServerId = str(body, "previousServerId")
    if (previousServerId && previousServerId !== server.id) {
      const previous = await prisma.musicServer.findUnique({ where: { id: previousServerId } })
      if (previous && previous.organizationId === server.organizationId) {
        await prisma.musicServer.update({
          where: { id: previous.id },
          data: { agentTokenHash: null, pairedAt: null, status: "UNKNOWN" },
        })
        forgetAgent(previous.id)
        await pushActivity({
          type: "SERVER_DISCONNECTED",
          message: `${previous.name} released — its agent re-paired to ${updated.name}.`,
          serverId: previous.id,
        })
      }
    }

    markAgentSeen(server.id)
    await pushActivity({ type: "SERVER_CONNECTED", message: `${updated.name} paired and connected.`, serverId: server.id })

    return reply.status(201).send({
      agentToken,
      serverId: server.id,
      locationId: updated.locationId,
      heartbeatIntervalSeconds: env.agentHeartbeatIntervalSeconds,
      musicServerHubUrl: `${env.publicApiUrl}${MUSIC_SERVER_HUB_PATH}`,
    })
    }
  )

  // --------------------------------------------------------------------
  // Token rotation — an already-paired agent can mint a fresh token
  // without a human re-running pairing (e.g. after a credential wipe).
  // --------------------------------------------------------------------
  app.post(`${p}/server/token`, async (request, reply) => {
    const ctx = await requireAgent(request)
    const agentToken = generateAgentToken(ctx.serverId)
    await prisma.musicServer.update({ where: { id: ctx.serverId }, data: { agentTokenHash: sha256Hex(agentToken) } })
    markAgentSeen(ctx.serverId)
    return reply.send({ agentToken })
  })

  // --------------------------------------------------------------------
  // Heartbeat: CPU/RAM/disk + cached-track counters, every
  // HeartbeatIntervalSeconds. Drives MusicServer.status /
  // lastHeartbeatAt and the SERVER_CONNECTED / HEARTBEAT_RECEIVED /
  // SERVER_DISCONNECTED realtime events (SERVER_DISCONNECTED itself is
  // emitted by the sweep in ../lib/agent-sweep.ts once heartbeats stop).
  // --------------------------------------------------------------------
  app.post<{ Body: Record<string, unknown> }>(`${p}/server/heartbeat`, async (request, reply) => {
    const ctx = await requireAgent(request)
    const body = request.body ?? {}
    if (str(body, "serverVersion") === undefined) throw badRequest("The ServerVersion field is required.")

    const wasOffline = ctx.server.status === "OFFLINE" || ctx.server.status === "UNKNOWN"
    const reportedTimezone = validTimeZoneOrNull(str(body, "timezone", "timeZone"))
    const updated = await prisma.musicServer.update({
      where: { id: ctx.serverId },
      data: {
        status: "ONLINE",
        lastHeartbeatAt: new Date(),
        version: str(body, "serverVersion") ?? ctx.server.version,
        cpuPercent: num(body, "cpuPercent") ?? ctx.server.cpuPercent,
        ramPercent: num(body, "ramPercent") ?? ctx.server.ramPercent,
        diskPercent: num(body, "diskPercent") ?? ctx.server.diskPercent,
        diskFreeGb: num(body, "diskFreeGb") ?? ctx.server.diskFreeGb,
        diskTotalGb: num(body, "diskTotalGb") ?? ctx.server.diskTotalGb,
        cachedTracks: num(body, "cachedTracks") ?? ctx.server.cachedTracks,
        cachedSizeGb: num(body, "cachedSizeGb") ?? ctx.server.cachedSizeGb,
        ipAddress: str(body, "ipAddress") ?? ctx.server.ipAddress,
        autoBootEnabled: bool(body, "autoBootEnabled") ?? ctx.server.autoBootEnabled,
        // The venue PC's own IANA timezone — what Prayer Mode fires on.
        // Only accepted if Intl recognizes it, so a malformed value can
        // never reach the date math (lib/prayer-location.ts).
        reportedTimezone: reportedTimezone ?? ctx.server.reportedTimezone,
        // Stamped only when a *usable* timezone actually arrived on this
        // beat, so the portal's pill can tell "reporting now" from "reported
        // once, weeks ago" — an ordinary heartbeat must not refresh it.
        ...(reportedTimezone ? { reportedLocationAt: new Date() } : {}),
        // Coordinates are only ever stored when the agent genuinely knows
        // them. An agent that doesn't send them leaves these null, and the
        // venue's city is looked up instead — 0,0 is never written here.
        ...coordinateUpdate(body, ctx.server),
      },
    })
    markAgentSeen(ctx.serverId)

    if (wasOffline) {
      await pushActivity({ type: "SERVER_CONNECTED", message: `${updated.name} connected.`, serverId: ctx.serverId })
    } else {
      emitEvent({ type: "HEARTBEAT_RECEIVED", serverId: ctx.serverId, data: { lastHeartbeatAt: updated.lastHeartbeatAt } })
    }

    const pendingCount = await prisma.remoteCommand.count({ where: { serverId: ctx.serverId, status: { in: ["PENDING", "SENT"] } } })
    return reply.send({ ok: true, serverTimeUtc: new Date().toISOString(), pendingCommands: pendingCount })
  })

  // --------------------------------------------------------------------
  // Pending commands — the authoritative delivery path. MusicServerHub
  // (agent/signalrHub.ts) can nudge an already-connected agent to poll
  // sooner, but every command is always retrievable here regardless.
  // --------------------------------------------------------------------
  app.get(`${p}/server/commands/pending`, async (request, reply) => {
    const ctx = await requireAgent(request)
    markAgentSeen(ctx.serverId)
    const commands = await prisma.remoteCommand.findMany({
      where: { serverId: ctx.serverId, status: { in: ["PENDING", "SENT"] } },
      orderBy: { issuedAt: "asc" },
    })
    const now = new Date()
    await prisma.remoteCommand.updateMany({
      where: { id: { in: commands.filter((c) => c.status === "PENDING").map((c) => c.id) } },
      data: { status: "SENT", sentAt: now },
    })
    const items = await Promise.all(
      commands.map(async (c) => ({
        commandId: c.id,
        type: c.type,
        zoneId: await localZoneIdOf(c.zoneId),
        payload: c.payload ?? undefined,
        sequence: c.sequence,
        issuedAt: c.issuedAt.toISOString(),
      }))
    )
    return reply.send({ commands: items })
  })

  // --------------------------------------------------------------------
  // Command ack — advances PENDING/SENT -> EXECUTING -> SUCCESS|FAILED|
  // TIMEOUT, and (for zone transport commands) resolves the in-memory
  // waiter a portal request is blocked on (see ../lib/agent-registry.ts,
  // used from ../routes/commands.ts).
  // --------------------------------------------------------------------
  app.post<{ Body: Record<string, unknown> }>(`${p}/server/commands/ack`, async (request, reply) => {
    const ctx = await requireAgent(request)
    const body = request.body ?? {}
    const commandId = str(body, "commandId")
    const status = str(body, "status")?.toUpperCase() as CommandStatus | undefined
    if (!commandId || !status) throw badRequest("commandId and status are required.")
    if (!["EXECUTING", "SUCCESS", "FAILED", "TIMEOUT"].includes(status)) throw badRequest("Invalid status.")

    const command = await prisma.remoteCommand.findUnique({ where: { id: commandId } })
    if (!command || command.serverId !== ctx.serverId) throw notFound("Command")

    // A command already in a terminal state (the cloud gave up and recorded
    // TIMEOUT, or a duplicate/delayed ack repeats a status already
    // recorded) must not be re-resolved by an ack that arrives after the
    // fact. Root cause this closed off: SET_EQ writes straight to
    // EqualizerAPO's config.txt, and firing one from the portal while the
    // Windows side is still mid-write/reload on a *previous* one throws
    // EBUSY there; the agent's own retry-with-backoff can then run long
    // enough that its eventual SUCCESS ack lands after the cloud's ack
    // wait already expired and recorded TIMEOUT. Before this check, that
    // late ack silently flipped the row to SUCCESS — and since a
    // SUCCESS ack usually carries no resultMessage of its own, the `??`
    // fallback below kept the *TIMEOUT's* "No response ... within Xms"
    // text attached to a status that now claimed to have worked. Found by
    // querying the command history: 22 rows married exactly that
    // contradiction. The real fix (serializing/atomically writing
    // config.txt) belongs on the Windows side; this only stops the cloud
    // from lying about which one actually happened.
    if (["SUCCESS", "FAILED", "TIMEOUT"].includes(command.status)) {
      markAgentSeen(ctx.serverId)
      return reply.send({ ok: true, note: "Command already resolved; this ack was not applied." })
    }

    const resultMessage = str(body, "resultMessage") ?? null
    const now = new Date()
    const updated = await prisma.remoteCommand.update({
      where: { id: commandId },
      data: {
        status,
        executingAt: status === "EXECUTING" ? now : command.executingAt,
        completedAt: status === "SUCCESS" || status === "FAILED" || status === "TIMEOUT" ? now : command.completedAt,
        resultMessage: resultMessage ?? command.resultMessage,
      },
    })

    const zoneStateRaw = field(body, "zoneState")
    if (updated.zoneId && status === "SUCCESS" && zoneStateRaw && typeof zoneStateRaw === "object") {
      const zoneState = zoneStateRaw as Record<string, unknown>
      const data: Record<string, unknown> = {}
      const volume = num(zoneState, "volume")
      if (volume !== undefined) data.volume = volume
      const muted = field(zoneState, "muted")
      if (typeof muted === "boolean") data.muted = muted
      const playbackState = str(zoneState, "playbackState")
      if (playbackState && ZONE_STATE_MAP[playbackState.toUpperCase()]) data.playbackState = ZONE_STATE_MAP[playbackState.toUpperCase()]
      const currentTrackId = str(zoneState, "currentTrackId")
      if (currentTrackId) data.currentTrackId = currentTrackId
      // The agent's zoneState read-back (agent-bridge/lib/agent.js
      // readBackZoneState) never reports the equalizer — EqualizerAPO's
      // config.txt has no "what's currently applied" query, only a write
      // path — so it's carried here from the command's own payload instead
      // (the same payload ../lib/zone-effects.ts applyZoneCommandEffect
      // would otherwise apply). Without this, a SET_EQ ack still lands here
      // (volume/muted/playbackState are always present), which sets
      // lastAppliedSequence below and makes ../routes/commands.ts skip its
      // applyZoneCommandEffect fallback as "already applied" — silently
      // dropping the EQ change even though the Windows side wrote it fine.
      if (updated.type === "SET_EQ" && command.payload && typeof command.payload === "object") {
        data.equalizer = command.payload
      }
      // QA review Option 2: diagnostic only, never throws — warns if this
      // ack is about to be treated as "fully applied" (Object.keys(data)
      // below) without actually touching the field ZONE_EFFECT_FIELD says
      // this command type is expected to persist. This is precisely the
      // shape the SET_EQ bug had before the block above existed: catches
      // the *next* command type that repeats it, rather than requiring
      // someone to notice a field silently never changing in production.
      const expectedField = ZONE_EFFECT_FIELD[updated.type]
      if (expectedField && data[expectedField] === undefined) {
        request.log.warn(
          { commandId, type: updated.type, expectedField },
          `SET_EQ-class gap: ${updated.type} ack'd SUCCESS but its zoneState-derived update never touched "${expectedField}" — check whether the agent's zoneState read-back reports it, or whether this needs the same explicit payload merge SET_EQ got.`
        )
      }
      if (Object.keys(data).length > 0) {
        // Mark this command's sequence as applied so ../routes/commands.ts'
        // fallback (../lib/zone-effects.ts#applyZoneCommandEffect) doesn't
        // re-apply it on top of the agent's own authoritative state —
        // that would double-advance NEXT/PREVIOUS.
        if (updated.sequence != null) data.lastAppliedSequence = updated.sequence
        await prisma.zone.update({ where: { id: updated.zoneId }, data })
      }
      emitEvent({ type: "ZONE_STATUS_CHANGED", serverId: ctx.serverId, zoneId: updated.zoneId, data: { zoneId: updated.zoneId, source: "AGENT" } })
      emitEvent({ type: "PLAYBACK_CHANGED", serverId: ctx.serverId, zoneId: updated.zoneId, data: { commandId, type: updated.type } })
    }

    // SET_AUTO_BOOT has no zone — persist the confirmed value directly onto
    // the server row so the portal reflects it without waiting for the next
    // heartbeat (see also the heartbeat handler above, which reports the
    // same field from C:\ProgramData\MusicServer\auto-boot.json on its own
    // cadence — belt-and-suspenders if a heartbeat and this ack race).
    if (updated.type === "SET_AUTO_BOOT" && status === "SUCCESS") {
      const payload = command.payload as Record<string, unknown> | null
      const enabled = payload && typeof payload.enabled === "boolean" ? payload.enabled : undefined
      if (enabled !== undefined) {
        await prisma.musicServer.update({ where: { id: ctx.serverId }, data: { autoBootEnabled: enabled } })
      }
    }

    if (status === "SUCCESS" || status === "FAILED" || status === "TIMEOUT") {
      await pushActivity({
        type: "COMMAND_COMPLETED",
        message: `${updated.type.replaceAll("_", " ")} ${status === "SUCCESS" ? "completed" : status.toLowerCase()} on ${ctx.server.name}${resultMessage ? `: ${resultMessage}` : "."}`,
        serverId: ctx.serverId,
        zoneId: updated.zoneId,
      })
    }

    // A failed server-level command (Forget, Restart Playback, Sync, Auto
    // Boot) is otherwise invisible unless someone happens to open
    // /commands: the operator who triggered it may have moved on assuming
    // success (the FORGET_SERVER bug this closes: a broken agent-bridge
    // config acked FAILED, and nothing else ever said so). A persistent
    // Alert fixes that. Routine zone transport is excluded — its failure
    // already throws straight back to the button-presser (see
    // ../routes/commands.ts), so a duplicate Alert for a momentary
    // offline PLAY/PAUSE would just be noise on the Alerts page.
    if (status === "FAILED" && !ZONE_TRANSPORT_TYPES.has(updated.type)) {
      await prisma.alert.create({
        data: {
          severity: "warning",
          title: `${updated.type.replaceAll("_", " ")} failed`,
          message: `${ctx.server.name}: ${resultMessage ?? "The Windows Music Server reported failure with no further detail."}`,
          serverId: ctx.serverId,
        },
      })
    }

    markAgentSeen(ctx.serverId)
    resolveAck(commandId, status, resultMessage)
    return reply.send({ ok: true })
  })

  // --------------------------------------------------------------------
  // Track sync — files live on Linux storage (backend/data/music, served
  // at /media/music/<storageKey>); the agent reports what it already has
  // cached and pulls the rest itself.
  // --------------------------------------------------------------------
  app.post<{ Body: Record<string, unknown> }>(`${p}/server/tracks/sync`, async (request, reply) => {
    const ctx = await requireAgent(request)
    const body = request.body ?? {}
    const cachedTrackIdsRaw = field(body, "cachedTrackIds")
    const cachedTrackIds = Array.isArray(cachedTrackIdsRaw) ? cachedTrackIdsRaw.filter((x): x is string => typeof x === "string") : []

    if (cachedTrackIds.length > 0) {
      await Promise.all(
        cachedTrackIds.map((trackId) =>
          prisma.trackSyncState.upsert({
            where: { trackId_serverId: { trackId, serverId: ctx.serverId } },
            create: { trackId, serverId: ctx.serverId, status: "CACHED_ON_SERVER", progressPercent: 100 },
            update: { status: "CACHED_ON_SERVER", progressPercent: 100, errorMessage: null },
          })
        )
      )
      await pushActivity({ type: "MUSIC_SYNC_COMPLETED", message: `${cachedTrackIds.length} track(s) cached on ${ctx.server.name}.`, serverId: ctx.serverId })
    }

    const queued = await prisma.trackSyncState.findMany({
      where: { serverId: ctx.serverId, status: "QUEUED_FOR_SYNC" },
      include: { track: true },
    })
    await prisma.trackSyncState.updateMany({
      where: { serverId: ctx.serverId, status: "QUEUED_FOR_SYNC" },
      data: { status: "SYNCING" },
    })

    const cachedCount = await prisma.trackSyncState.count({ where: { serverId: ctx.serverId, status: "CACHED_ON_SERVER" } })
    const cachedStates = await prisma.trackSyncState.findMany({ where: { serverId: ctx.serverId, status: "CACHED_ON_SERVER" }, include: { track: true } })
    const cachedSizeGb = cachedStates.reduce((sum, s) => sum + s.track.fileSizeMb, 0) / 1024
    await prisma.musicServer.update({ where: { id: ctx.serverId }, data: { cachedTracks: cachedCount, cachedSizeGb } })

    return reply.send({
      tracksToSync: queued.map((s) => ({
        trackId: s.trackId,
        title: s.track.title,
        artist: s.track.artist,
        fileSizeMb: s.track.fileSizeMb,
        // Signed and expiring — /media/music/ is no longer an open
        // directory (see lib/media-url.ts).
        url: signedMediaUrl(s.track.storageKey),
      })),
    })
  })

  // --------------------------------------------------------------------
  // Zone sync — the agent reports the zones it knows about; each gets a
  // stable CMMP Zone row keyed by (serverId, localZoneId).
  // --------------------------------------------------------------------
  app.post<{ Body: Record<string, unknown> }>(`${p}/server/zones/sync`, async (request, reply) => {
    const ctx = await requireAgent(request)
    const body = request.body ?? {}
    const zonesRaw = field(body, "zones")
    // A genuine JSON array (even an empty one — the machine really has no
    // zones) is what makes this report authoritative enough to prune from.
    // A missing/malformed "zones" field is not: it never reaches
    // cmmp.syncZones() in the first place when the agent's own local.getZones()
    // failed (agent-bridge/lib/agent.js heartbeatOnce's catch skips the call
    // entirely), so treating a missing field as "zero zones" here would wipe
    // every zone on this server over a request that was never a real report.
    const zonesReported = Array.isArray(zonesRaw)
    const zones = zonesReported ? zonesRaw : []

    const mapping: { localZoneId: string; zoneId: string }[] = []
    for (const raw of zones) {
      if (!raw || typeof raw !== "object") continue
      const z = raw as Record<string, unknown>
      const localZoneId = str(z, "localZoneId", "id", "zoneId")
      const name = str(z, "name") ?? "Zone"
      if (!localZoneId) continue

      const playbackRaw = str(z, "playbackState")?.toUpperCase()
      const playbackState = (playbackRaw && ZONE_STATE_MAP[playbackRaw]) || undefined
      const volume = num(z, "volume")
      const mutedVal = field(z, "muted")
      const muted = typeof mutedVal === "boolean" ? mutedVal : undefined

      const existing = await prisma.zone.findUnique({ where: { serverId_localZoneId: { serverId: ctx.serverId, localZoneId } } })
      const zone = existing
        ? await prisma.zone.update({
            where: { id: existing.id },
            data: { name, ...(playbackState ? { playbackState } : {}), ...(volume !== undefined ? { volume } : {}), ...(muted !== undefined ? { muted } : {}) },
          })
        : await prisma.zone.create({
            data: {
              serverId: ctx.serverId,
              locationId: ctx.server.locationId,
              localZoneId,
              name,
              playbackState: playbackState ?? "OFFLINE",
              volume: volume ?? 50,
              muted: muted ?? false,
            },
          })
      mapping.push({ localZoneId, zoneId: zone.id })
      emitEvent({ type: "ZONE_STATUS_CHANGED", serverId: ctx.serverId, zoneId: zone.id, data: { zoneId: zone.id, source: "AGENT" } })
    }

    // Local -> cloud delete (Task 1): a zone this server used to report but
    // no longer does is gone locally, so its cloud row is pruned too — a
    // deleted-locally zone must not linger here as a STOPPED ghost. Only
    // ever touches rows with a real localZoneId (never a cloud-only zone
    // that simply hasn't synced yet, since those have localZoneId null).
    if (zonesReported) {
      const reportedLocalIds = mapping.map((m) => m.localZoneId)
      const staleZones = await prisma.zone.findMany({
        where: {
          serverId: ctx.serverId,
          localZoneId: { not: null },
          NOT: { localZoneId: { in: reportedLocalIds } },
        },
        select: { id: true },
      })
      if (staleZones.length > 0) {
        await prisma.zone.deleteMany({ where: { id: { in: staleZones.map((z) => z.id) } } })
        for (const z of staleZones) {
          emitEvent({ type: "ZONE_STATUS_CHANGED", serverId: ctx.serverId, zoneId: z.id, data: { zoneId: z.id, source: "AGENT" } })
        }
      }
    }

    markAgentSeen(ctx.serverId)
    return reply.send({ zones: mapping })
  })

  // --------------------------------------------------------------------
  // Zone-playlist sync — what each zone should have cached/playing, so
  // the agent can pre-fetch tracks and keep playing offline.
  // --------------------------------------------------------------------
  app.post(`${p}/server/zone-playlists/sync`, async (request, reply) => {
    const ctx = await requireAgent(request)
    const zones = await prisma.zone.findMany({ where: { serverId: ctx.serverId } })
    const items = await Promise.all(
      zones.map(async (zone) => {
        const playlist = zone.currentPlaylistId
          ? await prisma.playlist.findUnique({ where: { id: zone.currentPlaylistId }, include: { tracks: { orderBy: { position: "asc" } } } })
          : null
        return {
          localZoneId: zone.localZoneId ?? zone.id,
          zoneId: zone.id,
          playlistId: zone.currentPlaylistId,
          // Randomised, not the order tracks were added — seeded on
          // zone+playlist so it stays put while this assignment lasts.
          trackIds: playlist
            ? seededShuffle(
                playlist.tracks.map((t) => t.trackId),
                `${zone.id}:${playlist.id}`
              )
            : [],
          excludedTrackIds: zone.excludedTrackIds,
          currentTrackId: zone.currentTrackId,
        }
      })
    )
    markAgentSeen(ctx.serverId)
    return reply.send({ zonePlaylists: items })
  })

  // --------------------------------------------------------------------
  // Schedules — Prayer Mode / playlist schedules for this server's zones,
  // so the agent can compute and run them locally, independent of the
  // cloud connection (see README "Prayer Mode delivery").
  // --------------------------------------------------------------------
  app.get(`${p}/server/schedules`, async (request, reply) => {
    const ctx = await requireAgent(request)
    const zones = await prisma.zone.findMany({
      where: { serverId: ctx.serverId },
      select: { id: true, localZoneId: true, excludedTrackIds: true },
    })
    const zoneIds = zones.map((z) => z.id)
    const localOf = new Map(zones.map((z) => [z.id, z.localZoneId ?? z.id]))
    const excludedOf = new Map(zones.map((z) => [z.id, z.excludedTrackIds]))
    const schedules = await prisma.schedule.findMany({ where: { zoneId: { in: zoneIds }, enabled: true }, orderBy: { startTime: "asc" } })

    // Each slot's own track list, not just its playlistId: a schedule can
    // name a playlist the zone isn't currently playing, and the agent has
    // no other way to reach that playlist's tracks (it authenticates as an
    // agent, not a portal session, so it cannot call GET /playlists/:id).
    // Bundling it here means "the schedules API" stays the one system —
    // no second sync surface for schedule-driven playback.
    const playlistIds = Array.from(new Set(schedules.map((s) => s.playlistId)))
    const playlistTracks = playlistIds.length
      ? await prisma.playlistTrack.findMany({ where: { playlistId: { in: playlistIds } }, orderBy: { position: "asc" } })
      : []
    const tracksByPlaylist = new Map<string, string[]>()
    for (const pt of playlistTracks) {
      const arr = tracksByPlaylist.get(pt.playlistId)
      if (arr) arr.push(pt.trackId)
      else tracksByPlaylist.set(pt.playlistId, [pt.trackId])
    }

    markAgentSeen(ctx.serverId)
    return reply.send({
      schedules: schedules.map((s) => ({
        id: s.id,
        localZoneId: localOf.get(s.zoneId) ?? s.zoneId,
        zoneId: s.zoneId,
        playlistId: s.playlistId,
        trackIds: seededShuffle(tracksByPlaylist.get(s.playlistId) ?? [], `${s.zoneId}:${s.playlistId}`),
        excludedTrackIds: excludedOf.get(s.zoneId) ?? [],
        name: s.name,
        startTime: s.startTime,
        endTime: s.endTime,
        days: s.days,
        priority: s.priority,
      })),
    })
  })
}
