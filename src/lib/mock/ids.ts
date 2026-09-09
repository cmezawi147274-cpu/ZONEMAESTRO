let counters: Record<string, number> = {}

/** Deterministic, human-scannable ids (e.g. "srv_00007") for mock data. */
export function nextId(prefix: string): string {
  counters[prefix] = (counters[prefix] ?? 0) + 1
  return `${prefix}_${String(counters[prefix]).padStart(5, "0")}`
}

export function resetIdCounters() {
  counters = {}
}

export function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}
