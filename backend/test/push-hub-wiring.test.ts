/**
 * End-to-end wiring for the push capability marker.
 *
 * The unit tests cover each half: the agent puts `caps=cmdfix` on the hub
 * URL, and pushToAgent only sends to sockets registered as capable. This
 * covers the join between them — a real WebSocket, a real agent token
 * verified against the database, signalrHub's own parsing, and a real push.
 * A typo in the parameter name would pass both unit tests and fail here.
 *
 * Uses throwaway `zzhub-` fixtures and its own local http server. It never
 * touches production venues, production rows, or the running backend.
 */
import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import http from "node:http"
import { WebSocket } from "ws"
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const P = "zzhub-"
const RS = ""

type Hub = typeof import("../src/agent/signalrHub.js")
type Registry = typeof import("../src/lib/agent-registry.js")

let registry: Registry
let server: http.Server
let port: number
const sockets: WebSocket[] = []

/** A paired agent exactly as lib/agent-auth.ts expects to find one. */
async function fixtureAgent(suffix: string, version: string): Promise<{ serverId: string; token: string }> {
  const serverId = `${P}srv-${suffix}-${Date.now()}`
  const secret = crypto.randomBytes(32).toString("hex")
  const token = `${serverId}.${secret}`
  await prisma.musicServer.create({
    data: {
      id: serverId,
      organizationId: `${P}org`,
      locationId: `${P}loc`,
      name: `Hub Wiring ${suffix}`,
      status: "ONLINE",
      version,
      agentTokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    },
  })
  return { serverId, token }
}

/** Opens a hub socket, completes the SignalR handshake, and collects frames. */
async function connectAgent(token: string, caps?: string): Promise<{ frames: string[] }> {
  const url = new URL(`ws://127.0.0.1:${port}/hubs/musicserver`)
  url.searchParams.set("access_token", token)
  if (caps) url.searchParams.set("caps", caps)
  const ws = new WebSocket(url.toString())
  sockets.push(ws)
  const frames: string[] = []
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hub handshake timed out")), 5000)
    ws.on("message", (data) => {
      const text = data.toString("utf8")
      frames.push(text)
      // The server answers the handshake with an empty object frame.
      if (frames.length === 1) {
        clearTimeout(timer)
        resolve()
      }
    })
    ws.on("error", reject)
    // signalrHub.ts verifies the token (a database read) before it starts
    // listening for messages, so a handshake sent the instant the socket
    // opens is dropped on a local connection. A real agent's own latency
    // hides this; here the send is delayed deliberately.
    ws.on("open", () => setTimeout(() => ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS), 300))
  })
  frames.length = 0 // drop the handshake reply; keep only what follows
  return { frames }
}

const settle = () => new Promise((r) => setTimeout(r, 250))

before(async () => {
  process.env.JWT_ACCESS_SECRET ??= "zz-test-access"
  process.env.JWT_REFRESH_SECRET ??= "zz-test-refresh"
  await prisma.organization.create({
    data: { id: `${P}org`, name: "Hub Wiring Org", slug: `${P}org`, contactName: "Test", contactEmail: "hub-wiring@test.local" },
  })
  await prisma.location.create({
    data: { id: `${P}loc`, organizationId: `${P}org`, name: "Hub Wiring Venue", address: "1 Test St", city: "Testville", region: "TS", country: "TS", timezone: "UTC" },
  })

  const hub: Hub = await import("../src/agent/signalrHub.js")
  registry = await import("../src/lib/agent-registry.js")
  server = http.createServer()
  hub.attachMusicServerHub(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as { port: number }).port
})

after(async () => {
  for (const ws of sockets) ws.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await prisma.musicServer.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.location.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.organization.deleteMany({ where: { id: { startsWith: P } } })
  await prisma.$disconnect()
})

describe("hub capability marker, end to end", () => {
  test("an agent advertising cmdfix receives a pushed command", async () => {
    const agent = await fixtureAgent("caps", "1.0.0") // version alone would NOT qualify
    const { frames } = await connectAgent(agent.token, "cmdfix")
    await settle()

    const pushed = registry.pushToAgent(agent.serverId, "ReceiveCommand", [{ commandId: `${P}cmd-1` }])
    await settle()

    assert.equal(pushed, true, "the cloud refused to push to an agent that advertised the fix")
    assert.equal(frames.length, 1, "the agent never received the pushed command")
    assert.match(frames[0], /ReceiveCommand/)
    assert.match(frames[0], new RegExp(`${P}cmd-1`))
  })

  test("the same agent build without the marker is never pushed to", async () => {
    const agent = await fixtureAgent("nocaps", "1.0.0")
    const { frames } = await connectAgent(agent.token) // no caps parameter
    await settle()

    const pushed = registry.pushToAgent(agent.serverId, "ReceiveCommand", [{ commandId: `${P}cmd-2` }])
    await settle()

    assert.equal(pushed, false, "an unfixed agent was woken by a push — it could run a command twice")
    assert.equal(frames.length, 0)
  })

  test("an unknown capability is ignored, and the agent still polls normally", async () => {
    const agent = await fixtureAgent("othercaps", "1.0.0")
    const { frames } = await connectAgent(agent.token, "somethingelse")
    await settle()

    assert.equal(registry.pushToAgent(agent.serverId, "ReceiveCommand", [{ commandId: `${P}cmd-3` }]), false)
    assert.equal(frames.length, 0)
  })
})
