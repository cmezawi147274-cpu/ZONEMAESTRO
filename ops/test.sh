#!/usr/bin/env bash
#
# Run the backend regression suites against a running stack.
#
# There is no Node on this host, so tests run inside the backend builder
# image (the only one carrying dev dependencies). Only test/ is mounted, so
# the image's own node_modules stays visible — mounting the whole backend
# directory masks it and tsx disappears.
#
#   bash ops/test.sh
#
set -Eeuo pipefail
CMMP_DIR="${CMMP_DIR:-/opt/CMMP}"

DBURL="$(grep -E '^DATABASE_URL=' "$CMMP_DIR/.env" | cut -d= -f2- | sed 's/@postgres:/@cmmp-postgres-1:/')"
[ -n "$DBURL" ] || { echo "no DATABASE_URL in $CMMP_DIR/.env" >&2; exit 1; }

docker image inspect cmmp-backend-migrate >/dev/null 2>&1 \
  || ( cd "$CMMP_DIR" && docker compose --profile migrate build backend-migrate )

exec docker run --rm --network cmmp_default \
  -v "$CMMP_DIR/backend/test:/app/test:ro" -w /app \
  -e DATABASE_URL="$DBURL" \
  -e TEST_API_URL="${TEST_API_URL:-http://cmmp-backend-1:4000}" \
  --user 0:0 --entrypoint sh cmmp-backend-migrate \
  -c 'node --test --import tsx test/*.test.ts'
