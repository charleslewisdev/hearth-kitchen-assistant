# Questions and problems

## Signing in

### I forgot my password

On the sign-in screen, open **Forgot your password?**, enter your address and press **Send a
reset link**. The link works once, for one hour, and lets you choose a new password; every device
that was signed in is signed out. Without SMTP, the link is written to the server log (the newest
`actionUrl` line), so ask whoever runs Hearth to pass it on.

### A family member cannot sign in

Check these in order:

1. **Are they using the email address the invitation was sent to?** That is their sign-in
   address.
2. **Did they finish accepting the invitation?** If they never pressed **Create account and join**,
   they have no account. Look under **Pending invitations** on the **More** screen. If their
   address is still there, the invitation was not used. Send it again.
3. **Have there been many failed attempts?** Hearth limits sign-in attempts to 25 per 15 minutes
   for each internet address. Everyone at home usually shares one address, so one person's
   repeated wrong guesses can block the whole house for a while. Wait 15 minutes.
4. **Were they removed from the household?** Check the **Members** list on the **More** screen.

### "Hearth is invite-only. Ask the household owner for an invitation."

On the sign-in screen, this sentence is always shown; it explains why there is no sign-up button.

On the invitation screen, it means the email address typed does not match an open invitation.
Hearth deliberately gives the same answer whether the address is misspelled, the invitation
expired, or it was revoked. The owner can see which on the **More** screen.

### The invitation link has expired

Invitations last 48 hours. The owner goes to **More**, types the same address under **Invite
someone**, and presses **Send invitation** again. Hearth sends a new link and a new 48 hours.

If the invitation screen says **This invitation can't be used**, it has expired, been revoked, or
already been used. Ask the owner for a new one.

### My verification link expired

This applies only to the owner's first account. The link lasts one hour. Sign in with your email
and password anyway: Hearth says the address is not verified yet and sends a new link. Without
SMTP, the new link is the newest `actionUrl` line in the server log.

### I see "Name your household" but I was invited

That screen is for the first account only. If you see it after accepting an invitation, your
membership did not go through. Pressing **Create household** will tell you the Hearth already has
a household. Ask the owner to invite you again, then open the new link.

## Recipes and imports

### An import failed

Read the message; each one says what to do. The [importing guide](importing.md) lists every
message by source. In short:

- A web page failed: copy the recipe text from the page and use **Text**.
- A PDF has nothing Hearth can read, or a scanned PDF read badly: take a screenshot or photo of
  the page and use **Photo**.
- A photo read badly: crop to one recipe's column, retake it flat in good light, or use your
  phone's copy-text feature and paste into **Text**.
- Anything else: type it in with **By hand**.

### I cannot import a Word document

Word files are not supported. Copy the text and use **Text**, or save the document as a PDF from
Word and use **PDF**.

### How do I delete a recipe?

Open it, press **Delete recipe** at the bottom, then **Yes, delete**. It also comes off the meal
plan. Items it already put on the shopping list stay there.

### The same food shows up more than once on the shopping list

Hearth adds up amounts only for the same food in the same unit. "1 cup milk" and "2 tbsp milk"
stay on two lines, because Hearth does not convert units. Words that change what you buy also keep
foods apart: "yellow onions" and "onions" are two foods.

Size and preparation words no longer split a food ("large cloves garlic" is garlic). If a recipe
still makes an odd food name, edit its ingredient line so the extra words come after a comma. The
preview under the ingredient box shows the food name Hearth will use. There is no screen yet for
merging or renaming foods.

For the list you already have, remove the extra lines and add the right amount by hand.

### An ingredient amount looks wrong

Check the line on the recipe's **Edit** screen. Common causes:

- A range such as "2 to 3 cups" keeps only the low end, 2.
- A unit Hearth does not know becomes part of the food name. The Adding recipes page lists the ones it knows.
- A vague amount ("a few sprigs") is not read at all.

[Adding recipes by hand](adding-recipes.md#how-hearth-reads-an-ingredient-line) explains the
rules.

### A time in a step is not a button in cook mode

Write it as a number and a unit word: `30 minutes`, not `half an hour` or `1/2 hour`. See
[Timers in step text](adding-recipes.md#timers-in-step-text).
