import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { INSTALLER_DIR, INSTALLER_FILE } from "../routes/downloads.js"

const AGENT_PACKAGE_JSON = ["3-CONNECT-TO-CLOUD\\package.json", "3-CONNECT-TO-CLOUD/package.json"]

let cached: { key: string; version: string | null } | null = null

/** The agent version inside the installer the Settings page serves, or null. */
export function latestAgentVersion(): string | null {
  const full = path.join(INSTALLER_DIR, INSTALLER_FILE)
  let stat: fs.Stats
  try {
    stat = fs.statSync(full)
  } catch {
    return null
  }
  const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`
  if (cached?.key === key) return cached.version
  let version: string | null = null
  try {
    version = readAgentVersion(full, stat.size)
  } catch {
    version = null
  }
  cached = { key, version }
  return version
}

function readAgentVersion(file: string, size: number): string | null {
  const fd = fs.openSync(file, "r")
  try {
    const tailLength = Math.min(size, 22 + 0xffff)
    const tail = Buffer.alloc(tailLength)
    fs.readSync(fd, tail, 0, tailLength, size - tailLength)
    let eocd = -1
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return null
    const directorySize = tail.readUInt32LE(eocd + 12)
    const directoryOffset = tail.readUInt32LE(eocd + 16)
    if (directoryOffset + directorySize > size) return null
    const directory = Buffer.alloc(directorySize)
    fs.readSync(fd, directory, 0, directorySize, directoryOffset)
    let p = 0
    while (p + 46 <= directory.length && directory.readUInt32LE(p) === 0x02014b50) {
      const method = directory.readUInt16LE(p + 10)
      const compressedSize = directory.readUInt32LE(p + 20)
      const nameLength = directory.readUInt16LE(p + 28)
      const extraLength = directory.readUInt16LE(p + 30)
      const commentLength = directory.readUInt16LE(p + 32)
      const localOffset = directory.readUInt32LE(p + 42)
      const name = directory.toString("utf8", p + 46, p + 46 + nameLength)
      p += 46 + nameLength + extraLength + commentLength
      if (!AGENT_PACKAGE_JSON.includes(name)) continue
      const local = Buffer.alloc(30)
      fs.readSync(fd, local, 0, 30, localOffset)
      if (local.readUInt32LE(0) !== 0x04034b50) return null
      const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
      if (dataOffset + compressedSize > size) return null
      const data = Buffer.alloc(compressedSize)
      fs.readSync(fd, data, 0, compressedSize, dataOffset)
      const raw = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null
      if (!raw) return null
      const version = JSON.parse(raw.toString("utf8")).version
      return typeof version === "string" && version.trim() ? version.trim() : null
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
}
