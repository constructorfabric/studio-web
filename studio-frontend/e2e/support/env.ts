/**
 * Where the suite runs, and as whom — read once from the environment.
 *
 * The specs never see a host or a credential (ADR-0029). Everything that
 * differs between the compose stack, a shared stand and, one day, production
 * comes in through these three variables:
 *
 *   E2E_BASE_URL   the portal's address; defaults to the compose stack
 *   E2E_USER       a realm-local user with a password — never an SSO identity
 *   E2E_PASSWORD
 *
 * The defaults are the compose stack's seeded `demo/studio` from
 * `docker/keycloak/realm-studio.json`, and they are defaults *only* there.
 * Away from localhost a missing credential is a configuration error, and it
 * fails here, at config load, rather than as a timed-out login form.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export interface Credentials {
  username: string;
  password: string;
}

export interface E2EEnv {
  baseUrl: string;
  /** Compose stack: self-signed Keycloak on :8443, seeded users, disposable data. */
  isLocal: boolean;
  credentials: Credentials;
}

function readEnv(): E2EEnv {
  const baseUrl = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
  const isLocal = LOCAL_HOSTS.has(new URL(baseUrl).hostname);

  const username = process.env.E2E_USER ?? (isLocal ? 'demo' : undefined);
  const password = process.env.E2E_PASSWORD ?? (isLocal ? 'studio' : undefined);
  if (!username || !password) {
    throw new Error(
      `E2E_USER and E2E_PASSWORD must be set to run against ${baseUrl}; ` +
        'only the compose stack has seeded defaults.',
    );
  }

  return { baseUrl, isLocal, credentials: { username, password } };
}

export const e2eEnv: E2EEnv = readEnv();
