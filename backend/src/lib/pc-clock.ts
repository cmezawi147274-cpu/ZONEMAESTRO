interface ScheduleSlotLike {
  id: string
  localZoneId: string
  startTime: string
  endTime: string
  days: string[]
  priority: number | null
}

const CLOCK_CHECK_ZONE = "cmmp-clock-check"
const CLOCK_ANCHOR_ZONE = "cmmp-clock-anchor"
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
const SEC = 1000
const MIN = 60 * SEC
const DAY = 24 * 60 * MIN

const REACTION_MS = 5 * SEC
const QUIET_MS = 12 * SEC
const PAIR_MS = 15 * SEC
const COARSE_DONE_MS = 50 * SEC
const BRACKETS = [2 * MIN, 15 * MIN, 2 * 60 * MIN, DAY]
const COMB_EDGES = 6
const COMB_SUPPORT = 4
const PASSIVE_SUPPORT = 3
const BAND_MS = 2600
const TYPICAL_DELAY_MS = 1200
const CHECK_TIMEOUT_MS = 25 * MIN
const STALL_MS = 2 * MIN
const WANT_MS = 2 * MIN
const REFRESH_AFTER_MS = 60 * MIN
const RETRY_AFTER_MS = 30 * MIN
const MAX_RETRY_AFTER_MS = 12 * 60 * MIN
const BACKGROUND_REFRESH_MS = 24 * 60 * MIN
const ESTIMATE_TTL_MS = 7 * DAY
const PASSIVE_PRIOR_MS = 10 * MIN
const KEEP_POSTS_MS = 45 * MIN
const KEEP_OBSERVATIONS_MS = DAY
const MAX_INCONSISTENT = 6
const TRIGGER_PREFIX = "cmmp-clock-check-"
const TRIGGER_ACK_MS = 12 * SEC
const FAST_REACTION_MS = 3200
const FAST_BRACKETS = [30 * SEC, 15 * MIN, 2 * 60 * MIN, DAY]
const FAST_DONE_MS = 4 * SEC
const FAST_TRIGGER_GET_MS = 20 * SEC
const FAST_DONE_WAIT_MS = 15 * SEC
const FAST_MAX_TRIGGERS = 90
const FAST_MISSES = 3
const FAST_MAX_INCONSISTENT = 10
const PLAIN_PASS_MIN_MS = 15 * SEC
const PLAIN_PASS_MAX_MS = 27 * SEC
const FAST_ASSUME_MS = 12 * SEC
const SCAN_MAX_MS = 150 * SEC
const SCAN_LEAD_MS = 4 * SEC
const PROBE_WINDOW_MS = 2600
const REFINE_MS = 4 * SEC
const MAX_SCANS = 4
const MAX_FAST_SCANS = 6
const REAL_COMMAND_QUIET_MS = 15 * SEC
const TICK_SLACK_MS = 3000
const SCAN_SHIFTS = 10
const NARROW_MS = 20 * SEC
const SLOW_TRIGGER_MS = 2 * SEC
const PUBLISH_MS = 8 * SEC
const ANCHOR_NARROW_MS = 2 * 60 * MIN
const ANCHOR_MARGIN_MS = 60 * MIN

interface Observation {
  wall: number
  offsets: number[]
}

interface Test {
  kind: "bracket" | "cut"
  m: number
  end: number
  at: number
  p1: number | null
  first: boolean | null
  neutralAt: number | null
  testId?: string
  neutralId?: string
}

interface Trigger {
  id: string
  action: "test" | "neutral" | "deliver" | "probe" | "clear"
  firedAt: number
  fetched: boolean
  executingAt: number | null
  ownPostAt: number | null
}

interface Probe {
  g: number
  id: string | null
}

interface Scan {
  m: number
  lo: number
  hi: number
  label: number
  stage: "deliver" | "probe" | "clear"
  probes: Probe[]
  clearId: string | null
  clearAt: number | null
  result: { lo: number; hi: number } | null
  refine: boolean
}

interface Fast {
  scan: Scan | null
  scans: number
  assumed: boolean
  trigger: Trigger | null
  triggers: number
  misses: number
  latency: number
  changes: number[]
  own: number[]
  done: Map<string, number>
  slowest: number
  lastGet: { id: string; at: number } | null
  confirmed: boolean
  prior: ServerClock["estimate"]
}

interface ClockCheck {
  startedAt: number
  fast: Fast | null
  lastGetAt: number
  expected: number
  lo: number
  hi: number
  bracket: number
  slots: object[]
  changedAt: number
  test: Test | null
  comb: { edges: number[]; lo: number; hi: number } | null
  inconsistent: number
  restarted: boolean
}

interface ServerClock {
  posts: number[]
  observations: Observation[]
  observedEdges: Set<number>
  edgeCache: { key: string; edges: number[] } | null
  estimate: { errorMs: number; at: number; timeZone: string | null } | null
  check: ClockCheck | null
  wantedAt: number | null
  failedAt: number | null
  failures: number
  timeZone: string | null
  zone: number | null
  lastPlain: number | null
  realCommandAt: number | null
  realCommands: number[]
  realSlots: ScheduleSlotLike[]
  saved: ServerClock["estimate"]
}

const servers = new Map<string, ServerClock>()
const timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>()
let hooks: { push: (serverId: string, commandId: string) => void; save: (serverId: string, estimate: ServerClock["estimate"]) => void; now: () => number } = { push: () => {}, save: () => {}, now: () => Date.now() }
let triggerSeq = 0
const TRIGGER_RUN = Date.now().toString(36)

export function setClockCheckHooks(h: Partial<typeof hooks>) {
  hooks = { ...hooks, ...h }
}

export function restoreClockEstimate(serverId: string, estimate: NonNullable<ServerClock["estimate"]>) {
  const st = stateOf(serverId)
  if (st.estimate && st.estimate.at >= estimate.at) return
  st.estimate = estimate
  st.saved = estimate
}

function persist(serverId: string, st: ServerClock) {
  if (st.estimate === st.saved) return
  st.saved = st.estimate
  hooks.save(serverId, st.estimate)
}

function stateOf(serverId: string): ServerClock {
  let st = servers.get(serverId)
  if (!st) {
    st = {
      posts: [],
      observations: [],
      observedEdges: new Set(),
      edgeCache: null,
      estimate: null,
      check: null,
      wantedAt: null,
      failedAt: null,
      failures: 0,
      timeZone: null,
      zone: null,
      lastPlain: null,
      realCommandAt: null,
      realCommands: [],
      realSlots: [],
      saved: null,
    }
    servers.set(serverId, st)
  }
  return st
}

function zoneOffsetMs(timeZone: string | null, at: number): number | null {
  if (!timeZone) return null
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(at))
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
    const offset = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at / SEC) * SEC
    return Number.isFinite(offset) ? offset : null
  } catch {
    return null
  }
}

const pad = (n: number) => String(n).padStart(2, "0")
const hhmm = (msIntoDay: number) => `${pad(Math.floor(msIntoDay / (60 * MIN)))}:${pad(Math.floor((msIntoDay % (60 * MIN)) / MIN))}`

function windowSlots(from: number, to: number, id = CLOCK_CHECK_ZONE): object[] {
  const out: object[] = []
  for (let s = from; s < to; ) {
    const dayStart = Math.floor(s / DAY) * DAY
    const e = Math.min(to, dayStart + DAY)
    out.push({
      id,
      localZoneId: CLOCK_CHECK_ZONE,
      zoneId: CLOCK_CHECK_ZONE,
      playlistId: null,
      trackIds: [],
      excludedTrackIds: [],
      name: "Clock check",
      startTime: hhmm(s - dayStart),
      endTime: e === dayStart + DAY ? "24:00" : hhmm(e - dayStart),
      days: [DAY_NAMES[new Date(s).getUTCDay()]],
      priority: 0,
      repeat: false,
    })
    s = e
  }
  return out
}

const ANCHOR = DAY_NAMES.map((day) => ({
  id: CLOCK_ANCHOR_ZONE,
  localZoneId: CLOCK_ANCHOR_ZONE,
  zoneId: CLOCK_ANCHOR_ZONE,
  playlistId: null,
  trackIds: [],
  excludedTrackIds: [],
  name: "Clock check",
  startTime: "00:00",
  endTime: "24:00",
  days: [day],
  priority: 0,
  repeat: false,
}))

function activeAt(s: ScheduleSlotLike, wall: number): boolean {
  const d = new Date(wall)
  const now = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  const today = DAY_NAMES[d.getUTCDay()]
  const yesterday = DAY_NAMES[(d.getUTCDay() + 6) % 7]
  if (!Array.isArray(s.days)) return false
  if (s.startTime < s.endTime) return s.days.includes(today) && s.startTime <= now && now < s.endTime
  if (s.endTime < s.startTime) return (s.days.includes(today) && s.startTime <= now) || (s.days.includes(yesterday) && now < s.endTime)
  return false
}

function winnersAt(slots: ScheduleSlotLike[], wall: number): Map<string, string> {
  const best = new Map<string, ScheduleSlotLike>()
  for (const s of slots) {
    if (!s.localZoneId || !s.startTime || !s.endTime || !activeAt(s, wall)) continue
    const current = best.get(s.localZoneId)
    if (!current || (s.priority ?? 0) > (current.priority ?? 0)) best.set(s.localZoneId, s)
  }
  return new Map([...best].map(([zone, s]) => [zone, s.id]))
}

function realEdges(slots: ScheduleSlotLike[], from: number, to: number): number[] {
  const marks = new Set<string>()
  for (const s of slots) {
    marks.add(s.startTime)
    marks.add(s.endTime)
  }
  const edges: number[] = []
  for (let day = Math.floor(from / DAY) * DAY; day <= to; day += DAY) {
    for (const mark of marks) {
      const [h, m] = String(mark).split(":").map(Number)
      if (!Number.isInteger(h) || !Number.isInteger(m)) continue
      const wall = day + h * 60 * MIN + m * MIN
      if (wall < from || wall > to) continue
      const before = winnersAt(slots, wall - MIN)
      const after = winnersAt(slots, wall)
      const zones = new Set([...before.keys(), ...after.keys()])
      if ([...zones].some((z) => before.get(z) !== after.get(z))) edges.push(wall)
    }
  }
  return edges.sort((a, b) => a - b)
}

function cluster(observations: Observation[]): { offsetMs: number; support: number; runnerUp: number; inBand: (x: number) => boolean } | null {
  const starts = observations.flatMap((o) => o.offsets).sort((a, b) => a - b)
  const supportAt = (lo: number) => observations.filter((o) => o.offsets.some((x) => x >= lo && x <= lo + BAND_MS)).length
  let bandStart: number | null = null
  let support = 0
  for (const lo of starts) {
    const n = supportAt(lo)
    if (n > support) {
      support = n
      bandStart = lo
    }
  }
  if (bandStart === null) return null
  const top = bandStart
  const inBand = (x: number) => x >= top && x <= top + BAND_MS
  let runnerUp = 0
  for (const lo of starts) {
    if (Math.abs(lo - top) < BAND_MS) continue
    runnerUp = Math.max(runnerUp, supportAt(lo))
  }
  const all = observations.flatMap((o) => o.offsets.filter(inBand)).sort((a, b) => a - b)
  const middle = all[Math.floor(all.length / 2)]
  const perEdge = observations
    .map((o) => o.offsets.filter(inBand))
    .filter((xs) => xs.length > 0)
    .map((xs) => xs.reduce((a, b) => (Math.abs(b - middle) < Math.abs(a - middle) ? b : a)))
    .sort((a, b) => a - b)
  return { offsetMs: perEdge[Math.floor(perEdge.length / 2)] + TYPICAL_DELAY_MS, support, runnerUp, inBand }
}

function postsBetween(st: ServerClock, from: number, to: number): number[] {
  return st.posts.filter((t) => t > from && t <= to)
}

function pairedPostsBetween(st: ServerClock, from: number, to: number): number[] {
  return postsBetween(st, from, to).filter((a) => st.posts.some((b) => b !== a && Math.abs(b - a) < PAIR_MS))
}

function newCheck(now: number, expected: number, fast = false): ClockCheck {
  return {
    startedAt: now,
    fast: fast ? { scan: null, scans: 0, assumed: true, trigger: null, triggers: 0, misses: 0, latency: 700, changes: [], own: [], done: new Map(), slowest: 0, lastGet: null, confirmed: false, prior: null } : null,
    lastGetAt: now,
    expected,
    lo: expected - 3.5 * DAY,
    hi: expected + 3.5 * DAY,
    bracket: 0,
    slots: fast ? ANCHOR : [],
    changedAt: now - 2 * REACTION_MS,
    test: null,
    comb: null,
    inconsistent: 0,
    restarted: false,
  }
}

function anchorFor(c: ClockCheck, now: number): object[] {
  if (c.hi - c.lo > ANCHOR_NARROW_MS) return ANCHOR
  const from = Math.floor((now + c.lo - ANCHOR_MARGIN_MS) / MIN) * MIN
  const to = Math.ceil((now + c.hi + ANCHOR_MARGIN_MS) / MIN) * MIN
  return windowSlots(from, to, CLOCK_ANCHOR_ZONE).map((s) => ({ ...s, localZoneId: CLOCK_ANCHOR_ZONE, zoneId: CLOCK_ANCHOR_ZONE }))
}

function deliver(c: ClockCheck, slots: object[], now: number) {
  c.slots = c.fast ? [...slots, ...anchorFor(c, now)] : slots
  c.changedAt = now
}

function fail(st: ServerClock, now: number) {
  st.check = null
  st.failedAt = now
  st.failures++
}

function backingOff(st: ServerClock, now: number): boolean {
  return st.failedAt !== null && now - st.failedAt < Math.min(RETRY_AFTER_MS * 2 ** Math.max(0, st.failures - 1), MAX_RETRY_AFTER_MS)
}

function freshFor(st: ServerClock, now: number, ms: number): boolean {
  return st.estimate !== null && st.estimate.timeZone === st.timeZone && now - st.estimate.at < ms
}

function quiet(st: ServerClock, c: ClockCheck, now: number): boolean {
  if (now - c.changedAt < 2 * REACTION_MS) return false
  const recent = st.posts.filter((t) => t <= now).slice(-2)
  return recent.length < 2 || recent[1] - recent[0] >= QUIET_MS
}

function stepCheck(st: ServerClock, c: ClockCheck, now: number) {
  if (c.comb) {
    const comb = c.comb
    if (now < comb.edges[comb.edges.length - 1] - comb.lo + 10 * SEC) return
    const observations = comb.edges.map((wall) => ({
      wall,
      offsets: pairedPostsBetween(st, wall - comb.hi - SEC, wall - comb.lo + 5 * SEC).map((a) => wall - a),
    }))
    const found = cluster(observations)
    const ends = [observations[0], observations[observations.length - 1]]
    if (
      found &&
      found.support >= COMB_SUPPORT &&
      found.runnerUp <= found.support - 1 &&
      ends.every((o) => o.offsets.some(found.inBand))
    ) {
      st.estimate = { errorMs: found.offsetMs - (st.zone ?? 0), at: now, timeZone: st.timeZone }
      st.observations = []
      st.check = null
      st.failedAt = null
      st.failures = 0
    } else if (c.restarted) {
      fail(st, now)
    } else {
      st.check = { ...newCheck(now, c.expected), lo: comb.lo - 2 * MIN, hi: comb.hi + 2 * MIN, bracket: -1, restarted: true, changedAt: now }
    }
    return
  }

  const t = c.test
  if (t) {
    if (t.first === null) {
      if (now <= t.at + REACTION_MS) return
      const reacted = postsBetween(st, t.at, t.at + REACTION_MS)
      t.first = reacted.length > 0
      t.p1 = reacted[0] ?? null
    }
    if (t.neutralAt === null) {
      if (!quiet(st, c, now)) return
      t.neutralAt = now
      deliver(c, [], now)
      return
    }
    if (now <= t.neutralAt + REACTION_MS) return
    const p2 = postsBetween(st, t.neutralAt, t.neutralAt + REACTION_MS)[0] ?? null
    c.test = null
    if (t.first && p2 === null) {
      if (++c.inconsistent > MAX_INCONSISTENT) fail(st, now)
      return
    }
    if (t.kind === "bracket") {
      if (t.first || p2 !== null) {
        c.lo = Math.max(c.lo, t.m - (t.first ? (t.p1 as number) : (p2 as number)))
        c.hi = Math.min(c.hi, t.end - t.at)
        c.bracket = -1
      } else {
        c.bracket = c.bracket + 1 < BRACKETS.length ? c.bracket + 1 : -1
      }
    } else if (t.first) {
      c.lo = Math.max(c.lo, t.m - (t.p1 as number))
    } else if (p2 !== null) {
      c.lo = Math.max(c.lo, t.m - p2)
    } else {
      c.hi = Math.min(c.hi, t.m - t.at)
    }
    if (c.hi < c.lo) {
      fail(st, now)
      return
    }
  }

  if (!quiet(st, c, now)) return

  if (c.bracket >= 0) {
    const w = BRACKETS[c.bracket]
    const m = Math.floor((now + c.expected - w) / MIN) * MIN
    const end = Math.ceil((now + c.expected + w) / MIN) * MIN
    c.test = { kind: "bracket", m, end, at: now, p1: null, first: null, neutralAt: null }
    deliver(c, windowSlots(m, end), now)
    return
  }

  if (c.hi - c.lo <= COARSE_DONE_MS) {
    const first = Math.ceil((now + c.hi + 5 * SEC) / MIN) * MIN
    const edges = Array.from({ length: COMB_EDGES }, (_, i) => first + i * MIN)
    const slots: object[] = []
    for (let i = 0; i < edges.length; i += 2) slots.push(...windowSlots(edges[i], edges[i + 1]))
    c.comb = { edges, lo: c.lo, hi: c.hi }
    deliver(c, slots, now)
    return
  }

  const near = Math.round((now + (c.lo + c.hi) / 2) / MIN) * MIN
  const m = [near, near - MIN, near + MIN].find((x) => x - now - REACTION_MS > c.lo && x - now < c.hi)
  if (m === undefined) return
  const end = Math.min(Math.ceil((now + c.hi + MIN) / MIN) * MIN, m + 6.9 * DAY)
  c.test = { kind: "cut", m, end, at: now, p1: null, first: null, neutralAt: null }
  deliver(c, windowSlots(m, end), now)
}

function wake(serverId: string, at: number) {
  const previous = timers.get(serverId)
  if (previous && previous.at <= at) return
  if (previous) clearTimeout(previous.timer)
  const timer = setTimeout(() => {
    timers.delete(serverId)
    const st = servers.get(serverId)
    if (!st || !st.check || !st.check.fast) return
    try {
      fastStep(serverId, st, st.check, hooks.now())
    } catch {
      fail(st, hooks.now())
    }
    persist(serverId, st)
  }, Math.max(0, at - hooks.now()))
  ;(timer as { unref?: () => void }).unref?.()
  timers.set(serverId, { at, timer })
}

function setFastEstimate(st: ServerClock, c: ClockCheck, now: number) {
  const offsetMs = (c.lo + Math.max(c.lo, c.hi - TYPICAL_DELAY_MS)) / 2
  st.estimate = { errorMs: offsetMs - (st.zone ?? 0), at: now, timeZone: st.timeZone }
}

function plainPassNear(st: ServerClock, from: number, to: number): boolean {
  if (st.lastPlain === null) return false
  return from < st.lastPlain + PLAIN_PASS_MAX_MS && to > st.lastPlain + PLAIN_PASS_MIN_MS
}

function cutAt(c: ClockCheck, at: number, margin: number): number | undefined {
  const near = Math.round((at + (c.lo + c.hi) / 2) / MIN) * MIN
  return [near, near - MIN, near + MIN].find((x) => x - at > c.lo + margin && x - at < c.hi - margin)
}

function commandsBetween(st: ServerClock, from: number, to: number): boolean {
  return st.realCommands.some((t) => t >= from - REAL_COMMAND_QUIET_MS && t <= to)
}

function reactions(st: ServerClock, f: Fast, from: number, to: number): number[] {
  return postsBetween(st, from, to).filter((a) => !f.own.includes(a))
}

function windowEnd(f: Fast, from: number, id: string | null | undefined, ms: number): number | null {
  const done = id ? f.done.get(id) : undefined
  return done === undefined ? null : Math.max(from + ms, done + (done - from) + TICK_SLACK_MS)
}

function fire(serverId: string, st: ServerClock, c: ClockCheck, f: Fast, action: Trigger["action"], now: number, notBefore = now) {
  let at = Math.max(now, notBefore)
  if (action === "test") {
    const pair = 2 * (f.latency + FAST_REACTION_MS) + 800
    let start: number | null = null
    for (let t = at; t < at + 2 * MIN; t += 100) {
      if (!plainPassNear(st, t, t + pair)) {
        start = t
        break
      }
    }
    if (start === null) return wake(serverId, now + 5 * SEC)
    at = start
  }
  if (st.realCommandAt !== null && now - st.realCommandAt < REAL_COMMAND_QUIET_MS) at = Math.max(at, st.realCommandAt + REAL_COMMAND_QUIET_MS)
  if (at > now + 50) return wake(serverId, at)
  triggerSeq += 1
  f.trigger = { id: `${TRIGGER_PREFIX}${TRIGGER_RUN}-${triggerSeq}`, action, firedAt: now, fetched: false, executingAt: null, ownPostAt: null }
  f.triggers++
  hooks.push(serverId, f.trigger.id)
  wake(serverId, now + TRIGGER_ACK_MS + 50)
}

function handOver(st: ServerClock, c: ClockCheck, f: Fast, now: number) {
  if (f.confirmed && c.hi - c.lo <= PUBLISH_MS) return finishFast(st)
  st.check = { ...newCheck(now, c.expected), changedAt: now }
}

function finishFast(st: ServerClock) {
  st.observations = []
  st.check = null
  st.failedAt = null
  st.failures = 0
}

function startScan(serverId: string, st: ServerClock, c: ClockCheck, f: Fast, lo: number, hi: number, refine: boolean, now: number): boolean {
  const gap = 2 * f.slowest + TICK_SLACK_MS
  let m = Math.ceil((now + f.latency + SCAN_LEAD_MS + hi) / MIN) * MIN
  for (let shifts = 0; realEdges(st.realSlots, m - (hi - lo) - SCAN_LEAD_MS - gap - 5 * SEC, m + (hi - lo) + 3 * gap + 5 * SEC).length > 0; shifts++) {
    if (shifts >= SCAN_SHIFTS) return false
    m += MIN
  }
  f.scan = { m, lo, hi, label: 0, stage: "deliver", probes: [], clearId: null, clearAt: null, result: null, refine }
  f.scans++
  fire(serverId, st, c, f, "deliver", now, m - hi - SCAN_LEAD_MS)
  return true
}

function scanFinished(serverId: string, st: ServerClock, c: ClockCheck, f: Fast, scan: Scan, now: number) {
  if (scan.result) {
    const lo = Math.max(c.lo, scan.result.lo)
    const hi = Math.min(c.hi, scan.result.hi)
    if (scan.refine) {
      if (hi < lo) {
        if (!f.confirmed && f.scans < MAX_FAST_SCANS && startScan(serverId, st, c, f, c.lo - FAST_ASSUME_MS, c.hi + FAST_ASSUME_MS, false, now)) return
        if (f.confirmed) st.estimate = f.prior
        st.check = { ...newCheck(now, c.expected), changedAt: now }
        return
      }
      c.lo = lo
      c.hi = hi
      if (!f.confirmed) f.prior = st.estimate
      f.confirmed = true
      if (c.hi - c.lo <= PUBLISH_MS) setFastEstimate(st, c, now)
      if (c.hi - c.lo <= FAST_DONE_MS || f.scans >= MAX_FAST_SCANS || !startScan(serverId, st, c, f, c.lo - SEC, c.hi + SEC, true, now)) handOver(st, c, f, now)
      return
    }
    c.lo = hi < lo ? scan.result.lo : lo
    c.hi = hi < lo ? scan.result.hi : hi
    if (!startScan(serverId, st, c, f, c.lo - SEC, c.hi + SEC, true, now)) st.check = { ...newCheck(now, c.expected), changedAt: now }
    return
  }
  if (scan.refine) {
    if (!f.confirmed && f.scans < MAX_FAST_SCANS && startScan(serverId, st, c, f, c.lo - FAST_ASSUME_MS, c.hi + FAST_ASSUME_MS, false, now)) return
    return handOver(st, c, f, now)
  }
  if (f.scans >= MAX_SCANS) {
    st.check = { ...newCheck(now, c.expected), changedAt: now }
    return
  }
  c.lo = c.expected - 3.5 * DAY
  c.hi = c.expected + 3.5 * DAY
  c.bracket = 0
  fastStep(serverId, st, c, now)
}

function scanStep(serverId: string, st: ServerClock, c: ClockCheck, f: Fast, scan: Scan, now: number) {
  if (scan.stage === "clear") {
    if (scan.clearAt === null) return f.trigger ? undefined : fire(serverId, st, c, f, "clear", now)
    const end = scan.clearId ? windowEnd(f, scan.clearAt, scan.clearId, PROBE_WINDOW_MS) : scan.clearAt + PROBE_WINDOW_MS
    if (end === null && now < scan.clearAt + FAST_DONE_WAIT_MS) return wake(serverId, Math.min(scan.clearAt + FAST_DONE_WAIT_MS, now + 500))
    if (end !== null && now < end) return wake(serverId, end + 50)
    f.scan = null
    return scanFinished(serverId, st, c, f, scan, now)
  }
  if (scan.probes.length === 0) return f.trigger ? undefined : fire(serverId, st, c, f, "deliver", now, scan.m - scan.hi - SCAN_LEAD_MS)
  const gap = 2 * f.slowest + TICK_SLACK_MS
  const posts = reactions(st, f, scan.probes[0].g, now)
  const head = posts.findIndex((y, i) => i + 2 < posts.length && posts[i + 1] - y <= gap && posts[i + 2] - posts[i + 1] <= gap)
  if (head >= 0) {
    let before: Probe | null = null
    for (const probe of scan.probes) {
      if (probe.id === null || probe.g >= posts[head]) continue
      const end = windowEnd(f, probe.g, probe.id, PROBE_WINDOW_MS)
      if (end !== null && end <= now && reactions(st, f, probe.g, end).length === 0) before = probe
    }
    if (before && !commandsBetween(st, scan.probes[0].g, now)) scan.result = { lo: scan.m - posts[head + 1], hi: scan.m - before.g }
    scan.stage = "clear"
    return scanStep(serverId, st, c, f, scan, now)
  }
  const last = scan.probes.filter((probe) => probe.id !== null).pop()
  if (last) {
    const end = windowEnd(f, last.g, last.id, PROBE_WINDOW_MS)
    if (end === null && now < last.g + FAST_DONE_WAIT_MS) return wake(serverId, Math.min(last.g + FAST_DONE_WAIT_MS, now + 500))
    if (end !== null && now < end) return wake(serverId, end + 50)
    if (end === null) {
      scan.stage = "clear"
      return scanStep(serverId, st, c, f, scan, now)
    }
  }
  if (now > scan.m - scan.lo + 3 * gap + 2 * SEC) {
    scan.stage = "clear"
    return scanStep(serverId, st, c, f, scan, now)
  }
  if (!f.trigger) fire(serverId, st, c, f, "probe", now, scan.m - scan.hi - SEC)
}

function fastStep(serverId: string, st: ServerClock, c: ClockCheck, now: number) {
  const f = c.fast as Fast
  if (f.trigger) {
    const tr = f.trigger
    if (tr.executingAt === null && now - tr.firedAt <= TRIGGER_ACK_MS) return wake(serverId, tr.firedAt + TRIGGER_ACK_MS + 50)
    if (tr.executingAt !== null && now - tr.firedAt <= FAST_TRIGGER_GET_MS) return wake(serverId, tr.firedAt + FAST_TRIGGER_GET_MS + 50)
    f.trigger = null
    if (c.lastGetAt <= tr.firedAt && now - c.startedAt < 5 * MIN) {
      const s = f.scan
      if (s) {
        f.scan = null
        if (startScan(serverId, st, c, f, s.lo, s.hi, s.refine, now)) return
      }
    } else if (++f.misses >= FAST_MISSES) {
      return handOver(st, c, f, now)
    }
  }
  if (f.triggers >= FAST_MAX_TRIGGERS || f.slowest > SLOW_TRIGGER_MS) return handOver(st, c, f, now)
  if (f.scan) return scanStep(serverId, st, c, f, f.scan, now)
  const t = c.test
  if (t) {
    if (t.first === null) {
      const end = windowEnd(f, t.at, t.testId, FAST_REACTION_MS)
      if (end === null && now < t.at + FAST_DONE_WAIT_MS) return wake(serverId, Math.min(t.at + FAST_DONE_WAIT_MS, now + 500))
      if (end !== null && now < end) return wake(serverId, end + 50)
      const reacted = end === null ? [] : reactions(st, f, t.at, end)
      t.first = end !== null && reacted.length > 0
      t.p1 = reacted.length > 0 ? reacted[reacted.length - 1] : null
    }
    if (t.neutralAt === null) return fire(serverId, st, c, f, "neutral", now)
    const end2 = windowEnd(f, t.neutralAt, t.neutralId, FAST_REACTION_MS)
    if (end2 === null && now < t.neutralAt + FAST_DONE_WAIT_MS) return wake(serverId, Math.min(t.neutralAt + FAST_DONE_WAIT_MS, now + 500))
    if (end2 !== null && now < end2) return wake(serverId, end2 + 50)
    c.test = null
    const end1 = windowEnd(f, t.at, t.testId, FAST_REACTION_MS)
    const valid = end1 !== null && end2 !== null && !commandsBetween(st, t.at, end2)
    const gap = valid ? reactions(st, f, end1 as number, t.neutralAt) : []
    const second = valid && reactions(st, f, t.neutralAt, end2 as number).length > 0
    if (!valid || gap.length > 0 || t.first !== second) {
      if (++c.inconsistent > FAST_MAX_INCONSISTENT) { st.check = { ...newCheck(now, c.expected), changedAt: now }; return }
    } else if (t.kind === "bracket") {
      if (t.first) {
        c.lo = Math.max(c.lo, t.m - (t.p1 as number))
        c.hi = Math.min(c.hi, t.end - t.at)
        c.bracket = -1
      } else {
        c.bracket = c.bracket + 1 < FAST_BRACKETS.length ? c.bracket + 1 : -1
      }
    } else if (t.first) {
      c.lo = Math.max(c.lo, t.m - (t.p1 as number))
    } else {
      c.hi = Math.min(c.hi, t.m - t.at)
    }
    if (c.hi < c.lo) { st.check = { ...newCheck(now, c.expected), changedAt: now }; return }
  }
  if (f.assumed) {
    f.assumed = false
    if (startScan(serverId, st, c, f, c.expected - FAST_ASSUME_MS, c.expected + FAST_ASSUME_MS, false, now)) return
  }
  if (c.bracket < 0 && c.hi - c.lo <= SCAN_MAX_MS && startScan(serverId, st, c, f, c.lo, c.hi, false, now)) return
  if (c.bracket < 0 && c.hi - c.lo <= NARROW_MS) {
    st.check = { ...newCheck(now, c.expected), changedAt: now }
    return
  }
  fire(serverId, st, c, f, "test", now)
}

function relabel(serverId: string, c: ClockCheck, f: Fast, scan: Scan, now: number, id: string | null) {
  scan.label += 1
  deliver(c, windowSlots(scan.m, scan.m + MIN, `${CLOCK_CHECK_ZONE}-${scan.label}`), now)
  scan.probes.push({ g: now, id })
  f.changes = [...f.changes.filter((d) => now - d < MIN), now]
  wake(serverId, now + PROBE_WINDOW_MS + 50)
}

function clearScan(serverId: string, c: ClockCheck, f: Fast, scan: Scan, now: number, id: string | null) {
  deliver(c, [], now)
  scan.clearAt = now
  scan.clearId = id
  f.changes = [...f.changes.filter((d) => now - d < MIN), now]
  wake(serverId, now + PROBE_WINDOW_MS + 50)
}

function fastOnGet(serverId: string, c: ClockCheck, f: Fast, now: number) {
  const tr = f.trigger
  const scan = f.scan
  if (!tr || tr.ownPostAt === null || now < tr.ownPostAt) {
    if (scan && scan.stage === "probe") relabel(serverId, c, f, scan, now, null)
    else if (scan && scan.stage === "clear" && scan.clearAt === null) clearScan(serverId, c, f, scan, now, null)
    return
  }
  f.trigger = null
  f.misses = 0
  f.latency = 0.7 * f.latency + 0.3 * (now - tr.firedAt)
  f.lastGet = { id: tr.id, at: now }
  if (scan) {
    if (scan.stage === "clear") {
      if (scan.clearAt === null) clearScan(serverId, c, f, scan, now, tr.id)
      return wake(serverId, now + 50)
    }
    if (tr.action === "deliver" || tr.action === "probe") {
      scan.stage = "probe"
      return relabel(serverId, c, f, scan, now, tr.id)
    }
    return wake(serverId, now + 50)
  }
  f.changes = [...f.changes.filter((d) => now - d < MIN), now]
  if (tr.action === "neutral" && c.test) {
    c.test.neutralAt = now
    c.test.neutralId = tr.id
    deliver(c, [], now)
    return wake(serverId, now + FAST_REACTION_MS + 50)
  }
  if (tr.action !== "test") return wake(serverId, now + 50)
  let m: number | undefined
  let end: number
  if (c.bracket >= 0) {
    const w = FAST_BRACKETS[c.bracket]
    m = Math.floor((now + c.expected - w) / MIN) * MIN
    end = Math.ceil((now + c.expected + w) / MIN) * MIN
  } else {
    m = cutAt(c, now, Math.max(SEC, 0.15 * (c.hi - c.lo)))
    if (m === undefined) return wake(serverId, now + 200)
    end = Math.min(Math.ceil((now + c.hi + MIN) / MIN) * MIN, m + 6.9 * DAY)
  }
  c.test = { kind: c.bracket >= 0 ? "bracket" : "cut", m, end, at: now, p1: null, first: null, neutralAt: null, testId: tr.id }
  deliver(c, windowSlots(m, end), now)
  wake(serverId, now + FAST_REACTION_MS + 50)
}

function stepPassive(st: ServerClock, slots: ScheduleSlotLike[], now: number) {
  if (st.check || slots.length === 0 || st.zone === null) return
  const known = st.estimate && st.estimate.timeZone === st.timeZone && now - st.estimate.at < ESTIMATE_TTL_MS ? st.estimate : null
  const centre = st.zone + (known ? known.errorMs : 0)
  const lo = centre - (known ? 20 * SEC : PASSIVE_PRIOR_MS)
  const hi = centre + (known ? 20 * SEC : PASSIVE_PRIOR_MS)
  const from = Math.floor((now + lo - 30 * MIN) / MIN) * MIN
  const to = Math.floor((now + hi) / MIN) * MIN
  const key = `${from}|${to}|${JSON.stringify(slots.map((s) => [s.id, s.localZoneId, s.startTime, s.endTime, s.days, s.priority]))}`
  if (!st.edgeCache || st.edgeCache.key !== key) st.edgeCache = { key, edges: realEdges(slots, from, to) }
  const added: Observation[] = []
  for (const wall of st.edgeCache.edges) {
    if (now <= wall - lo + 10 * SEC || st.observedEdges.has(wall)) continue
    st.observedEdges.add(wall)
    const offsets = pairedPostsBetween(st, wall - hi - SEC, wall - lo + 5 * SEC).map((a) => wall - a)
    if (offsets.length === 0) continue
    const o = { wall, offsets }
    st.observations.push(o)
    added.push(o)
  }
  for (const wall of st.observedEdges) if (now - wall > 2 * DAY) st.observedEdges.delete(wall)
  st.observations = st.observations.filter((o) => now - o.wall < KEEP_OBSERVATIONS_MS).slice(-20)
  if (added.length === 0) return
  const found = cluster(st.observations)
  if (
    found &&
    found.support >= PASSIVE_SUPPORT &&
    found.runnerUp <= found.support - 2 &&
    added.some((o) => o.offsets.some(found.inBand))
  ) {
    st.estimate = { errorMs: found.offsetMs - st.zone, at: now, timeZone: st.timeZone }
  }
}

export function notePlaylistSync(serverId: string, at: number) {
  const st = stateOf(serverId)
  st.posts.push(at)
  st.posts = st.posts.filter((t) => at - t < KEEP_POSTS_MS)
  const f = st.check?.fast
  const tr = f?.trigger
  if (f && tr && tr.executingAt !== null && tr.ownPostAt === null && at >= tr.executingAt) {
    tr.ownPostAt = at
    f.own = [...f.own.filter((t) => at - t < KEEP_POSTS_MS), at]
    return
  }
  if (!f || !f.changes.some((d) => at > d && at <= d + 8 * SEC)) st.lastPlain = at
}

export function clockCheckCommands(serverId: string, now: number, realCommands = 0): object[] {
  const st = servers.get(serverId)
  if (st && realCommands > 0) {
    st.realCommandAt = now
    st.realCommands = [...st.realCommands.filter((t) => now - t < KEEP_POSTS_MS), now]
  }
  const tr = st?.check?.fast?.trigger
  if (!tr || tr.fetched) return []
  tr.fetched = true
  return [{ commandId: tr.id, type: "SYNC_CONFIG", zoneId: null, issuedAt: new Date(now).toISOString() }]
}

export function clockCheckAck(serverId: string, commandId: string, status: string, now: number): boolean {
  if (!commandId.startsWith(TRIGGER_PREFIX)) return false
  const f = servers.get(serverId)?.check?.fast
  const tr = f?.trigger
  if (tr && tr.id === commandId && status === "EXECUTING" && tr.executingAt === null) tr.executingAt = now
  if (f && status !== "EXECUTING" && !f.done.has(commandId)) {
    f.done.set(commandId, now)
    if (f.lastGet && f.lastGet.id === commandId) f.slowest = Math.max(f.slowest, now - f.lastGet.at)
    if (f.done.size > 20) f.done.delete(f.done.keys().next().value as string)
  }
  return true
}

export function clockCheckSlots(serverId: string, realSlots: ScheduleSlotLike[], timeZone: string | null, now: number, isEligible: () => boolean = () => false): object[] {
  const st = stateOf(serverId)
  try {
    st.timeZone = timeZone
    st.zone = zoneOffsetMs(timeZone, now)
    st.realSlots = realSlots
    if (st.check && st.check.expected !== (st.zone ?? 0)) st.check = null
    stepPassive(st, realSlots, now)
    if (st.check && (now - st.check.startedAt > CHECK_TIMEOUT_MS || now - st.check.lastGetAt > STALL_MS)) fail(st, now)
    const wanted = st.wantedAt !== null && now - st.wantedAt < WANT_MS
    if (!st.check && !backingOff(st, now) && (wanted || !freshFor(st, now, BACKGROUND_REFRESH_MS)) && isEligible()) {
      st.wantedAt = null
      st.check = newCheck(now, st.zone ?? 0, true)
      st.check.fast?.changes.push(now)
      wake(serverId, now + 4 * SEC)
    }
    const c = st.check
    if (!c) return []
    c.lastGetAt = now
    if (c.fast) fastOnGet(serverId, c, c.fast, now)
    else stepCheck(st, c, now)
    return st.check === c ? c.slots : []
  } catch {
    fail(st, now)
    return []
  } finally {
    persist(serverId, st)
  }
}

export function wantClockCheck(serverId: string, eligible: boolean, now = Date.now()) {
  if (!eligible) return
  const st = stateOf(serverId)
  if (st.check || freshFor(st, now, REFRESH_AFTER_MS) || backingOff(st, now)) return
  st.wantedAt = now
}

export function pcClockFor(serverId: string, timeZone: string | null, now = Date.now()): { wallMs: number | null; measuring: boolean } {
  const st = servers.get(serverId)
  if (!st) return { wallMs: null, measuring: false }
  const estimate = st.estimate && st.estimate.timeZone === timeZone && now - st.estimate.at < ESTIMATE_TTL_MS ? st.estimate : null
  return {
    wallMs: estimate ? now + (zoneOffsetMs(timeZone, now) ?? 0) + estimate.errorMs : null,
    measuring: (st.check !== null && now - st.check.lastGetAt < STALL_MS) || (st.wantedAt !== null && now - st.wantedAt < WANT_MS),
  }
}
