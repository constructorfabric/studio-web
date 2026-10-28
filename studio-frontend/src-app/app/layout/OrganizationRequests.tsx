/**
 * Organization Requests
 *
 * The platform administrator's list of people asking for an organization, and
 * the two answers (ADR-0051 §§4–5): approve — under the name asked for or a
 * corrected one — or reject with a reason the requester reads.
 *
 * Shell-owned, like the access gate, rather than a screen in an MFE: it is not
 * scoped to an organization, workspace or project, so no level of the address
 * is its home, and the person who needs it may have no organization at all —
 * the gate shows instead of every mounted screen then, while the top bar and
 * its account menu stay. The menu is where it opens from, and only for a
 * caller the backend says decides requests (`decides_requests`); everybody else
 * is refused by the routes anyway, so the item is absent rather than refusing.
 *
 * What a requester wrote is shown to the administrator verbatim — the name and
 * the note are the whole case they make — and nothing here is shown to anybody
 * else.
 */

import React from 'react';
import { X } from 'lucide-react';
import { apiRegistry } from '@gears-frontx/react';
import { responseStatus } from '@constructor-studio/mfe-shared';
import {
  OrganizationsApiService,
  type OrganizationRequest,
  type OrganizationRequestStatus,
} from '@/app/api';
import { formatWhen, messageOf } from './OrganizationAccessGate';

/** One page of the list: an administrator works through it oldest first. */
export const REQUESTS_PAGE = 50;

const STATUSES: readonly OrganizationRequestStatus[] = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
];

/**
 * Whether the signed-in person decides organization requests. Read once, and
 * false until answered or when the gear is absent: offering the list to
 * somebody it refuses would be the broken-product lesson the gate avoids.
 */
export function useDecidesRequests(): boolean {
  const [decides, setDecides] = React.useState(false);
  React.useEffect(() => {
    if (!apiRegistry.has(OrganizationsApiService)) return;
    let live = true;
    apiRegistry
      .getService(OrganizationsApiService)
      .capabilities.fetch()
      .then((capabilities) => {
        if (live) setDecides(capabilities?.decides_requests === true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return decides;
}

/** Which answer is being written for which row, if any. */
type Draft =
  | { kind: 'approve'; id: string; name: string }
  | { kind: 'reject'; id: string; reason: string };

export const OrganizationRequestsList: React.FC = () => {
  const [status, setStatus] = React.useState<OrganizationRequestStatus>('pending');
  const [offset, setOffset] = React.useState(0);
  const [items, setItems] = React.useState<OrganizationRequest[]>([]);
  const [total, setTotal] = React.useState(0);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [deciding, setDeciding] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /** Bumped after a decision, so the page is read again from the server. */
  const [generation, setGeneration] = React.useState(0);
  /** Which read the shown page answers; loading is any other being asked. */
  const readKey = `${status}:${offset}:${generation}`;
  const [shownKey, setShownKey] = React.useState<string | null>(null);
  const loading = shownKey !== readKey;

  React.useEffect(() => {
    let live = true;
    apiRegistry
      .getService(OrganizationsApiService)
      .organizationRequests({ scope: 'all', status, offset, limit: REQUESTS_PAGE })
      .fetch({ staleTime: 0 })
      .then((page) => {
        if (!live) return;
        setItems(page?.items ?? []);
        setTotal(page?.total ?? 0);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (live) setError(messageOf(failure));
      })
      .finally(() => {
        if (live) setShownKey(readKey);
      });
    return () => {
      live = false;
    };
  }, [status, offset, generation, readKey]);

  const decide = async (current: Draft) => {
    if (deciding) return;
    setDeciding(true);
    setError(null);
    try {
      const service = apiRegistry.getService(OrganizationsApiService);
      if (current.kind === 'approve') {
        await service
          .decideRequest(current.id)
          .fetch({ decision: 'approve', name: current.name.trim() });
      } else {
        const reason = current.reason.trim();
        await service
          .decideRequest(current.id)
          .fetch(reason ? { decision: 'reject', reason } : { decision: 'reject' });
      }
      setDraft(null);
      setGeneration((value) => value + 1);
    } catch (failure) {
      // A failed approval leaves the request pending and the organization
      // half-made; approving again finishes the same one (ADR-0051 §4).
      const status = responseStatus(failure);
      setError(
        current.kind === 'approve' && status !== undefined && status >= 500
          ? `${messageOf(failure)} — the organization may be half-created; approve again to finish it.`
          : messageOf(failure)
      );
    }
    setDeciding(false);
  };

  const renderActions = (request: OrganizationRequest) => {
    if (request.status !== 'pending') {
      return request.status === 'rejected' && request.reason ? (
        <span className="text-sm opacity-70">{request.reason}</span>
      ) : null;
    }
    if (draft?.id === request.id && draft.kind === 'approve') {
      return (
        <form
          className="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.name.trim()) void decide(draft);
          }}
        >
          <input
            aria-label="Organization name to approve"
            className="rounded border px-2 py-1 text-sm"
            maxLength={120}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            disabled={deciding}
          />
          <span className="flex gap-1">
            <button
              type="submit"
              className="rounded border px-2 py-1 text-sm"
              disabled={deciding || draft.name.trim() === ''}
            >
              Confirm approval
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-sm"
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
          </span>
        </form>
      );
    }
    if (draft?.id === request.id && draft.kind === 'reject') {
      return (
        <form
          className="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            void decide(draft);
          }}
        >
          <textarea
            aria-label="Reason the requester will read"
            className="rounded border px-2 py-1 text-sm"
            placeholder="Why not (the requester reads this)"
            rows={2}
            value={draft.reason}
            onChange={(event) => setDraft({ ...draft, reason: event.target.value })}
            disabled={deciding}
          />
          <span className="flex gap-1">
            <button
              type="submit"
              className="rounded border px-2 py-1 text-sm"
              disabled={deciding}
            >
              Confirm rejection
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-sm"
              onClick={() => setDraft(null)}
            >
              Cancel
            </button>
          </span>
        </form>
      );
    }
    return (
      <span className="flex gap-1">
        <button
          type="button"
          className="rounded border px-2 py-1 text-sm"
          disabled={deciding}
          onClick={() => setDraft({ kind: 'approve', id: request.id, name: request.name })}
        >
          Approve
        </button>
        <button
          type="button"
          className="rounded border px-2 py-1 text-sm"
          disabled={deciding}
          onClick={() => setDraft({ kind: 'reject', id: request.id, reason: '' })}
        >
          Reject
        </button>
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <label htmlFor="organization-requests-status" className="text-sm">
          Show
        </label>
        <select
          id="organization-requests-status"
          className="rounded border px-2 py-1 text-sm"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as OrganizationRequestStatus);
            setOffset(0);
            setDraft(null);
          }}
        >
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <span className="text-sm opacity-70">{loading ? 'Loading…' : `${total} in all`}</span>
      </div>

      {!loading && items.length === 0 && error === null && (
        <p className="text-sm opacity-70">
          {status === 'pending' ? 'Nobody is waiting for an answer.' : `No ${status} requests.`}
        </p>
      )}

      {items.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-1 pr-3 font-medium">Who asked</th>
              <th className="py-1 pr-3 font-medium">Organization</th>
              <th className="py-1 pr-3 font-medium">Note</th>
              <th className="py-1 pr-3 font-medium">Asked</th>
              <th className="py-1 font-medium" aria-label="Decision" />
            </tr>
          </thead>
          <tbody>
            {items.map((request) => (
              <tr key={request.id} className="border-b align-top">
                <td className="py-2 pr-3">
                  {request.requester_name || 'Unnamed'}
                  {request.requester_email && (
                    <span className="block opacity-70">{request.requester_email}</span>
                  )}
                </td>
                <td className="py-2 pr-3">{request.name}</td>
                <td className="max-w-xs whitespace-pre-wrap break-words py-2 pr-3">
                  {request.note}
                </td>
                <td className="whitespace-nowrap py-2 pr-3">{formatWhen(request.created_at_ms)}</td>
                <td className="py-2">{renderActions(request)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {total > REQUESTS_PAGE && (
        <div className="flex items-center gap-2 text-sm">
          <button
            type="button"
            className="rounded border px-2 py-1"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - REQUESTS_PAGE))}
          >
            Previous
          </button>
          <span>
            {offset + 1}–{Math.min(offset + REQUESTS_PAGE, total)} of {total}
          </span>
          <button
            type="button"
            className="rounded border px-2 py-1"
            disabled={offset + REQUESTS_PAGE >= total || loading}
            onClick={() => setOffset(offset + REQUESTS_PAGE)}
          >
            Next
          </button>
        </div>
      )}

      {error !== null && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
};

OrganizationRequestsList.displayName = 'OrganizationRequestsList';

/**
 * The frame the list opens in: a scrim and a card over everything, closed by
 * its button, the scrim or Escape. Mounted only while open, so the list reads
 * afresh every time it is opened.
 */
export const OrganizationRequestsDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="organization-requests-title"
        className="relative max-h-[90vh] w-[min(64rem,calc(100vw-2rem))] overflow-auto rounded-lg border bg-background p-4 text-foreground shadow-lg"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id="organization-requests-title" className="text-lg font-semibold">
            Organization requests
          </h2>
          <button type="button" aria-label="Close" className="rounded p-1" onClick={onClose}>
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        <OrganizationRequestsList />
      </div>
    </div>
  );
};

OrganizationRequestsDialog.displayName = 'OrganizationRequestsDialog';
