/**
 * An iframe as the editor's bridge sees it, without a browser: an event target
 * with a window to post to, inside a portal window that is an event target too.
 * `answersInit` makes the IDE inside reply to `studio.init`, as the real one does.
 */

import { vi } from 'vitest';

export function stubFrame(src: string, answersInit: () => boolean = () => false) {
  const portal = new EventTarget();
  const content = { postMessage: vi.fn() };
  const frame = Object.assign(new EventTarget(), {
    src,
    contentWindow: content,
    ownerDocument: { defaultView: portal },
  }) as unknown as HTMLIFrameElement;

  /** What the IDE's page posts to the portal; `source` and `origin` are the sender's. */
  const answer = (data: unknown, { source = content as unknown, origin = new URL(src).origin } = {}): void => {
    const event = new Event('message');
    Object.defineProperties(event, { data: { value: data }, origin: { value: origin }, source: { value: source } });
    portal.dispatchEvent(event);
  };
  content.postMessage.mockImplementation((message: { type?: string }) => {
    if (message.type === 'studio.init' && answersInit()) answer({ type: 'studio.status', dirty: 0 });
  });
  const load = (): void => void frame.dispatchEvent(new Event('load'));
  const sent = (): Record<string, unknown>[] => content.postMessage.mock.calls.map(([message]) => message);
  const types = (): unknown[] => sent().map((message) => message.type);
  return { frame, content, answer, load, sent, types };
}
