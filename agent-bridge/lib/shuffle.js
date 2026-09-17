"use strict";

/**
 * Per-zone shuffle, as a shuffle bag.
 *
 * The cloud randomises the order a zone's queue is *built* in, but the
 * compiled MusicServer then plays that fixed order on repeat for ever, so
 * every pass sounds identical. This module supplies the next track instead.
 *
 * A bag, not independent random picks: independent picks repeat a track
 * back to back roughly one time in N, which an operator hears as a broken
 * player rather than as shuffle. Here every track in the queue plays once
 * before any track plays twice.
 *
 * The bag is refilled when it empties and whenever the queue's contents
 * change (tracks added, removed or the whole playlist reassigned), and it
 * is keyed by zoneId so zones never share shuffle state.
 */

/** zoneId -> { signature, remaining: string[], lastPlayed: string|null } */
const bags = new Map();

/** Order-independent fingerprint of a queue's contents. */
function signatureOf(trackIds) {
  return trackIds.slice().sort().join("|");
}

function shuffled(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Refills `bag.remaining` with a fresh shuffle of the whole queue.
 *
 * A refill is the one moment a bag can hand back the track that just
 * finished — it is legal (that track's turn in the *new* pass), but two
 * passes joined at the seam still play it twice in a row, which sounds
 * like a stuck player. So when the fresh order opens on the track that
 * just played, it is swapped with a later one.
 */
function refill(bag, trackIds) {
  bag.remaining = shuffled(trackIds);
  if (bag.remaining.length > 1 && bag.remaining[0] === bag.lastPlayed) {
    const j = 1 + Math.floor(Math.random() * (bag.remaining.length - 1));
    [bag.remaining[0], bag.remaining[j]] = [bag.remaining[j], bag.remaining[0]];
  }
}

/**
 * The next track this zone should play, drawn from its bag.
 *
 * `trackIds` is the zone's current queue. Returns null when there is
 * nothing to shuffle (an empty queue, or a single track, which shuffles to
 * itself and is left to the service's own repeat).
 */
function nextTrackId(zoneId, trackIds) {
  const ids = (trackIds || []).filter(Boolean);
  if (ids.length < 2) return null;

  const signature = signatureOf(ids);
  let bag = bags.get(zoneId);
  if (!bag) {
    bag = { signature, remaining: [], lastPlayed: null };
    bags.set(zoneId, bag);
  }
  if (bag.signature !== signature) {
    // Queue contents changed: the old bag refers to tracks that may be gone.
    bag.signature = signature;
    bag.remaining = [];
  }
  // Drop anything that left the queue since the bag was filled.
  bag.remaining = bag.remaining.filter((id) => ids.includes(id));
  if (bag.remaining.length === 0) refill(bag, ids);

  const pick = bag.remaining.shift();
  bag.lastPlayed = pick;
  return pick;
}

/**
 * Records a track the zone started outside the bag, so the next refill
 * does not immediately repeat it. Creates the bag if this zone has none
 * yet (its very first track, started before nextTrackId() was ever
 * called for it) — otherwise this is a no-op exactly when it matters
 * most: a fresh zone's first track is the one case a same-track repeat
 * would be most audible.
 *
 * `trackIds`, when the caller has the queue cheaply available (it is not
 * always — see call sites), properly seeds `remaining` with every *other*
 * track rather than leaving the bag to refill from the full list on its
 * next draw. That distinction matters beyond just avoiding a back-to-back
 * repeat: without it, a caller counting "every distinct track has now
 * played once" (a non-repeating schedule slot deciding whether its pass
 * is complete) could see this track drawn a *second* time by the bag
 * before every other track had its first turn — the position-0-only
 * swap in refill() keeps it from repeating immediately, but not from
 * appearing anywhere else in that first shuffle.
 *
 * Without `trackIds`, `signature: null` never matches a real one, so the
 * next nextTrackId() call still resets `remaining` from its own trackIds
 * argument as usual while keeping `lastPlayed` — a smaller guarantee
 * (no immediate repeat) but the only one possible without the queue.
 */
function notePlayed(zoneId, trackId, trackIds) {
  if (!trackId) return;
  let bag = bags.get(zoneId);
  if (trackIds && trackIds.length) {
    const ids = trackIds.filter(Boolean);
    const signature = signatureOf(ids);
    if (!bag || bag.signature !== signature) {
      bags.set(zoneId, { signature, remaining: shuffled(ids.filter((id) => id !== trackId)), lastPlayed: trackId });
      return;
    }
  }
  if (!bag) {
    bag = { signature: null, remaining: [], lastPlayed: null };
    bags.set(zoneId, bag);
  }
  bag.lastPlayed = trackId;
}

/** Forgets zones that no longer exist, so a deleted zone's state cannot
 *  leak into a later zone that reuses its id. */
function prune(validZoneIds) {
  const keep = new Set(validZoneIds || []);
  for (const zoneId of [...bags.keys()]) {
    if (!keep.has(zoneId)) bags.delete(zoneId);
  }
}

/** Test/diagnostic view of a zone's bag. */
const peek = (zoneId) => {
  const bag = bags.get(zoneId);
  return bag ? { remaining: bag.remaining.slice(), lastPlayed: bag.lastPlayed } : null;
};

module.exports = { nextTrackId, notePlayed, prune, peek };
