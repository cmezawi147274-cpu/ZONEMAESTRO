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

/** Records a track the zone started outside the bag, so the next refill
 *  does not immediately repeat it. */
function notePlayed(zoneId, trackId) {
  const bag = bags.get(zoneId);
  if (bag && trackId) bag.lastPlayed = trackId;
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
