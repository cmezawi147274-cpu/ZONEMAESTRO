import type { FastifyInstance, FastifyRequest } from "fastify"
import fs from "node:fs"
import path from "node:path"
import { readSignedManifest, updateDir, UPDATE_FILE_NAME } from "../lib/update-manifest.js"

/**
 * Remote update for venue agents (kit 2026.11.20+ lib/updater.js), mounted
 * by routes/agent.ts under its prefix with requireAgent. A 404 means
 * "nothing published"; the agent verifies the signature and every file's
 * size and SHA-256 itself.
 */
export function registerUpdateRoutes(app: FastifyInstance, prefix: string, auth: (request: FastifyRequest) => Promise<unknown>) {
  app.get(`${prefix}/server/update/manifest`, async (request, reply) => {
    await auth(request)
    const published = await readSignedManifest()
    if (published === "missing" || published === "invalid") {
      if (published === "invalid") request.log.warn("the published update manifest is not valid; serving none")
      return reply.status(404).header("Cache-Control", "no-store").send({ error: "No update published" })
    }
    return reply.header("Cache-Control", "no-store").send(published)
  })

  app.get<{ Params: { name: string } }>(`${prefix}/server/update/file/:name`, async (request, reply) => {
    await auth(request)
    const name = request.params.name
    const notThere = () => reply.status(404).header("Cache-Control", "no-store").send({ error: "Update file not found" })
    if (!UPDATE_FILE_NAME.test(name)) return notThere()
    const full = path.join(updateDir(), "files", name)
    let stat: fs.Stats
    try {
      stat = await fs.promises.lstat(full)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") return notThere()
      throw err
    }
    if (!stat.isFile()) return notThere()
    reply.header("Content-Type", "application/zip")
    reply.header("Content-Length", stat.size)
    reply.header("Cache-Control", "no-store")
    return reply.send(fs.createReadStream(full))
  })
}
