/**
 * Sign-in screen.
 *
 * Lives in the light DOM, so it is styled with the shell's Tailwind +
 * aligned Studio palette, not with @gears-frontx/ui-kit (kit component CSS
 * reads complete-color tokens, which the shell defines as HSL triplets).
 *
 * Primary path is SSO (Authorization Code + PKCE); the collapsed developer
 * path accepts a static token for the backend's static-auth profiles
 * (config/dev.yaml, config/postgres.yaml) and validates it against /me
 * before establishing the session. The developer path exists only in dev
 * builds — Vite eliminates the branch from production bundles.
 */

import React, { useState } from 'react';
import { useFrontX } from '@gears-frontx/react';
import { ACCOUNTS_API_BASE_URL } from '@/app/api';

const IDP_HINTS = [
  { hint: 'google', label: 'Google' },
  { hint: 'github', label: 'GitHub' },
  { hint: 'microsoft', label: 'Microsoft' },
];

export interface LoginScreenProps {
  sessionExpired?: boolean;
  initialError?: string;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ sessionExpired, initialError }) => {
  const { auth } = useFrontX();
  const [error, setError] = useState<string | undefined>(
    initialError ?? (sessionExpired ? 'Session expired — please sign in again.' : undefined)
  );
  // DEV-gated so the default token string is eliminated from prod bundles.
  const [devToken, setDevToken] = useState(import.meta.env.DEV ? 'studio-admin-token' : '');
  const [busy, setBusy] = useState(false);

  const startSso = async (idpHint?: string) => {
    setBusy(true);
    try {
      const transition = await auth?.login?.({
        type: 'oauth',
        payload: idpHint ? { idpHint } : {},
      });
      if (transition?.type === 'redirect') {
        window.location.href = transition.redirectUrl;
        return; // navigating away
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const devSignIn = async (event: React.FormEvent) => {
    event.preventDefault();
    const token = devToken.trim();
    if (!token) return;
    setBusy(true);
    setError(undefined);
    try {
      // Validate before establishing the session, so a typo'd token never
      // momentarily mounts the authenticated app.
      const res = await fetch(`${ACCOUNTS_API_BASE_URL}/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError(res.status === 401 ? 'Invalid token' : `Sign-in failed: HTTP ${res.status}`);
        return;
      }
      await auth?.login?.({ type: 'static-token', payload: { token } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-8 shadow-sm">
        <h1 className="mb-1 text-2xl font-bold text-card-foreground">Constructor Studio</h1>
        <p className="mb-6 text-sm text-muted-foreground">Sign in to continue</p>

        {error && (
          <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={() => void startSso()}
          className="mb-3 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          Continue with Constructor ID
        </button>

        <div className="mb-6 flex gap-2">
          {IDP_HINTS.map(({ hint, label }) => (
            <button
              key={hint}
              type="button"
              disabled={busy}
              onClick={() => void startSso(hint)}
              className="flex-1 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              {label}
            </button>
          ))}
        </div>

        {import.meta.env.DEV && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Developer sign-in (static token)
            </summary>
            <form onSubmit={(e) => void devSignIn(e)} className="mt-3 flex gap-2">
              <input
                value={devToken}
                onChange={(e) => setDevToken(e.target.value)}
                placeholder="static token"
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              >
                Sign in
              </button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">
              Works only with the backend&apos;s static-auth profiles (config/dev.yaml).
            </p>
          </details>
        )}
      </div>
    </div>
  );
};

LoginScreen.displayName = 'LoginScreen';
