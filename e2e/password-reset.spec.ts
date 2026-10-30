import { test, expect } from '@playwright/test';
import { OWNER, resetLinkFor, seedOwnerAndHousehold } from './fixtures';

// A forgotten password, start to finish, with no SMTP: the link is read from the server log,
// which is how the owner of a mail-less install passes it on. Seeding as grocery-mvp.spec.ts.
test.beforeAll(async () => {
  await seedOwnerAndHousehold();
});

test('reset a forgotten password from the sign-in screen', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Forgot your password?').click();
  await page.getByLabel('Email for the account').fill(OWNER.email);
  await page.getByRole('button', { name: 'Send a reset link' }).click();
  await expect(page.getByRole('status')).toContainText('If that address has an account');

  await page.goto(await resetLinkFor(OWNER.email));
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await page.getByLabel('New password').fill('a-brand-new-password');
  await page.getByLabel('The same again').fill('a-brand-new-password');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByRole('status')).toContainText('Your new password is set');

  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.getByLabel('Email address', { exact: true }).fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill('a-brand-new-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Recipes' })).toBeVisible();
});
