/**
 * Deterministic shuffle for zone playback order.
 *
 * Zones play their playlist in a randomised order rather than the order
 * tracks were added. The randomisation is *seeded* rather than fresh on
 * every call, for two reasons:
 *
 *  - The agent re-syncs every few seconds. A different order each time
 *    would be noise: applyZoneTrackList() in agent-bridge/lib/agent.js
 *    reconciles queue *membership* only (it unqueues what's no longer
 *    assigned and appends what's missing), so a reshuffled array would
 *    change nothing on an already-correct queue and would only make the
 *    sync log impossible to read.
 *  - Seeding on zone + playlist means two zones running the same playlist
 *    get genuinely different orders, while one zone keeps a stable order
 *    for as long as that playlist stays assigned. Reassigning the
 *    playlist, or assigning it to another zone, produces a new order.
 */

/** 32-bit FNV-1a. Small, fast, and stable across processes — the order a
 * zone gets must not change just because the API server restarted. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 — a compact seeded PRNG. Good enough for shuffling a
 * playlist; explicitly not for anything security-related. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher-Yates against a seeded PRNG. Returns a new array; the input is
 * left alone. */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items]
  const rand = mulberry32(hashSeed(seed))
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
