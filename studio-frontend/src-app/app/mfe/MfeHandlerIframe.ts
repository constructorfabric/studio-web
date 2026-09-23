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
  wrapper: HTMLElement;
}

/**
 * The container the mount manager hands `mount` is, in practice, a shadow
 * root (see docs/adr/0021-an-mfe-entry-may-be-a-frame.md) carrying a
 * `<style id="__frontx-shadow-isolation__">` element `createShadowRoot`
 * seeds it with — and, under a mount strategy that shares one container
 * among several extensions, siblings this handler has no business touching.
 * `replaceChildren()` on the container itself would erase all of that, so
 * the handler owns one wrapper `<div>` per mount instead: everything it
 * shows lives inside the wrapper, and unmount removes only the wrapper.
 */
function createWrapper(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';
  return wrapper;
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
  // Costs nothing today and narrows what the embedded document learns about
  // where it was loaded from. No `sandbox`: that decision belongs to #323,
  // once something other than this repository's own static page is inside
  // the frame (see docs/adr/0021-an-mfe-entry-may-be-a-frame.md).
  frame.setAttribute('referrerpolicy', 'no-referrer');
  return frame;
}

/**
 * `role="status"` because this element is not only the first thing a mount
 * shows: it also comes back, after a frame has been on screen, when the
 * address is cleared. That is a change a sighted user sees and a screen
 * reader would otherwise pass over in silence.
 */
function createWaiting(): HTMLElement {
  const waiting = document.createElement('div');
  waiting.dataset.state = 'waiting';
  waiting.setAttribute('role', 'status');
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
        const wrapper = createWrapper();
        // What the wrapper is currently showing: an address, `null` for the
        // waiting state, and `undefined` until the first render — so the
        // first call always draws something, whichever of the two it is.
        let shown: string | null | undefined;

        const show = (url: string | null): void => {
          if (url === shown) {
            // A write to a shared property notifies every subscriber whether
            // or not the value changed, so the same address arrives again on
            // any republish. Assigning `src` an address the frame already
            // holds is a fresh navigation, not a no-op: the frame reloads and
            // loses whatever it held, which is unsaved work once a real
            // editor is inside. Redrawing the waiting state is cheaper but no
            // more welcome — it would re-announce itself to a screen reader.
            return;
          }
          if (url === null) {
            // Both "not said yet" and "said there is none" (readUrl's two
            // nulls) mean the frame has nowhere to point — including after
            // one was already shown, when the property is cleared. Drop the
            // stale frame rather than leave it loaded on a dead address, and
            // forget it so the next real address builds a fresh one.
            frame = null;
            wrapper.replaceChildren(createWaiting());
          } else {
            if (frame === null) {
              wrapper.replaceChildren();
              frame = createFrame();
              wrapper.appendChild(frame);
            }
            frame.setAttribute('src', url);
          }
          shown = url;
        };

        container.appendChild(wrapper);
        show(readUrl(bridge.getProperty(entry.urlProperty)));

        // Re-read rather than trust the notification's argument: this is what
        // the framework's own useSharedProperty does, and it keeps one answer
        // to "what is the address" instead of two.
        const unsubscribe = bridge.subscribeToProperty(entry.urlProperty, () => {
          show(readUrl(bridge.getProperty(entry.urlProperty)));
        });

        mounted.set(container, { unsubscribe, wrapper });
      },

      unmount(container) {
        const state = mounted.get(container);
        if (state === undefined) return;
        state.unsubscribe();
        mounted.delete(container);
        // Removes only what this handler put in the container — never a
        // sibling's DOM, and never the shadow root's own isolation style.
        state.wrapper.remove();
      },
    };

    return Promise.resolve(lifecycle);
  }
}
