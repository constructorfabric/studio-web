import { expect, type Page } from '@playwright/test';
import type { Credentials } from './env';

/**
 * Keycloak's own login form, driven by its form ids.
 *
 * `#username`, `#password` and `#kc-login` are the ids Keycloak's built-in
 * login themes have carried unchanged across versions and locales; the label
 * text beside them changes with both. The studio realm declares no
 * `loginTheme`, so this is the form every stand shows.
 *
 * Call it once the portal has handed the browser to the IdP — the helper waits
 * for the authorization endpoint, fills the form, and returns after the IdP has
 * sent the browser back to the portal's origin. A rejected password leaves the
 * browser on the IdP, and the origin check below names that rather than letting
 * the caller time out on a portal element that never appears.
 */
export async function signInThroughKeycloak(page: Page, credentials: Credentials): Promise<void> {
  await page.waitForURL(/\/protocol\/openid-connect\/auth/);
  const idpOrigin = new URL(page.url()).origin;

  await page.locator('#username').fill(credentials.username);
  await page.locator('#password').fill(credentials.password);
  await page.locator('#kc-login').click();

  await expect
    .poll(() => new URL(page.url()).origin, {
      message: `Keycloak did not send the browser back to the portal for "${credentials.username}" — check the credentials`,
    })
    .not.toBe(idpOrigin);
}
