import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

interface TestContext {
  org: { id: string; name: string; count?: number } | null;
  orgs: { id: string; name: string; count?: number }[];
  workspace: { id: string; name: string; count?: number } | null;
  workspaces: { id: string; name: string; count?: number }[];
  project: { id: string; name: string } | null;
  projects: { id: string; name: string }[];
  loading: boolean;
}

const { mockEventBus, context, level } = vi.hoisted(() => ({
  mockEventBus: { emit: vi.fn() },
  level: { value: 'organization' as 'organization' | 'workspace' | 'project' },
  context: { value: {} as TestContext },
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  useAppSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ 'app/context': context.value }),
  eventBus: mockEventBus,
}));

vi.mock('./useScreenLevel', () => ({ useScreenLevel: () => level.value }));

import { ContextChain } from './ContextChain';

describe('ContextChain (the path in the top bar)', () => {
  beforeEach(() => {
    level.value = 'organization';
    context.value = {
      org: { id: 'org-1', name: 'Acme Corporation', count: 3 },
      orgs: [
        { id: 'org-1', name: 'Acme Corporation', count: 3 },
        { id: 'org-2', name: 'Constructor Labs', count: 2 },
      ],
      workspace: { id: 'ws-1', name: 'Platform Workspace', count: 8 },
      workspaces: [
        { id: 'ws-1', name: 'Platform Workspace', count: 8 },
        { id: 'ws-2', name: 'Product Knowledge', count: 5 },
      ],
      project: { id: 'p-1', name: 'Agent Platform' },
      projects: [
        { id: 'p-1', name: 'Agent Platform' },
        { id: 'p-2', name: 'Developer Portal' },
      ],
      loading: false,
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('slots per level', () => {
    it('names the organization alone at its level, whatever is selected below', () => {
      render(<ContextChain />);
      expect(screen.getByText('Acme Corporation')).toBeTruthy();
      expect(screen.queryByText('Platform Workspace')).toBeNull();
      expect(screen.queryByText('Agent Platform')).toBeNull();
    });

    it('keeps the project out of the path until one is open', () => {
      level.value = 'workspace';
      render(<ContextChain />);
      expect(screen.getByText('Platform Workspace')).toBeTruthy();
      expect(screen.queryByText('Agent Platform')).toBeNull();
    });

    it('shows the whole path at the project level', () => {
      level.value = 'project';
      render(<ContextChain />);
      expect(screen.getByText('Acme Corporation')).toBeTruthy();
      expect(screen.getByText('Platform Workspace')).toBeTruthy();
      expect(screen.getByText('Agent Platform')).toBeTruthy();
    });

    it('skips a level nothing is selected at', () => {
      level.value = 'project';
      context.value.project = null;
      render(<ContextChain />);
      expect(screen.getByText('Platform Workspace')).toBeTruthy();
      expect(screen.queryByText('Agent Platform')).toBeNull();
    });

    it('renders nothing at all before an organization resolves', () => {
      context.value.org = null;
      const { container } = render(<ContextChain />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('switching', () => {
    it('announces an organization pick', async () => {
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Acme Corporation'));
      fireEvent.click(await screen.findByText('Constructor Labs'));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/org/changed', {
        orgId: 'org-2',
      });
    });

    it('announces a workspace pick from its own slot', async () => {
      level.value = 'workspace';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      fireEvent.click(await screen.findByText('Product Knowledge'));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/workspace/changed', {
        workspaceId: 'ws-2',
      });
    });

    it('keeps the last slot clickable, unlike a breadcrumb page', () => {
      level.value = 'project';
      render(<ContextChain />);
      const trigger = screen.getByText('Agent Platform').closest('button');
      expect(trigger).toBeTruthy();
      expect(trigger?.getAttribute('aria-current')).toBe('page');
      expect(trigger?.getAttribute('aria-disabled')).toBeNull();
    });

    it('frames the slot of the level in scope and no other', () => {
      level.value = 'workspace';
      render(<ContextChain />);
      expect(screen.getByText('Platform Workspace').closest('[data-current]')).toBeTruthy();
      expect(screen.getByText('Acme Corporation').closest('[data-current]')).toBeNull();
    });

    it('enters the level of the slot that was picked in', async () => {
      level.value = 'project';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      fireEvent.click(await screen.findByText('Product Knowledge'));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/level/requested', {
        level: 'workspace',
      });
    });

    it('stays put when the pick is a sibling of the level in scope', async () => {
      level.value = 'project';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Agent Platform'));
      fireEvent.click(await screen.findByText('Developer Portal'));
      expect(mockEventBus.emit).not.toHaveBeenCalledWith(
        'app/context/level/requested',
        expect.anything()
      );
    });

    it('enters a level whose slot has nothing to switch between', () => {
      level.value = 'project';
      context.value.workspaces = [{ id: 'ws-1', name: 'Platform Workspace', count: 8 }];
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      expect(mockEventBus.emit).toHaveBeenCalledWith('app/context/level/requested', {
        level: 'workspace',
      });
    });

    it('draws a slot with no siblings flat, with no menu to open', () => {
      context.value.orgs = [{ id: 'org-1', name: 'Acme Corporation', count: 3 }];
      render(<ContextChain />);
      expect(screen.getByText('Acme Corporation').closest('button')).toBeNull();
    });
  });

  describe('the caps label', () => {
    it('names the kind above the name', () => {
      level.value = 'workspace';
      render(<ContextChain />);
      expect(screen.getByText('Organization')).toBeTruthy();
      expect(screen.getByText('Workspace')).toBeTruthy();
    });

    it('is hidden from assistive tech, which hears the whole slot instead', () => {
      render(<ContextChain />);
      expect(screen.getByText('Organization').getAttribute('aria-hidden')).toBe('true');
      expect(
        screen.getByLabelText('Organization: Acme Corporation, switch')
      ).toBeTruthy();
    });
  });

  describe('counts under the names', () => {
    it('counts workspaces under an organization', async () => {
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Acme Corporation'));
      expect(await screen.findByText('3 workspaces')).toBeTruthy();
      expect(screen.getByText('2 workspaces')).toBeTruthy();
    });

    it('counts projects under a workspace', async () => {
      level.value = 'workspace';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Platform Workspace'));
      expect(await screen.findByText('8 projects')).toBeTruthy();
    });

    it('says nothing under a project, whose artifacts nobody has counted', async () => {
      level.value = 'project';
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Agent Platform'));
      expect(await screen.findByText('Developer Portal')).toBeTruthy();
      expect(screen.queryByText(/artifact/)).toBeNull();
    });

    it('leaves the subtitle out when the count did not arrive', async () => {
      context.value.orgs = context.value.orgs.map(({ id, name }) => ({ id, name }));
      render(<ContextChain />);
      fireEvent.click(screen.getByText('Acme Corporation'));
      expect(await screen.findByText('Constructor Labs')).toBeTruthy();
      expect(screen.queryByText(/workspaces/)).toBeNull();
    });
  });
});
