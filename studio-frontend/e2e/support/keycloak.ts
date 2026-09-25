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
 *
 * The form is filled only on an HTTPS page, without exception: every IdP this
 * suite knows — the compose stack's self-signed Keycloak on `:8443` and the
 * stands' realms alike — is HTTPS, and a password typed into an `http://`
 * authorization page would be a password sent in the clear to whoever
 * answered there.
 */
export async function signInThroughKeycloak(page: Page, credentials: Credentials): Promise<void> {
  await page.waitForURL(/\/protocol\/openid-connect\/auth/);
  const idpUrl = new URL(page.url());
  if (idpUrl.protocol !== 'https:') {
    throw new Error(
      `The IdP handed the browser an ${idpUrl.protocol} sign-in page (${idpUrl.origin}); ` +
        'credentials are only ever entered over HTTPS.',
    );
  }
  const idpOrigin = idpUrl.origin;

  await page.locator('#username').fill(credentials.username);
  await page.locator('#password').fill(credentials.password);
  await page.locator('#kc-login').click();

  await expect
    .poll(() => new URL(page.url()).origin, {
      message: `Keycloak did not send the browser back to the portal for "${credentials.username}" — check the credentials`,
    })
    .not.toBe(idpOrigin);
}
