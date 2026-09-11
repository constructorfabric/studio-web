import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import en from '../i18n/en.json';

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useFormatters: () => ({ formatRelative: (value: unknown) => String(value) }),
}));

vi.mock('../../../i18n', () => ({
  useWorkspacesText:
    () =>
    (key: string, params?: Record<string, unknown>): string =>
      String((en as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_match, name) =>
        String(params?.[name] ?? `{${name}}`)
      ),
}));

import { WorkspacesTable } from './WorkspacesTable';

const workspaces = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `w${index}`,
    name: `Workspace ${index}`,
    tenant_type: 'workspace',
    status: 'active',
    updated_at: '2026-01-01T00:00:00Z',
  })) as never;

afterEach(cleanup);

describe('the caption under the table', () => {
  it('counts the organization, not the page', () => {
    render(
      <WorkspacesTable rows={workspaces(10)} total={10} emptyMessage="" onOpen={() => undefined} />
    );
    expect(screen.getByText(/of/).textContent).toBe('1–10 of 10 workspaces');
  });

  // The regression this guards: `total` given the filtered rows makes the
  // caption restate the row count back at itself — "1-2 of 2" — instead of
  // saying how many of the organization's workspaces the search matched.
  it('keeps naming the whole when a search narrows the rows', () => {
    render(
      <WorkspacesTable rows={workspaces(2)} total={10} emptyMessage="" onOpen={() => undefined} />
    );
    expect(screen.getByText(/of/).textContent).toBe('1–2 of 10 workspaces');
  });

  it('says none are shown when a search matches nothing', () => {
    render(
      <WorkspacesTable rows={workspaces(0)} total={10} emptyMessage="none" onOpen={() => undefined} />
    );
    expect(screen.getByText(/of/).textContent).toBe('0–0 of 10 workspaces');
  });

  it('reads as one workspace when that is all the organization has', () => {
    render(
      <WorkspacesTable rows={workspaces(1)} total={1} emptyMessage="" onOpen={() => undefined} />
    );
    expect(screen.getByText(/of/).textContent).toBe('1–1 of 1 workspace');
  });
});
