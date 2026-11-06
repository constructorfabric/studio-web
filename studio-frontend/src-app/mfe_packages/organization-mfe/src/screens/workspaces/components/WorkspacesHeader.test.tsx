import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import en from '../i18n/en.json';
import ru from '../i18n/ru.json';

const { text } = vi.hoisted(() => ({ text: { language: 'en' } }));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useMfeBridge: () => null,
}));

vi.mock('../../../actions/overlayActions', () => ({ openWorkspaceForm: vi.fn() }));

vi.mock('../../../i18n', async () => {
  const { dictionaryText } = await import('@frontx-test-utils/dictionaryText');
  return {
    useWorkspacesText: () =>
      text.language === 'ru' ? dictionaryText(ru, 'ru') : dictionaryText(en),
  };
});

import { WorkspacesHeader } from './WorkspacesHeader';

const renderHeader = (props: { busy?: boolean; total?: number; projectTotal?: number }) =>
  render(
    <WorkspacesHeader
      canCreate
      busy={props.busy ?? false}
      total={props.total}
      projectTotal={props.projectTotal}
    />
  );

describe('WorkspacesHeader totals', () => {
  afterEach(() => {
    cleanup();
    text.language = 'en';
  });

  it('counts the workspaces and their projects in one line', () => {
    renderHeader({ total: 1, projectTotal: 3 });
    expect(screen.getByText('1 workspace · 3 projects')).toBeTruthy();
  });

  it('takes each count in the form its language gives it', () => {
    text.language = 'ru';
    renderHeader({ total: 2, projectTotal: 5 });
    expect(screen.getByText('2 воркспейса · 5 проектов')).toBeTruthy();
  });

  it('says nothing while the list is being read', () => {
    renderHeader({ busy: true, total: 1, projectTotal: 3 });
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it('says nothing until both totals are in', () => {
    renderHeader({ total: 1 });
    expect(screen.queryByText(/·/)).toBeNull();
    cleanup();
    renderHeader({ projectTotal: 3 });
    expect(screen.queryByText(/·/)).toBeNull();
  });
});
