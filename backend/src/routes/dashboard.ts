import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { requireAuth, requireUser, tenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden } from "../lib/http-error.js"

export default async function dashboardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get("/dashboard/stats", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "server:read")) throw forbidden()
    const scope = tenantScope(request)

    if (!scope.isSuperAdmin && !scope.organizationId) {
      return reply.send({
        totalOrganizations: 0,
        totalLocations: 0,
        serversOnline: 0,
        serversOffline: 0,
        serversWarning: 0,
        activeZones: 0,
        playingZones: 0,
        syncJobsInProgress: 0,
        syncJobsFailed: 0,
        openAlerts: 0,
      })
    }

    const orgFilter = scope.isSuperAdmin ? {} : { organizationId: scope.organizationId! }
    const locations = await prisma.location.findMany({ where: orgFilter, select: { id: true } })
    const locationIds = locations.map((l) => l.id)
    const servers = await prisma.musicServer.findMany({ where: orgFilter, select: { id: true, status: true } })
    const serverIds = servers.map((s) => s.id)

    const [totalOrganizations, activeZones, playingZones, syncJobsInProgress, syncJobsFailed, openAlerts] = await Promise.all([
      scope.isSuperAdmin ? prisma.organization.count() : Promise.resolve(1),
      prisma.zone.count({ where: { locationId: { in: locationIds }, playbackState: { not: "OFFLINE" } } }),
      prisma.zone.count({ where: { locationId: { in: locationIds }, playbackState: "PLAYING" } }),
      prisma.trackSyncState.count({ where: { serverId: { in: serverIds }, status: { in: ["SYNCING", "QUEUED_FOR_SYNC"] } } }),
      prisma.trackSyncState.count({ where: { serverId: { in: serverIds }, status: "FAILED" } }),
      prisma.alert.count({
        where: {
          acknowledged: false,
          OR: [{ serverId: { in: serverIds } }, { locationId: { in: locationIds } }],
        },
      }),
    ])

    return reply.send({
      totalOrganizations,
      totalLocations: locations.length,
      serversOnline: servers.filter((s) => s.status === "ONLINE" || s.status === "UPDATING").length,
      serversOffline: servers.filter((s) => s.status === "OFFLINE").length,
      serversWarning: servers.filter((s) => s.status === "WARNING").length,
      activeZones,
      playingZones,
      syncJobsInProgress,
      syncJobsFailed,
      openAlerts,
    })
  })
}
