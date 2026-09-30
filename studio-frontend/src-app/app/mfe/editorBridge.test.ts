/**
 * The editor's postMessage channel against a stubbed frame: no IDE, no
 * browser navigation — a frame is an event target with a window to post to,
 * and the portal is the event target its messages arrive on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFrame } from '@frontx-test-utils/stubFrame';
import {
  INIT_REPEAT_MS,
  connectEditorBridge,
  editorTheme,
  type EditorBridgeOptions,
  type EditorInit,
} from './editorBridge';

const ORIGIN = 'https://portal.test';
const ADDRESS = `${ORIGIN}/studio/s1/?token=gate`;


const INIT: EditorInit = { theme: 'light', workspaceId: 'p1', apiToken: 'T1' };

function connect(frame: HTMLIFrameElement, overrides: Partial<EditorBridgeOptions> = {}) {
  const options = {
    init: vi.fn(() => INIT),
    onAnswer: vi.fn(),
    onReload: vi.fn(),
    onOpenComponent: vi.fn(),
    ...overrides,
  };
  return { bridge: connectEditorBridge(frame, options), options };
}

describe('connectEditorBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says nothing before the frame loads, then repeats the init until any studio.* answers', () => {
    const f = stubFrame(ADDRESS);
    const { options } = connect(f.frame);
    expect(f.sent()).toEqual([]);

    f.load();
    expect(f.sent()).toEqual([{ type: 'studio.init', ...INIT }]);
    vi.advanceTimersByTime(INIT_REPEAT_MS * 2);
    expect(f.types()).toEqual(['studio.init', 'studio.init', 'studio.init']);

    f.answer({ type: 'studio.status', dirty: 0 });
    expect(options.onAnswer).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INIT_REPEAT_MS * 5);
    expect(f.types()).toHaveLength(3);

    // A later message is not a second answer.
    f.answer({ type: 'studio.status', dirty: 1 });
    expect(options.onAnswer).toHaveBeenCalledTimes(1);
  });

  it("posts to the frame's own origin only, never to `*`", () => {
    const f = stubFrame(ADDRESS);
    const { bridge } = connect(f.frame);

    f.load();
    f.answer({ type: 'studio.status', dirty: 0 });
    bridge.post({ type: 'studio.theme', theme: 'dark' });

    expect(f.content.postMessage.mock.calls.map(([, target]) => target)).toEqual([ORIGIN, ORIGIN]);
  });

  it('reads the init afresh for every repeat', () => {
    const f = stubFrame(ADDRESS);
    let token = 'T1';
    connect(f.frame, { init: () => ({ ...INIT, apiToken: token }) });

    f.load();
    token = 'T2';
    vi.advanceTimersByTime(INIT_REPEAT_MS);

    expect(f.sent().map((message) => message.apiToken)).toEqual(['T1', 'T2']);
  });

  it('holds the rest until the answer, only the latest of each type', () => {
    const f = stubFrame(ADDRESS);
    const { bridge } = connect(f.frame);

    bridge.post({ type: 'studio.openInEditor', path: 'web/README.md' });
    bridge.post({ type: 'studio.theme', theme: 'dark' });
    bridge.post({ type: 'studio.openInEditor', path: 'web/src/main.ts' });
    f.load();
    f.answer({ type: 'studio.status', dirty: 0 });

    expect(f.sent()).toEqual([
      { type: 'studio.init', ...INIT },
      { type: 'studio.openInEditor', path: 'web/src/main.ts' },
      { type: 'studio.theme', theme: 'dark' },
    ]);

    bridge.post({ type: 'studio.token', apiToken: 'T2' });
    expect(f.sent().slice(-1)).toEqual([{ type: 'studio.token', apiToken: 'T2' }]);
  });

  it.each([
    ['another window', { type: 'studio.status', dirty: 0 }, { source: {} }],
    ['another origin', { type: 'studio.status', dirty: 0 }, { origin: 'https://evil.test' }],
    ['an opaque origin', { type: 'studio.status', dirty: 0 }, { origin: 'null' }],
    ['a message that is not studio.*', { type: 'webpackOk' }, {}],
    ['a message with no type', { dirty: 0 }, {}],
    ['a string', 'studio.status', {}],
  ])('takes %s for no answer', (_case, data, sender) => {
    const f = stubFrame(ADDRESS);
    const { bridge, options } = connect(f.frame);
    bridge.post({ type: 'studio.openInEditor', path: 'web/README.md' });

    f.load();
    f.answer(data, sender);
    vi.advanceTimersByTime(INIT_REPEAT_MS);

    expect(options.onAnswer).not.toHaveBeenCalled();
    expect(f.types()).toEqual(['studio.init', 'studio.init']);
  });

  it('starts over when the frame loads again after an answer, and tells nothing twice', () => {
    const f = stubFrame(ADDRESS);
    const { bridge, options } = connect(f.frame);
    bridge.post({ type: 'studio.openInEditor', path: 'web/README.md' });
    f.load();
    f.answer({ type: 'studio.status', dirty: 0 });

    f.load();
    expect(options.onReload).toHaveBeenCalledTimes(1);
    bridge.post({ type: 'studio.theme', theme: 'dark' });
    expect(f.types()).toEqual(['studio.init', 'studio.openInEditor', 'studio.init']);

    f.answer({ type: 'studio.status', dirty: 0 });
    expect(options.onAnswer).toHaveBeenCalledTimes(2);
    expect(f.types()).toEqual(['studio.init', 'studio.openInEditor', 'studio.init', 'studio.theme']);
  });

  it("does not take the gate's splash reloading itself for an IDE that reloaded", () => {
    const f = stubFrame(ADDRESS);
    const { options } = connect(f.frame);

    f.load();
    f.load();
    f.load();

    expect(options.onReload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(INIT_REPEAT_MS);
    // One repeat running, not three.
    expect(f.types()).toEqual(['studio.init', 'studio.init', 'studio.init', 'studio.init']);
  });

  it('hands a request for a component to the shell', () => {
    const f = stubFrame(ADDRESS);
    const { options } = connect(f.frame);
    f.load();

    f.answer({ type: 'studio.openComponent', name: 'cf-gears-api-gateway' });
    f.answer({ type: 'studio.openComponent', name: '' });
    f.answer({ type: 'studio.openComponent' });

    expect(options.onOpenComponent).toHaveBeenCalledTimes(1);
    expect(options.onOpenComponent).toHaveBeenCalledWith('cf-gears-api-gateway');
  });

  it('stops everything once disposed', () => {
    const f = stubFrame(ADDRESS);
    const { bridge, options } = connect(f.frame);
    f.load();

    bridge.dispose();
    vi.advanceTimersByTime(INIT_REPEAT_MS * 3);
    f.load();
    f.answer({ type: 'studio.status', dirty: 0 });

    expect(f.types()).toEqual(['studio.init']);
    expect(options.onAnswer).not.toHaveBeenCalled();
  });
});

describe('editorTheme', () => {
  it.each([
    ['default', 'light'],
    ['light', 'light'],
    ['dark', 'dark'],
    ['dracula', 'dark'],
    ['dracula-large', 'dark'],
    [undefined, 'dark'],
  ] as const)('shows the IDE %s as %s', (portal, editor) => {
    expect(editorTheme(portal)).toBe(editor);
  });
});
