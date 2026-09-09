import { isMockMode } from "@/lib/config"
import { apiClient } from "@/lib/api/client"
import { delay } from "@/lib/mock/delay"
import { store } from "@/lib/mock/store"
import { nextId } from "@/lib/mock/ids"
import { applyZoneCommandEffect } from "@/lib/mock/zone-effects"
import { getTenantScope } from "@/lib/auth/session"
import type { CommandSource, CommandType } from "@/lib/constants"
import type { RemoteCommand } from "@/lib/api/types"

export interface SendCommandInput {
  serverId: string
  zoneId?: string | null
  type: CommandType
  payload?: Record<string, unknown>
  issuedBy: string
  /** Internal-only. The one caller-supplied value ever trusted is
   * "SCHEDULE", used by the Prayer scheduler (src/lib/prayer/scheduler.ts)
   * — it isn't a client-selectable role. Every other value is ignored:
   * `send()` derives USER vs SUPER_ADMIN from the acting session itself,
   * never from what the client claims (see `getTenantScope()`). */
  source?: CommandSource
}

/** Zone transport/volume commands apply immediately — success or error, for
 * every role, never PENDING — see `send()` below. Other server-level
 * actions (sync, restart, reboot) still use the async PENDING -> SENT ->
 * EXECUTING -> SUCCESS lifecycle confirmed by src/lib/mock/simulate.ts
 * `tickCommands`. */
const ZONE_TRANSPORT_TYPES = new Set<CommandType>([
  "PLAY",
  "PAUSE",
  "STOP",
  "NEXT",
  "PREVIOUS",
  "SET_VOLUME",
  "MUTE",
  "UNMUTE",
])

export const commandsApi = {
  async list(filters?: { serverId?: string }): Promise<RemoteCommand[]> {
    if (isMockMode) {
      await delay()
      // Commands have no organizationId of their own — scope via the org
      // that owns the target server. SUPER_ADMIN is unrestricted.
      const scope = getTenantScope()
      let items = store.commands
      if (!scope.isSuperAdmin) {
        if (!scope.organizationId) return []
        const allowedServerIds = new Set(
          store.servers.filter((s) => s.organizationId === scope.organizationId).map((s) => s.id)
        )
        items = items.filter((c) => allowedServerIds.has(c.serverId))
      }
      if (filters?.serverId) items = items.filter((c) => c.serverId === filters.serverId)
      return items.map((c) => ({ ...c })).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
    }
    const qs = filters?.serverId ? `?serverId=${filters.serverId}` : ""
    return apiClient.get<RemoteCommand[]>(`/commands${qs}`)
  },

  async send(input: SendCommandInput): Promise<RemoteCommand> {
    if (isMockMode) {
      await delay(200)

      // Audit-only, never trusted from the client — see SendCommandInput.
      const scope = getTenantScope()
      const source: CommandSource = input.source === "SCHEDULE" ? "SCHEDULE" : scope.isSuperAdmin ? "SUPER_ADMIN" : "USER"
      const now = new Date().toISOString()
      const server = store.servers.find((s) => s.id === input.serverId)

      if (ZONE_TRANSPORT_TYPES.has(input.type)) {
        // Every role takes the exact same path: apply the action now, or
        // return an error. Never PENDING, never a client-side optimistic
        // patch, never a wait for a local-server confirmation.
        if (!server || server.status === "OFFLINE" || server.status === "UNKNOWN") {
          const failedCommand: RemoteCommand = {
            id: nextId("cmd"),
            serverId: input.serverId,
            zoneId: input.zoneId ?? null,
            type: input.type,
            payload: input.payload,
            status: "FAILED",
            issuedBy: input.issuedBy,
            issuedAt: now,
            sentAt: null,
            completedAt: now,
            resultMessage: `${server?.name ?? "Server"} is offline.`,
            source,
            sequence: null,
          }
          store.commands.unshift(failedCommand)
          throw new Error(failedCommand.resultMessage!)
        }

        const zone = input.zoneId ? store.zones.find((z) => z.id === input.zoneId) : undefined
        const sequence = zone ? ++zone.commandSequence : null
        const failed = Math.random() < 0.08
        const command: RemoteCommand = {
          id: nextId("cmd"),
          serverId: input.serverId,
          zoneId: input.zoneId ?? null,
          type: input.type,
          payload: input.payload,
          status: failed ? "FAILED" : "SUCCESS",
          issuedBy: input.issuedBy,
          issuedAt: now,
          sentAt: now,
          executingAt: now,
          completedAt: now,
          resultMessage: failed ? "Agent reported an error executing the command." : "Acknowledged by MusicServer agent.",
          source,
          sequence,
        }
        store.commands.unshift(command)
        store.pushActivity({
          type: "COMMAND_COMPLETED",
          message: `${input.type.replaceAll("_", " ")} ${failed ? "failed" : "applied"} for ${server.name}.`,
          serverId: input.serverId,
          zoneId: input.zoneId,
        })
        if (failed) throw new Error(command.resultMessage!)
        applyZoneCommandEffect(command)
        return command
      }

      // Other server-level actions (sync, restart, reboot) keep the
      // original async lifecycle — see src/lib/mock/simulate.ts `tickCommands`.
      const command: RemoteCommand = {
        id: nextId("cmd"),
        serverId: input.serverId,
        zoneId: input.zoneId ?? null,
        type: input.type,
        payload: input.payload,
        status: "PENDING",
        issuedBy: input.issuedBy,
        issuedAt: now,
        sentAt: null,
        source,
        sequence: null,
      }
      store.commands.unshift(command)
      // No activity event here — "queued" isn't "completed". The real
      // completion is logged later by src/lib/mock/simulate.ts
      // `tickCommands`, once this command actually reaches SUCCESS/FAILED.
      return command
    }
    return apiClient.post<RemoteCommand>("/commands", input)
  },

  async get(id: string): Promise<RemoteCommand | null> {
    if (isMockMode) {
      await delay(150)
      // A copy, not the live store reference — see locations.ts `get()`.
      const command = store.commands.find((c) => c.id === id)
      if (!command) return null
      const scope = getTenantScope()
      if (!scope.isSuperAdmin) {
        const server = store.servers.find((s) => s.id === command.serverId)
        if (!server || server.organizationId !== scope.organizationId) return null
      }
      return { ...command }
    }
    return apiClient.get<RemoteCommand>(`/commands/${id}`)
  },
}
