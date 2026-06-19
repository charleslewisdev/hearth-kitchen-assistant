# Server image. Built from the repo ROOT (monorepo workspace context):
#   docker build -f apps/server/Dockerfile .
FROM node:20-slim
RUN corepack enable
WORKDIR /app

# Copy workspace manifests first so `pnpm install` is cached across source changes.
# All workspace package.json files are needed for a --frozen-lockfile install to resolve.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

# Source.
COPY . .

EXPOSE 3000
# Migrate-on-boot, then start. Migrations run as the DB owner (DATABASE_URL); the
# repository layer drops to the unprivileged hearth_app role at query time (RLS).
CMD ["sh", "-c", "pnpm --filter @hearth/server db:migrate && pnpm --filter @hearth/server exec tsx src/server.ts"]
