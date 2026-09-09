"use strict";

/**
 * Equalizer support via Equalizer APO, for every zone and every output device.
 *
 * Why this exists: the compiled MusicServer service has no audio-processing
 * surface at all — its per-zone action set is fixed (play, resume, pause,
 * stop, skip, volume, mute, unmute) and `POST /zones/:id/eq` answers
 * `404 Unknown action: eq`, as do equalizer/dsp/effects/gain/balance. So a
 * CMMP SET_EQ cannot be satisfied inside MusicServer.
 *
 * Equalizer APO sits below it, in the Windows audio stack, attached to an
 * output *device*. Every zone is bound to exactly one device
 * (`zone.audioDeviceId`, an MMDevice id like
 * "{0.0.0.00000000}.{43cf5731-f0c7-4287-9964-0ee34dcf254e}"), so per-zone EQ
 * is per-device EQ, and it applies to whatever LibVLC plays through it.
 *
 * Layout written here:
 *   config/config.txt        — one `Device: <name>` block per zone, each
 *                              including that zone's own file
 *   config/cmmp-zone-<id>.txt — that zone's curve
 * Equalizer APO watches these files and applies edits live: no restart of
 * MusicServer, the bridge, or APO itself.
 *
 * Anything this module cannot genuinely do throws a real Error, which
 * lib/agent.js's executeCommand() acks FAILED with — the same honesty
 * pattern as REBOOT_SERVER. It never reports success it did not achieve.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * Writes `data` to `filePath` without ever exposing a reader (Equalizer
 * APO's file watcher/reloader) to a partial or locked file.
 *
 * Root cause this fixes: writing config.txt in place raced Equalizer APO's
 * own reload of that same file — a write landing while APO still had it
 * open for read threw `EBUSY: resource busy or locked`. Writing to a temp
 * file in the same directory and renaming it over the target is atomic on
 * NTFS (fs.renameSync -> MoveFileEx with MOVEFILE_REPLACE_EXISTING), so a
 * watcher only ever sees the old complete file or the new complete file,
 * never a half-written or exclusively-locked one.
 */
function writeFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );
  fs.writeFileSync(tmp, data, "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

/**
 * Serializes async work per key so two EQ updates for the same server never
 * race each other, regardless of how close together they arrive. Each call
 * chains onto the previous promise for that key; failures don't wedge the
 * queue for later calls.
 */
const queues = new Map();
function withLock(key, fn) {
  const prior = queues.get(key) || Promise.resolve();
  const run = prior.then(fn, fn);
  // Keep the chain alive for the next caller even if this one throws.
  queues.set(
    key,
    run.then(
      () => {},
      () => {}
    )
  );
  return run;
}

const APO_DIRS = ["C:\\Program Files\\EqualizerAPO", "C:\\Program Files (x86)\\EqualizerAPO"];

/** ISO 10-band centre frequencies, index-matched to CMMP's `bands[10]`. */
const BAND_HZ = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const MMDEV_RENDER = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render";
/** Device description ("Headphones", "Speakers") — what APO matches `Device:` against. */
const NAME_VALUE = "{a45c254e-df1c-4efd-8020-67d146a850e0},2";

function apoDir() {
  const dir = APO_DIRS.find((d) => fs.existsSync(path.join(d, "EqualizerAPO.dll")));
  if (!dir) {
    throw new Error(
      "Equalizer APO is not installed on this PC, so there is nothing that can apply an EQ curve here. " +
        "Install it and enable it on this zone's output device."
    );
  }
  return dir;
}

const configDir = () => path.join(apoDir(), "config");

/**
 * "{0.0.0.00000000}.{43cf5731-...}" -> "{43cf5731-...}".
 * The MMDevice id's trailing brace group is the render device's own GUID,
 * which is the key under ...\MMDevices\Audio\Render.
 */
function deviceGuidOf(audioDeviceId) {
  const groups = String(audioDeviceId || "").match(/\{[0-9a-fA-F-]{36}\}/g);
  return groups && groups.length ? groups[groups.length - 1] : null;
}

/**
 * The device's friendly description, read from the same registry key
 * Windows and Equalizer APO both read. Returns null when the device is
 * unknown — the caller turns that into a real, actionable error rather than
 * writing a config block that would silently match nothing.
 */
function deviceNameOf(guid) {
  if (!guid) return null;
  try {
    const out = execFileSync(
      "reg",
      ["query", `${MMDEV_RENDER}\\${guid}\\Properties`, "/v", NAME_VALUE],
      { encoding: "utf8", windowsHide: true }
    );
    const m = out.match(/REG_SZ\s+(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** Is Equalizer APO actually attached to this device? A curve written for a
 * device APO is not hooked into would be a silent no-op. */
function apoEnabledOn(guid) {
  try {
    const out = execFileSync("reg", ["query", `${MMDEV_RENDER}\\${guid}\\FxProperties`], {
      encoding: "utf8",
      windowsHide: true,
    });
    return /EC1CC9CE|B48F9B61|EqualizerAPO/i.test(out);
  } catch {
    return false;
  }
}

const clampDb = (v) => Math.max(-20, Math.min(20, Number(v) || 0));
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/**
 * CMMP sends each tone effect as `{ on: boolean, amount: 0..100 }`.
 *
 * Reading that as a plain truthiness test is what silently broke EQ on this
 * server: `{ on: false }` is a truthy *object*, so every curve — whatever
 * CMMP asked for — was written with the same welded-on +6 dB/120 Hz,
 * +4 dB/100 Hz and +3 dB/8 kHz shelves, and a preamp large enough to make
 * room for them. Two deliberately opposite presets then differed only in
 * their (comparatively small) graphic bands underneath an identical, much
 * louder shelf pair, so they sounded like the same over-bassy, quiet
 * preset. `amount` was ignored entirely, so a 5% bass lift and a 100% one
 * were the same 6 dB.
 *
 * Returns 0..1: 0 = off (emit nothing at all), 1 = full strength. A bare
 * boolean or number is tolerated so older/newer payload shapes still work.
 */
function effectStrength(effect) {
  if (effect == null) return 0;
  if (typeof effect === "boolean") return effect ? 1 : 0;
  if (typeof effect === "number") return clamp01(effect / 100);
  if (typeof effect !== "object") return 0;
  if (effect.on !== true) return 0;
  return effect.amount == null ? 1 : clamp01(Number(effect.amount) / 100);
}

/** Shelf gains at `amount: 100`, in dB. */
const BASS_BOOST = { fc: 120, maxDb: 9 };
const LOUDNESS_LOW = { fc: 100, maxDb: 6 };
const LOUDNESS_HIGH = { fc: 8000, maxDb: 4 };

/**
 * Approximate gain a shelf contributes at frequency `f`, used only to size
 * the preamp. A low shelf tends to its full gain below Fc and to 0 above it
 * (half gain at Fc); a high shelf is the mirror image.
 */
const shelfGainAt = (sh, f) =>
  sh.type === "LSC" ? sh.gain / (1 + (f / sh.fc) ** 2) : sh.gain / (1 + (sh.fc / f) ** 2);

/**
 * CMMP's ZoneEqualizerSettings -> Equalizer APO filter lines.
 *
 * The preamp is derived from the *actual* peak boost rather than left at a
 * fixed value: boosting bands without headroom is what makes an equalizer
 * sound worse than no equalizer at all, because the summed signal clips.
 * It is measured per frequency (graphic band + whatever the shelves add
 * there) rather than by summing each part's global maximum, which used to
 * over-attenuate by 10 dB or more for boosts that never overlap.
 * A flat curve yields `Preamp: 0 dB` and a bit-transparent pass-through, so
 * enabling EQ without changing anything costs no quality.
 */
function curveFor(settings) {
  const s = settings || {};
  const bands = Array.isArray(s.bands) ? s.bands : [];
  const gains = BAND_HZ.map((_, i) => clampDb(bands[i]));

  const lines = [];
  lines.push(`# Generated by the CMMP agent bridge — do not edit by hand.`);

  if (s.enabled === false) {
    // Full bypass, not "every band at 0": a flat curve still carries the
    // preamp and the shelves, which is not what `enabled: false` means.
    lines.push("Preamp: 0 dB");
    lines.push("# EQ disabled for this zone: flat, bit-transparent pass-through.");
    return lines.join("\r\n") + "\r\n";
  }

  // bassBoost / loudness are real, well-defined shelves, scaled by the
  // strength CMMP asked for. `virtualizer` has no faithful APO equivalent,
  // so it is reported as unsupported instead of being approximated into
  // something the operator did not ask for.
  const bass = effectStrength(s.bassBoost);
  const loud = effectStrength(s.loudness);
  const virt = effectStrength(s.virtualizer);

  const shelves = [];
  if (bass > 0) shelves.push({ type: "LSC", fc: BASS_BOOST.fc, gain: BASS_BOOST.maxDb * bass });
  if (loud > 0) {
    shelves.push({ type: "LSC", fc: LOUDNESS_LOW.fc, gain: LOUDNESS_LOW.maxDb * loud });
    shelves.push({ type: "HSC", fc: LOUDNESS_HIGH.fc, gain: LOUDNESS_HIGH.maxDb * loud });
  }
  // A shelf that rounds away to 0.0 dB is a filter that does nothing.
  const active = shelves.filter((sh) => Number(sh.gain.toFixed(1)) !== 0);

  // Probe the band centres plus the two shelf plateaus, where a shelf's
  // contribution is largest.
  const probes = [20, ...BAND_HZ, 20000];
  const boostAt = (f, graphic) =>
    graphic + active.reduce((sum, sh) => sum + shelfGainAt(sh, f), 0);
  // Outside the band centres the graphic EQ holds the nearest band's gain.
  const graphicAt = (f) => {
    let best = 0;
    let bestDist = Infinity;
    BAND_HZ.forEach((hz, i) => {
      const d = Math.abs(Math.log2(f / hz));
      if (d < bestDist) {
        bestDist = d;
        best = gains[i];
      }
    });
    return best;
  };
  const peak = Math.max(0, ...probes.map((f) => boostAt(f, graphicAt(f))));
  // Half a dB of slack keeps inter-sample peaks from clipping too.
  const preamp = peak > 0 ? -(peak + 0.5) : 0;

  lines.push(`Preamp: ${preamp.toFixed(1)} dB`);
  lines.push(`GraphicEQ: ${BAND_HZ.map((hz, i) => `${hz} ${gains[i].toFixed(1)}`).join("; ")}`);
  for (const sh of active) {
    lines.push(`Filter: ON ${sh.type} Fc ${sh.fc} Hz Gain ${sh.gain.toFixed(1)} dB Q 0.7`);
  }
  if (virt > 0) {
    lines.push("# NOTE: 'virtualizer' has no Equalizer APO equivalent and was not applied.");
  }
  return lines.join("\r\n") + "\r\n";
}

const zoneFileName = (zoneId) => `cmmp-zone-${String(zoneId).replace(/[^A-Za-z0-9._-]/g, "_")}.txt`;

/**
 * Rebuilds config.txt from every per-zone file currently on disk, so each
 * device gets only its own zone's curve and zones never bleed into one
 * another. Rewritten wholesale (rather than appended to) so a zone that is
 * re-pointed at a different device does not leave a stale block behind.
 */
function rebuildRootConfig(dir, mapping) {
  const lines = [
    "# Generated by the CMMP agent bridge — do not edit by hand.",
    "# One block per zone, scoped to that zone's own output device.",
    "",
  ];
  for (const { deviceName, file } of mapping) {
    lines.push(`Device: ${deviceName}`);
    lines.push(`Include: ${file}`);
    lines.push("");
  }
  writeFileAtomic(path.join(dir, "config.txt"), lines.join("\r\n"));
}

/** Every zone file present, paired with the device it was written for. */
function readMapping(dir) {
  const map = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^cmmp-zone-.*\.txt$/.test(f)) continue;
    const head = fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/)[1] || "";
    const m = head.match(/^# device:\s*(.+)$/i);
    if (m) map.push({ deviceName: m[1].trim(), file: f });
  }
  return map;
}

/**
 * Applies `settings` to the device `zone` is bound to. Returns a summary of
 * what was really written, which the bridge reports back to CMMP.
 */
function applyZoneEqualizer(zone, settings) {
  if (!zone) throw new Error("Zone not found on this server, so its output device is unknown.");
  const guid = deviceGuidOf(zone.audioDeviceId);
  if (!guid) {
    throw new Error(
      `Zone "${zone.zoneName || zone.zoneId}" has no output device bound to it, so there is nothing to equalize. ` +
        "Assign an audio device to the zone first."
    );
  }
  const deviceName = deviceNameOf(guid);
  if (!deviceName) {
    throw new Error(`This PC has no audio device ${guid} any more — the zone points at a device that is gone.`);
  }
  if (!apoEnabledOn(guid)) {
    throw new Error(
      `Equalizer APO is not enabled on "${deviceName}". Run DeviceSelector.exe in ` +
        `${apoDir()}, tick that device, and reboot — until then no EQ can reach this zone.`
    );
  }

  const dir = configDir();
  // Serialized per config directory (i.e. per server/APO install): two EQ
  // requests arriving close together — even for different zones, since they
  // share one config.txt — write one after the other instead of racing.
  return withLock(dir, () => {
    const file = zoneFileName(zone.zoneId);
    const body = curveFor(settings);
    // Line 2 records the device so rebuildRootConfig can re-scope every zone.
    const withDevice = body.replace(/\r\n/, `\r\n# device: ${deviceName}\r\n`);
    writeFileAtomic(path.join(dir, file), withDevice);

    rebuildRootConfig(dir, readMapping(dir));
    return { deviceName, file, enabled: settings && settings.enabled !== false };
  });
}

/**
 * Deletes config for zones that no longer exist on this server.
 *
 * Without this, deleting a zone in CMMP (or re-pairing to a different
 * server, which retires the old zone ids) would leave that zone's curve
 * applied to its output device for ever — silently colouring whatever zone
 * uses that device next, with nothing in the portal to explain why.
 */
function pruneStaleZones(validZoneIds) {
  const dir = configDir();
  return withLock(dir, () => {
    const keep = new Set((validZoneIds || []).map((id) => zoneFileName(id)));
    const removed = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/^cmmp-zone-.*.txt$/.test(f)) continue;
      if (keep.has(f)) continue;
      fs.unlinkSync(path.join(dir, f));
      removed.push(f);
    }
    if (removed.length) rebuildRootConfig(dir, readMapping(dir));
    return removed;
  });
}

module.exports = {
  applyZoneEqualizer,
  pruneStaleZones,
  deviceGuidOf,
  deviceNameOf,
  apoEnabledOn,
  apoDir,
  configDir,
  curveFor,
  BAND_HZ,
};
