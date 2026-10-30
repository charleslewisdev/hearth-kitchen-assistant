import { test, expect } from '@playwright/test';
import {
  INVITE_LINK_PREFIX,
  inviteLinkFor,
  OWNER,
  pendingInvitationId,
  seedOwnerAndHousehold,
} from './fixtures';

/**
 * The invitation happy path, end to end, against the real running stack:
 *   owner signs in -> invites an address -> the link the console mailer printed is followed in
 *   a second browser -> that person sets a password -> they are in the household, reading its
 *   recipes.
 *
 * The link is read out of the API server's log rather than handed over from the database,
 * because on the deployment this milestone is for there is no SMTP and that log line IS the
 * email (mail/mailer.ts). Taking the id from the database would prove the invitation exists;
 * this proves the operator has something to send.
 *
 * A second browser CONTEXT, not a second page: cookies are per context, so the invitee's
 * browser starts with no session at all. Sharing one would mean the owner's session followed
 * them into every assertion below, and every one of them would pass for that reason.
 */
test.beforeAll(async () => {
  await seedOwnerAndHousehold();
});

test('invitation happy path: invite -> emailed link -> new member sees the recipes', async ({
  page,
  browser,
}) => {
  // Unique per run so the log parser cannot match an earlier run's line for the same address on
  // a reused server. Everything else about the run is reset by the fixture.
  const invitee = `e2e-invitee-${Date.now()}@example.com`;
  const inviteePassword = 'hearth-e2e-invitee-pw';
  const recipe = 'Shared Chili';

  // 1. The owner signs in. `exact` on both fields: the first-boot disclosure on the same screen
  //    carries "Your email address" and "Choose a password".
  await page.goto('/');
  await page.getByLabel('Email address', { exact: true }).fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();

  // 2. ...and puts one recipe in the household, which is what the invitee will be able to see
  //    at the end and could not see before joining.
  await page
    .getByRole('link', { name: /New recipe/ })
    .first()
    .click();
  await page.getByLabel('Title').fill(recipe);
  await page.getByLabel('Servings').fill('4');
  await page.getByLabel('Ingredients, one per line').fill('2 cans chickpeas\n1 tbsp cumin');
  await page.getByRole('textbox', { name: 'Step 1' }).fill('Simmer until it thickens.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: recipe })).toBeVisible();

  // 3. The owner invites an address from the household screen.
  await page.goto('/more');
  await expect(page.getByRole('heading', { name: 'Household', exact: true })).toBeVisible();
  await page.getByLabel('Email address', { exact: true }).fill(invitee);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('status')).toContainText(`Invitation sent to ${invitee}.`);
  await expect(page.getByRole('listitem').filter({ hasText: invitee })).toBeVisible();

  // 4. Recover the link the way the operator of a zero-config install has to: out of the log.
  const link = await inviteLinkFor(invitee);
  /*
    Checked against the invitation in the database, and checked exactly, because the rest of
    this test cannot check it at all: sign-up accepts the pending invitation for the ADDRESS
    (`joinInvitedHousehold`), never the id in the URL, so every assertion below would pass just
    the same on a link carrying a stale id or a truncated one. This is the assertion that says
    the operator can copy that line out of the log and have it mean something - pointed at the
    web origin rather than the API's, where it would 404 after being sent.
  */
  expect(link).toBe(`${INVITE_LINK_PREFIX}${await pendingInvitationId(invitee)}`);

  // 5. The invitee opens it in a browser that has never seen this app, and signs up.
  const inviteeContext = await browser.newContext();
  try {
    const inviteePage = await inviteeContext.newPage();
    await inviteePage.goto(link);
    await expect(inviteePage.getByRole('heading', { name: 'Join this Hearth' })).toBeVisible();

    await inviteePage.getByLabel('Email address', { exact: true }).fill(invitee);
    await inviteePage.getByLabel('Your name').fill('E2E Invitee');
    await inviteePage.getByLabel('Password', { exact: true }).fill(inviteePassword);
    await inviteePage.getByRole('button', { name: 'Create account and join' }).click();

    // Signing up consumed the invitation and wrote the membership in the same request
    // (`joinInvitedHousehold`), so the session gate lets them straight into the app shell.
    // Onboarding here would mean they arrived with an account and no household.
    await expect(inviteePage.getByRole('heading', { name: 'Recipes' })).toBeVisible();

    // 6. They are in the OWNER's household, not one of their own: the owner's recipe is there,
    //    and it opens.
    await inviteePage.getByRole('link', { name: recipe }).click();
    await expect(inviteePage.getByRole('heading', { name: recipe })).toBeVisible();
    await expect(inviteePage.getByRole('listitem').filter({ hasText: 'chickpeas' })).toBeVisible();

    // And they are here as themselves. Without this the two assertions above would also pass if
    // the invitee's browser were somehow signed in as the owner.
    await inviteePage.goto('/more');
    const theirRow = inviteePage.getByRole('listitem').filter({ hasText: invitee });
    await expect(theirRow).toContainText('You');
    await expect(theirRow).toContainText('Member');
    // Only the owner may invite, and the screen says so rather than offering a form that fails.
    await expect(inviteePage.getByRole('button', { name: 'Send invitation' })).toHaveCount(0);
  } finally {
    await inviteeContext.close();
  }

  // 7. The owner's own screen agrees: a second member, and nothing left pending. The invitation
  //    was consumed rather than merely followed.
  await page.reload();
  await expect(page.getByRole('listitem').filter({ hasText: invitee })).toContainText('Member');
  await expect(page.getByText('Nobody is waiting on an invitation.')).toBeVisible();
});
