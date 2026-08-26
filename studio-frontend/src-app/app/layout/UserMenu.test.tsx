import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearUser } from '@gears-frontx/react';

/**
 * Identity used to live at the foot of the left menu. The menu became a drawer
 * that is closed most of the time, so sign-out moved to the top bar — these are
 * the menu's old user-block tests, following the control to its new home.
 */

interface TestUser {
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

const { mockAuth, mockDispatch, headerState } = vi.hoisted(() => ({
  mockAuth: { logout: vi.fn() },
  mockDispatch: vi.fn(),
  headerState: {
    user: { displayName: 'Alexander Johanson', email: 'alex@studio' } as TestUser | null,
    loading: false,
  },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useFrontX: () => ({ auth: mockAuth }),
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ 'layout/header': headerState }),
}));

import { UserMenu } from './UserMenu';

/** The identity block and sign-out live behind the avatar trigger. */
function openMenu(label = 'Alexander Johanson') {
  fireEvent.click(screen.getByLabelText(label));
}

describe('UserMenu', () => {
  beforeEach(() => {
    headerState.user = { displayName: 'Alexander Johanson', email: 'alex@studio' };
    headerState.loading = false;
    mockAuth.logout.mockResolvedValue({ type: 'none' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('labels the trigger with the signed-in identity', () => {
    render(<UserMenu />);
    expect(screen.getByLabelText('Alexander Johanson')).toBeTruthy();
  });

  it('falls back to the email when no display name is known', () => {
    headerState.user = { email: 'alex@studio' };
    render(<UserMenu />);
    expect(screen.getByLabelText('alex@studio')).toBeTruthy();
  });

  it('shows a placeholder rather than an identity while the user is loading', () => {
    headerState.user = null;
    headerState.loading = true;
    render(<UserMenu />);
    expect(screen.queryByLabelText('User')).toBeNull();
  });

  it('names the user and their email once opened', async () => {
    render(<UserMenu />);
    openMenu();
    await waitFor(() => expect(screen.getByText('alex@studio')).toBeTruthy());
  });

  it('sign-out clears the user and logs out via the auth runtime', async () => {
    render(<UserMenu />);
    openMenu();
    fireEvent.click(await screen.findByText('Sign out'));

    await waitFor(() => expect(mockAuth.logout).toHaveBeenCalled());
    expect(mockDispatch).toHaveBeenCalledWith(clearUser());
  });

  it('follows the IdP redirect returned by logout', async () => {
    mockAuth.logout.mockResolvedValue({ type: 'redirect', redirectUrl: 'https://idp/logout' });
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      set href(value: string) {
        assign(value);
      },
    } as unknown as Location);

    render(<UserMenu />);
    openMenu();
    fireEvent.click(await screen.findByText('Sign out'));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://idp/logout'));
    vi.restoreAllMocks();
  });
});
