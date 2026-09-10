import type { FastifyRequest } from "fastify"
import { prisma } from "./db.js"

/**
 * Security audit trail.
 *
 * Every privileged mutation records who did it, to what, and from where.
 * This is deliberately separate from `pushActivity` (lib/activity.ts), which
 * feeds the dashboard's operational timeline and carries no actor or IP.
 *
 * Two rules:
 *  - **Never throws.** An audit write must not be able to fail the operation
 *    it describes; a caller that had its delete rejected because logging
 *    failed would be worse than the missing log line.
 *  - **Never stores credentials.** `metadata` is filtered below, so a route
 *    that passes its whole request body cannot leak a password hash or token
 *    into a table intended to be readable by compliance staff.
 */

const REDACT = /password|secret|token|hash|authorization|credential/i

function safeMetadata(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(safeMetadata)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT.test(k) ? "[redacted]" : safeMetadata(v)
  }
  return out
}

export interface AuditEntry {
  /** Dotted verb: "user.delete", "server.forget", "track.delete". */
  action: string
  targetType: string
  targetId?: string | null
  /** One human sentence, readable by someone who does not know the schema. */
  summary: string
  metadata?: unknown
  /** For the unauthenticated cases (a failed login) where there is no
   * request.authUser to read an actor from. */
  actorEmailOverride?: string
}

export async function audit(request: FastifyRequest, entry: AuditEntry): Promise<void> {
  try {
    const user = request.authUser
    const forwarded = (request.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    await prisma.auditLog.create({
      data: {
        actorId: user?.id ?? null,
        actorEmail: user?.email ?? entry.actorEmailOverride ?? "anonymous",
        actorRole: user?.role ?? "NONE",
        organizationId: user?.organizationId ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        summary: entry.summary,
        ip: forwarded ?? request.ip ?? null,
        userAgent: (request.headers["user-agent"] as string | undefined)?.slice(0, 500) ?? null,
        metadata: entry.metadata === undefined ? undefined : (safeMetadata(entry.metadata) as never),
      },
    })
  } catch (err) {
    request.log.warn({ err, action: entry.action }, "audit log write failed")
  }
}
