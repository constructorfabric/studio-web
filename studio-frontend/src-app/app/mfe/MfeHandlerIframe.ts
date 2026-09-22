/**
 * Loads a micro-frontend whose entry is a frame rather than a module.
 *
 * See docs/adr/0021-an-mfe-entry-may-be-a-frame.md. The handler knows nothing
 * about what is inside the frame: the entry names a shared property, the
 * address arrives in it, and who writes it is somebody else's decision.
 */

import {
  MfeHandler,
  MfeBridgeFactory,
  ChildMfeBridgeImpl,
  type ChildMfeBridge,
  type MfeEntry,
  type MfeEntryLifecycle,
  type SharedProperty,
} from '@gears-frontx/react';

/** An entry loaded into a frame. Adds the one field the subtype declares. */
export interface MfeEntryIframe extends MfeEntry {
  urlProperty: string;
}

/**
 * The shipped default does exactly this one line — the runtime wires the
 * bridge through its own, separate factory afterwards. Written out here
 * rather than imported because `MfeBridgeFactoryDefault` has left the
 * package's public surface in versions after the pinned 0.3.0-alpha.2.
 */
class IframeBridgeFactory extends MfeBridgeFactory<ChildMfeBridgeImpl> {
  create(domainId: string, _entryTypeId: string, instanceId: string): ChildMfeBridgeImpl {
    return new ChildMfeBridgeImpl(domainId, instanceId);
  }

  dispose(_bridge: ChildMfeBridgeImpl): void {
    // Nothing of ours to release: the frame and its subscription belong to the
    // lifecycle and are dropped in unmount.
  }
}

/** What one mounted container owns, so unmount can undo exactly that. */
interface MountState {
  unsubscribe: () => void;
}

/**
 * A property reads as a wrapper — `{ id, value }` — and is absent entirely
 * until the host has published under that id. Both "not said yet" and "said
 * there is none" mean the same thing to a frame: nowhere to point.
 */
function readUrl(property: SharedProperty | undefined): string | null {
  const value = property?.value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function createFrame(): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  // The container is always a shadow root carrying `:host { all: initial }`,
  // so a frame with no size of its own collapses to nothing.
  frame.style.width = '100%';
  frame.style.height = '100%';
  // Zero width renders no border regardless of style, and reads back
  // predictably: jsdom's CSSOM (cssstyle) treats a bare `border: none` as
  // "clear the longhand", not "store none", so `style.border` can never
  // read back as the string 'none' — see borderTopStyle.js's `set()`.
  frame.style.border = '0';
  frame.setAttribute('title', 'Embedded application');
  return frame;
}

function createWaiting(): HTMLElement {
  const waiting = document.createElement('div');
  waiting.dataset.state = 'waiting';
  waiting.style.padding = '1rem';
  waiting.textContent = 'Waiting for the address…';
  return waiting;
}

export class MfeHandlerIframe extends MfeHandler<MfeEntryIframe, ChildMfeBridge> {
  readonly bridgeFactory = new IframeBridgeFactory();

  constructor(handledBaseTypeId: string, priority = 10) {
    super(handledBaseTypeId, priority);
  }

  load(entry: MfeEntryIframe, _extensionId: string): Promise<MfeEntryLifecycle<ChildMfeBridge>> {
    // One lifecycle object serves every mount of this extension — the runtime
    // caches the load — so per-mount state is keyed by container rather than
    // captured once. `unmount` receives the container and nothing else.
    const mounted = new WeakMap<Element | ShadowRoot, MountState>();

    const lifecycle: MfeEntryLifecycle<ChildMfeBridge> = {
      mount(container, bridge) {
        let frame: HTMLIFrameElement | null = null;

        const show = (url: string | null): void => {
          if (url === null) {
            // Both "not said yet" and "said there is none" (readUrl's two
            // nulls) mean the frame has nowhere to point — including after
            // one was already shown, when the property is cleared. Drop the
            // stale frame rather than leave it loaded on a dead address, and
            // forget it so the next real address builds a fresh one.
            frame = null;
            container.replaceChildren(createWaiting());
            return;
          }
          if (frame === null) {
            container.replaceChildren();
            frame = createFrame();
            container.appendChild(frame);
          }
          frame.setAttribute('src', url);
        };

        container.replaceChildren(createWaiting());
        show(readUrl(bridge.getProperty(entry.urlProperty)));

        // Re-read rather than trust the notification's argument: this is what
        // the framework's own useSharedProperty does, and it keeps one answer
        // to "what is the address" instead of two.
        const unsubscribe = bridge.subscribeToProperty(entry.urlProperty, () => {
          show(readUrl(bridge.getProperty(entry.urlProperty)));
        });

        mounted.set(container, { unsubscribe });
      },

      unmount(container) {
        const state = mounted.get(container);
        if (state === undefined) return;
        state.unsubscribe();
        mounted.delete(container);
        container.replaceChildren();
      },
    };

    return Promise.resolve(lifecycle);
  }
}
