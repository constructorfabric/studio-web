import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataGridTableColumn } from '@gears-frontx/ui-kit';
import en from './i18n/en.json';
import ru from './i18n/ru.json';
import projectEn from '../../i18n/en.json';
import { sourceRow } from '../../../../model/sourceRows.fixture';
import type { SourceRow } from '../../../../model/sourceRows';
import type { SourceRowActions } from '../../../../shared/useSourceRowActions';

/** Each cell of the Sources table (#688). */

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useFormatters: () => ({
    formatRelative: (value: string | number) => `rel ${new Date(value).toISOString()}`,
  }),
}));

vi.mock('../../../../shared/dayTime', () => ({
  useDayTime: () => (value: string) => `day ${new Date(value).toISOString()}`,
}));

vi.mock('../../../../shared/daysAgo', () => ({
  useDaysAgo: () => (back: number) => `${back} back`,
}));

vi.mock('../../../../i18n', async () => {
  const { dictionaryText } = await import('@frontx-test-utils/dictionaryText');
  return {
    useSourcesText: () => dictionaryText(en),
    useProjectText: () => dictionaryText(projectEn),
  };
});

import { dictionaryText } from '@frontx-test-utils/dictionaryText';
import { sourceColumns } from './sourceColumns';
import { stubResizeObserver } from '@frontx-test-utils/stubResizeObserver';

const PROVIDERS: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab' };

const actions: SourceRowActions = {
  connectionsRead: true,
  providerName: (provider) => PROVIDERS[provider] ?? provider,
  syncNow: vi.fn(),
  cancelSync: vi.fn(),
  openSpecs: vi.fn(),
  openUploads: vi.fn(),
};

const WEEK = { open: 2, merged: 1, commits: 5, days: [0, 0, 1, 0, 0, 1, 0] };

function columns(windowDays: number | null = 7, container?: HTMLElement) {
  return sourceColumns({ t: dictionaryText(en), windowDays, actions, scale: 3, container });
}

const column = (id: string, windowDays?: number | null, container?: HTMLElement) =>
  columns(windowDays, container).find((entry) => entry.id === id) as DataGridTableColumn<SourceRow>;

function cell(id: string, row: SourceRow, container?: HTMLElement) {
  const { render: draw } = column(id, 7, container);
  return render(<>{typeof draw === 'function' ? draw(row) : draw}</>);
}

beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  cleanup();
  vi.mocked(actions.openSpecs).mockReset();
});

describe('the headers', () => {
  it('name the seven columns, in order, with the activity window', () => {
    expect(columns().map((entry) => [entry.id, entry.label])).toEqual([
      ['source', 'Source'],
      ['role', 'Role'],
      ['specs', 'Specs'],
      ['pull_requests', 'Pull requests · 7 days'],
      ['commits', 'Commits · 7 days'],
      ['last_sync', 'Last sync'],
      ['actions', 'Actions'],
    ]);
  });

  // The kit's header (0.4.3): 10px uppercase monospace (0.6em a character), 1rem padding each side,
  // and 4px to spare so rounding does not cut the last letter.
  it.each([
    ['en', en],
    ['ru', ru],
  ] as const)('fit their fixed widths in %s', (language, words) => {
    const fixed = sourceColumns({ t: dictionaryText(words, language), windowDays: 7, actions, scale: 3 })
      .filter((entry) => entry.id !== 'actions' && String(entry.width).endsWith('rem'))
      .map((entry) => [entry.label, (String(entry.label).length * 6 + 32 + 4) / 16 <= parseFloat(String(entry.width))]);
    expect(fixed.filter(([, fits]) => !fits)).toEqual([]);
  });

  it('leave the window out when the activity was not read', () => {
    expect(column('pull_requests', null).label).toBe('Pull requests');
    expect(column('commits', null).label).toBe('Commits');
  });

  it('hide the Actions header from the eye, not from a screen reader', () => {
    const Header = column('actions').headerComponent as React.ComponentType<{
      column: DataGridTableColumn<SourceRow>;
    }>;
    render(<Header column={column('actions')} />);

    expect(screen.getByText('Actions').className).toMatch(/visuallyHidden/);
  });
});

describe('the Source cell', () => {
  it("shows the provider, the name, and the path with the config's branch", () => {
    const { container } = cell('source', sourceRow());

    expect(screen.getByRole('img', { name: 'GitHub' }).getAttribute('title')).toBe('GitHub');
    expect(screen.getByText('api')).toBeTruthy();
    expect(screen.getByText('acme/api · main')).toBeTruthy();
    expect(container.querySelector('.lucide-github')).not.toBeNull();
  });

  it('gives the name and the path in full as their titles, for when they are cut', () => {
    cell('source', sourceRow({ fullPath: 'acme/a-long-repository-name', name: 'a-long-repository-name' }));

    expect(screen.getByText('a-long-repository-name').getAttribute('title')).toBe('a-long-repository-name');
    expect(screen.getByText('acme/a-long-repository-name · main').getAttribute('title')).toBe(
      'acme/a-long-repository-name · main'
    );
  });

  it('shows the path alone without a branch', () => {
    cell('source', sourceRow({ branch: null }));

    expect(screen.getByText('acme/api')).toBeTruthy();
  });

  it('draws a provider it has no mark for as a cloud, and no provider without a name', () => {
    const unknown = cell('source', sourceRow({ provider: 'azure' }));
    expect(screen.getByRole('img', { name: 'azure' })).toBeTruthy();
    expect(unknown.container.querySelector('.lucide-cloud')).not.toBeNull();
    cleanup();

    const none = cell('source', sourceRow({ provider: null }));
    expect(screen.queryByRole('img')).toBeNull();
    expect(none.container.querySelector('.lucide-cloud')).not.toBeNull();
  });
});

describe('the Role cell', () => {
  it('says what the source is: its provider', () => {
    const { container } = cell('role', sourceRow());

    expect(container.textContent).toBe('GitHub');
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('is a dash when the provider is not known', () => {
    const { container } = cell('role', sourceRow({ provider: null }));

    expect(container.textContent).toBe('—');
  });
});

describe('the Specs cell', () => {
  it('opens the specs from a count above zero, as the menu does', () => {
    const row = sourceRow({ specs: 12 });
    cell('specs', row);

    const link = screen.getByRole('button', { name: '12' });
    expect(link.getAttribute('title')).toBe('Open specs from this source');
    fireEvent.click(link);
    expect(actions.openSpecs).toHaveBeenCalledWith(row);
  });

  it('shows 0 and a missing count as text, with nothing to open', () => {
    cell('specs', sourceRow({ specs: 0 }));
    expect(screen.getByText('0')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();

    cell('specs', sourceRow({ specs: null }));
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('the Pull requests cell', () => {
  it('shows the open and merged counts beside the week', () => {
    cell('pull_requests', sourceRow({ activity: WEEK }));

    expect(screen.getByText('2 open')).toBeTruthy();
    expect(screen.getByText('1 merged')).toBeTruthy();
    expect(
      screen.getByRole('img', { name: 'Pull requests per day, oldest first: 0, 0, 1, 0, 0, 1, 0' })
    ).toBeTruthy();
  });

  it('names each bar by how many days back it is', async () => {
    const measure = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (!this.classList.contains('recharts-responsive-container')) return measure.call(this);
      return { x: 0, y: 0, top: 0, left: 0, width: 96, height: 24, right: 96, bottom: 24 } as DOMRect;
    });
    const { container } = cell('pull_requests', sourceRow({ activity: WEEK }));
    const chart = container.querySelector('.recharts-wrapper') as HTMLElement;

    // Seven bars across 96px: the fourth from the end is three days back.
    fireEvent.mouseMove(chart, { clientX: 48, clientY: 12 });
    await waitFor(() => expect(screen.getByText('3 back')).toBeTruthy());
    fireEvent.mouseMove(chart, { clientX: 94, clientY: 12 });
    await waitFor(() => expect(screen.getByText('0 back')).toBeTruthy());
  });

  it("opens the week's tooltip in the table's container", async () => {
    const root = document.body.appendChild(document.createElement('div'));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, width: 96, height: 24, right: 96, bottom: 24,
    } as DOMRect);
    const { container } = cell('pull_requests', sourceRow({ activity: WEEK }), root);

    fireEvent.pointerEnter(container.querySelector('[data-chart]') as HTMLElement);
    fireEvent.mouseMove(container.querySelector('.recharts-wrapper') as HTMLElement, {
      clientX: 94,
      clientY: 12,
    });
    await waitFor(() => expect(within(root).getByText('0 back')).toBeTruthy());
    root.remove();
  });

  it('says the activity is unavailable when it was not read', () => {
    cell('pull_requests', sourceRow({ activity: null }));

    expect(screen.getByText('Pull request activity unavailable')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('the Commits cell', () => {
  it('shows the count, or a dash when it is missing', () => {
    cell('commits', sourceRow({ activity: WEEK }));
    expect(screen.getByText('5')).toBeTruthy();
    cleanup();

    cell('commits', sourceRow({ activity: null }));
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('the Last sync cell', () => {
  const lines = (row: SourceRow) =>
    [...cell('last_sync', row).container.querySelectorAll('span')].map((line) => [
      line.textContent,
      line.getAttribute('title'),
    ]);

  it('gives the last successful sync as day and time, with how long ago as its title', () => {
    expect(lines(sourceRow())).toEqual([
      ['day 2026-10-14T10:52:00.000Z', 'rel 2026-10-14T10:52:00.000Z'],
    ]);
  });

  it.each<[SourceRow['lastSync'], string]>([
    [{ kind: 'not_synced' }, 'Not synced'],
    [{ kind: 'not_connected' }, 'Not connected'],
    [{ kind: 'unavailable', provider: 'gitlab' }, "Sync isn't available for GitLab yet"],
  ])('reads %j as %s', (lastSync, text) => {
    expect(lines(sourceRow({ lastSync }))).toEqual([[text, null]]);
  });

  it('keeps the first line while a sync runs, and says so on the second', () => {
    expect(
      lines(sourceRow({ sync: { kind: 'in_flight', cancelling: false, canCancel: true } }))
    ).toEqual([
      ['day 2026-10-14T10:52:00.000Z', 'rel 2026-10-14T10:52:00.000Z'],
      ['Syncing…', null],
    ]);
    cleanup();
    expect(
      lines(sourceRow({ sync: { kind: 'in_flight', cancelling: true, canCancel: false } }))[1]
    ).toEqual(['Cancelling…', null]);
  });

  it('says the last attempt failed or was cancelled, with the reason as the title', () => {
    const stopped = (sync: SourceRow['sync']) =>
      lines(sourceRow({ lastSync: { kind: 'not_synced' }, sync }))[1];

    expect(
      stopped({
        kind: 'stopped',
        status: 'failed',
        reason: { kind: 'provider', text: 'Bad credentials' },
        canRetry: true,
      })
    ).toEqual(['Last attempt failed', 'Bad credentials']);
    cleanup();
    expect(
      stopped({
        kind: 'stopped',
        status: 'lost',
        reason: { kind: 'i18n', key: 'artifacts_reason_task_lost' },
        canRetry: false,
      })
    ).toEqual(['Last attempt failed', 'the gear stopped answering for this task']);
    cleanup();
    expect(
      stopped({ kind: 'stopped', status: 'cancelled', reason: null, canRetry: true })
    ).toEqual(['Last attempt cancelled', null]);
  });
});

describe('the Actions cell', () => {
  it("holds the row's menu", () => {
    cell('actions', sourceRow());

    expect(screen.getByRole('button', { name: 'Actions for api' })).toBeTruthy();
  });
});
