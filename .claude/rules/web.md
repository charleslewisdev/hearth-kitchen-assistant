---
paths:
  - "apps/web/**"
---
# Web app

- Import from the server only the `AppRouter` type (`@hearth/server/src/trpc/routers`) and constants from `@hearth/server/src/messages.ts`. Anything else pulls node:fs and pg into the bundle and breaks `vite build`.
- No path aliases; use relative imports.
- Styles are CSS modules using the semantic `var(--token)` roles (D24, D49), not raw hex. Text on an accent fill is `var(--color-on-accent)`; department colours are `--dept-<key>-bg`/`-ink` via `departmentStyle()` in `src/lib/departments.ts`. Titles use `var(--font-display)` (h1 to h3 get it by default).
- `<Onboarding />` renders when the session has no active household. `/accept-invite/:id` sits outside the session gate on purpose.
- tRPC goes through `httpBatchLink` and the Vite proxy; don't hardcode the API origin. Keep `maxItems: MAX_TRPC_BATCH` on every batch link: the server answers larger batches with a 400.
