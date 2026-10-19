import crypto from "node:crypto"
import type { Prisma } from "@prisma/client"
import { prisma } from "../lib/db.js"
import { env } from "../lib/env.js"

export const FIXTURE_PREFIX = "zz"

export interface Term {
  index: number
  startedAt: string
  endsAt: string
  reason: "initial" | "renewal"
  confirmedBy: { type: "system"; label: string } | { type: "user"; userId: string; email: string }
}

export interface SubscriptionEvent {
  id: string
  type: string
  at: string
  term: number
  [key: string]: unknown
}

export interface SubscriptionRecord {
  serverId: string
  id: string
  startedAt: string
  endsAt: string
  status: string
  createdByConnection: Record<string, unknown>
  terms: Term[]
  events: SubscriptionEvent[]
  notes: string
  reminderDays: number[]
  dismissed: { term: number; threshold: number; at: string }[]
  connectionCount: number
  lastConnectionAt: string
  durationMonths: number
}

export interface ServerInfo {
  serverId: string
  name: string
  organizationId: string
  organizationName: string | null
  serverStatus: string
}

export interface ConnectionMeta {
  source: string
  serverId: string
  serverName: string | null
  organizationId: string | null
  version: string | null
  ipAddress: string | null
  caps: string[]
}

export interface Actor {
  userId: string
  email: string
}

const TABLE = "subscription.server_record"
const LEGACY_TABLE = "subscription.record"
const CARRIED_OVER_NOTE = "This connection count and last connection were fleet-wide before the per-server change."

const ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`
const iso = (expr: string) => `to_char((${expr}) AT TIME ZONE 'UTC', ${ISO_FORMAT})`
const plus12Months = (expr: string) => `(((${expr}) AT TIME ZONE 'UTC') + interval '12 months') AT TIME ZONE 'UTC'`
const plusMonths = (expr: string, months: string) => `(((${expr}) AT TIME ZONE 'UTC') + make_interval(months => ${months})) AT TIME ZONE 'UTC'`

const thresholdEvents = (nowParam: string) => `COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'id', gen_random_uuid()::text,
    'type', 'threshold',
    'threshold', t.label,
    'term', jsonb_array_length(r.terms),
    'at', ${iso(`${nowParam}::timestamptz`)},
    'crossedAt', ${iso(`r.ends_at - t.days * interval '24 hours'`)}
  ) ORDER BY t.ord)
  FROM (VALUES ('90', 90, 1), ('30', 30, 2), ('7', 7, 3), ('1', 1, 4), ('ended', 0, 5)) AS t(label, days, ord)
  WHERE r.ends_at - t.days * interval '24 hours' <= ${nowParam}::timestamptz
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(r.events) AS e
      WHERE e->>'type' = 'threshold' AND e->>'threshold' = t.label AND (e->>'term')::int = jsonb_array_length(r.terms)
    )
), '[]'::jsonb)`

const event = (type: string, nowParam: string, extra = "") =>
  `jsonb_build_array(jsonb_build_object('id', gen_random_uuid()::text, 'type', '${type}', 'at', ${iso(`${nowParam}::timestamptz`)}, 'term', jsonb_array_length(r.terms)${extra}))`

const ENSURE_SQL = [
  `CREATE SCHEMA IF NOT EXISTS subscription`,
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
    server_id text PRIMARY KEY,
    id text NOT NULL,
    started_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'active',
    created_by_connection jsonb NOT NULL,
    terms jsonb NOT NULL,
    events jsonb NOT NULL,
    notes text NOT NULL DEFAULT '',
    reminder_days jsonb NOT NULL,
    dismissed jsonb NOT NULL DEFAULT '[]'::jsonb,
    connection_count integer NOT NULL,
    last_connection_at timestamptz NOT NULL
  )`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS duration_months integer NOT NULL DEFAULT 12 CHECK (duration_months BETWEEN 1 AND 60)`,
]

const LEGACY_EXISTS_SQL = `SELECT to_regclass('${LEGACY_TABLE}') IS NOT NULL AS present`

const COPY_LEGACY_SQL = `INSERT INTO ${TABLE} (
    server_id, id, started_at, ends_at, status, created_by_connection, terms, events,
    notes, reminder_days, dismissed, connection_count, last_connection_at
  )
  SELECT
    l.created_by_connection->>'serverId', l.id, l.started_at, l.ends_at, l.status, l.created_by_connection, l.terms,
    l.events || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text,
      'type', 'carried_over',
      'at', ${iso("$1::timestamptz")},
      'term', jsonb_array_length(l.terms),
      'note', $2::text
    )),
    l.notes, l.reminder_days, l.dismissed, l.connection_count, l.last_connection_at
  FROM ${LEGACY_TABLE} AS l
  WHERE COALESCE(l.created_by_connection->>'serverId', '') <> ''
  ON CONFLICT (server_id) DO NOTHING
  RETURNING server_id`

const CONNECTION_SQL = `INSERT INTO ${TABLE} AS r (
    server_id, id, started_at, ends_at, status, created_by_connection,
    terms, events, notes, reminder_days, dismissed, connection_count, last_connection_at
  ) VALUES (
    $1, $2, $3::timestamptz, ${plus12Months("$3::timestamptz")}, 'active', $4::jsonb,
    jsonb_build_array(jsonb_build_object(
      'index', 1,
      'startedAt', ${iso("$3::timestamptz")},
      'endsAt', ${iso(plus12Months("$3::timestamptz"))},
      'reason', 'initial',
      'confirmedBy', jsonb_build_object('type', 'system', 'label', 'First venue connection')
    )),
    jsonb_build_array(jsonb_build_object('id', gen_random_uuid()::text, 'type', 'created', 'at', ${iso("$3::timestamptz")}, 'term', 1)),
    '', '[90, 30, 7, 1]'::jsonb, '[]'::jsonb, 1, $3::timestamptz
  )
  ON CONFLICT (server_id) DO UPDATE SET
    connection_count = r.connection_count + 1,
    last_connection_at = EXCLUDED.last_connection_at,
    events = r.events || ${thresholdEvents("$3")}
  RETURNING (xmax::text = '0') AS inserted`

const RESTART_SQL = `UPDATE ${TABLE} AS r SET
    events = r.events || ${event("restarted", "$1")} || ${thresholdEvents("$1")}
  RETURNING r.server_id`

const NOTES_SQL = `UPDATE ${TABLE} AS r SET
    notes = $2,
    events = r.events || ${event("note_saved", "$3", `, 'by', $4::jsonb`)}
  WHERE r.server_id = $1
  RETURNING r.*`

const REMINDERS_SQL = `UPDATE ${TABLE} AS r SET
    reminder_days = $2::jsonb,
    events = r.events || ${event("reminders_saved", "$3", `, 'by', $4::jsonb, 'reminderDays', $2::jsonb`)}
  WHERE r.server_id = $1
  RETURNING r.*`

const DISMISS_SQL = `UPDATE ${TABLE} AS r SET
    dismissed = r.dismissed || jsonb_build_array(jsonb_build_object('term', jsonb_array_length(r.terms), 'threshold', $2::int, 'at', ${iso("$3::timestamptz")}))
  WHERE r.server_id = $1
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(r.dismissed) AS d
      WHERE (d->>'term')::int = jsonb_array_length(r.terms) AND (d->>'threshold')::int = $2::int
    )
  RETURNING r.*`

const EXPORT_SQL = `UPDATE ${TABLE} AS r SET
    events = r.events || ${event("exported", "$2", `, 'by', $3::jsonb, 'format', $4::text`)}
  WHERE r.server_id = $1
  RETURNING r.*`

const newStart = `CASE WHEN r.ends_at > $2::timestamptz THEN r.ends_at ELSE $2::timestamptz END`

const RENEW_SQL = `UPDATE ${TABLE} AS r SET
    ends_at = ${plusMonths(newStart, "r.duration_months")},
    terms = r.terms || jsonb_build_array(jsonb_build_object(
      'index', jsonb_array_length(r.terms) + 1,
      'startedAt', ${iso(newStart)},
      'endsAt', ${iso(plusMonths(newStart, "r.duration_months"))},
      'reason', 'renewal',
      'confirmedBy', jsonb_build_object('type', 'user', 'userId', $3::jsonb->>'userId', 'email', $3::jsonb->>'email')
    )),
    events = r.events || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text,
      'type', 'renewal_confirmed',
      'at', ${iso("$2::timestamptz")},
      'term', jsonb_array_length(r.terms) + 1,
      'by', $3::jsonb,
      'previousEndsAt', ${iso("r.ends_at")},
      'endsAt', ${iso(plusMonths(newStart, "r.duration_months"))}
    ))
  WHERE r.server_id = $1 AND to_char(r.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $4
  RETURNING r.*`

const currentTermStart = `((r.terms -> (jsonb_array_length(r.terms) - 1)) ->> 'startedAt')::timestamptz`
const newEnd = plusMonths(currentTermStart, "$2::int")

const DURATION_SQL = `UPDATE ${TABLE} AS r SET
    ends_at = ${newEnd},
    duration_months = $2::int,
    terms = jsonb_set(r.terms, ARRAY[(jsonb_array_length(r.terms) - 1)::text, 'endsAt'], to_jsonb(${iso(newEnd)})),
    events = r.events || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text,
      'type', 'duration_changed',
      'at', ${iso("$3::timestamptz")},
      'term', jsonb_array_length(r.terms),
      'by', $4::jsonb,
      'previousDurationMonths', r.duration_months,
      'durationMonths', $2::int,
      'previousEndsAt', ${iso("r.ends_at")},
      'endsAt', ${iso(newEnd)}
    ))
  WHERE r.server_id = $1 AND to_char(r.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $5
  RETURNING r.*`

const READ_ONE_SQL = `SELECT * FROM ${TABLE} WHERE server_id = $1`
const READ_ALL_SQL = `SELECT * FROM ${TABLE}`
const CLOCK_SQL = `SELECT ends_at FROM ${TABLE} WHERE server_id = $1`

const MAX_PENDING = 200
let pending = 0
let chain: Promise<unknown> = Promise.resolve()

function serial<T>(task: () => Promise<T>): Promise<T> {
  if (pending >= MAX_PENDING) return Promise.reject(new Error("too many pending subscription writes"))
  pending++
  const run = chain.then(task, task)
  chain = run.catch(() => {}).finally(() => {
    pending--
  })
  return run
}

async function write<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]> {
  const results = await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`),
    prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = '5s'`),
    prisma.$queryRawUnsafe<T[]>(sql, ...params),
  ])
  return results[2] as T[]
}

async function readOnly<T>(query: Prisma.PrismaPromise<T>): Promise<T> {
  const results = await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET TRANSACTION READ ONLY`),
    prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '1s'`),
    prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = '2s'`),
    query,
  ])
  return results[3] as T
}

export async function copyLegacyRecord(at: Date): Promise<string[]> {
  const present = await readOnly(prisma.$queryRawUnsafe<{ present: boolean }[]>(LEGACY_EXISTS_SQL))
  if (!present[0]?.present) return []
  const rows = await write<{ server_id: string }>(COPY_LEGACY_SQL, at.toISOString(), CARRIED_OVER_NOTE)
  return rows.map((r) => r.server_id)
}

let ensured: Promise<void> | null = null

export function ensureTable(): Promise<void> {
  if (!ensured) {
    ensured = serial(async () => {
      await prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`),
        prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = '5s'`),
        ...ENSURE_SQL.map((sql) => prisma.$executeRawUnsafe(sql)),
      ])
      await copyLegacyRecord(new Date())
    }).catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

export function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string }
  return e?.meta?.code === "42P01" || e?.code === "42P01" || /relation .* does not exist/i.test(e?.message ?? "")
}

export function cloudLabel(): string {
  try {
    return new URL(env.publicApiUrl).hostname
  } catch {
    return "server"
  }
}

interface Row {
  server_id: string
  id: string
  started_at: Date
  ends_at: Date
  status: string
  created_by_connection: Record<string, unknown>
  terms: Term[]
  events: SubscriptionEvent[]
  notes: string
  reminder_days: number[]
  dismissed: { term: number; threshold: number; at: string }[]
  connection_count: number
  last_connection_at: Date
  duration_months: number
}

function toRecord(row: Row): SubscriptionRecord {
  return {
    serverId: row.server_id,
    id: row.id,
    startedAt: row.started_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    status: row.status,
    createdByConnection: row.created_by_connection,
    terms: row.terms,
    events: row.events,
    notes: row.notes,
    reminderDays: row.reminder_days,
    dismissed: row.dismissed,
    connectionCount: row.connection_count,
    lastConnectionAt: row.last_connection_at.toISOString(),
    durationMonths: row.duration_months,
  }
}

export async function recordConnection(meta: ConnectionMeta, at: Date): Promise<{ inserted: boolean }> {
  await ensureTable()
  const metadata = { ...meta, at: at.toISOString() }
  const rows = await serial(() =>
    write<{ inserted: boolean }>(CONNECTION_SQL, meta.serverId, crypto.randomUUID(), at.toISOString(), JSON.stringify(metadata))
  )
  return { inserted: rows[0]?.inserted === true }
}

export async function appendRestart(at: Date): Promise<number> {
  await ensureTable()
  const rows = await serial(() => write<{ server_id: string }>(RESTART_SQL, at.toISOString()))
  return rows.length
}

async function readRows(sql: string, ...params: unknown[]): Promise<Row[]> {
  try {
    return await readOnly(prisma.$queryRawUnsafe<Row[]>(sql, ...params))
  } catch (err) {
    if (isMissingTable(err)) return []
    throw err
  }
}

export async function readRecord(serverId: string): Promise<SubscriptionRecord | null> {
  const rows = await readRows(READ_ONE_SQL, serverId)
  return rows[0] ? toRecord(rows[0]) : null
}

export async function readAllRecords(): Promise<SubscriptionRecord[]> {
  return (await readRows(READ_ALL_SQL)).map(toRecord)
}

export async function readEndsAt(serverId: string): Promise<string | null> {
  try {
    const rows = await readOnly(prisma.$queryRawUnsafe<{ ends_at: Date }[]>(CLOCK_SQL, serverId))
    return rows[0] ? rows[0].ends_at.toISOString() : null
  } catch (err) {
    if (isMissingTable(err)) return null
    throw err
  }
}

const notFixture = { NOT: [{ id: { startsWith: FIXTURE_PREFIX } }, { organizationId: { startsWith: FIXTURE_PREFIX } }] }
const serverSelect = { id: true, name: true, organizationId: true, status: true } as const

async function organizationNames(): Promise<Map<string, string>> {
  const orgs = await readOnly(prisma.organization.findMany({ select: { id: true, name: true } }))
  return new Map(orgs.map((o) => [o.id, o.name]))
}

export async function listServers(): Promise<ServerInfo[]> {
  const servers = await readOnly(prisma.musicServer.findMany({ where: notFixture, select: serverSelect }))
  const names = await organizationNames()
  return servers.map((s) => ({
    serverId: s.id,
    name: s.name,
    organizationId: s.organizationId,
    organizationName: names.get(s.organizationId) ?? null,
    serverStatus: s.status,
  }))
}

export async function readServer(serverId: string): Promise<ServerInfo | null> {
  if (serverId.startsWith(FIXTURE_PREFIX)) return null
  const server = await readOnly(prisma.musicServer.findFirst({ where: { AND: [{ id: serverId }, notFixture] }, select: serverSelect }))
  if (!server) return null
  const names = await organizationNames()
  return {
    serverId: server.id,
    name: server.name,
    organizationId: server.organizationId,
    organizationName: names.get(server.organizationId) ?? null,
    serverStatus: server.status,
  }
}

async function update(sql: string, ...params: unknown[]): Promise<SubscriptionRecord | null> {
  try {
    const rows = await serial(() => write<Row>(sql, ...params))
    return rows[0] ? toRecord(rows[0]) : null
  } catch (err) {
    if (isMissingTable(err)) return null
    throw err
  }
}

export function saveNotes(serverId: string, notes: string, actor: Actor, at: Date) {
  return update(NOTES_SQL, serverId, notes, at.toISOString(), JSON.stringify(actor))
}

export function saveReminders(serverId: string, reminderDays: number[], actor: Actor, at: Date) {
  return update(REMINDERS_SQL, serverId, JSON.stringify(reminderDays), at.toISOString(), JSON.stringify(actor))
}

export function dismissBanner(serverId: string, threshold: number, at: Date) {
  return update(DISMISS_SQL, serverId, threshold, at.toISOString())
}

export function appendExport(serverId: string, format: "json" | "text", actor: Actor, at: Date) {
  return update(EXPORT_SQL, serverId, at.toISOString(), JSON.stringify(actor), format)
}

export function renew(serverId: string, confirmEndDate: string, actor: Actor, at: Date) {
  return update(RENEW_SQL, serverId, at.toISOString(), JSON.stringify(actor), confirmEndDate)
}

export function changeDuration(serverId: string, months: number, confirmEndDate: string, actor: Actor, at: Date) {
  return update(DURATION_SQL, serverId, months, at.toISOString(), JSON.stringify(actor), confirmEndDate)
}
