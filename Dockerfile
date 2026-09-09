# syntax=docker/dockerfile:1

# ==============================================================================
# Cloud Music Management Portal — production image
#
# Multi-stage build producing a minimal runtime image from Next.js's
# "standalone" output. Builds and runs identically on Ubuntu Server 26.04 LTS
# (or any Docker host) via docker-compose.yml.
# ==============================================================================

ARG NODE_VERSION=22-alpine

# ------------------------------------------------------------------------------
# deps: install dependencies only (maximizes layer caching)
# ------------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ------------------------------------------------------------------------------
# builder: compile the Next.js app
# ------------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules

# Copy only the Next.js app. `backend/` and `agent-bridge/` are deliberately
# NOT copied: they are separate builds (backend has its own Dockerfile) with
# their own tsconfigs, and pulling them in makes `next build` typecheck server
# code that was never meant for the browser bundle. .dockerignore excludes
# them too — this explicit list is the belt to that suspenders, so the image
# cannot pick them up even if the ignore file is missing from a build context.
COPY package.json package-lock.json* ./
COPY next.config.ts tsconfig.json next-env.d.ts postcss.config.mjs eslint.config.mjs components.json ./
COPY src ./src
COPY public ./public
COPY prisma ./prisma

# Build-time public env vars must be present at build time (they're inlined
# into the client bundle). Pass them with --build-arg in docker-compose.yml
# or `docker build --build-arg`.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_USE_MOCK_API=false
ARG BACKEND_INTERNAL_URL=http://backend:4000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}
ENV NEXT_PUBLIC_USE_MOCK_API=${NEXT_PUBLIC_USE_MOCK_API}
ENV BACKEND_INTERNAL_URL=${BACKEND_INTERNAL_URL}
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ------------------------------------------------------------------------------
# runner: minimal production image
# ------------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Next.js "standalone" output bundles only the files needed to run.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
