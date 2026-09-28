import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontXProvider, createFrontXApp, eventBus } from '@gears-frontx/react';
import {
  createMfeBridgeFixture,
  mfeContextValue,
} from '@frontx-test-utils/createMfeBridgeFixture.ts';
import '../../events/workspaceEvents';

const { createWorkspace, org, translations } = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  org: { current: { id: 'org-1', name: 'Fabric' } as { id: string; name: string } | null },
  translations: { current: { isLoaded: true, error: null as Error | null } },
}));

/** Every gear this MFE registers refuses in jsdom, except the one write. */
class StubService {
  private readonly refuse = () => ({ fetch: () => Promise.reject(new Error('no gear in jsdom')) });
  readonly getTenant = this.refuse;
  readonly getProjects = this.refuse;
  readonly getWorkspaces = this.refuse;
  readonly getTenantMetadata = this.refuse;
  readonly findTenantUser = this.refuse;
  readonly connections = this.refuse;
  readonly providers = this.refuse();
  readonly createWorkspace = createWorkspace;
  /** The mock plugin walks every registered service; a stub has none. */
  readonly getPlugins = () => new Map();
}

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  AccountsApiService: StubService,
  ConnectorsApiService: StubService,
  useOrganization: () => ({ org: org.current, loading: false, failed: false }),
  useHostChrome: () => ({ containerRef: { current: null }, dataTheme: 'light', language: 'en' }),
}));

vi.mock('../../i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../i18n')>()),
  useWorkspaceCreateScreenTranslations: () => translations.current,
  useWorkspaceCreateText: () => (key: string) => key,
}));

const CREATED = { id: 'ws-9', name: 'Platform' };

type Chain = [{ action: { payload?: Record<string, unknown> } }];

/** The `created` announcements among whatever else the form sent the host. */
function announcements(calls: Chain[]): Record<string, unknown>[] {
  return calls
    .map(([chain]) => chain.action.payload)
    .filter((payload): payload is Record<string, unknown> => payload?.kind === 'created');
}

async function mountForm(executeActionsChain?: ReturnType<typeof vi.fn>) {
  createFrontXApp({});
  const { mfeApp } = await import('../../init');
  const { NewWorkspaceForm } = await import('./NewWorkspaceForm');
  const fixture = createMfeBridgeFixture({
    domainId: 'overlay',
    instanceId: 'inst',
    ...(executeActionsChain ? { executeActionsChain: executeActionsChain as never } : {}),
  });

  const tree = () => (
    <FrontXProvider app={mfeApp} mfeBridge={mfeContextValue(fixture.bridge)}>
      <NewWorkspaceForm />
    </FrontXProvider>
  );
  const view = render(tree());

  return {
    mfeApp,
    rerender: () => view.rerender(tree()),
    executeActionsChain: executeActionsChain ?? fixture.executeActionsChain,
    name: async (value: string): Promise<void> => {
      await act(async () => {
        fireEvent.change(screen.getByLabelText('field_name'), { target: { value } });
      });
    },
    press: async (label: string): Promise<void> => {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: label }));
      });
    },
    /** What the effect emits once the tenant is written. */
    written: async (orgId: string): Promise<void> => {
      await act(async () => {
        eventBus.emit('mfe/workspaces/created', { ...CREATED, orgId });
        await Promise.resolve();
      });
    },
  };
}

beforeEach(() => {
  org.current = { id: 'org-1', name: 'Fabric' };
  translations.current = { isLoaded: true, error: null };
});

describe('the organization a new workspace is announced under', () => {
  beforeEach(() => {
    createWorkspace.mockReset();
    createWorkspace.mockResolvedValue(CREATED);
  });

  it('is the one in scope when the name was confirmed', async () => {
    const { executeActionsChain, name, press } = await mountForm();

    await name('Platform');
    await press('create');

    expect(createWorkspace).toHaveBeenCalledWith({ name: 'Platform', parentId: 'org-1' });
    expect(announcements(executeActionsChain.mock.calls as never)).toEqual([
      { kind: 'created', workspace: CREATED, organizationId: 'org-1' },
    ]);
  });

  // The regression this file is for. The member switched organization while the
  // tenant was being written, so the workspace belongs to an organization that
  // is no longer in scope — and the announcement has to say so. Naming the
  // current one instead would file it under the wrong organization, or have the
  // shell drop it as stale.
  it('is the workspace’s own, not whichever is in scope when it lands', async () => {
    org.current = { id: 'org-2', name: 'Other' };
    const { executeActionsChain, written } = await mountForm();

    await written('org-1');

    expect(announcements(executeActionsChain.mock.calls as never)).toEqual([
      { kind: 'created', workspace: CREATED, organizationId: 'org-1' },
    ]);
  });

  // A refused announcement keeps the workspace *and* its organization, so Try
  // again re-sends the same scope rather than reading one afresh.
  it('is kept for the retry when the announcement fails', async () => {
    const executeActionsChain = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost'))
      .mockResolvedValue(undefined);

    org.current = { id: 'org-2', name: 'Other' };
    const { press, written } = await mountForm(executeActionsChain);

    await written('org-1');
    // The refusal is reported; its wording is `refusalFrom`'s business.
    expect(screen.getByRole('alert')).toBeTruthy();

    await press('retry');

    const resent = announcements(executeActionsChain.mock.calls as never);
    expect(resent).toHaveLength(2);
    expect(resent.map((payload) => payload.organizationId)).toEqual(['org-1', 'org-1']);
  });

  it('is never claimed while no organization is in scope', async () => {
    org.current = null;
    const { executeActionsChain, name, press } = await mountForm();

    await name('Platform');
    await press('create');

    // The form says so rather than writing under a parent it cannot name.
    expect(screen.getByRole('alert').textContent).toBe('error_no_org');
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(announcements(executeActionsChain.mock.calls as never)).toEqual([]);
  });
});

describe('the form behind its first-load skeleton', () => {
  it('waits for the dictionary once, not again while a language change loads it', async () => {
    translations.current = { isLoaded: false, error: null };
    const { rerender } = await mountForm();
    expect(screen.queryByRole('heading')).toBeNull();

    translations.current = { isLoaded: true, error: null };
    rerender();
    expect(screen.getByRole('heading', { name: 'title' })).toBeTruthy();

    translations.current = { isLoaded: false, error: null };
    rerender();
    expect(screen.getByRole('heading', { name: 'title' })).toBeTruthy();
  });

  it('shows the failure, not the skeleton, when the dictionary does not load', async () => {
    translations.current = { isLoaded: false, error: new Error('no dictionary') };
    await mountForm();

    expect(screen.getByRole('alert').textContent).toBe('Could not load this screen.');
    expect(screen.getByRole('heading', { name: 'title' })).toBeTruthy();
  });
});
