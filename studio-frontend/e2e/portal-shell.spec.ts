import { test, expect } from '@playwright/test';
import { e2eEnv } from './support/env';
import { signInThroughKeycloak } from './support/keycloak';

/**
 * The first thing every user does, on every stand: arrive signed out, go
 * through the IdP, come back to a portal that is theirs.
 *
 * "Reaches the shell" is asserted on landmarks, not on content. The `<header>`
 * (`banner`) and `<main>` are what `Layout` renders for everybody who is
 * signed in — a member sees their screens inside `main`, somebody with no
 * organization yet sees the onboarding state there (ADR-0011). Either way the
 * login screen is gone and the top bar is up, and that is what this scenario
 * is for. Whether the right screen is inside `main` is another scenario.
 */
test(
  'a user signs in through Keycloak and reaches the portal shell',
  { tag: '@readonly' },
  async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Constructor Studio' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue with Constructor ID' }).click();

    await signInThroughKeycloak(page, e2eEnv.credentials);

    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByText('Sign in to continue')).toHaveCount(0);
  },
);
