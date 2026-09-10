#!/usr/bin/env bash
#
# CMMP nightly backup — Postgres dump + the uploaded-music volume.
#
# Both stateful volumes had no backup of any kind, and no rehearsed restore.
# Unlike a security bug there is no recovering from that after the fact, so
# this errs towards being loud: it verifies every artifact it writes and
# exits non-zero if anything is wrong, so a failing timer is visible rather
# than silently producing empty files for months.
#
#   Manual run:  bash /opt/CMMP/ops/backup.sh
#   Restore:     bash /opt/CMMP/ops/restore.sh <timestamp>
#
set -Eeuo pipefail

CMMP_DIR="${CMMP_DIR:-/opt/CMMP}"
DEST="${CMMP_BACKUP_DIR:-/opt/cmmp-backups/db}"
KEEP_DAYS="${CMMP_BACKUP_KEEP:-14}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
LOG="${DEST}/backup.log"

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG" >&2; }
fail() { log "FAILED: $*"; exit 1; }
trap 'fail "aborted on line $LINENO"' ERR

mkdir -p "$DEST"

# Credentials come from the deployed .env, never hardcoded here.
[ -f "$CMMP_DIR/.env" ] || fail "no $CMMP_DIR/.env"
PGUSER="$(grep -E '^POSTGRES_USER=' "$CMMP_DIR/.env" | cut -d= -f2- || true)"; PGUSER="${PGUSER:-cmmp}"
PGDB="$(grep -E '^POSTGRES_DB=' "$CMMP_DIR/.env" | cut -d= -f2- || true)"; PGDB="${PGDB:-cmmp}"

PG_CONTAINER="$(docker ps --filter name=cmmp-postgres --format '{{.Names}}' | head -1)"
[ -n "$PG_CONTAINER" ] || fail "postgres container is not running"

DB_OUT="$DEST/cmmp-db-$STAMP.dump"
MUSIC_OUT="$DEST/cmmp-music-$STAMP.tar.gz"

# --- Database ---------------------------------------------------------------
# Custom format (-Fc): compressed, and pg_restore can list/verify it without
# a live database, which is what makes the verification below meaningful.
log "dumping database $PGDB"
docker exec "$PG_CONTAINER" pg_dump -U "$PGUSER" -d "$PGDB" -Fc --no-owner --no-acl > "$DB_OUT.tmp" \
  || fail "pg_dump failed"
mv "$DB_OUT.tmp" "$DB_OUT"

# A dump that cannot be listed is not a backup. This catches truncation and
# the classic "0-byte file written for six months" failure.
TABLES="$(docker exec -i "$PG_CONTAINER" pg_restore --list < "$DB_OUT" 2>/dev/null | grep -c 'TABLE DATA' || true)"
[ "${TABLES:-0}" -ge 5 ] || fail "dump verification failed — only ${TABLES:-0} tables found in $DB_OUT"
log "database ok: $TABLES tables, $(du -h "$DB_OUT" | cut -f1)"

# --- Uploaded music ---------------------------------------------------------
# Read straight off the named volume, so this works whether or not the
# backend container is running.
log "archiving music volume"
docker run --rm -v cmmp_music-data:/data:ro -v "$DEST":/out alpine:3 \
  tar czf "/out/$(basename "$MUSIC_OUT").tmp" -C /data . || fail "music archive failed"
mv "$MUSIC_OUT.tmp" "$MUSIC_OUT"
tar tzf "$MUSIC_OUT" >/dev/null 2>&1 || fail "music archive is corrupt"
FILES="$(tar tzf "$MUSIC_OUT" | grep -cv '/$' || true)"
log "music ok: $FILES files, $(du -h "$MUSIC_OUT" | cut -f1)"

# --- Checksums + retention --------------------------------------------------
( cd "$DEST" && sha256sum "$(basename "$DB_OUT")" "$(basename "$MUSIC_OUT")" > "cmmp-$STAMP.sha256" )

find "$DEST" -name 'cmmp-db-*.dump'      -mtime "+$KEEP_DAYS" -delete
find "$DEST" -name 'cmmp-music-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -name 'cmmp-*.sha256'       -mtime "+$KEEP_DAYS" -delete

log "backup complete: $STAMP (keeping $KEEP_DAYS days, $(du -sh "$DEST" | cut -f1) total)"
echo "$STAMP"
