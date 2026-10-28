/**
 * The platform administrator's list of organization requests.
 *
 * The rules under test: the list is everybody's pending requests, oldest
 * first as the backend orders them; approving may correct the name, and what
 * is approved is what is sent; rejecting carries the reason the requester
 * reads; a decided request leaves the pending list because the list is read
 * again, not edited in place; and only a caller the backend says decides
 * requests is offered the list at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

const { mockHas, mockGetService } = vi.hoisted(() => ({
  mockHas: vi.fn(),
  mockGetService: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { has: mockHas, getService: mockGetService },
}));

import type { OrganizationRequest } from '@/app/api';
import {
  OrganizationRequestsList,
  REQUESTS_PAGE,
  useDecidesRequests,
} from './OrganizationRequests';

function request(overrides: Partial<OrganizationRequest> = {}): OrganizationRequest {
  return {
    id: 'req-1',
    requested_by: 'person-1',
    requester_name: 'Ada Lovelace',
    requester_email: 'ada@example.test',
    name: 'Analytical Engines',
    note: 'We make engines.',
    status: 'pending',
    created_at_ms: 1_767_225_600_000,
    ...overrides,
  };
}

function services({ pages = [[request()]] as OrganizationRequest[][], decides = true } = {}) {
  let read = 0;
  const listFetch = vi.fn().mockImplementation(async () => {
    const items = pages[Math.min(read, pages.length - 1)] ?? [];
    read += 1;
    return { items, total: items.length };
  });
  const organizationRequests = vi.fn().mockReturnValue({ fetch: listFetch });
  const decisionFetch = vi.fn().mockResolvedValue(request({ status: 'approved' }));
  const decideRequest = vi.fn().mockReturnValue({ fetch: decisionFetch });
  const organizations = {
    capabilities: {
      fetch: vi.fn().mockResolvedValue({
        self_service: false,
        organization_creation: 'request',
        decides_requests: decides,
      }),
    },
    organizationRequests,
    decideRequest,
  };
  mockHas.mockReturnValue(true);
  mockGetService.mockReturnValue(organizations);
  return { organizationRequests, listFetch, decideRequest, decisionFetch };
}

describe('OrganizationRequestsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('lists everybody’s pending requests: who asked, for what, and why', async () => {
    const { organizationRequests } = services();
    render(<OrganizationRequestsList />);
    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('ada@example.test')).toBeTruthy();
    expect(screen.getByText('Analytical Engines')).toBeTruthy();
    expect(screen.getByText('We make engines.')).toBeTruthy();
    expect(organizationRequests).toHaveBeenCalledWith({
      scope: 'all',
      status: 'pending',
      offset: 0,
      limit: REQUESTS_PAGE,
    });
  });

  it('approves under a corrected name, then reads the list again', async () => {
    const { decideRequest, decisionFetch, listFetch } = services({
      pages: [[request()], []],
    });
    render(<OrganizationRequestsList />);
    fireEvent.click(await screen.findByText('Approve'));
    const name = screen.getByLabelText('Organization name to approve');
    expect((name as HTMLInputElement).value).toBe('Analytical Engines');
    fireEvent.change(name, { target: { value: ' Engines Ltd ' } });
    fireEvent.click(screen.getByText('Confirm approval'));
    await waitFor(() =>
      expect(decisionFetch).toHaveBeenCalledWith({ decision: 'approve', name: 'Engines Ltd' })
    );
    expect(decideRequest).toHaveBeenCalledWith('req-1');
    // Decided, it is no longer pending: the page the server answers next is empty.
    expect(await screen.findByText('Nobody is waiting for an answer.')).toBeTruthy();
    expect(listFetch).toHaveBeenCalledTimes(2);
  });

  it('rejects with the reason the requester will read', async () => {
    const { decisionFetch } = services({ pages: [[request()], []] });
    render(<OrganizationRequestsList />);
    fireEvent.click(await screen.findByText('Reject'));
    fireEvent.change(screen.getByLabelText('Reason the requester will read'), {
      target: { value: ' Use your company email. ' },
    });
    fireEvent.click(screen.getByText('Confirm rejection'));
    await waitFor(() =>
      expect(decisionFetch).toHaveBeenCalledWith({
        decision: 'reject',
        reason: 'Use your company email.',
      })
    );
    expect(await screen.findByText('Nobody is waiting for an answer.')).toBeTruthy();
  });

  it('says an approval that failed part-way is finished by approving again', async () => {
    const { decisionFetch } = services();
    decisionFetch.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 500'), {
        response: { status: 500, data: { detail: 'Internal error' } },
      })
    );
    render(<OrganizationRequestsList />);
    fireEvent.click(await screen.findByText('Approve'));
    fireEvent.click(screen.getByText('Confirm approval'));
    expect(await screen.findByText(/approve again to finish it/)).toBeTruthy();
    // The draft stays, so approving again is one click.
    expect(screen.getByText('Confirm approval')).toBeTruthy();
  });

  it('shows other statuses on request', async () => {
    const { organizationRequests } = services({
      pages: [[request()], [request({ status: 'rejected', reason: 'Not a company.' })]],
    });
    render(<OrganizationRequestsList />);
    await screen.findByText('Approve');
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'rejected' } });
    expect(await screen.findByText('Not a company.')).toBeTruthy();
    expect(screen.queryByText('Approve')).toBeNull();
    expect(organizationRequests).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'all', status: 'rejected' })
    );
  });
});

describe('useDecidesRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is true only for a caller the backend says decides requests', async () => {
    services({ decides: true });
    const decides = renderHook(() => useDecidesRequests());
    await waitFor(() => expect(decides.result.current).toBe(true));

    services({ decides: false });
    const doesNot = renderHook(() => useDecidesRequests());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(doesNot.result.current).toBe(false);
  });

  it('is false where the gear is not registered', () => {
    mockHas.mockReturnValue(false);
    const { result } = renderHook(() => useDecidesRequests());
    expect(result.current).toBe(false);
    expect(mockGetService).not.toHaveBeenCalled();
  });
});
