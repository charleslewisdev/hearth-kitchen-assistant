# Sourced by run.sh and demo.sh: starts Postgres, makes sure `hearth_demo` exists and is migrated,
# and points this shell at it. Needs a repo-root .env, as every local command here does.
pnpm db:up

set -a
. ./.env
set +a
export DATABASE_URL="${DATABASE_URL%/*}/hearth_demo"
export DATA_DIR=./.data/demo

if ! docker compose exec -T db psql -U hearth -d postgres -Atc \
  "select 1 from pg_database where datname = 'hearth_demo'" | grep -q 1; then
  docker compose exec -T db createdb -U hearth hearth_demo
fi

pnpm db:migrate
