import crypto from "node:crypto"
import { prisma } from "../lib/db.js"
import { env } from "../lib/env.js"

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
  id: string
  serverLabel: string
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

const TABLE = "subscription.record"
const ISO_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`
const iso = (expr: string) => `to_char((${expr}) AT TIME ZONE 'UTC', ${ISO_FORMAT})`
const plus12Months = (expr: string) => `(((${expr}) AT TIME ZONE 'UTC') + interval '12 months') AT TIME ZONE 'UTC'`

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
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    id text NOT NULL,
    server_label text NOT NULL,
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
]

const CONNECTION_SQL = `INSERT INTO ${TABLE} AS r (
    singleton, id, server_label, started_at, ends_at, status, created_by_connection,
    terms, events, notes, reminder_days, dismissed, connection_count, last_connection_at
  ) VALUES (
    true, $1, $2, $3::timestamptz, ${plus12Months("$3::timestamptz")}, 'active', $4::jsonb,
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
  ON CONFLICT (singleton) DO UPDATE SET
    connection_count = r.connection_count + 1,
    last_connection_at = EXCLUDED.last_connection_at,
    events = r.events || ${thresholdEvents("$3")}
  RETURNING (xmax::text = '0') AS inserted`

const RESTART_SQL = `UPDATE ${TABLE} AS r SET
    events = r.events || ${event("restarted", "$1")} || ${thresholdEvents("$1")}
  WHERE r.singleton
  RETURNING r.id`

const NOTES_SQL = `UPDATE ${TABLE} AS r SET
    notes = $1,
    events = r.events || ${event("note_saved", "$2", `, 'by', $3::jsonb`)}
  WHERE r.singleton
  RETURNING r.*`

const REMINDERS_SQL = `UPDATE ${TABLE} AS r SET
    reminder_days = $1::jsonb,
    events = r.events || ${event("reminders_saved", "$2", `, 'by', $3::jsonb, 'reminderDays', $1::jsonb`)}
  WHERE r.singleton
  RETURNING r.*`

const DISMISS_SQL = `UPDATE ${TABLE} AS r SET
    dismissed = r.dismissed || jsonb_build_array(jsonb_build_object('term', jsonb_array_length(r.terms), 'threshold', $1::int, 'at', ${iso("$2::timestamptz")}))
  WHERE r.singleton
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(r.dismissed) AS d
      WHERE (d->>'term')::int = jsonb_array_length(r.terms) AND (d->>'threshold')::int = $1::int
    )
  RETURNING r.*`

const EXPORT_SQL = `UPDATE ${TABLE} AS r SET
    events = r.events || ${event("exported", "$1", `, 'by', $2::jsonb, 'format', $3::text`)}
  WHERE r.singleton
  RETURNING r.*`

const newStart = `CASE WHEN r.ends_at > $1::timestamptz THEN r.ends_at ELSE $1::timestamptz END`

const RENEW_SQL = `UPDATE ${TABLE} AS r SET
    ends_at = ${plus12Months(newStart)},
    terms = r.terms || jsonb_build_array(jsonb_build_object(
      'index', jsonb_array_length(r.terms) + 1,
      'startedAt', ${iso(newStart)},
      'endsAt', ${iso(plus12Months(newStart))},
      'reason', 'renewal',
      'confirmedBy', jsonb_build_object('type', 'user', 'userId', $2::jsonb->>'userId', 'email', $2::jsonb->>'email')
    )),
    events = r.events || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid()::text,
      'type', 'renewal_confirmed',
      'at', ${iso("$1::timestamptz")},
      'term', jsonb_array_length(r.terms) + 1,
      'by', $2::jsonb,
      'previousEndsAt', ${iso("r.ends_at")},
      'endsAt', ${iso(plus12Months(newStart))}
    ))
  WHERE r.singleton AND to_char(r.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $3
  RETURNING r.*`

const READ_SQL = `SELECT * FROM ${TABLE} WHERE singleton`
const CLOCK_SQL = `SELECT ends_at FROM ${TABLE} WHERE singleton`

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

let ensured: Promise<void> | null = null

export function ensureTable(): Promise<void> {
  if (!ensured) {
    ensured = serial(async () => {
      await prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`),
        prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = '5s'`),
        ...ENSURE_SQL.map((sql) => prisma.$executeRawUnsafe(sql)),
      ])
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

export function serverLabel(): string {
  try {
    return new URL(env.publicApiUrl).hostname
  } catch {
    return "server"
  }
}

interface Row {
  id: string
  server_label: string
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
}

function toRecord(row: Row): SubscriptionRecord {
  return {
    id: row.id,
    serverLabel: row.server_label,
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
  }
}

export async function recordConnection(meta: ConnectionMeta, at: Date): Promise<{ inserted: boolean }> {
  await ensureTable()
  const metadata = { ...meta, at: at.toISOString() }
  const rows = await serial(() =>
    write<{ inserted: boolean }>(CONNECTION_SQL, crypto.randomUUID(), serverLabel(), at.toISOString(), JSON.stringify(metadata))
  )
  return { inserted: rows[0]?.inserted === true }
}

export async function appendRestart(at: Date): Promise<boolean> {
  await ensureTable()
  const rows = await serial(() => write<{ id: string }>(RESTART_SQL, at.toISOString()))
  return rows.length > 0
}

export async function readRecord(): Promise<SubscriptionRecord | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Row[]>(READ_SQL)
    return rows[0] ? toRecord(rows[0]) : null
  } catch (err) {
    if (isMissingTable(err)) return null
    throw err
  }
}

export async function readEndsAt(): Promise<string | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ ends_at: Date }[]>(CLOCK_SQL)
    return rows[0] ? rows[0].ends_at.toISOString() : null
  } catch (err) {
    if (isMissingTable(err)) return null
    throw err
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

export function saveNotes(notes: string, actor: Actor, at: Date) {
  return update(NOTES_SQL, notes, at.toISOString(), JSON.stringify(actor))
}

export function saveReminders(reminderDays: number[], actor: Actor, at: Date) {
  return update(REMINDERS_SQL, JSON.stringify(reminderDays), at.toISOString(), JSON.stringify(actor))
}

export function dismissBanner(threshold: number, at: Date) {
  return update(DISMISS_SQL, threshold, at.toISOString())
}

export function appendExport(format: "json" | "text", actor: Actor, at: Date) {
  return update(EXPORT_SQL, at.toISOString(), JSON.stringify(actor), format)
}

export function renew(confirmEndDate: string, actor: Actor, at: Date) {
  return update(RENEW_SQL, at.toISOString(), JSON.stringify(actor), confirmEndDate)
}
