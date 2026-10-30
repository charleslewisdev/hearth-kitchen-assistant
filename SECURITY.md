# Security

Hearth holds a household's recipes, meal plans, shopping lists and accounts, and it is meant to
face the internet behind a reverse proxy. Reports are welcome.

## Reporting a vulnerability

Report it privately through this repository's **Security** tab ("Report a vulnerability"). Please
do not open a public issue. Include the version or commit, what an attacker can reach, and the
steps to reproduce.

This is a one-maintainer project, so there is no response-time promise, but reports take priority
over feature work.

## Supported versions

Only the latest commit on `main` and the image built from it receive fixes.

## Running it safely

- Read the proxy section of [`deploy/unraid/README.md`](deploy/unraid/README.md) before exposing an
  instance. `TRUST_PROXY` decides which client address the rate limiters see.
- Claim a new instance before you share its address. Until then, anyone holding the setup token
  can create the first account.
- With no `SMTP_HOST`, invitation links go to the server log. Anyone who can read the log can join
  the household, so configure SMTP before forwarding logs anywhere.
- Change the default database password before putting the compose stack on a shared machine.
