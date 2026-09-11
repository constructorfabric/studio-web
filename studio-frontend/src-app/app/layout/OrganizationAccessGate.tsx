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
 */

import React from 'react';
import { apiRegistry, eventBus, useAppSelector } from '@gears-frontx/react';
import {
  IdentityApiService,
  OrganizationsApiService,
  type Invitation,
} from '@/app/api';
import { APP_CONTEXT_SLICE_KEY, type AppContextState } from '@/app/slices/appContextSlice';

/** What the screen is waiting on, so it never shows two things at once. */
type Busy = 'idle' | 'loading' | 'creating' | 'accepting';

export const OrganizationAccessGate: React.FC = () => {
  const [canCreate, setCanCreate] = React.useState(false);
  const [invitations, setInvitations] = React.useState<Invitation[]>([]);
  const [name, setName] = React.useState('');
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
      if (!live) return;
      setCanCreate(capabilities?.self_service ?? false);
      setInvitations(waiting?.items ?? []);
      setBusy('idle');
    };
    void load();
    return () => {
      live = false;
    };
  }, []);

  /**
   * Both paths end the same way: ask the shell to resolve its context again.
   * Whatever just became true is true on the server, and re-reading it is how
   * this screen goes away — guessing what changed would be a second source of
   * truth for the thing this screen exists to reflect.
   */
  const reloadContext = () => eventBus.emit('app/context/fetch');

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

        {canCreate ? (
          <form onSubmit={create} className="flex flex-col gap-2">
            <label htmlFor="new-organization-name" className="text-sm font-medium">
              Or create your own
            </label>
            <p className="text-sm opacity-70">
              You will own it, and can invite others once it exists.
            </p>
            <div className="flex gap-2">
              <input
                id="new-organization-name"
                className="flex-1 rounded border px-3 py-2 text-sm"
                placeholder="Organization name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy === 'creating'}
              />
              <button
                type="submit"
                className="rounded border px-3 py-2 text-sm"
                disabled={busy !== 'idle' || name.trim() === ''}
              >
                Create
              </button>
            </div>
          </form>
        ) : (
          busy !== 'loading' &&
          invitations.length === 0 && (
            <p className="text-sm opacity-70">
              Ask a Studio administrator or an organization owner for an invitation. Once you have
              one, your organizations appear in the top bar.
            </p>
          )
        )}

        {error !== null && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
};

OrganizationAccessGate.displayName = 'OrganizationAccessGate';

/**
 * What to show the person when a write is refused.
 *
 * The backend's refusals here are written for them — "you are its only owner",
 * "that invitation has expired" — so the message is passed through rather than
 * replaced with something generic that says less.
 */
function messageOf(failure: unknown): string {
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
