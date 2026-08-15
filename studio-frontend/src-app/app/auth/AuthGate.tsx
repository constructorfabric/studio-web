/**
 * Sign-in gate for the whole portal.
 *
 * On load: completes an OIDC redirect callback when `?code` is present
 * (the provider is re-entrant-safe, so a StrictMode double-mount performs
 * one exchange), scrubs the OIDC params from the URL, then restores the
 * session from the refresh token. Children — the entire authenticated app —
 * mount only after a session exists, so Layout's fetchCurrentUser always
 * runs with a token.
 */

import React, { useEffect, useRef, useState } from 'react';
import { keycloakOidcProvider } from './keycloakOidcProvider';
import { LoginScreen } from './LoginScreen';

const OIDC_CALLBACK_PARAMS = ['code', 'state', 'session_state', 'iss'];

type Phase = 'restoring' | 'unauthenticated' | 'authenticated';

function scrubCallbackParams(): void {
  const url = new URL(window.location.href);
  for (const p of OIDC_CALLBACK_PARAMS) url.searchParams.delete(p);
  window.history.replaceState({}, document.title, url.pathname + url.search);
}

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [phase, setPhase] = useState<Phase>('restoring');
  const [expired, setExpired] = useState(false);
  const [callbackError, setCallbackError] = useState<string | undefined>();
  const phaseRef = useRef<Phase>('restoring');
  phaseRef.current = phase;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      if (params.has('code')) {
        try {
          await keycloakOidcProvider.handleCallback({ params: Object.fromEntries(params) });
        } catch (error) {
          if (!cancelled) setCallbackError(error instanceof Error ? error.message : String(error));
        } finally {
          scrubCallbackParams();
        }
      }
      const check = await keycloakOidcProvider.checkAuth();
      if (!cancelled) setPhase(check.authenticated ? 'authenticated' : 'unauthenticated');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return keycloakOidcProvider.subscribe((event) => {
      if (event.state === 'authenticated') {
        setExpired(false);
        setCallbackError(undefined);
        setPhase('authenticated');
      } else {
        // Losing an established session (failed renewal, sign-out elsewhere)
        // is "expired"; never being signed in is not.
        if (phaseRef.current === 'authenticated') setExpired(true);
        setPhase('unauthenticated');
      }
    });
  }, []);

  if (phase === 'restoring') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Restoring session…
      </div>
    );
  }
  if (phase === 'unauthenticated') {
    return <LoginScreen sessionExpired={expired} initialError={callbackError} />;
  }
  return <>{children}</>;
};

AuthGate.displayName = 'AuthGate';
