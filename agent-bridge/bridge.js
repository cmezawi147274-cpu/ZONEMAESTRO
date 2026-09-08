#!/usr/bin/env node
/**
 * CMMP Agent Bridge
 * ------------------
 * The compiled Windows agent shipped in MusicServer-Full-Setup-Package
 * (MusicServer.Api.exe / MusicServer.Service.exe) does NOT implement the
 * CMMP cloud-pairing protocol described in backend/README.md — its own
 * "cloud" surface is a bundled loopback mini-cloud for the mobile app,
 * with no field anywhere for a CMMP pairing code, and there is no source
 * for those binaries on this machine to extend.
 *
 * This process is the missing piece: it speaks the CMMP backend's
 * documented agent protocol (backend/src/routes/agent.ts) on one side,
 * and drives the local MusicServer's own already-working REST API on
 * 127.0.0.1:8765 on the other — the same API a human drives from its
 * Setup UI, so every command produces genuine LibVLC playback and every
 * "cached" track is really downloaded into the local music folder.
 *
 * It also serves its own local control panel (ui/) which closes the two
 * gaps the compiled Setup UI cannot: entering a CMMP pairing code, and
 * a Zones page with real Previous / Next transport.
 *
 * Runs unchanged on Windows and Linux — plain Node, no dependencies.
 * Config: environment variables (see .env.example / README.md).
 */
"use strict";

const { env, getState } = require("./lib/config");
const { log } = require("./lib/log");
const cmmp = require("./lib/cmmp");
const agent = require("./lib/agent");
const { startUi } = require("./ui/server");

async function main() {
  log(`CMMP Agent Bridge ${env.agentVersion} starting. CMMP=${env.cmmpApiUrl} LOCAL=${env.localApiUrl}`);

  // The control panel comes up first and unconditionally, so an unpaired
  // (or misconfigured) agent is still reachable — that is exactly when an
  // operator needs it.
  startUi();

  if (!getState().agentToken && env.pairingCode) {
    // Legacy/unattended path: PAIRING_CODE in .env still works for
    // scripted installs. Interactive pairing happens in the panel.
    try {
      await cmmp.pair(env.pairingCode);
    } catch (err) {
      log.error(`Pairing with the code in .env failed: ${err.message}`);
    }
  }

  if (getState().agentToken) {
    await agent.start();
  } else {
    log.warn(
      `Not paired yet. Open http://${env.uiHost === "0.0.0.0" ? "127.0.0.1" : env.uiHost}:${env.uiPort} ` +
        `and paste the pairing code from the cloud portal (Location → Register Server).`
    );
  }
}

main().catch((err) => {
  log.error("Fatal:", err.message);
  process.exit(1);
});
