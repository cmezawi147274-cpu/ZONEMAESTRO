#!/bin/sh
set -e
cd /opt/CMMP
if [ ! -f .env ]; then
  cp .env.example .env
fi
sed -i 's/NEXT_PUBLIC_USE_MOCK_API=true/NEXT_PUBLIC_USE_MOCK_API=false/' .env
grep -q '^NEXT_PUBLIC_USE_MOCK_API=' .env || echo 'NEXT_PUBLIC_USE_MOCK_API=false' >> .env
grep -q '^POSTGRES_PASSWORD=' .env || echo 'POSTGRES_PASSWORD=change-me-before-deploying' >> .env
grep -q '^DATABASE_URL=' .env || echo 'DATABASE_URL=postgresql://cmmp:change-me-before-deploying@postgres:5432/cmmp?schema=public' >> .env
echo "MOCK line:"
grep MOCK_API .env
docker compose --profile full up -d --build
echo "DONE. Open http://181.214.100.148:3000/login and press Ctrl+F5"
