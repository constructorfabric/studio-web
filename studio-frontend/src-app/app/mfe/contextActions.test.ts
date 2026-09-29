import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEmit = vi.hoisted(() => vi.fn());

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  eventBus: { on: vi.fn(), emit: mockEmit },
}));

import artifactOpenSchema from './schemas/action_context_artifact_open.v1.json';
import artifactSelectedSchema from './schemas/shared_property_context_artifact.v1.json';
import { STUDIO_ARTIFACT_KINDS } from '@constructor-studio/mfe-shared';
import {
  artifactRequestOf,
  createArtifactOpenHandler,
  createContextPublishHandler,
  createWorkspacePublishHandler,
} from './contextActions';

/**
 * What an MFE's action turns into on the shell's event bus. This is the seam
 * where a scope claim is either made or lost: the handler is the last place
 * that still has the MFE's payload, and the guard on the other side cannot
 * check a claim that was never sent.
 */

const WORKSPACE = { id: 'ws-1', name: 'Platform' };
const PROJECT = { id: 'p1', name: 'Atlas' };

const emitted = (eventName: string): unknown[] =>
  mockEmit.mock.calls.filter(([name]) => name === eventName).map(([, payload]) => payload);

async function workspaceAction(payload: Record<string, unknown>): Promise<void> {
  await createWorkspacePublishHandler().handleAction('action', payload);
}

async function contextAction(payload: Record<string, unknown>): Promise<void> {
  await createContextPublishHandler().handleAction('action', payload);
}

describe('a workspace picked on a screen', () => {
  beforeEach(() => {
    mockEmit.mockClear();
  });

  // The level is asked for *inside* the announcement. Two independent events
  // let the shell refuse the workspace as stale and still honour the move,
  // landing the session on the workspace level with the previous workspace.
  it('asks for its level as part of the announcement, not beside it', async () => {
    await workspaceAction({ kind: 'selected', workspace: WORKSPACE, organizationId: 'org-1' });

    expect(emitted('app/context/workspace/changed')).toEqual([
      {
        workspaceId: WORKSPACE.id,
        name: WORKSPACE.name,
        enter: true,
        organizationId: 'org-1',
      },
    ]);
    expect(emitted('app/context/level/requested')).toEqual([]);
  });

  it('is not announced at all when the payload is not a workspace', async () => {
    await workspaceAction({ kind: 'selected', workspace: { id: 'ws-1' } });

    expect(mockEmit).not.toHaveBeenCalled();
  });

  // Creation does not move the session anywhere; the overlay that sent it is
  // still on screen and closes itself.
  it('carries the organization it was created under, and asks for no level', async () => {
    await workspaceAction({ kind: 'created', workspace: WORKSPACE, organizationId: 'org-1' });

    expect(emitted('app/context/workspace/created')).toEqual([
      { ...WORKSPACE, organizationId: 'org-1' },
    ]);
    expect(emitted('app/context/level/requested')).toEqual([]);
  });
});

describe('a project opened by the MFE that owns projects', () => {
  beforeEach(() => {
    mockEmit.mockClear();
  });

  it('names the workspace it was read in, on the list as well as the project', async () => {
    await contextAction({
      kind: 'opened',
      project: PROJECT,
      siblings: [PROJECT],
      workspaceId: 'ws-1',
    });

    // The list first: the slot must never name a project while the menu behind
    // it still holds the previous workspace's siblings.
    expect(mockEmit.mock.calls.map(([name]) => name)).toEqual([
      'app/context/projects',
      'app/context/project/opened',
    ]);
    expect(emitted('app/context/projects')).toEqual([{ items: [PROJECT], workspaceId: 'ws-1' }]);
    expect(emitted('app/context/project/opened')).toEqual([{ ...PROJECT, workspaceId: 'ws-1' }]);
  });

  // The hole this closes: an omitted scope reads as "not claimed", which the
  // shell treats as "cannot be checked" — so an announcement without one was
  // the single payload that always got through, including from a workspace the
  // session had already left.
  it('is refused outright when it names no workspace', async () => {
    await contextAction({ kind: 'opened', project: PROJECT, siblings: [PROJECT] });

    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('is refused when the workspace it names is not a string', async () => {
    await contextAction({
      kind: 'opened',
      project: PROJECT,
      siblings: [PROJECT],
      workspaceId: 42,
    });

    expect(mockEmit).not.toHaveBeenCalled();
  });

  // Leaving a project is not scoped: there is nothing to file under a workspace
  // and nothing a late one could overwrite.
  it('needs no workspace to say a project was closed', async () => {
    await contextAction({ kind: 'closed' });

    expect(emitted('app/context/project/closed')).toHaveLength(1);
  });
});

describe('artifact open request', () => {
  const REQUEST = {
    projectId: 'p1',
    artifactId: 'n-1',
    repository: 'group/repo',
    path: 'docs/a.md',
    kind: 'file',
  };

  it('reads the five fields the schema names', () => {
    expect(artifactRequestOf(REQUEST)).toEqual(REQUEST);
  });

  it('refuses a payload missing an id or carrying an unknown kind', () => {
    expect(artifactRequestOf({ ...REQUEST, projectId: '' })).toBeNull();
    expect(artifactRequestOf({ ...REQUEST, artifactId: undefined })).toBeNull();
    expect(artifactRequestOf({ ...REQUEST, kind: 'spec_finding' })).toBeNull();
    expect(artifactRequestOf(undefined)).toBeNull();
  });

  it('becomes the request the shell navigates on', async () => {
    mockEmit.mockClear();
    await createArtifactOpenHandler().handleAction('action', REQUEST);
    expect(emitted('app/context/artifact/requested')).toEqual([REQUEST]);
  });

  it('puts nothing on the bus for a payload it refuses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockEmit.mockClear();
    await createArtifactOpenHandler().handleAction('action', { ...REQUEST, kind: 'spec_finding' });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('names the same kinds as the property the shell answers with', () => {
    expect(artifactSelectedSchema.properties.value.properties.kind.enum).toEqual(
      artifactOpenSchema.properties.payload.properties.kind.enum
    );
  });

  it('names the kinds mfe-shared declares — the ones projects-mfe keys its types by', () => {
    expect([...artifactOpenSchema.properties.payload.properties.kind.enum].sort()).toEqual(
      [...STUDIO_ARTIFACT_KINDS].sort()
    );
  });
});
