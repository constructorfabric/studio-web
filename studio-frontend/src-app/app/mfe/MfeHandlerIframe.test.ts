// @vitest-environment jsdom

/**
 * The iframe loader (ADR-0021).
 *
 * The teardown tests are the point of the file. A load is cached per
 * extension instance, so one lifecycle object serves every mount of that
 * extension, and `unmount` is handed only the container — never the bridge.
 * A subscription held in a single closure therefore survives the first
 * unmount and keeps writing into a frame that has left the page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MfeHandlerIframe, type MfeEntryIframe } from '@/app/mfe/MfeHandlerIframe';
import { STUDIO_MFE_ENTRY_IFRAME } from '@constructor-studio/mfe-shared';

const URL_PROPERTY = 'gts.frontx.mfes.comm.shared_property.v1~constructor_studio.space.mfe.frame_url.v1~';

const entry: MfeEntryIframe = {
  id: `${STUDIO_MFE_ENTRY_IFRAME}acme.demo.mfe.frame.v1`,
  requiredProperties: [URL_PROPERTY],
  actions: [],
  domainActions: [],
  urlProperty: URL_PROPERTY,
};

/**
 * A bridge that records its subscribers so a test can push a value in.
 *
 * `getProperty` answers the wrapper the real bridge answers —
 * `{ id, value }` — and `undefined` when nothing has been published. The
 * loader re-reads through it on every notification, the way the framework's
 * own useSharedProperty does, so the notification carries no value here.
 */
function createBridge(initial: string | null | undefined = undefined) {
  const subscribers = new Map<string, Array<(value: unknown) => void>>();
  let current: string | null | undefined = initial;
  return {
    subscribers,
    emit(value: string | null) {
      current = value;
      for (const cb of subscribers.get(URL_PROPERTY) ?? []) {
        cb({ id: URL_PROPERTY, value });
      }
    },
    bridge: {
      domainId: 'screen',
      instanceId: 'inst-1',
      executeActionsChain: vi.fn(),
      registerActionHandler: vi.fn(),
      getProperty: (id: string) =>
        id === URL_PROPERTY && current !== undefined
          ? { id: URL_PROPERTY, value: current }
          : undefined,
      subscribeToProperty(id: string, cb: (value: unknown) => void) {
        const list = subscribers.get(id) ?? [];
        list.push(cb);
        subscribers.set(id, list);
        return () => {
          subscribers.set(id, (subscribers.get(id) ?? []).filter((c) => c !== cb));
        };
      },
    },
  };
}

function frameIn(container: Element): HTMLIFrameElement | null {
  return container.querySelector('iframe');
}

let handler: MfeHandlerIframe;

beforeEach(() => {
  handler = new MfeHandlerIframe(STUDIO_MFE_ENTRY_IFRAME);
});

describe('MfeHandlerIframe', () => {
  it('handles the iframe entry subtype at a priority above the default', () => {
    expect(handler.handledBaseTypeId).toBe(STUDIO_MFE_ENTRY_IFRAME);
    expect(handler.priority).toBeGreaterThan(0);
  });

  it('shows a waiting state while the property holds nothing', async () => {
    const lifecycle = await handler.load(entry, 'ext-1');
    const container = document.createElement('div');
    const { bridge } = createBridge(null);

    await lifecycle.mount(container, bridge as never);

    expect(frameIn(container)).toBeNull();
    expect(container.textContent).not.toBe('');
  });

  it('points the frame at the address already in the property', async () => {
    const lifecycle = await handler.load(entry, 'ext-1');
    const container = document.createElement('div');
    const { bridge } = createBridge('https://example.test/page');

    await lifecycle.mount(container, bridge as never);

    expect(frameIn(container)?.getAttribute('src')).toBe('https://example.test/page');
  });

  it('fills the container, which a shadow root does not do for it', async () => {
    const lifecycle = await handler.load(entry, 'ext-1');
    const container = document.createElement('div');
    const { bridge } = createBridge('https://example.test/page');

    await lifecycle.mount(container, bridge as never);

    const frame = frameIn(container)!;
    expect(frame.style.width).toBe('100%');
    expect(frame.style.height).toBe('100%');
    // Not 'none': jsdom's CSSOM never reads a border-style of 'none' back out
    // (see MfeHandlerIframe.ts), so the loader zeroes the width instead —
    // equally borderless, and the one value this environment round-trips.
    expect(frame.style.border).toBe('0px');
  });

  it('follows the address when the property changes', async () => {
    const lifecycle = await handler.load(entry, 'ext-1');
    const container = document.createElement('div');
    const harness = createBridge(null);

    await lifecycle.mount(container, harness.bridge as never);
    harness.emit('https://example.test/first');

    expect(frameIn(container)?.getAttribute('src')).toBe('https://example.test/first');
  });

  it('leaves no listener behind after unmount', async () => {
    const lifecycle = await handler.load(entry, 'ext-1');
    const container = document.createElement('div');
    const harness = createBridge('https://example.test/page');

    await lifecycle.mount(container, harness.bridge as never);
    await lifecycle.unmount(container);

    expect(harness.subscribers.get(URL_PROPERTY)).toEqual([]);
    expect(container.childNodes).toHaveLength(0);
  });

  it('does not touch a detached frame when the property changes later', async () => {
    const lifecycle = await handler.load(entry, 'ext-1');
    const container = document.createElement('div');
    const harness = createBridge('https://example.test/page');

    await lifecycle.mount(container, harness.bridge as never);
    const frame = frameIn(container)!;
    await lifecycle.unmount(container);
    harness.emit('https://example.test/second');

    expect(frame.getAttribute('src')).toBe('https://example.test/page');
  });

  it('serves a second mount of the same cached lifecycle', async () => {
    const lifecycle = await handler.load(entry, 'ext-1');
    const first = document.createElement('div');
    const second = document.createElement('div');
    const harness = createBridge('https://example.test/page');

    await lifecycle.mount(first, harness.bridge as never);
    await lifecycle.unmount(first);
    await lifecycle.mount(second, harness.bridge as never);
    harness.emit('https://example.test/again');

    expect(frameIn(second)?.getAttribute('src')).toBe('https://example.test/again');
    expect(harness.subscribers.get(URL_PROPERTY)).toHaveLength(1);
  });
});
