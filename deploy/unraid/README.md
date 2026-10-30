# Deploying Hearth on unraid

Two containers on a private docker network, behind the reverse proxy you already use (D46):

```
browser ──https──▶ your reverse proxy (HAProxy on pfSense, NPM, SWAG, …)
                     │  http, to [unraid IP]:8484
                     ▼
                   hearth      the app: web UI, API, auth, OCR   (network: hearth)
                     │  by name, over the `hearth` network
                     ▼
                   hearth-db   Postgres 16, no host port         (network: hearth)
```

Templates: `hearth-db.xml` and `hearth.xml` in this directory. Image:
`ghcr.io/charleslewisdev/hearth` (`latest`, plus a short-commit tag per build, which you can pin).

## Before you start

**Registry access.** Package visibility on GHCR is set separately from the repository's, and this
image is private. If you are not the owner, build your own image from the root `Dockerfile`. As the
owner, log the box in once with a GitHub token that has `read:packages` only:

```
docker login ghcr.io -u charleslewisdev
```

unraid rebuilds `/root` at boot, but on current releases `/root/.docker` is a link onto the flash
drive (`/boot/config/plugins/dockerMan`), so the login survives a reboot. Check with
`ls -l /root/.docker` if unsure; if it is a plain directory, re-run the login from your `go` file
or a User Script at array start.

**The network.** Create it once. Settings → Docker → "Preserve user defined networks" must be on,
or unraid drops it when the Docker service restarts.

```
docker network create hearth
```

## 1. hearth-db

Add Container → `hearth-db` template. Set `POSTGRES_PASSWORD` now: Postgres reads it only when it
first creates the data directory. Put the data directory on your cache pool
(`/mnt/<pool>/appdata/hearth/db`) rather than `/mnt/user/...`; a database wants the direct path.

No host port is published. Only containers on the `hearth` network can reach it.

## 2. hearth

Add Container → `hearth` template.

| Field          | Value                                                               |
| -------------- | ------------------------------------------------------------------- |
| Web port       | a free host port, default `8484`                                    |
| Data directory | `/mnt/<pool>/appdata/hearth/data` (holds the generated auth secret) |
| `DATABASE_URL` | `postgres://hearth:<the password>@hearth-db:5432/hearth`            |
| `PUBLIC_URL`   | `https://hearth.example.com`, the address people type               |
| `TRUST_PROXY`  | your proxy's IP as unraid sees it, e.g. the pfSense LAN address     |

`PUBLIC_URL` is the auth base URL and the trusted origin, and its `https` scheme is what marks the
session cookie Secure. Set it before anyone signs in.

`TRUST_PROXY` decides whose `X-Forwarded-For` is believed, which decides the client address the
rate limiters key on. Naming the proxy's address is better than a hop count here: the port is
reachable from the whole LAN, and a hop count would believe any machine that connects to it. Left
at `0`, every visitor looks like the proxy and the household shares one sign-in budget.

Once it reports healthy, `ls <data directory>` on the host should show `auth-secret` and
`setup-token`. If it is empty, the secret is inside the container and the next update will sign
everyone out: stop and fix that before anyone signs up.

Settings → Docker → Docker Autostart: put `hearth-db` above `hearth` with a few seconds' wait.
`hearth` also restarts itself (`--restart unless-stopped`) if it wins the race and finds no
database, because it runs its migrations before serving and exits if it cannot.

## 3. The reverse proxy

Any proxy works. It needs to terminate TLS for your hostname, forward to `[unraid IP]:8484`, and
add `X-Forwarded-For`.

**HAProxy on pfSense:** a backend with one server, `[unraid IP]:8484`, health check `GET /health`.
On the frontend, an ACL on the host header routing `hearth.example.com` to that backend, and
"Use forwardfor option" ticked, which appends the client address to `X-Forwarded-For`. Your
existing shared frontend and certificate (ACME or otherwise) are all it needs. No websockets, no
sticky sessions.

Uploads: an import of up to four photos sends about 16 MB in one request. If the proxy caps
request bodies, allow at least 20 MB.

## 4. Claim the instance

1. `docker logs hearth` shows a line starting `This Hearth has no household yet`, with the setup
   token. It is also in `<data directory>/setup-token`.
2. Open `PUBLIC_URL`, expand **Setting up this Hearth for the first time?**, paste the token, and
   create your account.
3. Without SMTP, the verification link is in the log: the newest line with `actionUrl`. Open it.
   If it has expired (one hour), sign in anyway and Hearth logs a new one.
4. Sign in, name the household. The token file is deleted and the line stops appearing.
5. Invite people from **More**. Without SMTP each invitation link is an `actionUrl` log line;
   send it to them yourself.

Anyone who can read the log or the token file can claim the instance while it is unclaimed, so
do this before you share the address.

## Check the proxy chain once

From a machine outside your LAN (a phone off Wi-Fi works), with a deliberately false header:

```
curl -s -o /dev/null -H 'X-Forwarded-For: 203.0.113.9' https://hearth.example.com/api/nope
docker logs hearth --tail 5
```

The `incoming request` line's `req.remoteAddress` must be that machine's public address.

- `203.0.113.9`: something trusts too much. `TRUST_PROXY` is a hop count higher than the chain.
- The pfSense address: `TRUST_PROXY` does not name it, or HAProxy is not adding the header.
- A `172.x` docker address: the proxy's traffic is reaching the container through something
  that rewrites the source; name that address instead.

## Mail

Leave `SMTP_*` blank and Hearth sends no mail: invitation and verification links are written to
its log, and the log is then a credential. Fine on a box only you can read; set a relay before you
ship logs anywhere. `LOG_LEVEL=silent` without SMTP means those links go nowhere.

## What to back up

- **The database.** `hearth-backup.sh` in this directory is a User Scripts script: a nightly
  compressed `pg_dump` into `appdata/hearth/backups`, keeping 14 days. A dump is consistent while
  Postgres runs; a copy of the data directory is not, unless the container is stopped. The
  script's header has the restore steps, including the one that matters: create the
  `hearth_app` role before loading the dump, because roles are not in it.
- **`appdata/hearth/data`**: the auth secret. Losing it signs everyone out, nothing worse.

## Updating

**Check for Updates** offers each new `latest`. The container migrates on boot, so an update is
pull, restart, wait for healthy. Migrations are forward-only: dump the database before an update
you are unsure about, since rolling the image back does not roll the schema back.

## Never

Run the Playwright suite against a deployment. It empties the database it points at.
