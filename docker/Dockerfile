# syntax=docker/dockerfile:1
# Multi-target image for the OpenSend API, worker and dashboard.
#   docker build -f docker/Dockerfile --target api .
FROM node:24.21.0-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
# The dashboard proxies /api to the API; the target is fixed at build time (Next.js rewrites).
ARG OPENSEND_API_INTERNAL_URL=http://api:3001
ENV OPENSEND_API_INTERNAL_URL=$OPENSEND_API_INTERNAL_URL
RUN pnpm turbo run build

FROM base AS api
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]

FROM base AS worker
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3002
CMD ["node", "apps/worker/dist/main.js"]

FROM node:24.21.0-alpine AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
