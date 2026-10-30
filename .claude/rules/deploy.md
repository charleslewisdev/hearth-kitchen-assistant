---
paths:
  - 'deploy/**'
  - 'docker-compose*.yml'
  - 'Dockerfile'
  - '.dockerignore'
---

# Deploy

- One image, `ghcr.io/charleslewisdev/hearth`, built from the root `Dockerfile`: the API plus the web app it serves (D46). There is no Caddy container any more.
- `TRUST_PROXY` is a hop count or a list of proxy addresses/CIDRs, default 0. Behind a proxy on a port other machines can reach, set it to that proxy's address, not a hop count.
- The unraid template publishes no DB host port (D37); app and DB share the `hearth` custom network.
- Compose runs with `NODE_ENV=production`; the cookie secret is generated into `DATA_DIR` on a volume. Never ship a default secret; compose once signed cookies with the published dev one.
- The healthcheck lives only in the `Dockerfile`; don't re-add it to compose. The db service's `pg_isready` check is separate.
- In `docker-compose.yml`, pass SMTP settings as bare keys; the unraid template carries them as `<Config>` entries. The image namespace is fixed by D34; don't change it.
- `pino-pretty` is a runtime dependency; the image needs it.
- Keep local state out of the image: `.dockerignore` excludes `**/.data` (secrets, setup tokens, test-kitchen credentials). Never write the owner's own domain names into deploy files; use placeholders.
