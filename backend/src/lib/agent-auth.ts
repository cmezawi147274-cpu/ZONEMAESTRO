import crypto from "node:crypto"
import type { FastifyRequest } from "fastify"
import { prisma } from "./db.js"
import { HttpError } from "./http-error.js"
import { env } from "./env.js"
import type { MusicServer } from "@prisma/client"

/** Windows MusicServer agent auth — separate from the browser's JWT
 * bearer scheme (auth-context.ts). The agent holds a long-lived opaque
 * token issued at pairing time (POST /api/pairing/complete) and refreshed
 * via POST /api/server/token. We never decompile MusicServer.Api to learn
 * its own token format, so this is CMMP's own scheme: `${cmmpServerId}.${secret}`,
 * verified by comparing a SHA-256 hash against MusicServer.agentTokenHash. */

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

export function generateAgentToken(serverId: string): string {
  const secret = crypto.randomBytes(32).toString("base64url")
  return `${serverId}.${secret}`
}

export interface AgentContext {
  serverId: string
  server: MusicServer
}

/** Distinguishes *why* a token failed, not just that it did — each needs a
 * different on-site response (stop retrying and open a ticket vs. just
 * re-pair). See routes/agent.ts's error codes and the DeletedServerTombstone
 * doc comment in prisma/schema.prisma. */
export type AgentAuthFailure =
  | "TOKEN_MALFORMED" // no/garbage Authorization header — same on-site advice as TOKEN_UNKNOWN
  | "TOKEN_UNKNOWN" // well-formed token, but no row (or row never existed) matches its serverId
  | "TOKEN_REVOKED" // the row exists but this token is not (or no longer) its current credential
  | "SERVER_DELETED" // the row this token belonged to was deliberately removed

export type AgentAuthResult = { ok: true; ctx: AgentContext } | { ok: false; reason: AgentAuthFailure }

/** Shared by requireAgent below and the raw WebSocket upgrade handler for
 * MusicServerHub (agent/signalrHub.ts), which has no Fastify request to
 * hang a preHandler off of. */
export async function checkAgentToken(token: string | null | undefined): Promise<AgentAuthResult> {
  if (!token || !token.includes(".")) return { ok: false, reason: "TOKEN_MALFORMED" }
  const serverId = token.slice(0, token.indexOf("."))
  const server = await prisma.musicServer.findUnique({ where: { id: serverId } })
  if (!server) {
    const tombstoned = await prisma.deletedServerTombstone.findUnique({ where: { id: serverId } })
    return { ok: false, reason: tombstoned ? "SERVER_DELETED" : "TOKEN_UNKNOWN" }
  }
  if (!server.agentTokenHash || sha256Hex(token) !== server.agentTokenHash) {
    return { ok: false, reason: "TOKEN_REVOKED" }
  }
  return { ok: true, ctx: { serverId, server } }
}

/** Boolean-shaped wrapper for callers (the SignalR hub) that only need
 * accept/reject, not the specific reason. */
export async function verifyAgentToken(token: string): Promise<AgentContext | null> {
  if (!env.musicServerAgentAllowed) return null
  const result = await checkAgentToken(token)
  return result.ok ? result.ctx : null
}

const FAILURE_RESPONSES: Record<AgentAuthFailure, { code: string; message: string }> = {
  TOKEN_MALFORMED: { code: "AGENT_TOKEN_UNKNOWN", message: "Agent token required." },
  TOKEN_UNKNOWN: { code: "AGENT_TOKEN_UNKNOWN", message: "Invalid agent token." },
  TOKEN_REVOKED: { code: "AGENT_TOKEN_REVOKED", message: "This agent token is no longer valid — re-pair this machine." },
  SERVER_DELETED: {
    code: "SERVER_DELETED",
    message: "This server was removed from the portal — re-pair this machine to reconnect.",
  },
}

export async function requireAgent(request: FastifyRequest): Promise<AgentContext> {
  if (!env.musicServerAgentAllowed) {
    throw new HttpError(401, "AGENT_DISABLED", "Windows MusicServer agent integration is disabled on this backend.")
  }
  const header = request.headers.authorization
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null
  const result = await checkAgentToken(token)
  if (!result.ok) {
    const { code, message } = FAILURE_RESPONSES[result.reason]
    throw new HttpError(401, code, message)
  }
  return result.ctx
}
