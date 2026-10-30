# The Hearth image: the API and the web app it serves, one container beside Postgres (D46).
# Built from the repo root:
#   docker build -t hearth .
FROM node:20-slim
RUN corepack enable
WORKDIR /app

# Copy workspace manifests first so `pnpm install` is cached across source changes.
# All workspace package.json files are needed for a --frozen-lockfile install to resolve.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/enrichment/package.json packages/enrichment/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

# Source, then the web app's static build, which the server serves in production. `tsc` in the
# web build reaches the server's router types, which is why this is one workspace build.
COPY . .
RUN pnpm --filter @hearth/web build

ENV NODE_ENV=production
# Where the generated auth secret and setup token are kept. Mount a volume here: the unraid
# template and compose both do. Unset, the server falls back to ./.data under the directory it
# runs from, which is in the container layer and is lost on every recreate.
ENV DATA_DIR=/data

EXPOSE 3000

# In the IMAGE, not only in docker-compose.yml, because the deployment does not use compose:
# an unraid container gets whatever the image declares and nothing else, and the deployment
# README tells the operator to wait for this container to report healthy before starting the
# web one. Without this it would never report anything at all.
#
# `start-period` covers migrate-on-boot below: until migrations finish nothing is listening,
# and a failure during that window is expected rather than a fault. PORT is read at check time
# because it is configurable, so a moved port does not leave the check pointing at 3000.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrate-on-boot, then start. Migrations run as the DB owner (DATABASE_URL); the
# repository layer drops to the unprivileged hearth_app role at query time (RLS).
CMD ["sh", "-c", "pnpm --filter @hearth/server db:migrate && pnpm --filter @hearth/server exec tsx src/server.ts"]
