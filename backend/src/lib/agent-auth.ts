import crypto from "node:crypto"
import type { FastifyRequest } from "fastify"
import { prisma } from "./db.js"
import { unauthorized } from "./http-error.js"
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

/** Shared by the Fastify preHandler below and the raw WebSocket upgrade
 * handler for MusicServerHub (agent/signalrHub.ts), which has no Fastify
 * request to hang a preHandler off of. */
export async function verifyAgentToken(token: string): Promise<AgentContext | null> {
  if (!env.musicServerAgentAllowed) return null
  if (!token || !token.includes(".")) return null
  const serverId = token.slice(0, token.indexOf("."))
  const server = await prisma.musicServer.findUnique({ where: { id: serverId } })
  if (!server || !server.agentTokenHash) return null
  if (sha256Hex(token) !== server.agentTokenHash) return null
  return { serverId, server }
}

export async function requireAgent(request: FastifyRequest): Promise<AgentContext> {
  if (!env.musicServerAgentAllowed) throw unauthorized("Windows MusicServer agent integration is disabled on this backend.")
  const header = request.headers.authorization
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null
  if (!token) throw unauthorized("Agent token required.")
  const ctx = await verifyAgentToken(token)
  if (!ctx) throw unauthorized("Invalid agent token.")
  return ctx
}
