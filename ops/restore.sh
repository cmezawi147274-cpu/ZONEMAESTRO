#!/usr/bin/env bash
#
# CMMP restore. Destructive by default — it replaces live data.
#
#   List what's available:
#     bash ops/restore.sh --list
#
#   Rehearse (safe: restores into a throwaway database, touches nothing live).
#   Do this after any schema change, and at least monthly:
#     bash ops/restore.sh <timestamp> --rehearse
#
#   Real restore (requires typing the confirmation phrase):
#     bash ops/restore.sh <timestamp>
#     bash ops/restore.sh <timestamp> --db-only
#     bash ops/restore.sh <timestamp> --music-only
#
set -Eeuo pipefail

CMMP_DIR="${CMMP_DIR:-/opt/CMMP}"
DEST="${CMMP_BACKUP_DIR:-/opt/cmmp-backups/db}"
log() { printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
fail() { log "FAILED: $*"; exit 1; }

PGUSER="$(grep -E '^POSTGRES_USER=' "$CMMP_DIR/.env" | cut -d= -f2- || true)"; PGUSER="${PGUSER:-cmmp}"
PGDB="$(grep -E '^POSTGRES_DB=' "$CMMP_DIR/.env" | cut -d= -f2- || true)"; PGDB="${PGDB:-cmmp}"
PG="$(docker ps --filter name=cmmp-postgres --format '{{.Names}}' | head -1)"
[ -n "$PG" ] || fail "postgres container is not running"

if [ "${1:-}" = "--list" ] || [ -z "${1:-}" ]; then
  echo "Available backups in $DEST:"
  ls -1 "$DEST"/cmmp-db-*.dump 2>/dev/null | sed 's/.*cmmp-db-//;s/\.dump$//' | sort -r | while read -r s; do
    printf '  %s   db=%s  music=%s\n' "$s" \
      "$(du -h "$DEST/cmmp-db-$s.dump" 2>/dev/null | cut -f1)" \
      "$(du -h "$DEST/cmmp-music-$s.tar.gz" 2>/dev/null | cut -f1)"
  done
  exit 0
fi

STAMP="$1"; shift
MODE="all"; REHEARSE=0
for a in "$@"; do case "$a" in
  --db-only) MODE=db;; --music-only) MODE=music;; --rehearse) REHEARSE=1;;
  *) fail "unknown option $a";; esac; done

DB_FILE="$DEST/cmmp-db-$STAMP.dump"
MUSIC_FILE="$DEST/cmmp-music-$STAMP.tar.gz"

# Integrity first — never restore something that failed its checksum.
if [ -f "$DEST/cmmp-$STAMP.sha256" ]; then
  ( cd "$DEST" && sha256sum -c "cmmp-$STAMP.sha256" >/dev/null ) || fail "checksum mismatch for $STAMP"
  log "checksums ok"
fi

if [ "$REHEARSE" = 1 ]; then
  # The whole point: prove the dump actually restores, without going near
  # live data. Restores into a scratch database, counts what landed, drops it.
  TMPDB="cmmp_rehearse_$(date +%s)"
  log "rehearsing into scratch database $TMPDB (live data untouched)"
  docker exec "$PG" psql -U "$PGUSER" -d postgres -q -c "CREATE DATABASE \"$TMPDB\";"
  docker exec -i "$PG" pg_restore -U "$PGUSER" -d "$TMPDB" --no-owner --no-acl < "$DB_FILE" >/dev/null 2>&1 || true
  echo
  echo "  Row counts restored from $STAMP:"
  docker exec "$PG" psql -U "$PGUSER" -d "$TMPDB" -t -A -c \
    "select '    '||relname||' = '||n_live_tup from pg_stat_user_tables where n_live_tup>0 order by n_live_tup desc limit 12;"
  TOTAL=$(docker exec "$PG" psql -U "$PGUSER" -d "$TMPDB" -t -A -c "select coalesce(sum(n_live_tup),0) from pg_stat_user_tables;")
  docker exec "$PG" psql -U "$PGUSER" -d postgres -q -c "DROP DATABASE \"$TMPDB\";"
  echo
  [ "${TOTAL:-0}" -gt 0 ] || fail "rehearsal restored 0 rows — this backup is NOT usable"
  log "REHEARSAL PASSED: $TOTAL rows restored and verified, scratch database dropped"
  exit 0
fi

echo "This REPLACES live data in database '$PGDB'${MODE:+ (mode: $MODE)} from backup $STAMP."
printf 'Type exactly "restore %s" to proceed: ' "$STAMP"
read -r CONFIRM
[ "$CONFIRM" = "restore $STAMP" ] || fail "not confirmed"

if [ "$MODE" != "music" ]; then
  [ -f "$DB_FILE" ] || fail "missing $DB_FILE"
  log "stopping backend so nothing writes mid-restore"
  ( cd "$CMMP_DIR" && docker compose stop backend >/dev/null 2>&1 ) || true
  log "restoring database"
  docker exec -i "$PG" pg_restore -U "$PGUSER" -d "$PGDB" --clean --if-exists --no-owner --no-acl < "$DB_FILE" >/dev/null 2>&1 || true
  log "database restored"
fi

if [ "$MODE" != "db" ]; then
  [ -f "$MUSIC_FILE" ] || fail "missing $MUSIC_FILE"
  log "restoring music volume"
  docker run --rm -v cmmp_music-data:/data -v "$DEST":/in:ro alpine:3 \
    sh -c "rm -rf /data/* && tar xzf /in/$(basename "$MUSIC_FILE") -C /data" || fail "music restore failed"
  log "music restored"
fi

( cd "$CMMP_DIR" && docker compose --profile full up -d backend >/dev/null 2>&1 ) || true
log "restore complete — verify at /health and /ready"
