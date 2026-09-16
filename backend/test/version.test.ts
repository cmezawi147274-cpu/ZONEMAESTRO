/**
 * Agent version comparison — the only visibility there is into an outdated
 * fleet, since there is no inbound path to a venue and therefore no remote
 * update. A bug here is silent: servers simply never get flagged and the
 * fleet view reads as healthy.
 *
 * The reported string has already changed shape once (venues shipped
 * "0.2.0-bridge"; the v1.0.0 release reports plain semver) and is read from
 * the agent's package.json, so it will keep moving.
 *
 * Pure unit test — lib/version.ts has no imports, so this needs no running
 * backend and no database.
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { agentVersionStatus, isVersionBelow } from "../src/lib/version.js"

const MIN = "1.0.0"

describe("agentVersionStatus", () => {
  test("the format venues in the field actually report sorts below 1.0.0", () => {
    // Pre-release venues shipped this exact string and cannot be upgraded
    // remotely — a technician has to run SETUP.cmd on the PC. If the cloud
    // cannot read it, those are precisely the venues that vanish from the
    // fleet view instead of being flagged for a visit.
    assert.equal(agentVersionStatus("0.2.0-bridge", MIN), "outdated")
    assert.equal(isVersionBelow("0.2.0-bridge", MIN), true)
  })

  test("the current release reads as current", () => {
    assert.equal(agentVersionStatus("1.0.0", MIN), "current")
    assert.equal(isVersionBelow("1.0.0", MIN), false)
  })

  test("a missing version is unknown, never current and never outdated", () => {
    // The distinction matters: "unknown" means nobody can tell what this
    // venue runs, which needs looking at. Reporting it as current would
    // hide it; reporting it as outdated would send a technician for nothing.
    assert.equal(agentVersionStatus(null, MIN), "unknown")
    assert.equal(agentVersionStatus(undefined, MIN), "unknown")
    assert.equal(agentVersionStatus("", MIN), "unknown")
    assert.equal(isVersionBelow(null, MIN), false)
  })

  test("garbage is unknown, not silently passed", () => {
    for (const garbage of ["—", "not-a-version", "v1.0.0", "1.x.0", "1..0", "  ", "-1.0.0", "NaN"]) {
      assert.equal(agentVersionStatus(garbage, MIN), "unknown", `"${garbage}" should be unknown`)
      assert.equal(isVersionBelow(garbage, MIN), false, `"${garbage}" must never be reported as outdated`)
    }
  })

  test("no configured minimum means unknown rather than a blanket pass", () => {
    assert.equal(agentVersionStatus("1.0.0", null), "unknown")
    assert.equal(agentVersionStatus("0.2.0-bridge", null), "unknown")
    assert.equal(agentVersionStatus("1.0.0", "garbage"), "unknown")
  })

  test("ordinary ordering, including differing lengths", () => {
    assert.equal(agentVersionStatus("0.9.9", "1.0.0"), "outdated")
    assert.equal(agentVersionStatus("1.0.1", "1.0.0"), "current")
    assert.equal(agentVersionStatus("1.1.0", "1.0.0"), "current")
    assert.equal(agentVersionStatus("2.0.0", "1.0.0"), "current")
    assert.equal(agentVersionStatus("1.0", "1.0.0"), "current")
    assert.equal(agentVersionStatus("1.0", "1.0.1"), "outdated")
    assert.equal(agentVersionStatus("1.0.0-rc1", "1.0.0"), "current")
  })
})
