import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AuthStateListener } from '@gears-frontx/auth';
import type { StudioAuthStateEvent } from './keycloakOidcProvider';

const { mockAuth, mockUseFrontX, listeners } = vi.hoisted(() => ({
  mockAuth: {
    checkAuth: vi.fn(),
    handleCallback: vi.fn(),
    subscribe: vi.fn(),
  },
  mockUseFrontX: vi.fn(),
  listeners: [] as Array<(event: unknown) => void>,
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useFrontX: mockUseFrontX,
}));

// The gate's contract with LoginScreen is just these two props — stub the
// screen so assertions don't depend on its markup.
vi.mock('./LoginScreen', () => ({
  LoginScreen: ({ sessionExpired, initialError }: { sessionExpired?: boolean; initialError?: string }) => (
    <div data-testid="login" data-expired={String(sessionExpired ?? false)}>
      {initialError}
    </div>
  ),
}));

import { AuthGate } from './AuthGate';

function notify(event: StudioAuthStateEvent): void {
  for (const listener of listeners) listener(event);
}

describe('AuthGate', () => {
  beforeEach(() => {
    mockUseFrontX.mockReturnValue({ auth: mockAuth });
    mockAuth.checkAuth.mockResolvedValue({ authenticated: false });
    mockAuth.handleCallback.mockResolvedValue({ type: 'none' });
    mockAuth.subscribe.mockImplementation((listener: AuthStateListener) => {
      listeners.push(listener as (event: unknown) => void);
      return () => {};
    });
  });

  afterEach(() => {
    cleanup();
    listeners.length = 0;
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('renders children once the session is restored', async () => {
    mockAuth.checkAuth.mockResolvedValue({ authenticated: true, session: { kind: 'bearer', token: 't' } });
    render(<AuthGate>app-content</AuthGate>);
    expect(await screen.findByText('app-content')).toBeTruthy();
  });

  it('lands on the login screen when checkAuth rejects — never stuck on restoring', async () => {
    mockAuth.checkAuth.mockRejectedValue(new Error('token endpoint returned a non-JSON response'));
    render(<AuthGate>app-content</AuthGate>);

    const login = await screen.findByTestId('login');
    expect(login.textContent).toContain('non-JSON response');
    expect(screen.queryByText('Restoring session…')).toBeNull();
  });

  it('surfaces an OIDC ?error callback and scrubs it from the URL', async () => {
    window.history.replaceState({}, '', '/?error=access_denied&error_description=User+declined');
    render(<AuthGate>app-content</AuthGate>);

    const login = await screen.findByTestId('login');
    expect(login.textContent).toContain('Sign-in failed: User declined');
    expect(window.location.search).toBe('');
    expect(mockAuth.handleCallback).not.toHaveBeenCalled();
  });

  it('completes a ?code callback, scrubs the URL, and mounts the app', async () => {
    window.history.replaceState({}, '', '/?code=abc&state=xyz&session_state=s#hash');
    mockAuth.checkAuth.mockResolvedValue({ authenticated: true, session: { kind: 'bearer', token: 't' } });
    render(<AuthGate>app-content</AuthGate>);

    expect(await screen.findByText('app-content')).toBeTruthy();
    expect(mockAuth.handleCallback).toHaveBeenCalledWith({
      params: expect.objectContaining({ code: 'abc', state: 'xyz' }),
    });
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#hash'); // scrub keeps the fragment
  });

  it('shows the callback failure on the login screen', async () => {
    window.history.replaceState({}, '', '/?code=abc&state=forged');
    mockAuth.handleCallback.mockRejectedValue(new Error('SSO callback state mismatch'));
    render(<AuthGate>app-content</AuthGate>);

    const login = await screen.findByTestId('login');
    expect(login.textContent).toContain('state mismatch');
    expect(window.location.search).toBe('');
  });

  it('treats losing an established session as expiry', async () => {
    mockAuth.checkAuth.mockResolvedValue({ authenticated: true, session: { kind: 'bearer', token: 't' } });
    render(<AuthGate>app-content</AuthGate>);
    await screen.findByText('app-content');

    notify({ state: 'unauthenticated' }); // failed renewal
    const login = await screen.findByTestId('login');
    expect(login.getAttribute('data-expired')).toBe('true');
  });

  it('does not call an explicit sign-out "expired"', async () => {
    mockAuth.checkAuth.mockResolvedValue({ authenticated: true, session: { kind: 'bearer', token: 't' } });
    render(<AuthGate>app-content</AuthGate>);
    await screen.findByText('app-content');

    notify({ state: 'unauthenticated', reason: 'signed-out' });
    const login = await screen.findByTestId('login');
    expect(login.getAttribute('data-expired')).toBe('false');
  });

  it('renders ungated with a warning when no auth runtime is configured', () => {
    // The no-uikit scaffold entry builds createFrontXApp() without an auth
    // plugin — the gate must not crash the whole app on mount there.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockUseFrontX.mockReturnValue({});
    render(<AuthGate>app-content</AuthGate>);

    expect(screen.getByText('app-content')).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no auth runtime configured'));
    warn.mockRestore();
  });

  it('flips to the app when the provider reports a fresh session', async () => {
    render(<AuthGate>app-content</AuthGate>);
    await screen.findByTestId('login');

    notify({ state: 'authenticated', session: { kind: 'bearer', token: 't' } });
    await waitFor(() => expect(screen.queryByTestId('login')).toBeNull());
    expect(screen.getByText('app-content')).toBeTruthy();
  });
});
