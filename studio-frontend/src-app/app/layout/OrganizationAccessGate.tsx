/**
 * Organization Access Gate
 *
 * What an authenticated person sees when they belong to no organization.
 *
 * This is a supported state, not an error (ADR-0011 §3). Authentication
 * establishes who somebody is; it does not grant organization membership, so
 * "signed in with nowhere to go" is a normal place to be — on a first login, or
 * after a membership is revoked.
 *
 * It is also a state somebody can leave without an administrator, which is what
 * ADR-0018 §2 changed: they create their own organization and own it, or they
 * accept an invitation already addressed to them. Both are offered here, and
 * neither reveals anything about the installation. The screen still names no
 * organization it has not been asked about, lists no workspaces and no members:
 * naming an organization to somebody with no membership would leak the tenant
 * tree to anybody who can authenticate, which is the failure ADR-0011 exists to
 * prevent. An invitation is the exception the invitation itself creates — its
 * organization was already disclosed to this person when it was sent.
 *
 * Where creation is off — an installation inside one company, whose people are
 * joined to the organization it already has — the control is absent rather than
 * present-and-refusing: the capability is read before it is offered.
 *
 * Between the two is `request` (ADR-0051 §5): a cloud before billing, where the
 * person asks and a platform administrator approves the organization. They see
 * a name and a note to ask with, then their request's state — pending, which
 * they may withdraw, or rejected with the reason and a way to ask again. Their
 * own request is the only one shown, so the rule above still holds: it names
 * only the organization this person asked for.
 */

import React from 'react';
import { apiRegistry, eventBus, useAppSelector } from '@gears-frontx/react';
import { parseProblemDetails } from '@constructor-studio/mfe-shared';
import {
  IdentityApiService,
  OrganizationsApiService,
  type Invitation,
  type OrganizationCapabilities,
  type OrganizationCreation,
  type OrganizationRequest,
} from '@/app/api';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';

/** What the screen is waiting on, so it never shows two things at once. */
type Busy = 'idle' | 'loading' | 'creating' | 'requesting' | 'withdrawing' | 'accepting';

/**
 * How often a pending request is read again while this screen is up, so an
 * approval shows without a reload. A person with no organization has no tenant
 * to receive studio events on, so this is the one poll here; it runs only while
 * something is pending and stops with the screen.
 */
export const PENDING_POLL_MS = 30_000;

/** The limits the backend enforces, so the form refuses what it would. */
const NAME_MAX = 120;
const NOTE_MAX = 2000;

/**
 * The installation's setting. A backend older than ADR-0051 answers only
 * `self_service`, whose `true` and `false` meant what `open` and `off` mean now.
 */
export function creationOf(capabilities: OrganizationCapabilities | null): OrganizationCreation {
  return capabilities?.organization_creation ?? (capabilities?.self_service ? 'open' : 'off');
}

export const OrganizationAccessGate: React.FC = () => {
  const [creation, setCreation] = React.useState<OrganizationCreation>('off');
  const [invitations, setInvitations] = React.useState<Invitation[]>([]);
  /** The person's newest request, where creation is `request`. */
  const [latest, setLatest] = React.useState<OrganizationRequest | null>(null);
  const [name, setName] = React.useState('');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState<Busy>('loading');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    const load = async () => {
      const [capabilities, waiting] = await Promise.all([
        apiRegistry.has(OrganizationsApiService)
          ? apiRegistry
              .getService(OrganizationsApiService)
              .capabilities.fetch()
              .catch(() => null)
          : null,
        apiRegistry.has(IdentityApiService)
          ? apiRegistry
              .getService(IdentityApiService)
              .myInvitations.fetch()
              .catch(() => null)
          : null,
      ]);
      const mode = creationOf(capabilities);
      // A request that could not be read shows the form: asking again is
      // refused with the pending one named, which says more than a blank screen.
      const mine = mode === 'request' ? await readMine().catch(() => null) : null;
      if (!live) return;
      setCreation(mode);
      setInvitations(waiting?.items ?? []);
      setLatest(mine);
      if (mine?.status === 'rejected') setName(mine.name);
      setBusy('idle');
    };
    void load();
    return () => {
      live = false;
    };
  }, []);

  /**
   * Every path out ends the same way: ask the shell to resolve its context
   * again. Whatever just became true is true on the server, and re-reading it
   * is how this screen goes away — guessing what changed would be a second
   * source of truth for the thing this screen exists to reflect.
   */
  const reloadContext = () => eventBus.emit('app/context/fetch');

  // An approval is one more path out: the organization now exists with this
  // person as its owner. Once per request — if the context still has no
  // organization (an approval older than a revoked membership), the screen
  // offers the form again instead of asking the shell in a loop.
  const reloadedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (latest?.status !== 'approved' || reloadedFor.current === latest.id) return;
    reloadedFor.current = latest.id;
    reloadContext();
  }, [latest]);

  const pending = latest?.status === 'pending';
  React.useEffect(() => {
    if (!pending) return;
    let live = true;
    const timer = setInterval(() => {
      void readMine()
        .then((mine) => {
          if (live) setLatest(mine);
        })
        .catch(() => undefined);
    }, PENDING_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pending]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy !== 'idle') return;
    setBusy('creating');
    setError(null);
    try {
      await apiRegistry.getService(OrganizationsApiService).create.fetch({ name: name.trim() });
      reloadContext();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy('idle');
    }
  };

  const request = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy !== 'idle') return;
    setBusy('requesting');
    setError(null);
    try {
      const asked = await apiRegistry
        .getService(OrganizationsApiService)
        .requestOrganization.fetch(
          note.trim() ? { name: name.trim(), note: note.trim() } : { name: name.trim() }
        );
      setLatest(asked);
      setNote('');
    } catch (failure) {
      setError(messageOf(failure));
    }
    setBusy('idle');
  };

  const withdraw = async (waiting: OrganizationRequest) => {
    if (busy !== 'idle') return;
    setBusy('withdrawing');
    setError(null);
    try {
      const withdrawn = await apiRegistry
        .getService(OrganizationsApiService)
        .cancelRequest(waiting.id)
        .fetch(undefined);
      setLatest(withdrawn);
      setName(waiting.name);
    } catch (failure) {
      setError(messageOf(failure));
    }
    setBusy('idle');
  };

  const accept = async (invitation: Invitation) => {
    if (busy !== 'idle') return;
    setBusy('accepting');
    setError(null);
    try {
      await apiRegistry
        .getService(IdentityApiService)
        .acceptInvitation.fetch({ invitation_id: invitation.id });
      reloadContext();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy('idle');
    }
  };

  const nameField = (id: string) => (
    <input
      id={id}
      className="flex-1 rounded border px-3 py-2 text-sm"
      placeholder="Organization name"
      maxLength={NAME_MAX}
      value={name}
      onChange={(event) => setName(event.target.value)}
      disabled={busy === 'creating' || busy === 'requesting'}
    />
  );

  const renderRequest = () => {
    if (latest?.status === 'pending') {
      return (
        <section className="flex flex-col gap-2 rounded border p-3">
          <h2 className="text-sm font-medium">Your request is waiting for review</h2>
          <p className="text-sm">
            <strong>{latest.name}</strong>
            <span className="block opacity-70">Asked {formatWhen(latest.created_at_ms)}</span>
          </p>
          <p className="text-sm opacity-70">
            A platform administrator reviews it. Once it is approved, the organization opens here
            and you own it.
          </p>
          <div>
            <button
              type="button"
              className="rounded border px-3 py-1 text-sm"
              disabled={busy !== 'idle'}
              onClick={() => void withdraw(latest)}
            >
              Withdraw
            </button>
          </div>
        </section>
      );
    }

    const rejected = latest?.status === 'rejected' ? latest : null;
    return (
      <form onSubmit={request} className="flex flex-col gap-2">
        {rejected && (
          <div className="mb-2 rounded border p-3 text-sm">
            Your request for <strong>{rejected.name}</strong> was not approved.
            {rejected.reason && <span className="mt-1 block">{rejected.reason}</span>}
          </div>
        )}
        <label htmlFor="requested-organization-name" className="text-sm font-medium">
          {rejected ? 'Ask again' : 'Or ask for an organization'}
        </label>
        <p className="text-sm opacity-70">
          A platform administrator reviews the request. Once it is approved you own the
          organization, and can invite others.
        </p>
        {nameField('requested-organization-name')}
        <textarea
          aria-label="Note for the administrator"
          className="rounded border px-3 py-2 text-sm"
          placeholder="Who you are and what it is for (optional)"
          maxLength={NOTE_MAX}
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={busy === 'requesting'}
        />
        <div>
          <button
            type="submit"
            className="rounded border px-3 py-2 text-sm"
            disabled={busy !== 'idle' || name.trim() === ''}
          >
            Ask for an organization
          </button>
        </div>
      </form>
    );
  };

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="w-full max-w-md">
        <h1 className="mb-3 text-xl font-semibold">You are not in an organization yet</h1>

        {invitations.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-2 text-sm font-medium">Invitations waiting for you</h2>
            <ul className="flex flex-col gap-2">
              {invitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex items-center justify-between gap-3 rounded border p-3"
                >
                  <span className="text-sm">
                    Join as <strong>{invitation.role}</strong>
                    <span className="block opacity-70">{invitation.email}</span>
                  </span>
                  <button
                    type="button"
                    className="rounded border px-3 py-1 text-sm"
                    disabled={busy !== 'idle'}
                    onClick={() => void accept(invitation)}
                  >
                    Accept
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {creation === 'open' && (
          <form onSubmit={create} className="flex flex-col gap-2">
            <label htmlFor="new-organization-name" className="text-sm font-medium">
              Or create your own
            </label>
            <p className="text-sm opacity-70">
              You will own it, and can invite others once it exists.
            </p>
            <div className="flex gap-2">
              {nameField('new-organization-name')}
              <button
                type="submit"
                className="rounded border px-3 py-2 text-sm"
                disabled={busy !== 'idle' || name.trim() === ''}
              >
                Create
              </button>
            </div>
          </form>
        )}

        {creation === 'request' && busy !== 'loading' && renderRequest()}

        {creation === 'off' && busy !== 'loading' && invitations.length === 0 && (
          <p className="text-sm opacity-70">
            Ask a Studio administrator or an organization owner for an invitation. Once you have
            one, your organizations appear in the top bar.
          </p>
        )}

        {error !== null && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
};

OrganizationAccessGate.displayName = 'OrganizationAccessGate';

/** The person's newest request, or null when they have never asked. */
async function readMine(): Promise<OrganizationRequest | null> {
  const page = await apiRegistry
    .getService(OrganizationsApiService)
    .organizationRequests({ scope: 'mine', limit: 1 })
    .fetch({ staleTime: 0 });
  return page?.items[0] ?? null;
}

/** When a request was made, in the reader's own calendar. */
export function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * What to show the person when a write is refused.
 *
 * The backend's refusals here are written for them — "you are its only owner",
 * "that invitation has expired", "you already have a request waiting" — so the
 * message is passed through rather than replaced with something generic that
 * says less. A failed precondition says only "Operation precondition not met"
 * in `detail`; its sentence is the violation's (docs/errors-catalog.md).
 */
export function messageOf(failure: unknown): string {
  const problem = parseProblemDetails(failure);
  for (const violation of problem.violations) {
    if (typeof violation.description === 'string' && violation.description.trim() !== '') {
      return violation.description;
    }
  }
  if (problem.detail) return problem.detail;
  if (failure instanceof Error && failure.message !== '') return failure.message;
  return 'That did not work. Try again in a moment.';
}

/**
 * Whether the shell should show the gate instead of the mounted screen.
 *
 * `loading` deliberately does NOT gate: the context resolves after the shell
 * mounts, and flashing an onboarding message at everybody on every load would
 * be worse than a moment of empty chrome.
 */
export function useHasNoOrganization(): boolean {
  const context = useAppSelector(
    (state) => state[APP_CONTEXT_SLICE_KEY] as AppContextState | undefined
  );
  return context?.access === 'unassigned';
}
