import { recordConnection, appendRestart } from "./store.js"

export interface ClientConnection {
  source: string
  serverId: string
  serverName?: string | null
  organizationId?: string | null
  version?: string | null
  ip?: string | null
  caps?: string[]
}

const FIXTURE_PREFIX = "zz"

export function logFailure(what: string, err: unknown) {
  try {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[subscription] ${what}: ${message.split("\n")[0]}`)
  } catch {
    // never let logging itself throw
  }
}

const text = (value: unknown, max = 200) => (typeof value === "string" && value ? value.slice(0, max) : null)

export async function onClientConnected(connection: ClientConnection): Promise<void> {
  try {
    const serverId = text(connection?.serverId)
    if (!serverId || serverId.startsWith(FIXTURE_PREFIX)) return
    const organizationId = text(connection.organizationId)
    if (organizationId?.startsWith(FIXTURE_PREFIX)) return
    await recordConnection(
      {
        source: text(connection.source, 40) ?? "unknown",
        serverId,
        serverName: text(connection.serverName),
        organizationId,
        version: text(connection.version, 60),
        ipAddress: text(connection.ip, 100),
        caps: Array.isArray(connection.caps) ? connection.caps.map((c) => text(c, 40)).filter((c): c is string => !!c).slice(0, 10) : [],
      },
      new Date()
    )
  } catch (err) {
    logFailure("could not record a client connection", err)
  }
}

let restartScheduled = false

export async function recordRestart(): Promise<void> {
  try {
    if (restartScheduled) return
    restartScheduled = true
    await appendRestart(new Date())
  } catch (err) {
    logFailure("could not record the restart", err)
  }
}
