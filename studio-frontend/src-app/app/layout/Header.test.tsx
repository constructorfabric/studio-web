import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearUser } from '@gears-frontx/react';

const { mockAuth, mockDispatch, headerState } = vi.hoisted(() => ({
  mockAuth: { logout: vi.fn() },
  mockDispatch: vi.fn(),
  headerState: {
    user: { displayName: 'Studio Admin', email: 'admin@studio' },
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

import { Header } from './Header';

describe('Header', () => {
  beforeEach(() => {
    mockAuth.logout.mockResolvedValue({ type: 'none' });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the user identity', () => {
    render(<Header />);
    expect(screen.getByText('Studio Admin')).toBeTruthy();
  });

  it('sign-out clears the header user and logs out via the auth runtime', async () => {
    render(<Header />);
    fireEvent.click(screen.getByText('Sign out'));

    await waitFor(() => expect(mockAuth.logout).toHaveBeenCalled());
    expect(mockDispatch).toHaveBeenCalledWith(clearUser());
  });
});
