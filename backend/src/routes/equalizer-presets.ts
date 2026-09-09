import type { FastifyInstance } from "fastify"
import { prisma } from "../lib/db.js"
import { requireAuth, requireUser, tenantScope } from "../lib/auth-context.js"
import { can } from "../lib/rbac.js"
import { forbidden, notFound, badRequest } from "../lib/http-error.js"

/** Mirrors src/lib/equalizer/presets.ts — 10 bands, each clamped to +/-12 dB. */
const BAND_COUNT = 10
const MIN_DB = -12
const MAX_DB = 12

/** Presets are org-shared config, so they reuse the zone permissions rather
 * than introducing a permission that would have to be mirrored into
 * src/lib/auth/rbac.ts as well: `zone:read` to pick one, `zone:assign` to
 * save or delete one — which correctly excludes VIEWER from editing the
 * curves everyone else sees. */
function normalizeBands(input: unknown): number[] {
  if (!Array.isArray(input) || input.length !== BAND_COUNT) {
    throw badRequest(`bands must be an array of exactly ${BAND_COUNT} numbers.`)
  }
  return input.map((raw) => {
    const n = typeof raw === "number" ? raw : Number(raw)
    if (!Number.isFinite(n)) throw badRequest("bands must all be finite numbers.")
    // Clamp rather than reject: the client already clamps with clampDb, so
    // an out-of-range value here is a rounding artefact, not a real request
    // to boost 40 dB.
    return Math.min(MAX_DB, Math.max(MIN_DB, Math.round(n * 10) / 10))
  })
}

function serialize(p: { id: string; name: string; bands: unknown; createdAt: Date }) {
  return { id: p.id, name: p.name, bands: p.bands as number[], createdAt: p.createdAt.toISOString() }
}

export default async function equalizerPresetsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get("/equalizer-presets", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "zone:read")) throw forbidden()
    const scope = tenantScope(request)
    // A SUPER_ADMIN has no organizationId of their own; they read whichever
    // org they're acting in, and otherwise see every org's presets.
    const where = scope.organizationId ? { organizationId: scope.organizationId } : {}
    const presets = await prisma.eqPreset.findMany({ where, orderBy: { name: "asc" } })
    return reply.send(presets.map(serialize))
  })

  app.post<{ Body: { name?: unknown; bands?: unknown; organizationId?: string; locationId?: string } }>(
    "/equalizer-presets",
    async (request, reply) => {
      const user = requireUser(request)
      if (!can(user.role, "zone:assign")) throw forbidden()
      const scope = tenantScope(request)

      const name = typeof request.body?.name === "string" ? request.body.name.trim() : ""
      if (!name) throw badRequest("A preset name is required.")
      if (name.length > 40) throw badRequest("Preset names are limited to 40 characters.")
      const bands = normalizeBands(request.body?.bands)

      // A SUPER_ADMIN has no organizationId of their own, so the org comes
      // from the zone the dialog was opened on: its location owns the
      // organization. Same rule as POST /servers — never trust an
      // organizationId straight off the body for a scoped role, or an Org
      // Admin could plant a preset in another tenant.
      let organizationId = scope.organizationId ?? undefined
      if (!organizationId && request.body?.locationId) {
        const location = await prisma.location.findUnique({ where: { id: request.body.locationId } })
        if (!location) throw notFound("Location")
        organizationId = location.organizationId
      }
      organizationId ??= request.body?.organizationId
      if (!organizationId) {
        throw badRequest("Could not determine which organization this preset belongs to.")
      }
      if (scope.organizationId && organizationId !== scope.organizationId) throw forbidden()

      // Re-saving a name replaces that curve rather than erroring, so
      // "save over my Friday preset" is one action in the UI, not two.
      const preset = await prisma.eqPreset.upsert({
        where: { organizationId_name: { organizationId, name } },
        create: { organizationId, name, bands, createdById: user.id },
        update: { bands, createdById: user.id },
      })
      return reply.status(201).send(serialize(preset))
    }
  )

  app.delete<{ Params: { id: string } }>("/equalizer-presets/:id", async (request, reply) => {
    const user = requireUser(request)
    if (!can(user.role, "zone:assign")) throw forbidden()
    const scope = tenantScope(request)
    const preset = await prisma.eqPreset.findUnique({ where: { id: request.params.id } })
    if (!preset) throw notFound("Preset")
    if (scope.organizationId && preset.organizationId !== scope.organizationId) throw notFound("Preset")
    await prisma.eqPreset.delete({ where: { id: preset.id } })
    return reply.status(204).send()
  })
}
