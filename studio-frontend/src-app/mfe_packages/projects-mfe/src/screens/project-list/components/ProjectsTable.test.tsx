import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FrontXProvider, createFrontXApp, i18nRegistry } from '@gears-frontx/react';
import { createMfeBridgeFixture } from '../../../../../../__test-utils__/createMfeBridgeFixture';
import { BridgeProvider } from '../../../shared/bridge';
import { PROJECT_LIST_NAMESPACE } from '../../../i18n';
import en from '../i18n/en.json';
import { ProjectsTable } from './ProjectsTable';
import { TENANT_TYPES, type TenantDto } from '../../../api/types';
import type { TreeRow } from '../../../shared/projectTree';

/**
 * The click path of one row, without any HTTP: the table takes its rows as
 * props. It exists because "the project row does not react" has two very
 * different causes — a wrong `tenant_type` on the wire, or this code — and this
 * test rules out the second one for good.
 */

function tenant(id: string, tenantType: string, childCount = 0): TenantDto {
  return {
    id,
    name: id,
    status: 'active',
    tenant_type: tenantType,
    parent_id: 'ws',
    self_managed: false,
    depth: 3,
    child_count: childCount,
    created_at: '2026-08-20T09:00:00Z',
    updated_at: '2026-08-20T09:00:00Z',
  };
}

const row = (t: TenantDto, over: Partial<TreeRow> = {}): TreeRow => ({
  tenant: t,
  level: 0,
  expandable: t.child_count > 0,
  expanded: false,
  pending: false,
  ...over,
});

const PROJECT = tenant('proj', TENANT_TYPES.project);
const EMPTY_WORKSPACE = tenant('empty-ws', TENANT_TYPES.workspace);
const FULL_WORKSPACE = tenant('full-ws', TENANT_TYPES.workspace, 2);

async function mount(rows: TreeRow[], onToggle: (tenantId: string) => void = () => undefined) {
  createFrontXApp({});
  const { mfeApp } = await import('../../../init');
  const { bridge } = createMfeBridgeFixture({ domainId: 'screen', instanceId: 'inst' });
  i18nRegistry.register(PROJECT_LIST_NAMESPACE, 'en' as never, en);

  render(
    <FrontXProvider app={mfeApp}>
      <BridgeProvider bridge={bridge}>
        <ProjectsTable rows={rows} onToggle={onToggle} />
      </BridgeProvider>
    </FrontXProvider>
  );
  return mfeApp;
}

describe('ProjectsTable rows', () => {
  it('opens the project on click — a project row is never disabled', async () => {
    const app = await mount([row(PROJECT)]);
    const button = screen.getByRole('button', { name: /proj/ }) as HTMLButtonElement;

    expect(button.disabled).toBe(false);
    // A leaf claims no expansion state.
    expect(button.getAttribute('aria-expanded')).toBeNull();

    await act(async () => {
      fireEvent.click(button);
    });

    const state = app.store.getState() as Record<string, { projectId: string | null }>;
    expect(state['projects/nav'].projectId).toBe('proj');
  });

  it('toggles a workspace that has children, and disables one that has none', async () => {
    const toggled: string[] = [];
    await mount([row(FULL_WORKSPACE), row(EMPTY_WORKSPACE)], (id: string) => {
      toggled.push(id);
    });

    const full = screen.getByRole('button', { name: /full-ws/ }) as HTMLButtonElement;
    expect(full.disabled).toBe(false);
    expect(full.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      fireEvent.click(full);
    });
    expect(toggled).toEqual(['full-ws']);

    // Nothing to open and nothing to expand: the row is inert on purpose.
    expect((screen.getByRole('button', { name: /empty-ws/ }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });
});
