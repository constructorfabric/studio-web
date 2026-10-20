import { describe, expect, it, vi } from 'vitest';
import { FRONTX_SCREEN_DOMAIN, type ChildMfeBridge } from '@gears-frontx/react';
import {
  STUDIO_ACTION_NOTIFY,
  STUDIO_ARTIFACT_KINDS,
  isStudioArtifactKind,
  notify,
  type StudioNotice,
} from './hostActions';

describe('isStudioArtifactKind', () => {
  it('accepts every declared kind', () => {
    for (const kind of STUDIO_ARTIFACT_KINDS) expect(isStudioArtifactKind(kind)).toBe(true);
  });

  it('refuses anything else, including a near miss and a non-string', () => {
    for (const value of ['spec_finding', 'File', '', undefined, null, 1, {}]) {
      expect(isStudioArtifactKind(value)).toBe(false);
    }
  });
});

describe('notify', () => {
  it('asks the screen domain for a toast with the notice as it was given', () => {
    const executeActionsChain = vi.fn(() => Promise.resolve());
    const bridge = { executeActionsChain } as unknown as ChildMfeBridge;
    notify(bridge, { kind: 'error', text: 'Could not change the type' }, 'test');
    expect(executeActionsChain).toHaveBeenCalledWith({
      action: {
        type: STUDIO_ACTION_NOTIFY,
        target: FRONTX_SCREEN_DOMAIN,
        payload: { kind: 'error', text: 'Could not change the type' },
      },
    });
  });

  it('passes the id through, for a toast the next notice replaces', () => {
    const executeActionsChain = vi.fn(() => Promise.resolve());
    const bridge = { executeActionsChain } as unknown as ChildMfeBridge;
    notify(bridge, { kind: 'loading', text: 'Checking', id: 'specs-check:p-1' }, 'test');
    expect(executeActionsChain).toHaveBeenCalledWith({
      action: {
        type: STUDIO_ACTION_NOTIFY,
        target: FRONTX_SCREEN_DOMAIN,
        payload: { kind: 'loading', text: 'Checking', id: 'specs-check:p-1' },
      },
    });
  });

  it('takes a loading notice only with an id, since nothing else could close that toast', () => {
    // Stops compiling once a loading notice's id turns optional.
    const idRequired: undefined extends Extract<StudioNotice, { kind: 'loading' }>['id']
      ? false
      : true = true;
    expect(idRequired).toBe(true);
  });
});
