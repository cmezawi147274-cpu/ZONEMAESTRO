# syntax=docker/dockerfile:1

# ==============================================================================
# CMMP backend — REST API, realtime gateway and Windows MusicServer agent
# surface.
#
# The cloud half of the system runs on Linux (Ubuntu Server 26.04 LTS); this
# image is what `docker compose up` starts alongside the portal and Postgres.
# The Windows MusicServer agents are clients of it over outbound HTTPS only.
# ==============================================================================

ARG NODE_VERSION=22-alpine

# ------------------------------------------------------------------------------
# deps: production + build dependencies (maximizes layer caching)
# ------------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ------------------------------------------------------------------------------
# builder: generate the Prisma client and compile TypeScript to dist/
# ------------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ------------------------------------------------------------------------------
# runner: production dependencies + compiled output only
# ------------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# The generated Prisma client lives in node_modules and is not reproduced by
# `npm ci --omit=dev`, so it is copied from the builder stage. `prisma/` comes
# along for the schema the client validates against. Migrations are applied by
# the `backend-migrate` service in docker-compose.yml, which runs the
# `builder` stage (where the Prisma CLI is present) — this runtime image
# deliberately carries no dev dependencies.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Uploaded audio lives here and must be a volume — see MUSIC_STORAGE_DIR.
RUN mkdir -p /app/data/music && chown -R node:node /app/data
ENV MUSIC_STORAGE_DIR=/app/data/music

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
