// @cpt-dod:cpt-studiofrontend-dod-editor-bridge-frame:p1
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
 * Told of every frame the handler creates — one per address — once it is in
 * the page with its address set and before it loads, and handed back what to
 * call when that frame goes: the address cleared or replaced, or the
 * container unmounted. What talks to the frame is the caller's business; the
 * handler still knows nothing of what is inside.
 */
export type FrameHook = (frame: HTMLIFrameElement, entry: MfeEntryIframe) => (() => void) | undefined;

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
  releaseFrame: () => void;
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
  // where it was loaded from.
  frame.setAttribute('referrerpolicy', 'no-referrer');
  // Copy and paste in the editor. A same-origin frame has them anyway; the
  // local Docker session answers on another port, and there it needs this.
  frame.setAttribute('allow', 'clipboard-read; clipboard-write');
  // No `sandbox`, decided in #323 (docs/theia-bridge-contract-v1.md §6): on a
  // stand the editor is on the portal's own origin, where a sandbox without
  // `allow-same-origin` breaks its websocket and one with it can be lifted
  // from inside.
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

  constructor(handledBaseTypeId: string, private readonly onFrame?: FrameHook) {
    super(handledBaseTypeId, 10);
  }

  load(entry: MfeEntryIframe, _extensionId: string): Promise<MfeEntryLifecycle<ChildMfeBridge>> {
    // One lifecycle object serves every mount of this extension — the runtime
    // caches the load — so per-mount state is keyed by container rather than
    // captured once. `unmount` receives the container and nothing else.
    const mounted = new WeakMap<Element | ShadowRoot, MountState>();
    const { onFrame } = this;
    // The hook's release, or nothing: a hook that throws must not take the frame down with it.
    const attach = (frame: HTMLIFrameElement): (() => void) | undefined => {
      try {
        return onFrame?.(frame, entry);
      } catch (error) {
        console.error('[MfeHandlerIframe] onFrame failed:', error);
        return undefined;
      }
    };

    const lifecycle: MfeEntryLifecycle<ChildMfeBridge> = {
      mount(container, bridge) {
        const wrapper = createWrapper();
        // What the wrapper is currently showing: an address, `null` for the
        // waiting state, and `undefined` until the first render — so the
        // first call always draws something, whichever of the two it is.
        let shown: string | null | undefined;
        let release: (() => void) | undefined;

        const releaseFrame = (): void => {
          release?.();
          release = undefined;
        };

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
          releaseFrame();
          if (url === null) {
            // Both "not said yet" and "said there is none" (readUrl's two
            // nulls) mean the frame has nowhere to point — including after
            // one was already shown, when the property is cleared. Drop the
            // stale frame rather than leave it loaded on a dead address.
            wrapper.replaceChildren(createWaiting());
          } else {
            // A new address gets a new frame, not a new `src`: it is another
            // application (another session), whoever talks to the frame
            // starts over with it, and the frame's own history does not pile
            // up in the browser's back button.
            const frame = createFrame();
            frame.setAttribute('src', url);
            wrapper.replaceChildren(frame);
            release = attach(frame);
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

        mounted.set(container, { unsubscribe, releaseFrame, wrapper });
      },

      unmount(container) {
        const state = mounted.get(container);
        if (state === undefined) return;
        state.unsubscribe();
        state.releaseFrame();
        mounted.delete(container);
        // Removes only what this handler put in the container — never a
        // sibling's DOM, and never the shadow root's own isolation style.
        state.wrapper.remove();
      },
    };

    return Promise.resolve(lifecycle);
  }
}
