import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

interface TestContext {
  scope: 'org' | 'project';
  org: { id: string; name: string } | null;
  orgs: { id: string; name: string }[];
  project: { id: string; name: string } | null;
  projects: { id: string; name: string }[];
  loading: boolean;
}

const { mockEventBus, context } = vi.hoisted(() => ({
  mockEventBus: { emit: vi.fn() },
  context: {
    value: {
      scope: 'org',
      org: { id: 'org-1', name: 'My Organization' },
      orgs: [
        { id: 'org-1', name: 'My Organization' },
        { id: 'org-2', name: 'Agent Labs' },
      ],
      project: null,
      projects: [],
      loading: false,
    } as TestContext,
  },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useAppSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ 'app/context': context.value }),
  eventBus: mockEventBus,
}));

import { ContextSwitcher } from './ContextSwitcher';

describe('ContextSwitcher', () => {
  beforeEach(() => {
    context.value = {
      scope: 'org',
      org: { id: 'org-1', name: 'My Organization' },
      orgs: [
        { id: 'org-1', name: 'My Organization' },
        { id: 'org-2', name: 'Agent Labs' },
      ],
      project: null,
      projects: [],
      loading: false,
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('organization scope', () => {
    it('names the organization in scope', () => {
      render(<ContextSwitcher />);
      expect(screen.getByText('My Organization')).toBeTruthy();
    });

    it('offers the other organizations and announces the pick', async () => {
      render(<ContextSwitcher />);
      fireEvent.click(screen.getByText('My Organization'));
      fireEvent.click(await screen.findByText('Agent Labs'));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/org/changed', {
        orgId: 'org-2',
      });
    });

    it('carries the icon colours on wrappers, not on <Icon>', () => {
      // @iconify/react renders an unclassed placeholder span until it has
      // resolved the icon, so a className handed to <Icon> is dropped for that
      // render and the glyph inherits the trigger's dark foreground. The colour
      // has to live on an element that is always there.
      const { container } = render(<ContextSwitcher />);
      const muted = container.querySelectorAll('span.text-muted-foreground');
      // Two: the leading scope glyph and the chevron.
      expect(muted.length).toBe(2);
      expect(container.querySelector('svg.text-muted-foreground')).toBeNull();
    });

    it('drops the chevron when there is only one organization to be in', () => {
      context.value.orgs = [{ id: 'org-1', name: 'My Organization' }];
      const { container } = render(<ContextSwitcher />);
      // A chevron would promise a menu that opens empty.
      expect(container.querySelector('button')).toBeNull();
    });
  });

  describe('project scope', () => {
    beforeEach(() => {
      context.value.scope = 'project';
      context.value.project = { id: 'p-1', name: 'Agent Platform' };
      context.value.projects = [
        { id: 'p-1', name: 'Agent Platform' },
        { id: 'p-2', name: 'Developer Portal' },
      ];
    });

    it('names the open project instead of the organization', () => {
      render(<ContextSwitcher />);
      expect(screen.getByText('Agent Platform')).toBeTruthy();
      expect(screen.queryByText('My Organization')).toBeNull();
    });

    it('announces a project pick for the owning MFE to navigate on', async () => {
      render(<ContextSwitcher />);
      fireEvent.click(screen.getByText('Agent Platform'));
      fireEvent.click(await screen.findByText('Developer Portal'));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/project/changed', {
        projectId: 'p-2',
      });
    });

    it('offers a way back up to the organization', async () => {
      render(<ContextSwitcher />);
      fireEvent.click(screen.getByText('Agent Platform'));
      fireEvent.click(await screen.findByText('All projects'));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/project/closed');
    });

    it('keeps the menu even with a single project, since leaving is a choice', () => {
      context.value.projects = [{ id: 'p-1', name: 'Agent Platform' }];
      render(<ContextSwitcher />);
      expect(screen.getByText('Agent Platform').closest('button')).toBeTruthy();
    });
  });

  describe('before anything resolves', () => {
    it('shows a placeholder while the lookup is in flight', () => {
      context.value = { ...context.value, org: null, orgs: [], loading: true };
      const { container } = render(<ContextSwitcher />);
      expect(container.firstChild).toBeTruthy();
      expect(screen.queryByText('My Organization')).toBeNull();
    });

    it('stays empty rather than naming a context the backend has not confirmed', () => {
      context.value = { ...context.value, org: null, orgs: [], loading: false };
      const { container } = render(<ContextSwitcher />);
      expect(container.firstChild).toBeNull();
    });
  });
});
