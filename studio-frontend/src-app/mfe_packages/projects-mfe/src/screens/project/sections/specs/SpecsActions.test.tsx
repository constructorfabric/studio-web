import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecsCheckState } from '../../../../slices/specsCheckSlice';

const { slice, status, requestSpecsCheck } = vi.hoisted(() => ({
  slice: { current: null as unknown as SpecsCheckState },
  status: { current: undefined as { configured: boolean } | undefined },
  requestSpecsCheck: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { getService: () => ({ status: {} }) },
  useApiQuery: () => ({ data: status.current }),
  useAppSelector: (select: (state: unknown) => unknown) =>
    select({ 'projects/specsCheck': slice.current }),
}));
vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  useWorkspace: () => ({ workspace: { id: 'w-1' }, loading: false, failed: false }),
}));
vi.mock('../../../../api/SpecQualityApiService', () => ({ SpecQualityApiService: class {} }));
vi.mock('../../../../i18n', () => {
  const t = Object.assign((key: string) => key, {
    count: (key: string, count: number) => `${key} ${count}`,
  });
  return {
    useSpecsSectionTranslations: () => ({ isLoaded: true, error: null }),
    useSpecsText: () => t,
  };
});
vi.mock('../../../../actions/specsCheckActions', () => ({ requestSpecsCheck }));
vi.mock('../../upload/UploadDocumentsButton', () => ({
  UploadDocumentsButton: ({ projectId }: { projectId: string }) => (
    <button type="button">{`upload ${projectId}`}</button>
  ),
}));

import { SpecsActions } from './SpecsActions';

const repo = (id: string) => ({ id, origin: 'repository' as const });
const SHOWN = [repo('b-1'), repo('b-2'), { id: 'd-1', origin: 'authored' as const }];

function given(overrides: Partial<SpecsCheckState> = {}) {
  slice.current = { selected: [], shown: SHOWN, checks: {}, ...overrides };
}

const renderActions = () => render(<SpecsActions projectId="p-1" projectName="Billing" />);
const check = () => screen.getByRole('button', { name: /^check \d+$/ });
const sentTargets = () => requestSpecsCheck.mock.calls.map(([request]) => request.targets);

beforeEach(() => {
  given();
  status.current = { configured: true };
  requestSpecsCheck.mockClear();
});

describe("the Specs header's Check", () => {
  it('stays hidden until the table has written the rows it shows; Upload documents does not wait', () => {
    given({ shown: null });
    const { container } = renderActions();
    expect(container.textContent).toBe('upload p-1');
  });

  it('checks every shown row when none is selected', () => {
    renderActions();
    expect(check().textContent).toContain('check 3');
    fireEvent.click(check());
    expect(requestSpecsCheck).toHaveBeenCalledWith({
      projectId: 'p-1',
      workspaceId: 'w-1',
      project: 'Billing',
      targets: SHOWN,
    });
  });

  it('checks the selected rows, counting only the checkable ones', () => {
    given({ selected: ['b-2', 'candidate:n-1'] });
    renderActions();
    expect(check().textContent).toContain('check 1');
    fireEvent.click(check());
    expect(sentTargets()).toEqual([[repo('b-2')]]);
  });

  it('stays enabled while the status loads or cannot be read', () => {
    status.current = undefined;
    renderActions();
    expect(check().getAttribute('aria-disabled')).toBeNull();
  });

  it.each([
    ['Spec Quality is not configured', { configured: false }, {}, 'check_unconfigured'],
    ['there is nothing to check', { configured: true }, { shown: [] }, 'check_nothing'],
    [
      "the project's check runs",
      { configured: true },
      { checks: { 'p-1': { project: 'Billing', count: 3, phases: {}, outcome: null } } },
      'check_running',
    ],
  ])('is disabled, with the reason, when %s', async (_, configured, state, reason) => {
    status.current = configured;
    given(state as Partial<SpecsCheckState>);
    renderActions();
    expect(check().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(check());
    expect(requestSpecsCheck).not.toHaveBeenCalled();
    fireEvent.mouseEnter(check());
    fireEvent.pointerEnter(check());
    fireEvent.focus(check());
    expect(await screen.findByText(reason)).toBeTruthy();
  });

  it("can check one project while another project's check runs", () => {
    given({ checks: { 'p-2': { project: 'Other', count: 3, phases: {}, outcome: null } } });
    renderActions();
    fireEvent.click(check());
    expect(requestSpecsCheck).toHaveBeenCalledTimes(1);
  });

  describe('more than 50 specs', () => {
    const many = Array.from({ length: 51 }, (_, index) => repo(`b-${index}`));

    it('asks first, and checks them when told to', async () => {
      given({ shown: many });
      renderActions();
      fireEvent.click(check());
      expect(requestSpecsCheck).not.toHaveBeenCalled();
      const dialog = await screen.findByRole('alertdialog');
      expect(dialog.textContent).toContain('check_confirm_title 51');
      expect(dialog.textContent).toContain('check_confirm_note');

      fireEvent.click(screen.getByRole('button', { name: 'check_confirm' }));
      expect(sentTargets()).toEqual([many]);
    });

    it('checks nothing when cancelled', async () => {
      given({ shown: many });
      renderActions();
      fireEvent.click(check());
      fireEvent.click(await screen.findByRole('button', { name: 'check_cancel' }));
      expect(requestSpecsCheck).not.toHaveBeenCalled();
    });

    it('does not ask for 50', () => {
      given({ shown: many.slice(0, 50) });
      renderActions();
      fireEvent.click(check());
      expect(requestSpecsCheck).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });
});
