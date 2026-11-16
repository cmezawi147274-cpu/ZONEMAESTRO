import type { Alert, Role } from "@prisma/client"
import { prisma } from "./db.js"
import { can } from "./rbac.js"

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
const ACTIVE_MS = 30 * 24 * 60 * 60 * 1000
const ORG_ROLES = (["ORGANIZATION_ADMIN", "LOCATION_MANAGER", "VIEWER", "SUPER_ORGANIZATION_ADMIN"] as Role[]).filter((r) => can(r, "logs:read"))

export function notifyAlert(alert: Alert): void {
  sendAlertPush(alert).catch((err) => console.warn("[push] failed:", err))
}

async function sendAlertPush(alert: Alert) {
  const server = alert.serverId
    ? await prisma.musicServer.findUnique({ where: { id: alert.serverId }, select: { organizationId: true } })
    : null
  const location = !server && alert.locationId
    ? await prisma.location.findUnique({ where: { id: alert.locationId }, select: { organizationId: true } })
    : null
  const organizationId = server?.organizationId ?? location?.organizationId ?? null
  const devices = await prisma.pushDevice.findMany({
    where: {
      lastSeenAt: { gte: new Date(Date.now() - ACTIVE_MS) },
      user: {
        OR: [
          { role: "SUPER_ADMIN" },
          ...(organizationId ? [{ organizationId, role: { in: ORG_ROLES } }] : []),
        ],
      },
    },
    select: { token: true },
  })
  for (let i = 0; i < devices.length; i += 100) {
    const tokens = devices.slice(i, i + 100).map((d) => d.token)
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(
        tokens.map((to) => ({
          to,
          title: alert.title,
          body: alert.message.slice(0, 240),
          data: { url: "/monitoring" },
          sound: "default",
          priority: "high",
          channelId: "alerts",
        }))
      ),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`Expo push HTTP ${res.status}`)
    const { data } = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] }
    const gone = tokens.filter((_, j) => data?.[j]?.details?.error === "DeviceNotRegistered")
    if (gone.length) await prisma.pushDevice.deleteMany({ where: { token: { in: gone } } })
  }
}
