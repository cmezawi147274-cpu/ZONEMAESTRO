#!/usr/bin/env node
// Builds, signs and publishes a remote update for venue PCs (agent + optional Music Server).
//
//   node ops/publish-update.mjs build --agent-dir <dir> [--music-server-dir <dir> --music-server-version <v>]
//        [--key /root/cmmp-update-signing/private.pem] [--out /root/update-staging] [--force]
//   node ops/publish-update.mjs publish --from <out> --dest <dir>
//
// The agent (lib/updater.js) installs only what a manifest signed by the CMMP
// update key names, byte for byte. Publishing needs the owner's explicit permission.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { createRequire } from "node:module";

// Public half of the update key; must equal the agent's lib/update-key.js (checked on build).
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAt1KJ5EVpKce3u/Hf9vqTyPFuzm8zFcfzId9BKY/l7z4=
-----END PUBLIC KEY-----
`;
const DEFAULT_KEY = "/root/cmmp-update-signing/private.pem";
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const VERSION_RX = /^\d+(\.\d+){1,3}$/;
const REQUIRED_AGENT_FILES = ["package.json", "bridge.js", "launcher.js", "lib/agent.js", "lib/config.js", "lib/updater.js"];
const MANIFEST_FILE = "manifest.signed.json";
const ZIP_LIMIT = 0xffffffff; // no zip64

// Agent package rules: tools/cmmp-agent-package.sh, plus launcher.js, minus test/.
const AGENT_FILES = [
  "bridge.js", "launcher.js", "package.json", "README.md", "START-HERE.md",
  "SETUP.cmd", "Setup.ps1", "UNINSTALL.cmd", "Sign-Kit.ps1", ".env.example",
];
const AGENT_DIRS = ["lib", "ui", "docs", "tools"];
const EXCLUDE_NAMES = new Set([
  ".env", "agent-state.json", "agent-state.pairing.json", "agent.log", "agent.log.old",
  "setup-task-error.txt", "node_modules", ".gitignore", ".git", ".update", "test",
]);
const excludedName = (name) =>
  EXCLUDE_NAMES.has(name) || (name.startsWith(".env") && name !== ".env.example") || /\.log(\.old)?$/i.test(name);

function die(msg) {
  console.error(`publish-update: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = new Set(["force"]);
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    if (flags.has(key)) { out[key] = true; continue; }
    if (i + 1 >= argv.length) die(`${a} needs a value`);
    out[key] = argv[++i];
  }
  return out;
}

// ---- zip writer (stored/deflate, local headers + central directory + EOCD) ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** entries: [{ name (forward slashes), src (absolute path) }], written in the given order. */
function writeZip(zipPath, entries) {
  if (entries.length > 0xfffe) throw new Error("too many files for a zip without zip64");
  const fd = fs.openSync(zipPath, "w");
  const central = [];
  let offset = 0;
  const put = (buf) => {
    fs.writeSync(fd, buf);
    offset += buf.length;
  };
  try {
    for (const e of entries) {
      const data = fs.readFileSync(e.src);
      if (data.length >= ZIP_LIMIT) throw new Error(`${e.name} is 4 GiB or larger (zip64 is not supported)`);
      const crc = crc32(data);
      let method = 0;
      let body = data;
      if (data.length > 0) {
        const deflated = zlib.deflateRawSync(data, { level: 9 });
        if (deflated.length < data.length) { method = 8; body = deflated; }
      }
      const name = Buffer.from(e.name, "utf8");
      const { time, date } = dosTime(fs.statSync(e.src).mtime);
      if (offset + 30 + name.length + body.length >= ZIP_LIMIT) throw new Error("the zip would reach 4 GiB (zip64 is not supported)");
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0x0800, 6); // UTF-8 names
      lh.writeUInt16LE(method, 8);
      lh.writeUInt16LE(time, 10);
      lh.writeUInt16LE(date, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(body.length, 18);
      lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      lh.writeUInt16LE(0, 28);
      const localOffset = offset;
      put(lh);
      put(name);
      put(body);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0800, 8);
      ch.writeUInt16LE(method, 10);
      ch.writeUInt16LE(time, 12);
      ch.writeUInt16LE(date, 14);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(body.length, 20);
      ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      // extra, comment, disk, internal and external attributes stay 0
      ch.writeUInt32LE(localOffset, 42);
      central.push(Buffer.concat([ch, name]));
    }
    const cdOffset = offset;
    for (const c of central) put(c);
    const cdSize = offset - cdOffset;
    if (offset + 22 >= ZIP_LIMIT) throw new Error("the zip would reach 4 GiB (zip64 is not supported)");
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    put(eocd);
  } finally {
    fs.closeSync(fd);
  }
}

// ---- file selection ----

/** Regular files under root/rel (forward-slash names, sorted); refuses links. */
function walk(root, rel, skip) {
  const out = [];
  const dir = path.join(root, ...rel.split("/").filter(Boolean));
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`refusing a link in the package: ${child}`);
    if (entry.isDirectory()) out.push(...walk(root, child, skip));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

const sortNames = (names) => [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function agentFileList(agentDir) {
  const names = [];
  for (const f of AGENT_FILES) {
    const st = fs.lstatSync(path.join(agentDir, f), { throwIfNoEntry: false });
    if (st && st.isSymbolicLink()) throw new Error(`refusing a link in the package: ${f}`);
    if (st && st.isFile()) names.push(f);
  }
  for (const d of AGENT_DIRS) {
    if (fs.existsSync(path.join(agentDir, d))) names.push(...walk(agentDir, d, excludedName));
  }
  return sortNames(names);
}

/** Every local file reachable by require() from the agent's entry points must be in the package. */
function checkRequireGraph(agentDir, included) {
  const have = new Set(included);
  const seen = new Set();
  const queue = ["launcher.js", "bridge.js", "ui/server.js"];
  const missing = [];
  const resolve = (fromRel, spec) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    for (const c of [base, `${base}.js`, `${base}.json`, `${base}/index.js`]) {
      const st = fs.statSync(path.join(agentDir, c), { throwIfNoEntry: false });
      if (st && st.isFile()) return c;
    }
    return null;
  };
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!have.has(rel)) missing.push(rel);
    if (!rel.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(agentDir, rel), "utf8");
    for (const m of src.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      const dep = resolve(rel, m[1]);
      if (!dep) missing.push(`${m[1]} (required by ${rel}, not found)`);
      else queue.push(dep);
    }
    for (const m of src.matchAll(/["']tools["']\s*,\s*["']([^"'/\\]+\.ps1)["']/g)) {
      if (!have.has(`tools/${m[1]}`)) missing.push(`tools/${m[1]} (used by ${rel})`);
    }
  }
  if (missing.length) throw new Error(`the agent package would miss files it needs at run time: ${sortNames(missing).join(", ")}`);
}

// ---- manifest checks (same rules as lib/updater.js verifyManifest) ----

function checkPart(part, label) {
  if (!part || typeof part !== "object") throw new Error(`update manifest: "${label}" is malformed`);
  if (typeof part.version !== "string" || !VERSION_RX.test(part.version)) throw new Error(`update manifest: bad ${label} version`);
  if (typeof part.file !== "string" || !SAFE_FILE_NAME.test(part.file)) throw new Error(`update manifest: bad ${label} file name`);
  if (typeof part.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(part.sha256)) throw new Error(`update manifest: bad ${label} sha256`);
  if (!Number.isSafeInteger(part.size) || part.size <= 0) throw new Error(`update manifest: bad ${label} size`);
}

function verifyManifest(body, publicKey) {
  if (!body || typeof body.manifest !== "string" || typeof body.signature !== "string") throw new Error("the manifest file is malformed");
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(body.manifest, "utf8"), publicKey, Buffer.from(body.signature, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) throw new Error("the manifest signature does not verify with the CMMP update public key");
  const manifest = JSON.parse(body.manifest);
  if (manifest.schema !== 1) throw new Error(`unsupported update manifest schema ${manifest.schema}`);
  if (manifest.agent != null) checkPart(manifest.agent, "agent");
  if (manifest.musicServer != null) checkPart(manifest.musicServer, "musicServer");
  if (!manifest.agent && !manifest.musicServer) throw new Error("the update manifest offers nothing");
  if (manifest.agent && manifest.musicServer && manifest.agent.file === manifest.musicServer.file) throw new Error("agent and musicServer use the same file name");
  return manifest;
}

function sha256File(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

function checkFile(dir, part, label) {
  const file = path.join(dir, part.file);
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st || !st.isFile()) throw new Error(`${label} file ${part.file} is missing from ${dir}`);
  if (st.size !== part.size) throw new Error(`${label} file ${part.file} is ${st.size} bytes, the manifest says ${part.size}`);
  if (sha256File(file) !== part.sha256) throw new Error(`${label} file ${part.file} does not match the manifest sha256`);
  return file;
}

function loadPublicKey(args) {
  if (args["verify-public-key"]) return crypto.createPublicKey(fs.readFileSync(path.resolve(args["verify-public-key"])));
  return crypto.createPublicKey(PUBLIC_KEY_PEM);
}

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

/** Same as lib/updater.js compareVersions. */
function compareVersions(a, b) {
  const pa = String(a || "").split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b || "").split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The exe's FileVersion string (what tools/Get-Health.ps1 reports as musicServerVersion), or null. */
function exeFileVersion(file) {
  const buf = fs.readFileSync(file);
  const at = buf.indexOf(Buffer.from("VS_VERSION_INFO\0", "utf16le"));
  if (at < 6) return null;
  const end = Math.min(buf.length, at - 6 + buf.readUInt16LE(at - 6));
  const key = buf.indexOf(Buffer.from("FileVersion\0", "utf16le"), at);
  if (key < 0 || key >= end) return null;
  const start = (key + 24 + 3) & ~3; // value is 32-bit aligned after the key
  return buf.toString("utf16le", start, Math.min(end, start + 256)).split("\0")[0].trim() || null;
}

// ---- build ----

async function build(args) {
  if (!args["agent-dir"]) die("build needs --agent-dir <dir>");
  const agentDir = path.resolve(args["agent-dir"]);
  const outDir = path.resolve(args.out || "/root/update-staging");
  const keyPath = path.resolve(args.key || DEFAULT_KEY);
  const msDir = args["music-server-dir"] ? path.resolve(args["music-server-dir"]) : null;
  const msVersion = args["music-server-version"] || null;
  if (Boolean(msDir) !== Boolean(msVersion)) die("--music-server-dir and --music-server-version go together");
  if (msVersion && !VERSION_RX.test(msVersion)) die(`bad --music-server-version ${msVersion}`);

  const require = createRequire(path.join(agentDir, "package.json"));
  const pkg = JSON.parse(fs.readFileSync(path.join(agentDir, "package.json"), "utf8"));
  const agentVersion = pkg.version;
  if (typeof agentVersion !== "string" || !VERSION_RX.test(agentVersion)) die(`agent package.json version ${agentVersion} is not like 2026.11.20`);
  const { extractZip } = require("./lib/unzip.js");
  const agentKeyPem = require("./lib/update-key.js");
  const publicKey = loadPublicKey(args);
  if (!args["verify-public-key"] &&
      !crypto.createPublicKey(agentKeyPem).export({ type: "spki", format: "der" }).equals(publicKey.export({ type: "spki", format: "der" }))) {
    die("the agent's lib/update-key.js is not the CMMP update key this tool knows - refusing");
  }

  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length && !args.force) die(`${outDir} is not empty (use --force to write into it anyway)`);

  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  } catch {
    die(`could not read a private key from ${keyPath}`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") die(`the key in ${keyPath} is not an ed25519 key`);

  const agentNames = agentFileList(agentDir);
  checkRequireGraph(agentDir, agentNames);
  for (const rel of REQUIRED_AGENT_FILES) if (!agentNames.includes(rel)) die(`the agent package would miss ${rel}`);

  let msNames = null;
  if (msDir) {
    msNames = sortNames(walk(msDir, "", (n) => /^appsettings.*\.json$/i.test(n) || /\.log$/i.test(n)));
    for (const rel of ["Service/MusicServer.Service.exe", "PlaybackHost/MusicServer.PlaybackHost.dll"]) {
      if (!msNames.includes(rel)) die(`--music-server-dir has no ${rel}`);
    }
    // Venue PCs compare the manifest version with the installed exe's FileVersion.
    const exeVersion = exeFileVersion(path.join(msDir, "Service", "MusicServer.Service.exe"));
    if (!exeVersion || compareVersions(exeVersion, msVersion) !== 0) {
      die(`--music-server-version ${msVersion} must equal Service/MusicServer.Service.exe FileVersion (${exeVersion || "none found"}), or venue PCs re-download it every hour or never install it`);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(outDir, ".build-"));
  try {
    const parts = {};
    const agentFile = `agent-${agentVersion}.zip`;
    writeZip(path.join(work, agentFile), agentNames.map((n) => ({ name: n, src: path.join(agentDir, ...n.split("/")) })));
    parts.agent = { version: agentVersion, file: agentFile };
    if (msDir) {
      const msFile = `music-server-${msVersion}.zip`;
      writeZip(path.join(work, msFile), msNames.map((n) => ({ name: n, src: path.join(msDir, ...n.split("/")) })));
      parts.musicServer = { version: msVersion, file: msFile };
    }
    for (const p of Object.values(parts)) {
      const zip = path.join(work, p.file);
      p.sha256 = sha256File(zip);
      p.size = fs.statSync(zip).size;
    }
    const manifestObj = { schema: 1, agent: parts.agent };
    if (parts.musicServer) manifestObj.musicServer = parts.musicServer;
    const manifest = JSON.stringify(manifestObj);
    const signature = crypto.sign(null, Buffer.from(manifest, "utf8"), privateKey).toString("base64");
    privateKey = null;

    // Self-check: signature, manifest rules, sizes/hashes, and the zips through the agent's own extractor.
    const m = verifyManifest({ manifest, signature }, publicKey);
    checkFile(work, m.agent, "agent");
    if (m.musicServer) checkFile(work, m.musicServer, "musicServer");
    const ex = path.join(work, "extract-agent");
    const written = await extractZip(path.join(work, m.agent.file), ex);
    if (written.length !== agentNames.length) throw new Error("the agent zip did not extract every file");
    for (const rel of REQUIRED_AGENT_FILES) {
      if (!fs.existsSync(path.join(ex, rel))) throw new Error(`the agent zip is missing ${rel}`);
    }
    if (JSON.parse(fs.readFileSync(path.join(ex, "package.json"), "utf8")).version !== m.agent.version) throw new Error("the agent zip's package.json version differs from the manifest");
    for (const rel of written) {
      if (!fs.readFileSync(path.join(ex, rel)).equals(fs.readFileSync(path.join(agentDir, rel)))) throw new Error(`the agent zip changed ${rel}`);
    }
    rmrf(ex);
    if (m.musicServer) {
      const exm = path.join(work, "extract-ms");
      const w = await extractZip(path.join(work, m.musicServer.file), exm);
      if (w.length !== msNames.length) throw new Error("the Music Server zip did not extract every file");
      for (const rel of ["Service/MusicServer.Service.exe", "PlaybackHost/MusicServer.PlaybackHost.dll"]) {
        if (!fs.existsSync(path.join(exm, rel))) throw new Error(`the Music Server zip is missing ${rel}`);
      }
      rmrf(exm);
    }

    fs.mkdirSync(path.join(outDir, "files"), { recursive: true });
    for (const p of [m.agent, m.musicServer].filter(Boolean)) fs.renameSync(path.join(work, p.file), path.join(outDir, "files", p.file));
    fs.writeFileSync(path.join(outDir, MANIFEST_FILE), JSON.stringify({ manifest, signature }));
    console.log(`Built and signed in ${outDir}:`);
    console.log(`  agent ${m.agent.version}: files/${m.agent.file} (${agentNames.length} files, ${m.agent.size} bytes, sha256 ${m.agent.sha256})`);
    if (m.musicServer) console.log(`  Music Server ${m.musicServer.version}: files/${m.musicServer.file} (${msNames.length} files, ${m.musicServer.size} bytes, sha256 ${m.musicServer.sha256})`);
    console.log(`Inspect it, then: node ops/publish-update.mjs publish --from ${outDir} --dest /opt/CMMP/downloads/updates`);
  } finally {
    rmrf(work);
  }
}

// ---- publish ----

function copyAtomic(src, dest) {
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function publish(args) {
  if (!args.from || !args.dest) die("publish needs --from <out> --dest <dir>");
  const from = path.resolve(args.from);
  const dest = path.resolve(args.dest);
  const body = JSON.parse(fs.readFileSync(path.join(from, MANIFEST_FILE), "utf8"));
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "manifest,signature") throw new Error(`${MANIFEST_FILE} must hold exactly {manifest, signature}`);
  const m = verifyManifest(body, loadPublicKey(args));
  const parts = [m.agent, m.musicServer].filter(Boolean);
  for (const p of parts) checkFile(path.join(from, "files"), p, p === m.agent ? "agent" : "musicServer");

  // Never change the bytes of a file a live manifest may name: a same-name file must be identical.
  const toCopy = parts.filter((p) => {
    if (!fs.existsSync(path.join(dest, "files", p.file))) return true;
    try {
      checkFile(path.join(dest, "files"), p, "already published");
    } catch (err) {
      throw new Error(`${err.message} - rebuild with a new version instead`);
    }
    return false;
  });
  fs.mkdirSync(path.join(dest, "files"), { recursive: true });
  for (const p of toCopy) {
    const target = path.join(dest, "files", p.file);
    copyAtomic(path.join(from, "files", p.file), target);
    checkFile(path.join(dest, "files"), p, "published");
  }
  const tmp = path.join(dest, `${MANIFEST_FILE}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify({ manifest: body.manifest, signature: body.signature }));
  fs.renameSync(tmp, path.join(dest, MANIFEST_FILE));
  console.log(`Published to ${dest}:`);
  if (m.agent) console.log(`  agent ${m.agent.version}: files/${m.agent.file} (${m.agent.size} bytes)`);
  if (m.musicServer) console.log(`  Music Server ${m.musicServer.version}: files/${m.musicServer.file} (${m.musicServer.size} bytes)`);
  console.log(`  ${MANIFEST_FILE} switched last. Withdraw by renaming it away.`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (cmd === "build") await build(args);
  else if (cmd === "publish") publish(args);
  else die("usage: publish-update.mjs build --agent-dir <dir> [...] | publish --from <out> --dest <dir>");
} catch (err) {
  die(err && err.message ? err.message : String(err));
}
