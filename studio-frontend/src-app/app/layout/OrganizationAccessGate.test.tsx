/**
 * What somebody with no organization is offered.
 *
 * The rule under test: this state is one they can leave on their own (ADR-0018
 * §2) — by creating an organization, or by accepting an invitation already
 * addressed to them — and what they are offered is what the installation
 * actually allows. Offering creation where creation is refused teaches somebody
 * the product is broken; withholding it where it is allowed leaves them waiting
 * for an administrator this ADR exists to remove from the path.
 *
 * Where the installation only lets people ask (ADR-0051 §5), the same holds
 * for asking: the form, then the person's own request and what became of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  findByText,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

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
import type { OrganizationCreation, OrganizationRequest } from '@/app/api';
import { OrganizationAccessGate, PENDING_POLL_MS } from './OrganizationAccessGate';

const INVITATION = {
  id: 'inv-1',
  org_id: '00000000-0000-0000-0000-0000000000b1',
  email: 'ada@example.test',
  role: 'member',
  expires_at_epoch_ms: 4_102_444_800_000,
};

function request(overrides: Partial<OrganizationRequest> = {}): OrganizationRequest {
  return {
    id: 'req-1',
    requested_by: 'person-1',
    name: 'Acme',
    note: '',
    status: 'pending',
    created_at_ms: 1_767_225_600_000,
    ...overrides,
  };
}

function services({
  selfService = true,
  creation = undefined as OrganizationCreation | undefined,
  invitations = [] as (typeof INVITATION)[],
  mine = [] as OrganizationRequest[],
} = {}) {
  const create = { fetch: vi.fn().mockResolvedValue({ id: 'org-1', name: 'Acme' }) };
  const acceptInvitation = { fetch: vi.fn().mockResolvedValue({ org_id: INVITATION.org_id }) };
  const requestOrganization = {
    fetch: vi
      .fn()
      .mockImplementation(async (body: { name: string; note?: string }) =>
        request({ name: body.name, note: body.note ?? '' })
      ),
  };
  const mineFetch = vi.fn().mockResolvedValue({ items: mine, total: mine.length });
  const organizationRequests = vi.fn().mockReturnValue({ fetch: mineFetch });
  const cancelFetch = vi.fn().mockResolvedValue(request({ status: 'withdrawn' }));
  const cancelRequest = vi.fn().mockReturnValue({ fetch: cancelFetch });
  const organizations = {
    capabilities: {
      fetch: vi
        .fn()
        .mockResolvedValue(
          creation === undefined
            ? { self_service: selfService }
            : { self_service: creation === 'open', organization_creation: creation }
        ),
    },
    create,
    requestOrganization,
    organizationRequests,
    cancelRequest,
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
  return {
    create,
    acceptInvitation,
    requestOrganization,
    organizationRequests,
    mineFetch,
    cancelRequest,
    cancelFetch,
  };
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

  describe('where the installation says which of the three it is', () => {
    it('open: offers creation, and nothing to ask with', async () => {
      services({ creation: 'open', selfService: false });
      render(<OrganizationAccessGate />);
      await screen.findByText('Create');
      expect(screen.queryByText('Ask for an organization')).toBeNull();
    });

    it('off: offers neither creating nor asking', async () => {
      const { organizationRequests } = services({ creation: 'off' });
      render(<OrganizationAccessGate />);
      await screen.findByText(/ask a studio administrator/i);
      expect(screen.queryByPlaceholderText('Organization name')).toBeNull();
      // Nothing about requests is even read where there is nothing to ask.
      expect(organizationRequests).not.toHaveBeenCalled();
    });

    it('request: offers the form, never the create control, and sends the name and the note', async () => {
      const { requestOrganization, create } = services({ creation: 'request' });
      render(<OrganizationAccessGate />);
      const input = await screen.findByPlaceholderText('Organization name');
      expect(screen.queryByText('Create')).toBeNull();
      fireEvent.change(input, { target: { value: '  Acme  ' } });
      fireEvent.change(screen.getByLabelText('Note for the administrator'), {
        target: { value: ' We build bridges ' },
      });
      fireEvent.click(screen.getByText('Ask for an organization'));
      await waitFor(() =>
        expect(requestOrganization.fetch).toHaveBeenCalledWith({
          name: 'Acme',
          note: 'We build bridges',
        })
      );
      // The request's state replaces the form; the person is not in yet.
      expect(await screen.findByText('Your request is waiting for review')).toBeTruthy();
      expect(create.fetch).not.toHaveBeenCalled();
      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });

    it('request: shows a pending request with a way to withdraw it', async () => {
      const { cancelRequest, cancelFetch } = services({
        creation: 'request',
        mine: [request({ name: 'Bridges Ltd' })],
      });
      render(<OrganizationAccessGate />);
      expect(await screen.findByText('Bridges Ltd')).toBeTruthy();
      expect(screen.queryByPlaceholderText('Organization name')).toBeNull();
      fireEvent.click(screen.getByText('Withdraw'));
      await waitFor(() => expect(cancelRequest).toHaveBeenCalledWith('req-1'));
      expect(cancelFetch).toHaveBeenCalled();
      // Withdrawn, the form is back, holding the name they had asked for.
      const input = await screen.findByPlaceholderText('Organization name');
      expect((input as HTMLInputElement).value).toBe('Bridges Ltd');
    });

    it('request: shows a rejection with its reason, and lets them ask again', async () => {
      services({
        creation: 'request',
        mine: [request({ status: 'rejected', reason: 'Use your company email, please.' })],
      });
      render(<OrganizationAccessGate />);
      expect(await screen.findByText('Use your company email, please.')).toBeTruthy();
      expect(screen.getByText('Ask again')).toBeTruthy();
      expect((screen.getByPlaceholderText('Organization name') as HTMLInputElement).value).toBe(
        'Acme'
      );
    });

    it('request: an approved request re-reads the context, once', async () => {
      services({
        creation: 'request',
        mine: [request({ status: 'approved', organization_id: 'req-1' })],
      });
      render(<OrganizationAccessGate />);
      await waitFor(() => expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/fetch'));
      expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    });

    it('request: reads a pending request again until it is decided, and stops with the screen', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { mineFetch } = services({ creation: 'request', mine: [request()] });
        const { unmount } = render(<OrganizationAccessGate />);
        await screen.findByText('Withdraw');
        expect(mineFetch).toHaveBeenCalledTimes(1);

        mineFetch.mockResolvedValue({
          items: [request({ status: 'approved', organization_id: 'req-1' })],
          total: 1,
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(PENDING_POLL_MS);
        });
        expect(mineFetch).toHaveBeenCalledTimes(2);
        await waitFor(() => expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/fetch'));

        unmount();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(PENDING_POLL_MS * 3);
        });
        expect(mineFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('request: shows the sentence of a failed precondition, not its category', async () => {
      const { requestOrganization } = services({ creation: 'request' });
      requestOrganization.fetch.mockRejectedValueOnce(
        Object.assign(new Error('Request failed with status code 400'), {
          response: {
            status: 400,
            data: {
              detail: 'Operation precondition not met',
              context: {
                violations: [
                  {
                    type: 'REQUEST_ALREADY_PENDING',
                    subject: 'req-0',
                    description: 'You already have a request waiting for review.',
                  },
                ],
              },
            },
          },
        })
      );
      render(<OrganizationAccessGate />);
      fireEvent.change(await screen.findByPlaceholderText('Organization name'), {
        target: { value: 'Acme' },
      });
      fireEvent.click(screen.getByText('Ask for an organization'));
      expect(await screen.findByText('You already have a request waiting for review.')).toBeTruthy();
    });

    it('request: invitations stay on top', async () => {
      services({ creation: 'request', invitations: [INVITATION] });
      render(<OrganizationAccessGate />);
      const accept = await screen.findByText('Accept');
      const ask = await screen.findByText('Ask for an organization');
      expect(accept.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
