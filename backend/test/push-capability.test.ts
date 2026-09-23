/**
 * Push gating: who is allowed to receive a MusicServerHub push.
 *
 * A fixed and an unfixed agent can report the same version ("1.0.0"), so the
 * version cannot answer this. The agent states it on connect with
 * `caps=cmdfix` (agent-bridge/lib/hub.js), which agent/signalrHub.ts passes
 * to registerHubSocket. Anything else keeps using the REST poll, exactly as
 * it always has.
 *
 * Pure unit test: no HTTP, no database. lib/agent-registry.ts pulls in
 * lib/env.ts, which demands a few vars, so they are stubbed before import.
 */
import { test, describe, before } from "node:test"
import assert from "node:assert/strict"

type Registry = typeof import("../src/lib/agent-registry.js")
let registry: Registry

before(async () => {
  process.env.DATABASE_URL ??= "postgresql://zz:zz@127.0.0.1:5432/zz"
  process.env.JWT_ACCESS_SECRET ??= "zz-test-access"
  process.env.JWT_REFRESH_SECRET ??= "zz-test-refresh"
  registry = await import("../src/lib/agent-registry.js")
})

/** Minimal stand-in for the `ws` socket the hub registers. */
function fakeSocket() {
  const sent: string[] = []
  return {
    OPEN: 1,
    readyState: 1,
    sent,
    send(frame: string) {
      sent.push(frame)
    },
    on() {},
  }
}

describe("pushToAgent capability gate", () => {
  test("a socket that advertised cmdfix receives the push", () => {
    const id = `zz-push-${Date.now()}-a`
    const ws = fakeSocket()
    registry.registerHubSocket(id, ws as never, { pushCapable: true })

    assert.equal(registry.pushToAgent(id, "ReceiveCommand", [{ commandId: "zz-1" }]), true)
    assert.equal(ws.sent.length, 1)
    assert.match(ws.sent[0], /ReceiveCommand/)
  })

  test("a socket without the capability is never pushed to", () => {
    const id = `zz-push-${Date.now()}-b`
    const ws = fakeSocket()
    registry.registerHubSocket(id, ws as never)

    assert.equal(registry.pushToAgent(id, "ReceiveCommand", [{ commandId: "zz-2" }]), false)
    assert.equal(ws.sent.length, 0, "an unfixed agent must not be woken by a push")
  })

  test("no socket at all means no push, and no crash", () => {
    assert.equal(registry.pushToAgent(`zz-push-${Date.now()}-c`, "ReceiveCommand", []), false)
  })
})
