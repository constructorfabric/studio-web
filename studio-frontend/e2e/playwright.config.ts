import { defineConfig, devices } from '@playwright/test';
import { e2eEnv } from './support/env';

// End-to-end suite for the portal (ADR-0029). Few scenarios, one browser, and
// no knowledge of where it runs: the stand and the account come from
// `support/env.ts`, and this file only turns them into runner settings.
//
//   npm run e2e                                   the compose stack
//   E2E_BASE_URL=https://studio-dev.cfabric.org \
//   E2E_USER=… E2E_PASSWORD=… npm run e2e         a shared stand
//   npm run e2e -- --grep @readonly               only what may touch production
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results',

  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]]
    : [['list']],

  // A full sign-in round trip through the IdP on a cold stand is measured in
  // seconds, not milliseconds; the budget is generous so that a slow stand
  // is a slow pass, not a flaky fail.
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },

  use: {
    ...devices['Desktop Chrome'],
    baseURL: e2eEnv.baseUrl,
    // The compose stack's Keycloak answers on https://localhost:8443 with a
    // self-signed certificate. A stand must present a valid one — accepting
    // any certificate there would hide exactly the failure a smoke run is for.
    ignoreHTTPSErrors: e2eEnv.isLocal,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
