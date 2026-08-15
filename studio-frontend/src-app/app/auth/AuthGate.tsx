/**
 * Sign-in gate for the whole portal.
 *
 * On load: completes an OIDC redirect callback when `?code` is present
 * (the provider is re-entrant-safe, so a StrictMode double-mount performs
 * one exchange), surfaces `?error` callbacks from the IdP, scrubs the OIDC
 * params from the URL, then restores the session from the refresh token.
 * Every failure path lands on the login screen with a message — the gate
 * must never stay stuck on "Restoring session…". Children — the entire
 * authenticated app — mount only after a session exists, so Layout's
 * fetchCurrentUser always runs with a token.
 *
 * Talks to auth through the framework runtime (useFrontX().auth), not the
 * concrete provider — swapping the provider in main.tsx swaps it here too.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useFrontX } from '@gears-frontx/react';
import type { StudioAuthStateEvent } from './keycloakOidcProvider';
import { LoginScreen } from './LoginScreen';

const OIDC_CALLBACK_PARAMS = ['code', 'state', 'session_state', 'iss', 'error', 'error_description'];

type Phase = 'restoring' | 'unauthenticated' | 'authenticated';

function scrubCallbackParams(): void {
  const url = new URL(window.location.href);
  for (const p of OIDC_CALLBACK_PARAMS) url.searchParams.delete(p);
  window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
}

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { auth } = useFrontX();
  if (!auth) {
    throw new Error('AuthGate requires createFrontXApp({ auth: { provider } }) to be configured');
  }

  const [phase, setPhase] = useState<Phase>('restoring');
  const [expired, setExpired] = useState(false);
  const [callbackError, setCallbackError] = useState<string | undefined>();
  const phaseRef = useRef<Phase>('restoring');
  phaseRef.current = phase;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      let bootError: string | undefined;
      if (params.has('error')) {
        // The IdP redirected back with an OIDC error (declined consent,
        // unconfigured kc_idp_hint, client misconfiguration) instead of a code.
        bootError = `Sign-in failed: ${params.get('error_description') ?? params.get('error')}`;
        scrubCallbackParams();
      } else if (params.has('code')) {
        try {
          await auth.handleCallback?.({ params: Object.fromEntries(params) });
        } catch (error) {
          bootError = error instanceof Error ? error.message : String(error);
        } finally {
          scrubCallbackParams();
        }
      }
      let authenticated = false;
      try {
        authenticated = (await auth.checkAuth()).authenticated;
      } catch (error) {
        bootError ??= error instanceof Error ? error.message : String(error);
      }
      if (cancelled) return;
      if (bootError) setCallbackError(bootError);
      setPhase(authenticated ? 'authenticated' : 'unauthenticated');
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- auth is set once at app construction
  }, []);

  useEffect(() => {
    return auth.subscribe?.((event) => {
      if (event.state === 'authenticated') {
        setExpired(false);
        setCallbackError(undefined);
        setPhase('authenticated');
      } else if (event.state === 'unauthenticated') {
        // Losing an established session (failed renewal, sign-out elsewhere)
        // is "expired"; an explicit sign-out and never being signed in are not.
        const signedOut = (event as StudioAuthStateEvent).reason === 'signed-out';
        if (phaseRef.current === 'authenticated' && !signedOut) setExpired(true);
        setPhase('unauthenticated');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- auth is set once at app construction
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
