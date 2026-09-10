#!/bin/sh
set -e
cd /opt/CMMP
if [ ! -f .env ]; then
  cp .env.example .env
fi
sed -i 's/NEXT_PUBLIC_USE_MOCK_API=true/NEXT_PUBLIC_USE_MOCK_API=false/' .env
grep -q '^NEXT_PUBLIC_USE_MOCK_API=' .env || echo 'NEXT_PUBLIC_USE_MOCK_API=false' >> .env
# Never write a known placeholder as a credential. The backend refuses to
# boot on the values published in .env.example (backend/src/lib/env.ts
# assertSecretsAreNotPlaceholders), because leaving them in place means
# anyone who can read this repository can forge a SUPER_ADMIN token.
if ! grep -q '^POSTGRES_PASSWORD=' .env; then
  PG=$(openssl rand -base64 32 | tr -d '\n/+=' | head -c 40)
  echo "POSTGRES_PASSWORD=$PG" >> .env
  echo "DATABASE_URL=postgresql://cmmp:$PG@postgres:5432/cmmp?schema=public" >> .env
fi
for KEY in JWT_ACCESS_SECRET JWT_REFRESH_SECRET; do
  grep -q "^$KEY=" .env || echo "$KEY=$(openssl rand -base64 48 | tr -d '\n')" >> .env
done
echo "MOCK line:"
grep MOCK_API .env
docker compose --profile full up -d --build
echo "DONE. Open http://181.214.100.148:3000/login and press Ctrl+F5"
