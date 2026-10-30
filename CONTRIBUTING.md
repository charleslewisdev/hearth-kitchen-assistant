# Contributing

Bug reports and ideas are welcome as issues.

**Please open an issue before writing code.** Hearth is AGPL-3.0, and the author keeps copyright so
the project can be dual-licensed later (decision D21 in
[`docs/DECISION_LOG.md`](docs/DECISION_LOG.md)). That means outside contributions need a contributor
licence agreement. The agreement isn't published yet, so pull requests can't be merged for now.

## Working on it

You need Node 20, pnpm and Docker.

```sh
pnpm install
cp .env.example .env
pnpm db:up
pnpm db:migrate
set -a; . ./.env; set +a; pnpm --filter @hearth/server dev   # API on :3000
pnpm --filter @hearth/web dev                                # app on :5173
```

Before sending anything, run:

```sh
pnpm typecheck
pnpm lint
pnpm test:local
```

`pnpm test:local` truncates the database `DATABASE_URL` points at, so don't aim it at data you want
to keep. Run `pnpm test:e2e` too if you touch auth, invitations or the shopping flow.

`pnpm screenshots` regenerates the README images from an invented kitchen in its own database, and
`pnpm demo` opens that kitchen in a browser. Run the first after a visible UI change.

## Rules that are easy to miss

- Every domain table carries `household_id` and is reached through `withHousehold()`.
- Logs carry ids only, never user content.
- Core flows must work with no AI service. Import is deterministic.
- Keep every regex over untrusted text linear, and add a timed hostile-input test.
- Test fixtures must be invented. Don't commit text or pages copied from cookbooks or recipe sites.
