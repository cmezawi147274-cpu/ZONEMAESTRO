"use strict";

/**
 * Tiny in-memory ring-buffer logger. Everything the bridge does is also
 * kept here so the local control panel (ui/) can show a live activity
 * log without the operator needing access to the terminal that started
 * the process — the whole point of the panel is that a technician on
 * site can see what happened.
 */

const MAX_ENTRIES = 400;
const entries = [];
let nextId = 1;

function push(level, args) {
  const message = args
    .map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const entry = { id: nextId++, at: new Date().toISOString(), level, message };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  const line = `${entry.at} ${message}`;
  if (level === "warn") console.warn(line);
  else if (level === "error") console.error(line);
  else console.log(line);
  return entry;
}

const log = (...args) => push("info", args);
log.warn = (...args) => push("warn", args);
log.error = (...args) => push("error", args);

/** Entries newer than `sinceId`, oldest first. */
log.since = (sinceId = 0) => entries.filter((e) => e.id > sinceId);

module.exports = { log };
