#!/bin/sh
# One-shot real-mode start on the VDS. Safe to re-run.
# Wipes the Postgres volume (no production data yet) so a stale DB password
# cannot cause Prisma P1000, then migrates, seeds, and starts the stack.
set -e
cd /opt/CMMP

if [ ! -f .env ]; then
  cp .env.example .env
fi

sed -i 's/^NEXT_PUBLIC_USE_MOCK_API=.*/NEXT_PUBLIC_USE_MOCK_API=false/' .env
grep -q '^NEXT_PUBLIC_USE_MOCK_API=' .env || echo 'NEXT_PUBLIC_USE_MOCK_API=false' >> .env

# Keep POSTGRES_PASSWORD and DATABASE_URL in lockstep (P1000 if they differ).
PW=$(awk -F= '/^POSTGRES_PASSWORD=/{print substr($0,index($0,"=")+1); exit}' .env)
if [ -z "$PW" ]; then
  PW=change-me-before-deploying
  echo "POSTGRES_PASSWORD=$PW" >> .env
fi
DB_URL="postgresql://cmmp:${PW}@postgres:5432/cmmp?schema=public"
if grep -q '^DATABASE_URL=' .env; then
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=${DB_URL}|" .env
else
  echo "DATABASE_URL=${DB_URL}" >> .env
fi

echo "MOCK line:"
grep '^NEXT_PUBLIC_USE_MOCK_API=' .env

echo "Stopping stack and wiping Postgres volume..."
docker compose --profile full down -v

echo "Migrating..."
docker compose --profile migrate run --rm backend-migrate

echo "Seeding..."
docker compose --profile migrate run --rm backend-migrate npm run db:seed

echo "Starting portal + backend + Postgres..."
docker compose --profile full up -d

echo "DONE. Open http://181.214.100.148:3000/login and press Ctrl+F5"
echo "Sign in: alex.chen@cmmp.example / cmmp-demo-2026"
