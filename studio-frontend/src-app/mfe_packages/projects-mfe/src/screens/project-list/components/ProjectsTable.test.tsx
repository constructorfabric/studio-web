import { TENANT_TYPES, type Tenant } from '@constructor-studio/mfe-shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontXProvider, createFrontXApp, i18nRegistry } from '@gears-frontx/react';
import {
  createMfeBridgeFixture,
  mfeContextValue,
} from '../../../../../../__test-utils__/createMfeBridgeFixture';
import { OrganizationProvider, STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION } from '@constructor-studio/mfe-shared';
import { PROJECT_LIST_NAMESPACE } from '../../../i18n';
import en from '../i18n/en.json';
import { ProjectsTable } from './ProjectsTable';
import type { ProjectConfigState } from '../../../shared/useProjectConfig';
import type { UserLookup } from '../../../shared/users';

/**
 * The click path of one row, without any HTTP: the table takes its rows as
 * props. It exists because "the project row does not react" has two very
 * different causes — a wrong `tenant_type` on the wire, or this code — and this
 * test rules out the second one for good.
 */

const CONFIG = { status: 'draft' as const, owner_id: 'user-1' };

/** Reassigned per test: the Status cell reads all four fields differently. */
let configState: ProjectConfigState;

vi.mock('../../../shared/useProjectConfig', () => ({
  useProjectConfig: () => configState,
}));

/** Reassigned per test, like `configState`: the Owner cell reads all three. */
let ownerState: UserLookup = {
  user: { id: 'user-1', username: 'ada', display_name: 'Ada L.' },
  loading: false,
  failed: false,
};

vi.mock('../../../shared/users', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/users')>(
    '../../../shared/users'
  );
  return { ...actual, useUserById: () => ownerState };
});

function tenant(id: string, tenantType: string): Tenant {
  return {
    id,
    name: id,
    status: 'active',
    tenant_type: tenantType,
    parent_id: 'ws',
    self_managed: false,
    depth: 3,
    child_count: 0,
    created_at: '2026-08-20T09:00:00Z',
    updated_at: '2026-08-20T09:00:00Z',
  };
}

const PROJECT = tenant('proj', TENANT_TYPES.project);

async function mount(rows: Tenant[]) {
  createFrontXApp({});
  const { mfeApp } = await import('../../../init');
  const { bridge, executeActionsChain } = createMfeBridgeFixture({
    domainId: 'screen',
    instanceId: 'inst',
    // The shell publishes an object here, not a string — the fixture's property
    // map is typed for strings only, which is all this cast is about.
    initialProperties: {
      [STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION]: { id: 'org', name: 'Org' } as unknown as string,
    },
  });
  i18nRegistry.register(PROJECT_LIST_NAMESPACE, 'en' as never, en);

  render(
    <FrontXProvider app={mfeApp} mfeBridge={mfeContextValue(bridge)}>
      <OrganizationProvider>
        <ProjectsTable rows={rows} />
      </OrganizationProvider>
    </FrontXProvider>
  );
  return { mfeApp, executeActionsChain };
}

const beforeEachState = () => {
  configState = { config: CONFIG, loading: false, unset: false, failed: false };
  ownerState = {
    user: { id: 'user-1', username: 'ada', display_name: 'Ada L.' },
    loading: false,
    failed: false,
  };
};

describe('ProjectsTable rows', () => {
  beforeEach(beforeEachState);

  it('tells the shell to open the project, and opens nothing itself', async () => {
    const { mfeApp, executeActionsChain } = await mount([PROJECT]);
    const button = screen.getByRole('button', { name: /proj/ }) as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(button);
    });

    // The shell owns which project is open. A row asks; it does not decide.
    const payloads = executeActionsChain.mock.calls.map(([chain]) => chain.action.payload);
    expect(payloads).toContainEqual(
      expect.objectContaining({ kind: 'opened', project: { id: 'proj', name: 'proj' } })
    );

    // Local state stays put until the shell publishes the project back. It used
    // to be written here too, and that second writer is what made the shell's
    // echo look like "nothing changed" — the rail then marked no section.
    const state = mfeApp.store.getState() as Record<string, { projectId: string | null }>;
    expect(state['projects/nav'].projectId).toBeNull();
  });

  it('draws a row from the project metadata, not from the tenant', async () => {
    await mount([PROJECT]);

    // The project's own status, not the tenant lifecycle every tenant reports.
    expect(screen.getByText(en.status_draft)).toBeTruthy();
    // The owner id resolved against the organization's users.
    expect(screen.getByText('Ada L.')).toBeTruthy();
  });

  it('keeps the tenant lifecycle ahead of missing metadata', async () => {
    // A project that never reached the wizard 404s on its metadata; suspending
    // it must still read as suspended rather than as "no attributes".
    configState = { config: null, loading: false, unset: true, failed: false };
    const suspended = { ...tenant('susp', TENANT_TYPES.project), status: 'suspended' as const };
    await mount([suspended]);

    expect(screen.getByText(en.status_suspended)).toBeTruthy();
    expect(screen.queryByText(en.status_unset)).toBeNull();
  });

  it('says so when a healthy project carries no attributes yet', async () => {
    configState = { config: null, loading: false, unset: true, failed: false };
    await mount([PROJECT]);

    expect(screen.getByText(en.status_unset)).toBeTruthy();
  });

  it('shows a degraded cell, not a value, when the metadata read fails', async () => {
    // 500/timeout: neither "Unknown" nor "no owner" is true, and both would
    // outlive the failure by a cache window.
    configState = { config: null, loading: false, unset: false, failed: true };
    await mount([PROJECT]);

    expect(screen.getAllByText(en.load_failed)).toHaveLength(2);
    expect(screen.queryByText(en.status_unknown)).toBeNull();
    expect(screen.queryByText(en.no_owner)).toBeNull();
  });
});
