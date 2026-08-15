import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setHeaderLoading, setUser } from '@gears-frontx/react';

type BusHandler = (payload?: unknown) => void | Promise<void>;

const { listeners, mockHas, mockGetService, mockGetIdentity } = vi.hoisted(() => ({
  listeners: new Map<string, ((payload?: unknown) => void | Promise<void>)[]>(),
  mockHas: vi.fn(),
  mockGetService: vi.fn(),
  mockGetIdentity: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  eventBus: {
    on: vi.fn((eventName: string, handler: BusHandler) => {
      listeners.set(eventName, [...(listeners.get(eventName) ?? []), handler]);
      return () => listeners.delete(eventName);
    }),
    emit: vi.fn(),
  },
  apiRegistry: {
    has: mockHas,
    getService: mockGetService,
  },
}));

vi.mock('@/app/auth/keycloakOidcProvider', () => ({
  keycloakOidcProvider: { getIdentity: mockGetIdentity },
}));

import { registerBootstrapEffects } from './bootstrapEffects';

async function emit(eventName: string, payload?: unknown): Promise<void> {
  await Promise.all((listeners.get(eventName) ?? []).map((h) => h(payload)));
}

describe('registerBootstrapEffects', () => {
  const dispatch = vi.fn();

  beforeEach(() => {
    registerBootstrapEffects(dispatch);
    mockHas.mockReturnValue(true);
    mockGetService.mockReturnValue({
      me: { fetch: vi.fn().mockResolvedValue({ subject_id: 'abcdef12-3456', subject_type: 'user' }) },
    });
    mockGetIdentity.mockResolvedValue({
      sub: 'abcdef12-3456',
      claims: { name: 'Ada L', preferred_username: 'ada', email: 'ada@example.com' },
    });
  });

  afterEach(() => {
    listeners.clear();
    vi.clearAllMocks();
  });

  it('assembles the header user from token claims after the /me check', async () => {
    await emit('app/user/fetch');

    expect(dispatch).toHaveBeenCalledWith(setHeaderLoading(true));
    expect(dispatch).toHaveBeenCalledWith(
      setUser({ displayName: 'Ada L', email: 'ada@example.com' })
    );
    expect(dispatch).toHaveBeenCalledWith(setHeaderLoading(false));
  });

  it('falls back to preferred_username, then to the /me subject id', async () => {
    mockGetIdentity.mockResolvedValue({ sub: 'x', claims: { preferred_username: 'ada' } });
    await emit('app/user/fetch');
    expect(dispatch).toHaveBeenCalledWith(setUser({ displayName: 'ada', email: undefined }));

    dispatch.mockClear();
    mockGetIdentity.mockResolvedValue(null); // opaque static dev token
    await emit('app/user/fetch');
    expect(dispatch).toHaveBeenCalledWith(setUser({ displayName: 'abcdef12…', email: undefined }));
  });

  it('does nothing when the accounts service is not registered', async () => {
    mockHas.mockReturnValue(false);
    await emit('app/user/fetch');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('warns and clears the loading flag when the /me check fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetService.mockReturnValue({
      me: { fetch: vi.fn().mockRejectedValue(new Error('401')) },
    });

    await emit('app/user/fetch');

    expect(warn).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(setHeaderLoading(true));
    expect(dispatch).toHaveBeenCalledWith(setHeaderLoading(false));
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: expect.stringContaining('setUser') })
    );
    warn.mockRestore();
  });

  it('updates the header from app/user/loaded payloads', async () => {
    await emit('app/user/loaded', {
      user: { firstName: 'Grace', lastName: 'Hopper', email: 'g@example.com' },
    });
    expect(dispatch).toHaveBeenCalledWith(
      setUser({ displayName: 'Grace Hopper', email: 'g@example.com', avatarUrl: undefined })
    );
  });
});
