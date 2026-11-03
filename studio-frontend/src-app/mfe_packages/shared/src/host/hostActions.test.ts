import { describe, expect, it, vi } from 'vitest';
import {
  FRONTX_OVERLAY_DOMAIN,
  FRONTX_SCREEN_DOMAIN,
  type ActionHandler,
  type ActionsChain,
  type ChildMfeBridge,
} from '@gears-frontx/react';
import { STUDIO_ACTION_CHAIN_DONE, STUDIO_ACTION_CHAIN_FAILED } from './chainOutcome';
import {
  STUDIO_ACTION_NOTIFY,
  STUDIO_ACTION_WORKSPACES_PUBLISH,
  STUDIO_ARTIFACT_KINDS,
  isStudioArtifactKind,
  notify,
  requestFromHost,
  sendToHost,
  type HostAction,
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
    const executeActionsChain = vi.fn();
    const bridge = { executeActionsChain } as unknown as ChildMfeBridge;
    notify(bridge, { kind: 'error', text: 'Could not change the type' });
    expect(executeActionsChain).toHaveBeenCalledWith({
      action: {
        type: STUDIO_ACTION_NOTIFY,
        target: FRONTX_SCREEN_DOMAIN,
        payload: { kind: 'error', text: 'Could not change the type' },
      },
    });
  });

  it('passes the id through, for a toast the next notice replaces', () => {
    const executeActionsChain = vi.fn();
    const bridge = { executeActionsChain } as unknown as ChildMfeBridge;
    notify(bridge, { kind: 'loading', text: 'Checking', id: 'specs-check:p-1' });
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

const EXTENSION_ID = 'gts.frontx.mfes.ext.extension.v1~frontx.screensets.layout.overlay.v1~acme.overlays.form.v1';
const ACTION: HostAction = {
  type: STUDIO_ACTION_WORKSPACES_PUBLISH,
  target: FRONTX_OVERLAY_DOMAIN,
  payload: { kind: 'created' },
};

/** A bridge as mfes 0.4.0 has it: `executeActionsChain` hands the chain over and returns nothing. */
function voidBridge() {
  const handlers = new Map<string, ActionHandler>();
  const executeActionsChain = vi.fn<(chain: ActionsChain) => void>();
  const registerActionHandler = vi.fn((type: string, handler: ActionHandler) => {
    handlers.set(type, handler);
  });
  const bridge = { extensionId: EXTENSION_ID, executeActionsChain, registerActionHandler } as unknown as ChildMfeBridge;
  return { bridge, handlers, executeActionsChain, registerActionHandler };
}

describe('sendToHost', () => {
  it('hands the chain to the bridge and returns nothing', () => {
    const { bridge, executeActionsChain } = voidBridge();

    expect(sendToHost(bridge, ACTION)).toBeUndefined();
    expect(executeActionsChain).toHaveBeenCalledWith({ action: ACTION });
  });

  it('notify throws nothing when the bridge returns undefined', () => {
    const { bridge } = voidBridge();

    expect(() => notify(bridge, { kind: 'info', text: 'Saved' })).not.toThrow();
  });
});

describe('requestFromHost', () => {
  it("sends its replies to the bridge's own extension", () => {
    const { bridge, executeActionsChain } = voidBridge();

    void requestFromHost(bridge, ACTION);

    const [chain] = executeActionsChain.mock.calls[0];
    expect(chain.action).toEqual(ACTION);
    expect(chain.next?.action).toMatchObject({ type: STUDIO_ACTION_CHAIN_DONE, target: EXTENSION_ID });
    expect(chain.fallback?.action).toMatchObject({ type: STUDIO_ACTION_CHAIN_FAILED, target: EXTENSION_ID });
  });

  it('resolves on the done reply and rejects on the failed one', async () => {
    const { bridge, handlers, executeActionsChain } = voidBridge();
    const created = requestFromHost(bridge, ACTION);
    const refused = requestFromHost(bridge, ACTION);
    const [[first], [second]] = executeActionsChain.mock.calls;

    await handlers.get(STUDIO_ACTION_CHAIN_DONE)?.handleAction(STUDIO_ACTION_CHAIN_DONE, first.next?.action.payload);
    await handlers.get(STUDIO_ACTION_CHAIN_FAILED)?.handleAction(STUDIO_ACTION_CHAIN_FAILED, second.fallback?.action.payload);

    await expect(created).resolves.toBeUndefined();
    await expect(refused).rejects.toThrow();
  });

  it('registers its reply handlers once per bridge', () => {
    const { bridge, registerActionHandler } = voidBridge();

    void requestFromHost(bridge, ACTION);
    void requestFromHost(bridge, ACTION);

    expect(registerActionHandler.mock.calls.map(([type]) => type)).toEqual([
      STUDIO_ACTION_CHAIN_DONE,
      STUDIO_ACTION_CHAIN_FAILED,
    ]);
  });

  it('rejects at once without a bridge', async () => {
    await expect(requestFromHost(null, ACTION)).rejects.toThrow();
  });
});
