import type { FastifyInstance } from "fastify"
import fs from "node:fs"
import path from "node:path"
import { requireAuth, requireUser } from "../lib/auth-context.js"
import { forbidden, notFound } from "../lib/http-error.js"

/**
 * Super-Admin-only download of the Local Music Server installer.
 *
 * Deliberately not a release or version system: one fixed file on disk,
 * served as-is. Updating it is "replace the file on the host" — no deploy,
 * no rebuild, no restart, nothing here to change.
 *
 * The directory is bind-mounted read-only from the host
 * (docker-compose.yml, `backend.volumes`) and is deliberately NOT inside
 * MUSIC_STORAGE_DIR: lib/agent-sweep.ts' orphan-media sweep deletes any
 * file there without a matching Track row, which would eventually delete
 * this installer.
 */
const INSTALLER_DIR = "/app/data/downloads"
// The uploaded build, served byte-for-byte under its own name — nothing here
// generates, repacks or renames it.
const INSTALLER_FILE = "CMMP-Venue-Install-2026-09-22_1255.zip"

export default async function downloadsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAuth)

  app.get("/downloads/local-music-server", async (request, reply) => {
    const user = requireUser(request)
    // The same direct role check already used by routes/users.ts and
    // routes/commands.ts — no new permission, no change to lib/rbac.ts.
    if (user.role !== "SUPER_ADMIN") throw forbidden()

    const full = path.join(INSTALLER_DIR, INSTALLER_FILE)
    const stat = await fs.promises.stat(full).catch(() => null)
    if (!stat?.isFile()) throw notFound("Installer")

    reply.header("Content-Type", "application/zip")
    reply.header("Content-Length", stat.size)
    reply.header("Content-Disposition", `attachment; filename="${INSTALLER_FILE}"`)
    return reply.send(fs.createReadStream(full))
  })
}
