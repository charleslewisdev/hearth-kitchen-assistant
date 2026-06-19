# Web image. Two stages: build the static SPA with Vite, then serve it (and reverse-proxy
# the API) with Caddy. Built from the repo ROOT:
#   docker build -f apps/web/Dockerfile .
FROM node:20-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
# tsc needs the server source for the AppRouter type import; the workspace provides it.
RUN pnpm --filter @hearth/web build

FROM caddy:2-alpine
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
