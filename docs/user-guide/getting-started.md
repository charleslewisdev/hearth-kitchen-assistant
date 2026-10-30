# Getting started

This page is for the owner: the person who installs Hearth and sets it up. The last section is for
family members accepting an invitation.

## 1. Install Hearth

Follow [Deploying Hearth on unraid](../../deploy/unraid/README.md). It covers the two containers,
the docker network, your reverse proxy, and the settings on the `hearth` container.

Two settings matter for this page:

- **`PUBLIC_URL`** must be the address people type in their browser, with `https://`. Invitation
  and verification links are built from it.
- **`SMTP_*`** is your mail relay. You can leave it blank. Hearth then sends no email and writes
  each invitation and verification link into the server log instead (see
  [Mail without SMTP](#mail-without-smtp) below).

## 2. Find the setup token

A new Hearth has no accounts, and nobody can invite you. The first account is unlocked by a
**setup token** instead (decision D42). The server creates the token on first boot.

You can find it in two places:

- **The server log.** Run `docker logs hearth` and look for the line that starts
  `This Hearth has no household yet. Create the first account by sending the header
  "x-hearth-setup-token: ...`. The token is the value after the colon.
- **A file.** `/mnt/user/appdata/hearth/data/setup-token` (the `setup-token` file in the server's
  data directory).

The line is printed again on every boot until your household exists. Once the household exists,
the file is deleted and the token stops working.

Anyone who can read that log or file can claim your Hearth while it is unclaimed. Finish these
steps before you give the address to anyone.

## 3. Create the first account

1. Open Hearth in your browser. You see **Sign in to Hearth**.
2. Open **Setting up this Hearth for the first time?** below the sign-in form.
3. Paste the setup token. Enter your name, your email address and a password of at least 8
   characters.
4. Press **Create the first account**.

Hearth says the account was created and that it sent a link to confirm your address. It does not
sign you in yet.

## 4. Verify your email address

You must verify your address before you can sign in. This applies only to the first account.
People you invite are verified by the invitation itself.

- **With SMTP set up:** open the email "Verify your email address for Hearth" and follow the link.
- **Without SMTP:** the link is in the server log. Run `docker logs hearth` and find the
  newest line that says `no SMTP configured, so this log line IS the email`. The link is in its
  `actionUrl` field. Copy it into your browser.

Open the link within about an hour, because verification links expire after one hour. If yours
has expired, sign in with your email and password anyway. Hearth says the address is not verified
yet and sends a fresh link (with no SMTP, it is a new line in the server log).

The link takes you back to the sign-in screen, which says "Your email address is verified. Sign in
below." If the link was too old or damaged, the screen says so instead.

## 5. Sign in and name your household

1. Sign in with the email address and password you just chose.
2. Hearth shows **Name your household**. Type a name, for example "The Smith Kitchen".
3. Press **Create household**.

You are now in the app, and you are the household **Owner**. The setup token is gone. A Hearth
holds exactly one household. Everyone else joins it by invitation.

## 6. Invite your family

Only the owner can invite people.

1. Go to **More**.
2. Under **Invite someone**, type the person's email address and press **Send invitation**.
3. The invitation appears under **Pending invitations** with the date it expires.

An invitation lasts **48 hours**. If it expires, send it again to the same address. Hearth sends a
fresh link and restarts the clock. Expired invitations stay in the list so you can see why someone
could not get in. **Revoke** cancels an invitation that has not been used.

Without SMTP, each invitation link is written to the server log in the same way as the
verification link. Find the newest `actionUrl` line and send the link to the person yourself, for
example by text message.

Everyone in the household sees the same recipes, plans and shopping list. Members can do
everything except invite or remove people, or rename the household. The owner can remove a member from the **More** screen
with **Remove**, then **Yes, remove**. That person loses access to the household's recipes and
lists.

## Mail without SMTP

With `SMTP_HOST` blank, Hearth writes every invitation and verification link to its log, on a
line with a warning. Anyone who can read the log can use those links, and an invitation link lets
someone join your household. That is fine on a server only you can log in to. If you ever send
logs somewhere else, set up a mail relay first. The
[unraid guide](../../deploy/unraid/README.md#mail-or-the-absence-of-it) has the details, including
why `LOG_LEVEL=silent` breaks invitations when there is no SMTP.

## For family members: accepting an invitation

You get an email (or a link from the owner) that says you were invited to join the household.

1. Open the link. You see **Join this Hearth**.
2. Enter the **email address the invitation was sent to**. It must match exactly.
3. Enter your name and choose a password of at least 8 characters.
4. Press **Create account and join**.

Hearth creates your account, signs you in and opens the recipe library. You do not need to verify
your email; the invitation already proved it.

If something is wrong, Hearth tells you when you press the button:

- "Hearth is invite-only. Ask the household owner for an invitation." means the address does not
  match an open invitation. Check the spelling. If it is right, the invitation may have expired or
  been revoked. Ask the owner to send it again.
- If you open the link while signed in as someone else, Hearth says **This invitation is for
  someone else**. Sign out and open the link again.

After that, sign in at the Hearth address with your email and password.
