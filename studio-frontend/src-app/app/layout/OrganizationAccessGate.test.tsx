/**
 * What somebody with no organization is offered.
 *
 * The rule under test: this state is one they can leave on their own (ADR-0018
 * §2) — by creating an organization, or by accepting an invitation already
 * addressed to them — and what they are offered is what the installation
 * actually allows. Offering creation where creation is refused teaches somebody
 * the product is broken; withholding it where it is allowed leaves them waiting
 * for an administrator this ADR exists to remove from the path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, findByText, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockEventBus, mockHas, mockGetService } = vi.hoisted(() => ({
  mockEventBus: { emit: vi.fn() },
  mockHas: vi.fn(),
  mockGetService: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useAppSelector: () => ({ access: 'unassigned' }),
  eventBus: mockEventBus,
  apiRegistry: { has: mockHas, getService: mockGetService },
}));

import { IdentityApiService, OrganizationsApiService } from '@/app/api';
import { OrganizationAccessGate } from './OrganizationAccessGate';

const INVITATION = {
  id: 'inv-1',
  org_id: '00000000-0000-0000-0000-0000000000b1',
  email: 'ada@example.test',
  role: 'member',
  expires_at_epoch_ms: 4_102_444_800_000,
};

function services({
  selfService = true,
  invitations = [] as (typeof INVITATION)[],
} = {}) {
  const create = { fetch: vi.fn().mockResolvedValue({ id: 'org-1', name: 'Acme' }) };
  const acceptInvitation = { fetch: vi.fn().mockResolvedValue({ org_id: INVITATION.org_id }) };
  const organizations = {
    capabilities: { fetch: vi.fn().mockResolvedValue({ self_service: selfService }) },
    create,
  };
  const identity = {
    myInvitations: { fetch: vi.fn().mockResolvedValue({ items: invitations }) },
    acceptInvitation,
  };
  mockHas.mockReturnValue(true);
  mockGetService.mockImplementation((service: unknown) => {
    if (service === OrganizationsApiService) return organizations;
    if (service === IdentityApiService) return identity;
    return undefined;
  });
  return { create, acceptInvitation };
}

describe('OrganizationAccessGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('offers creation where the installation allows it', async () => {
    services({ selfService: true });
    render(<OrganizationAccessGate />);
    expect(await screen.findByPlaceholderText('Organization name')).toBeTruthy();
  });

  it('offers waiting, not a control that would be refused, where it does not', async () => {
    services({ selfService: false });
    render(<OrganizationAccessGate />);
    // The waiting copy is what appears; the create control never does.
    await screen.findByText(/ask a studio administrator/i);
    expect(screen.queryByPlaceholderText('Organization name')).toBeNull();
  });

  it('creates the organization and asks the shell to resolve its context again', async () => {
    const { create } = services({ selfService: true });
    render(<OrganizationAccessGate />);
    const input = await screen.findByPlaceholderText('Organization name');
    fireEvent.change(input, { target: { value: '  Acme  ' } });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(create.fetch).toHaveBeenCalledWith({ name: 'Acme' }));
    // Whatever just became true is true on the server; re-reading it is how
    // this screen goes away.
    expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/fetch');
  });

  it('accepts a waiting invitation by its id, never by a token it was never shown', async () => {
    const { acceptInvitation } = services({ invitations: [INVITATION] });
    render(<OrganizationAccessGate />);
    fireEvent.click(await screen.findByText('Accept'));
    await waitFor(() =>
      expect(acceptInvitation.fetch).toHaveBeenCalledWith({ invitation_id: 'inv-1' })
    );
    expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/fetch');
  });

  it('passes a refusal through rather than replacing it with something vaguer', async () => {
    const { create } = services({ selfService: true });
    create.fetch.mockRejectedValueOnce(new Error('an organization needs a name'));
    const { container } = render(<OrganizationAccessGate />);
    const input = await screen.findByPlaceholderText('Organization name');
    fireEvent.change(input, { target: { value: 'Acme' } });
    fireEvent.click(screen.getByText('Create'));
    expect(await findByText(container, 'an organization needs a name')).toBeTruthy();
  });
});
