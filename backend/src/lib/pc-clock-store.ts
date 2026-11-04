import { prisma } from "./db.js"

const TABLE = "pc_clock.estimate"

const ENSURE_SQL = [
  `CREATE SCHEMA IF NOT EXISTS pc_clock`,
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
    server_id text PRIMARY KEY,
    error_ms double precision NOT NULL,
    measured_at timestamptz NOT NULL,
    time_zone text
  )`,
]

let ready: Promise<void> | null = null

function ensure(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      for (const sql of ENSURE_SQL) await prisma.$executeRawUnsafe(sql)
    })()
    ready.catch(() => {
      ready = null
    })
  }
  return ready
}

export async function loadPcClockEstimates(): Promise<{ serverId: string; errorMs: number; at: number; timeZone: string | null }[]> {
  await ensure()
  const rows = await prisma.$queryRawUnsafe<{ server_id: string; error_ms: number; measured_at: Date; time_zone: string | null }[]>(
    `SELECT server_id, error_ms, measured_at, time_zone FROM ${TABLE}`
  )
  return rows.map((r) => ({ serverId: r.server_id, errorMs: Number(r.error_ms), at: new Date(r.measured_at).getTime(), timeZone: r.time_zone }))
}

export async function savePcClockEstimate(serverId: string, estimate: { errorMs: number; at: number; timeZone: string | null } | null) {
  await ensure()
  if (!estimate) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE server_id = $1`, serverId)
    return
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TABLE} (server_id, error_ms, measured_at, time_zone) VALUES ($1, $2, $3, $4)
     ON CONFLICT (server_id) DO UPDATE SET error_ms = EXCLUDED.error_ms, measured_at = EXCLUDED.measured_at, time_zone = EXCLUDED.time_zone`,
    serverId,
    estimate.errorMs,
    new Date(estimate.at),
    estimate.timeZone
  )
}
