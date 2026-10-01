import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession, AuthStateEvent, FrontXApp } from '@gears-frontx/react';

const { mockHas, mockGetService, publishFrameUrl, toastInfo } = vi.hoisted(() => ({
  mockHas: vi.fn(),
  mockGetService: vi.fn(),
  publishFrameUrl: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gears-frontx/react')>()),
  apiRegistry: { has: mockHas, getService: mockGetService },
}));
vi.mock('@/app/mfe/sharedContext', () => ({ publishFrameUrl }));
vi.mock('sonner', () => ({ toast: { info: toastInfo } }));

import { AccountsApiService, ConnectorsApiService, type StudioArtifact } from '@constructor-studio/mfe-shared';
import { stubFrame } from '@frontx-test-utils/stubFrame';
import type { MfeEntryIframe } from '@/app/mfe/MfeHandlerIframe';
import { APP_CONTEXT_SLICE_KEY } from '@/app/slices/appContextSlice';
import { APP_SESSION_SLICE_KEY } from '@/app/slices/appSessionSlice';
import {
  StudioEventsApiService,
  StudioSessionApiService,
  StudioTasksApiService,
  type StudioEvent,
  type StudioRunState,
  type StudioSessionState,
} from '@/app/api';
import { DARK_THEME_ID } from '@/app/themes/dark';
import { DEFAULT_THEME_ID } from '@/app/themes/default';
import { DRACULA_THEME_ID } from '@/app/themes/dracula';
import { DRACULA_LARGE_THEME_ID } from '@/app/themes/dracula-large';
import { LIGHT_THEME_ID } from '@/app/themes/light';
import reducer, {
  EDITOR_SESSION_SLICE_KEY,
  type EditorSessionPhase,
  type EditorSessionState,
} from '@/app/slices/editorSessionSlice';
import { EDITOR_FRAME_ENTRY, createEditorSession } from './editorSessionEffects';

const PROJECT = 'p1';
const ORG = 'o1';
const RUN = 'run-1';
const ADDRESS = 'https://ide.test/studio/s1/?token=gate';
const REPOS = [{ name: 'web', kind: 'git', url: 'https://git.test/acme/web.git', token_ref: 'ref-1' }];
const FILE: StudioArtifact = { artifactId: 'a1', repository: 'acme/web', path: 'src/main.ts', kind: 'file' };
const PROFILE = { id: 'u1', displayName: 'Ada Lovelace', email: 'ada@acme.test' };
const VIEWER = { sub: 'u1', name: 'Ada Lovelace', email: 'ada@acme.test', kind: 'person' };
const ANSWER_DEADLINE_MS = 2 * 60_000;

const entry = (id: string): MfeEntryIframe => ({
  id,
  requiredProperties: [],
  actions: [],
  domainActions: [],
  urlProperty: 'gts.frontx.mfes.comm.shared_property.v1~constructor_studio.space.mfe.frame_url.v1~',
});

function refusal(status: number, detail?: string): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: detail ? { detail } : {} },
  });
}

function session(state: StudioSessionState, readyRunId?: string) {
  return {
    id: 's1',
    workspace_id: PROJECT,
    state,
    url: ADDRESS,
    created_at_epoch_secs: 1_700_000_000,
    sources: [],
    ...(readyRunId ? { ready_run_id: readyRunId } : {}),
  };
}

function run(state: StudioRunState, lastError: string | null = null) {
  return { id: RUN, state, last_error: lastError, attempts: 1 };
}

function taskEvent(seq: number, kind: string, subjectId = RUN, payload: Record<string, unknown> = {}): StudioEvent {
  return {
    seq,
    at_ms: seq,
    kind,
    subject_type: 'task_run',
    subject_id: subjectId,
    source: 'studio-tasks',
    payload: { run_id: subjectId, state: kind.slice('task.'.length), ...payload },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness({ profile = PROFILE as typeof PROFILE | null, projectName = 'Web' } = {}) {
  let state: EditorSessionState = reducer(undefined, { type: '@@init' });
  const phases: EditorSessionPhase[] = [];
  let themeId = 'default';
  const themeListeners = new Set<() => void>();
  const authListeners = new Set<(event: AuthStateEvent) => void>();
  const getSession = vi.fn<() => Promise<AuthSession | null>>().mockResolvedValue({ kind: 'bearer', token: 'T1' });
  const app = {
    store: {
      dispatch: (action: unknown) => {
        state = reducer(state, action as never);
        phases.push(state.phase);
      },
      getState: () => ({
        [EDITOR_SESSION_SLICE_KEY]: state,
        [APP_CONTEXT_SLICE_KEY]: { project: { id: PROJECT, name: projectName } },
        [APP_SESSION_SLICE_KEY]: { profile },
      }),
    },
    themeRegistry: {
      getCurrent: () => ({ id: themeId }),
      subscribe: (listener: () => void) => {
        themeListeners.add(listener);
        return () => themeListeners.delete(listener);
      },
    },
    auth: {
      getSession,
      subscribe: (listener: (event: AuthStateEvent) => void) => {
        authListeners.add(listener);
        return () => authListeners.delete(listener);
      },
    },
    i18nRegistry: { t: (key: string) => key },
  } as unknown as FrontXApp;
  const setTheme = (id: string): void => {
    themeId = id;
    themeListeners.forEach((listener) => listener());
  };
  const authEvent = (event: AuthStateEvent): void => authListeners.forEach((listener) => listener(event));
  const renewToken = (token: string): void => authEvent({ state: 'authenticated', session: { kind: 'bearer', token } });

  const stream: { onEvent: ((event: StudioEvent) => void) | null; onComplete: (() => void) | null } = {
    onEvent: null,
    onComplete: null,
  };
  const disconnect = vi.fn();
  const events = {
    cursor: { fetch: vi.fn().mockResolvedValue({ events: [], latest_seq: 0 }) },
    streamFrom: vi.fn((_cursor: number) => ({
      key: ['/cf/studio-events/v1', 'SSE', '/stream'],
      connect: (onEvent: (event: StudioEvent) => void, onComplete?: () => void) => {
        stream.onEvent = onEvent;
        stream.onComplete = onComplete ?? null;
        return Promise.resolve('connection-1');
      },
      disconnect,
    })),
  };
  const launch = vi.fn();
  const sessions = { launch: { fetch: launch }, session: vi.fn() };
  const tasks = { run: vi.fn(), retry: vi.fn() };
  const accounts = {
    getTenantMetadata: vi.fn(() => ({
      fetch: () =>
        Promise.resolve({
          value: { sources: [{ connection_id: 'c1', full_path: 'acme/web', clone_url: 'https://git.test/acme/web.git' }] },
        }),
    })),
  };
  const connectors = {
    connections: vi.fn(() => ({
      fetch: () => Promise.resolve({ items: [{ id: 'c1', scope: 'organization', secret_ref: 'ref-1' }] }),
    })),
  };
  const services = new Map<unknown, unknown>([
    [StudioEventsApiService, events],
    [StudioSessionApiService, sessions],
    [StudioTasksApiService, tasks],
    [AccountsApiService, accounts],
    [ConnectorsApiService, connectors],
  ]);
  mockHas.mockReturnValue(true);
  mockGetService.mockImplementation((service: unknown) => services.get(service));

  const editor = createEditorSession(app);
  const open = (projectId = PROJECT, artifact: StudioArtifact | null = FILE): void =>
    editor.sync({ projectId, orgId: ORG, editor: true, artifact });
  const leave = (projectId = PROJECT): void => editor.sync({ projectId, orgId: ORG, editor: false, artifact: null });

  // The iframe handler: one frame per address, told to the session's hook
  // before it loads; leaving the editor unmounts it, coming back mounts a new
  // one on the address still published, and nothing is drawn while it is away.
  const ide = { answers: true };
  const frames: ReturnType<typeof stubFrame>[] = [];
  let shown: string | null = null;
  let mounted = true;
  let release: (() => void) | undefined;
  const mountFrame = (url: string | null): void => {
    release?.();
    release = undefined;
    if (url === null) return;
    const stub = stubFrame(url, () => ide.answers);
    frames.push(stub);
    release = editor.frame(stub.frame, entry(EDITOR_FRAME_ENTRY));
    // The frame loads once it is in the page, after the handler returns.
    void Promise.resolve().then(stub.load);
  };
  publishFrameUrl.mockImplementation((_app: unknown, url: string | null) => {
    if (url === shown) return;
    shown = url;
    if (mounted) mountFrame(url);
  });
  const unmount = (): void => {
    mounted = false;
    release?.();
    release = undefined;
  };
  const mount = (): void => {
    mounted = true;
    mountFrame(shown);
  };

  return {
    editor,
    open,
    leave,
    ide,
    frames,
    mount,
    unmount,
    setTheme,
    authEvent,
    renewToken,
    getSession,
    state: () => state,
    phases,
    events,
    stream,
    disconnect,
    launch,
    sessions,
    tasks,
    accounts,
  };
}

const published = (): unknown[] => publishFrameUrl.mock.calls.map(([, url]) => url);
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createEditorSession', () => {
  afterEach(() => {
    vi.clearAllMocks();
    // The console spies; `vi.fn()` mocks are left alone.
    vi.restoreAllMocks();
  });

  it('reuses a live session: reads the cursor first, launches once, publishes, follows nothing', async () => {
    const h = harness();
    h.launch.mockResolvedValue(session('running'));

    h.open();
    await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

    expect(h.events.cursor.fetch).toHaveBeenCalledWith({ staleTime: 0 });
    expect(h.events.cursor.fetch.mock.invocationCallOrder[0]).toBeLessThan(h.launch.mock.invocationCallOrder[0] ?? 0);
    expect(h.launch).toHaveBeenCalledWith({ workspace_id: PROJECT, repos: REPOS });
    expect(published()).toEqual([ADDRESS]);
    expect(h.events.streamFrom).not.toHaveBeenCalled();
    expect(h.tasks.run).not.toHaveBeenCalled();
  });

  it('launches: follows the run from the cursor, stays launching until task.succeeded, then publishes', async () => {
    const h = harness();
    h.launch.mockResolvedValue(session('starting', RUN));
    h.tasks.run.mockReturnValue({ fetch: vi.fn().mockResolvedValue(run('queued')) });

    h.open();
    await vi.waitFor(() => expect(h.stream.onEvent).not.toBeNull());
    expect(h.state().phase).toBe('launching');
    expect(h.events.streamFrom).toHaveBeenCalledWith(0);

    h.stream.onEvent?.(taskEvent(1, 'task.running', RUN, { attempts: 2 }));
    expect(h.state().phase).toBe('launching');
    expect(published()).toEqual([]);

    h.stream.onEvent?.(taskEvent(2, 'task.succeeded'));
    await vi.waitFor(() => expect(h.state().phase).toBe('ready'));
    expect(published()).toEqual([ADDRESS]);
    await vi.waitFor(() => expect(h.disconnect).toHaveBeenCalledWith('connection-1'));
  });

  it('ends failed with the run error when the backend gives up, and stops listening', async () => {
    const h = harness();
    h.launch.mockResolvedValue(session('starting', RUN));
    h.tasks.run.mockReturnValue({ fetch: vi.fn().mockResolvedValue(run('running')) });

    h.open();
    await vi.waitFor(() => expect(h.stream.onEvent).not.toBeNull());
    h.stream.onEvent?.(taskEvent(9, 'task.failed', RUN, { error: 'session s1 still starting after 3 minutes' }));

    await vi.waitFor(() => expect(h.state().phase).toBe('failed'));
    expect(h.state().failure).toEqual({ kind: 'run', error: 'session s1 still starting after 3 minutes' });
    expect(published()).toEqual([]);
    await vi.waitFor(() => expect(h.disconnect).toHaveBeenCalled());
  });

  it('reads a run handed back once, and answers from it when it had already ended', async () => {
    const h = harness();
    const read = vi.fn().mockResolvedValue(run('succeeded'));
    h.launch.mockResolvedValue(session('starting', RUN));
    h.tasks.run.mockReturnValue({ fetch: read });

    h.open();
    await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

    expect(h.tasks.run).toHaveBeenCalledWith({ runId: RUN });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ staleTime: 0 });
    expect(h.events.streamFrom).not.toHaveBeenCalled();
    expect(published()).toEqual([ADDRESS]);
  });

  describe('Try again', () => {
    it('puts a run that gave up back on the queue and follows it from a fresh cursor', async () => {
      const h = harness();
      h.launch.mockResolvedValue(session('starting', RUN));
      h.tasks.run.mockReturnValue({ fetch: vi.fn().mockResolvedValue(run('failed', 'gave up')) });
      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('failed'));
      expect(h.state().failure).toEqual({ kind: 'run', error: 'gave up' });
      expect(h.tasks.retry).not.toHaveBeenCalled();

      h.tasks.retry.mockReturnValue({ fetch: vi.fn().mockResolvedValue(run('queued')) });
      h.events.cursor.fetch.mockResolvedValue({ events: [], latest_seq: 41 });
      h.editor.retry();
      await vi.waitFor(() => expect(h.stream.onEvent).not.toBeNull());

      expect(h.launch).toHaveBeenCalledTimes(2);
      expect(h.tasks.retry).toHaveBeenCalledWith(RUN);
      expect(h.events.streamFrom).toHaveBeenLastCalledWith(41);
      expect(h.state().phase).toBe('launching');

      h.stream.onEvent?.(taskEvent(42, 'task.succeeded'));
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));
      // Try again clears the frame first, so whatever comes back gets a new one.
      expect(published()).toEqual([null, ADDRESS]);
    });

    describe('with the clock held', () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      it('still puts the run back when the read before the wait fails once', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const h = harness();
        h.launch.mockResolvedValue(session('starting', RUN));
        h.tasks.run.mockReturnValue({
          fetch: vi
            .fn()
            .mockResolvedValueOnce(run('failed', 'gave up'))
            .mockRejectedValueOnce(refusal(502))
            .mockResolvedValue(run('failed', 'gave up')),
        });
        h.tasks.retry.mockReturnValue({ fetch: vi.fn().mockResolvedValue(run('queued')) });
        h.open();
        await vi.waitFor(() => expect(h.state().phase).toBe('failed'));

        h.editor.retry();
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.waitFor(() => expect(h.tasks.retry).toHaveBeenCalledWith(RUN));
        expect(h.state().phase).toBe('launching');
      });

      it('falls through to the poll after five unreadable reads, and gives up after five more', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const h = harness();
        h.launch.mockResolvedValue(session('starting', RUN));
        const read = vi.fn().mockResolvedValueOnce(run('failed', 'gave up')).mockRejectedValue(refusal(502));
        h.tasks.run.mockReturnValue({ fetch: read });
        h.open();
        await vi.waitFor(() => expect(h.state().phase).toBe('failed'));

        h.editor.retry();
        // One read at once, four more two seconds apart: nothing is put back on a run nobody could read.
        await vi.advanceTimersByTimeAsync(8_000);
        expect(h.tasks.retry).not.toHaveBeenCalled();
        expect(h.state().phase).toBe('launching');
        expect(read).toHaveBeenCalledTimes(6);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(h.state().failure).toEqual({ kind: 'read' });
        expect(h.events.streamFrom).not.toHaveBeenCalled();
      });
    });

    it('follows the run as it is when somebody else already put it back', async () => {
      const h = harness();
      h.launch.mockResolvedValue(session('starting', RUN));
      h.tasks.run.mockReturnValue({
        fetch: vi
          .fn()
          .mockResolvedValueOnce(run('failed', 'gave up'))
          .mockResolvedValueOnce(run('failed', 'gave up'))
          .mockResolvedValue(run('queued')),
      });
      h.tasks.retry.mockReturnValue({ fetch: vi.fn().mockRejectedValue(refusal(400, 'run run-1 is still queued')) });
      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('failed'));

      h.editor.retry();
      await vi.waitFor(() => expect(h.stream.onEvent).not.toBeNull());
      expect(h.state().phase).toBe('launching');

      h.stream.onEvent?.(taskEvent(3, 'task.succeeded'));
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));
    });
  });

  describe('the fallback reads', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('reads the run every two seconds once the stream cannot answer, and sets no deadline', async () => {
      const h = harness();
      const read = vi.fn().mockResolvedValue(run('running'));
      h.launch.mockResolvedValue(session('starting', RUN));
      h.tasks.run.mockReturnValue({ fetch: read });

      h.open();
      await vi.waitFor(() => expect(h.stream.onComplete).not.toBeNull());
      await vi.advanceTimersByTimeAsync(10_000);
      // While the stream answers, nothing is polled.
      expect(read).toHaveBeenCalledTimes(1);

      h.stream.onComplete?.();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(read).toHaveBeenCalledTimes(3);
      expect(read).toHaveBeenLastCalledWith({ staleTime: 0 });

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(h.state().phase).toBe('launching');

      read.mockResolvedValue(run('succeeded'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.state().phase).toBe('ready');
      expect(published()).toEqual([ADDRESS]);
    });

    it('reads the session record every two seconds where there is no run, three minutes at most', async () => {
      const h = harness();
      const read = vi.fn().mockResolvedValue(session('starting'));
      h.launch.mockResolvedValue(session('starting'));
      h.sessions.session.mockReturnValue({ fetch: read });

      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('launching'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.sessions.session).toHaveBeenCalledWith({ sessionId: 's1' });
      expect(read).toHaveBeenCalledWith({ staleTime: 0 });

      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(h.state().failure).toEqual({ kind: 'timeout' });
      const reads = read.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(reads);
      expect(h.events.streamFrom).not.toHaveBeenCalled();
    });

    it('reads nothing once answered, however late the stream says it is over', async () => {
      const h = harness();
      const read = vi.fn().mockResolvedValue(run('queued'));
      h.launch.mockResolvedValue(session('starting', RUN));
      h.tasks.run.mockReturnValue({ fetch: read });

      h.open();
      await vi.waitFor(() => expect(h.stream.onEvent).not.toBeNull());
      h.stream.onEvent?.(taskEvent(1, 'task.succeeded'));
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

      h.stream.onComplete?.();
      h.stream.onEvent?.(taskEvent(2, 'task.running', RUN, { attempts: 3 }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(read).toHaveBeenCalledTimes(1);
      expect(h.state().phase).toBe('ready');
    });

    it('answers from the record once it says running', async () => {
      const h = harness();
      h.launch.mockResolvedValue(session('starting'));
      h.sessions.session.mockReturnValue({
        fetch: vi.fn().mockResolvedValueOnce(session('starting')).mockResolvedValue(session('running')),
      });

      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('launching'));
      await vi.advanceTimersByTimeAsync(4_000);
      expect(h.state().phase).toBe('ready');
      expect(published()).toEqual([ADDRESS]);
    });
  });

  it.each([
    [
      'sessions are off (503)',
      refusal(503, 'IDE sessions are not available in this deployment'),
      { kind: 'refused', detail: 'IDE sessions are not available in this deployment' },
    ],
    ['the project is out of reach (404)', refusal(404), { kind: 'unavailable' }],
    // The transport's own message is never shown.
    ['the launch fails with nothing said (500)', refusal(500), { kind: 'refused', detail: null }],
  ])('says why when %s', async (_case, error, failure) => {
    const h = harness();
    h.launch.mockRejectedValue(error);

    h.open();
    await vi.waitFor(() => expect(h.state().phase).toBe('failed'));
    expect(h.state().failure).toEqual(failure);
    expect(published()).toEqual([]);
  });

  it('launches nothing when the sources cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness();
    h.accounts.getTenantMetadata.mockReturnValue({ fetch: () => Promise.reject(refusal(500)) });

    h.open();
    await vi.waitFor(() => expect(h.state().phase).toBe('failed'));
    expect(h.state().failure).toEqual({ kind: 'sources' });
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("ends failed as the portal's own error, not the run's, when a dependency throws unexpectedly", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness();
    h.launch.mockResolvedValue(session('starting', RUN));
    h.tasks.run.mockReturnValue({ fetch: vi.fn().mockResolvedValue(run('queued')) });
    h.events.streamFrom.mockImplementation(() => {
      throw new Error('boom');
    });

    h.open();
    await vi.waitFor(() => expect(h.state().phase).toBe('failed'));
    expect(h.state().failure).toEqual({ kind: 'unexpected' });
    expect(error).toHaveBeenCalledWith('[editor-session] launch failed:', expect.objectContaining({ message: 'boom' }));
  });

  it('abandons the launch when the project changes: clears the address, drops the late answer', async () => {
    const h = harness();
    h.launch.mockResolvedValue(session('starting', RUN));
    h.tasks.run.mockReturnValue({ fetch: vi.fn().mockResolvedValue(run('queued')) });
    h.open();
    await vi.waitFor(() => expect(h.stream.onEvent).not.toBeNull());

    h.editor.sync({ projectId: 'p2', orgId: ORG, editor: false, artifact: null });
    expect(published()).toEqual([null]);
    expect(h.state().phase).toBe('idle');
    await vi.waitFor(() => expect(h.disconnect).toHaveBeenCalled());

    h.stream.onEvent?.(taskEvent(5, 'task.succeeded'));
    await settle();
    expect(published()).toEqual([null]);
    expect(h.state().phase).toBe('idle');
  });

  // `materialize` makes many passes per address, and a file switch inside the editor is a new address.
  it('asks once while the editor stays on screen, whatever it shows, and again when it comes back', async () => {
    const h = harness();
    h.launch.mockResolvedValue(session('running'));

    h.open();
    h.open();
    await vi.waitFor(() => expect(h.state().phase).toBe('ready'));
    h.open();
    h.leave();
    h.leave();
    expect(h.launch).toHaveBeenCalledTimes(1);

    h.open();
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(2));
  });

  // The tenant stream carries every run of every gear.
  it("is not answered by another run, or by an event that is not a run's", async () => {
    const h = harness();
    h.launch.mockResolvedValue(session('starting', RUN));
    h.tasks.run.mockReturnValue({ fetch: vi.fn().mockResolvedValue(run('queued')) });
    h.open();
    await vi.waitFor(() => expect(h.stream.onEvent).not.toBeNull());

    h.stream.onEvent?.(taskEvent(1, 'task.succeeded', 'run-2'));
    h.stream.onEvent?.({ ...taskEvent(2, 'workspace.updated'), subject_type: 'workspace' });
    await settle();

    expect(h.state().phase).toBe('launching');
    expect(published()).toEqual([]);
  });

  // AC: a live IDE is launching only until it answers, the first time and coming back.
  it('is launching until the IDE in the frame answers, the first time and coming back', async () => {
    const h = harness();
    h.ide.answers = false;
    h.launch.mockResolvedValue(session('running'));

    h.open();
    await vi.waitFor(() => expect(published()).toEqual([ADDRESS]));
    await settle();
    expect(h.state().phase).toBe('launching');
    h.frames[0]?.answer({ type: 'studio.status', dirty: 0 });
    expect(h.state().phase).toBe('ready');

    // Leaving unmounts the frame; coming back mounts a new one on the address still published.
    h.leave();
    h.unmount();
    h.open();
    h.mount();
    expect(h.state().phase).toBe('launching');
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(2));
    h.frames[1]?.answer({ type: 'studio.status', dirty: 0 });
    await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

    // The reuse publishes the same address again, which makes no third frame.
    expect(published()).toEqual([ADDRESS, ADDRESS]);
    expect(h.frames).toHaveLength(2);
  });

  // The switch can land while the POST is still out.
  it('publishes nothing from a launch answered after the project changed', async () => {
    const h = harness();
    const answer = deferred<ReturnType<typeof session>>();
    h.launch.mockReturnValue(answer.promise);
    h.open();
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalled());

    h.editor.sync({ projectId: 'p2', orgId: ORG, editor: false, artifact: null });
    answer.resolve(session('running'));
    await settle();

    expect(published()).toEqual([null]);
    expect(h.state().phase).toBe('idle');
  });

  it("launches the next project while staying on the editor, and drops the first one's late answer", async () => {
    const h = harness();
    const first = deferred<ReturnType<typeof session>>();
    h.launch.mockReturnValueOnce(first.promise).mockResolvedValue({ ...session('running'), workspace_id: 'p2' });
    h.open();
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(1));

    h.open('p2');
    expect(published()).toEqual([null]);
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(2));
    expect(h.launch).toHaveBeenLastCalledWith({ workspace_id: 'p2', repos: REPOS });

    first.resolve(session('running'));
    await vi.waitFor(() => expect(h.state().phase).toBe('ready'));
    await settle();
    expect(published()).toEqual([null, ADDRESS]);
  });

  describe('coming back to a ready editor', () => {
    it('draws launching and republishes only once the run succeeds when the session has to start again', async () => {
      const h = harness();
      h.launch.mockResolvedValueOnce(session('running')).mockResolvedValue(session('starting', RUN));
      h.tasks.run.mockReturnValue({ fetch: vi.fn().mockResolvedValue(run('queued')) });
      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

      h.leave();
      h.open();
      await vi.waitFor(() => expect(h.stream.onEvent).not.toBeNull());
      expect(h.state().phase).toBe('launching');
      expect(published()).toEqual([ADDRESS]);

      h.stream.onEvent?.(taskEvent(1, 'task.succeeded'));
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));
      expect(published()).toEqual([ADDRESS, ADDRESS]);
    });

    it('ends failed on a refusal and leaves the earlier address alone', async () => {
      const h = harness();
      h.launch.mockResolvedValueOnce(session('running')).mockRejectedValue(refusal(503, 'no room'));
      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

      h.leave();
      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('failed'));

      expect(h.state().failure).toEqual({ kind: 'refused', detail: 'no room' });
      expect(published()).toEqual([ADDRESS]);
    });
  });

  describe('the failure branches', () => {
    it('ends failed when the launch answers a stopped session, and waits on nothing', async () => {
      const h = harness();
      h.launch.mockResolvedValue(session('stopped'));

      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('failed'));

      expect(h.state().failure).toEqual({ kind: 'stopped' });
      expect(h.events.streamFrom).not.toHaveBeenCalled();
      expect(h.sessions.session).not.toHaveBeenCalled();
    });

    it('ends failed when the run handed back is gone (404), before the wait', async () => {
      const h = harness();
      h.launch.mockResolvedValue(session('starting', RUN));
      h.tasks.run.mockReturnValue({ fetch: vi.fn().mockRejectedValue(refusal(404)) });

      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('failed'));

      expect(h.state().failure).toEqual({ kind: 'run', error: null });
      expect(h.events.streamFrom).not.toHaveBeenCalled();
    });

    it('ignores Try again while a launch is in flight', async () => {
      const h = harness();
      const answer = deferred<ReturnType<typeof session>>();
      h.launch.mockReturnValue(answer.promise);
      h.open();
      await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(1));

      h.editor.retry();
      expect(h.launch).toHaveBeenCalledTimes(1);

      answer.resolve(session('running'));
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));
    });

    it('stays failed when the retry is refused and the run is still failed', async () => {
      const h = harness();
      h.launch.mockResolvedValue(session('starting', RUN));
      h.tasks.run.mockReturnValue({ fetch: vi.fn().mockResolvedValue(run('failed', 'gave up')) });
      h.tasks.retry.mockReturnValue({ fetch: vi.fn().mockRejectedValue(refusal(400, 'run run-1 has ended')) });
      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('failed'));

      h.editor.retry();
      await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(h.phases.slice(-2)).toEqual(['launching', 'failed']));

      expect(h.state().failure).toEqual({ kind: 'run', error: 'gave up' });
      expect(h.events.streamFrom).not.toHaveBeenCalled();
    });

    describe('with the clock held', () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      it('reads the run instead of streaming when the one read before the wait fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const h = harness();
        h.launch.mockResolvedValue(session('starting', RUN));
        const read = vi.fn().mockRejectedValueOnce(refusal(500)).mockResolvedValue(run('succeeded'));
        h.tasks.run.mockReturnValue({ fetch: read });

        h.open();
        await vi.waitFor(() => expect(h.state().phase).toBe('launching'));
        await vi.advanceTimersByTimeAsync(2_000);

        expect(h.state().phase).toBe('ready');
        expect(h.events.streamFrom).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
      });

      it('reads the run instead of streaming when the cursor cannot be read', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const h = harness();
        h.events.cursor.fetch.mockRejectedValue(refusal(500));
        h.launch.mockResolvedValue(session('starting', RUN));
        const read = vi.fn().mockResolvedValueOnce(run('running')).mockResolvedValue(run('succeeded'));
        h.tasks.run.mockReturnValue({ fetch: read });

        h.open();
        await vi.waitFor(() => expect(h.state().phase).toBe('launching'));
        await vi.advanceTimersByTimeAsync(2_000);

        expect(h.state().phase).toBe('ready');
        expect(h.events.streamFrom).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith('[editor-session] no event cursor:', expect.any(String));
      });

      it('reads the run when the stream cannot connect', async () => {
        const h = harness();
        h.events.streamFrom.mockImplementation(() => ({
          key: ['/cf/studio-events/v1', 'SSE', '/stream'],
          connect: () => Promise.reject(new Error('no stream')),
          disconnect: h.disconnect,
        }));
        h.launch.mockResolvedValue(session('starting', RUN));
        const read = vi.fn().mockResolvedValueOnce(run('running')).mockResolvedValue(run('succeeded'));
        h.tasks.run.mockReturnValue({ fetch: read });

        h.open();
        await vi.waitFor(() => expect(h.state().phase).toBe('launching'));
        await vi.advanceTimersByTimeAsync(2_000);

        expect(h.state().phase).toBe('ready');
        expect(read).toHaveBeenCalledTimes(2);
      });

      it('ends failed when the run disappears while it is read', async () => {
        const h = harness();
        h.launch.mockResolvedValue(session('starting', RUN));
        h.tasks.run.mockReturnValue({
          fetch: vi.fn().mockResolvedValueOnce(run('running')).mockRejectedValue(refusal(404)),
        });

        h.open();
        await vi.waitFor(() => expect(h.stream.onComplete).not.toBeNull());
        h.stream.onComplete?.();
        await vi.advanceTimersByTimeAsync(2_000);

        expect(h.state().failure).toEqual({ kind: 'run', error: null });
      });

      it('gives up on a run it cannot read five times in a row, saying so once', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const h = harness();
        h.launch.mockResolvedValue(session('starting', RUN));
        const read = vi.fn().mockResolvedValueOnce(run('running')).mockRejectedValue(refusal(503));
        h.tasks.run.mockReturnValue({ fetch: read });

        h.open();
        await vi.waitFor(() => expect(h.stream.onComplete).not.toBeNull());
        h.stream.onComplete?.();
        await vi.advanceTimersByTimeAsync(8_000);
        expect(h.state().phase).toBe('launching');

        await vi.advanceTimersByTimeAsync(2_000);
        expect(h.state().failure).toEqual({ kind: 'read' });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('[editor-session] run unreadable:', expect.any(String));

        const reads = read.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(read).toHaveBeenCalledTimes(reads);
      });

      it.each([
        ['says stopped', vi.fn().mockResolvedValue(session('stopped'))],
        ['is gone (404)', vi.fn().mockRejectedValue(refusal(404))],
      ])('ends failed when the record, with no run to follow, %s', async (_case, read) => {
        const h = harness();
        h.launch.mockResolvedValue(session('starting'));
        h.sessions.session.mockReturnValue({ fetch: read });

        h.open();
        await vi.waitFor(() => expect(h.state().phase).toBe('launching'));
        await vi.advanceTimersByTimeAsync(2_000);

        expect(h.state().failure).toEqual({ kind: 'stopped' });
      });

      it('gives up on a record it cannot read five times in a row, before the three minutes', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const h = harness();
        h.launch.mockResolvedValue(session('starting'));
        h.sessions.session.mockReturnValue({ fetch: vi.fn().mockRejectedValue(refusal(500)) });

        h.open();
        await vi.waitFor(() => expect(h.state().phase).toBe('launching'));
        await vi.advanceTimersByTimeAsync(10_000);

        expect(h.state().failure).toEqual({ kind: 'read' });
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('the IDE in the frame', () => {
    const answered = (h: ReturnType<typeof harness>, index = 0): void =>
      h.frames[index]?.answer({ type: 'studio.status', dirty: 0 });

    it('is told the theme, the token, the project and who is at the keyboard', async () => {
      const h = harness();
      h.launch.mockResolvedValue(session('running'));

      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

      expect(h.frames[0]?.sent()[0]).toEqual({
        type: 'studio.init',
        theme: 'light',
        workspaceId: PROJECT,
        apiToken: 'T1',
        viewer: VIEWER,
        workspaceName: 'Web',
      });
    });

    it.each([
      [DEFAULT_THEME_ID, 'light'],
      [LIGHT_THEME_ID, 'light'],
      [DARK_THEME_ID, 'dark'],
      [DRACULA_THEME_ID, 'dark'],
      [DRACULA_LARGE_THEME_ID, 'dark'],
    ])('shows the portal theme %s as %s', async (portal, editor) => {
      const h = harness();
      h.launch.mockResolvedValue(session('running'));
      h.setTheme(portal);

      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

      expect(h.frames[0]?.sent()[0]).toMatchObject({ type: 'studio.init', theme: editor });
    });

    it('says only what it knows: no viewer without a profile, no name for an unnamed project, no token but a bearer one', async () => {
      const h = harness({ profile: null, projectName: '' });
      h.getSession.mockResolvedValue({ kind: 'cookie' });
      h.launch.mockResolvedValue(session('running'));

      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));
      h.authEvent({ state: 'authenticated', session: { kind: 'cookie' } });

      expect(h.frames[0]?.sent()[0]).toEqual({ type: 'studio.init', theme: 'light', workspaceId: PROJECT });
      expect(h.frames[0]?.types()).not.toContain('studio.token');
    });

    it('says so when the session cannot be read, and starts the IDE without a token', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const h = harness();
      h.getSession.mockRejectedValue(new Error('IdP unreachable'));
      h.launch.mockResolvedValue(session('running'));

      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

      expect(h.frames[0]?.sent()[0]).not.toHaveProperty('apiToken');
      expect(warn).toHaveBeenCalledWith('[editor-session] no session for the editor:', 'IdP unreachable');
      warn.mockRestore();
    });

    it('takes no token from a read that a renewal has overtaken', async () => {
      const h = harness();
      const read = deferred<AuthSession | null>();
      h.getSession.mockReturnValue(read.promise);
      h.launch.mockResolvedValue(session('running'));
      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

      h.renewToken('T2');
      read.resolve({ kind: 'bearer', token: 'T1' });
      await settle();
      h.frames[0]?.load();

      expect(h.frames[0]?.sent().map((message) => message.apiToken).filter(Boolean)).toEqual(['T2', 'T2']);
    });

    it('takes no token from the read of a frame that has gone', async () => {
      const h = harness();
      const first = deferred<AuthSession | null>();
      h.getSession.mockReturnValueOnce(first.promise).mockResolvedValue({ kind: 'bearer', token: 'T2' });
      h.launch.mockResolvedValue(session('running'));
      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

      h.editor.retry();
      await vi.waitFor(() => expect(h.frames).toHaveLength(2));
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));
      first.resolve({ kind: 'bearer', token: 'T1' });
      await settle();
      h.frames[1]?.load();

      const tokens = h.frames[1]?.sent().map((message) => message.apiToken).filter(Boolean);
      expect(tokens).not.toContain('T1');
      expect(tokens?.slice(-1)).toEqual(['T2']);
    });

    it('is told by the newest frame only, and the older one going leaves the newer in charge', async () => {
      const h = harness();
      h.ide.answers = false;
      h.launch.mockResolvedValue(session('running'));
      h.open();
      await vi.waitFor(() => expect(published()).toEqual([ADDRESS]));
      await settle();

      // Another container's frame for the same entry, while the first is still up.
      const newer = stubFrame(ADDRESS, () => false);
      h.editor.frame(newer.frame, entry(EDITOR_FRAME_ENTRY));
      newer.load();
      h.frames[0]?.answer({ type: 'studio.status', dirty: 0 });
      expect(h.state().phase).toBe('launching');
      newer.answer({ type: 'studio.status', dirty: 0 });
      expect(h.state().phase).toBe('ready');

      h.unmount();
      h.open(PROJECT, { ...FILE, artifactId: 'a2', path: 'README.md' });

      expect(h.state().phase).toBe('ready');
      expect(newer.sent()).toContainEqual({ type: 'studio.openInEditor', path: 'web/README.md' });
    });

    it("does not open the last project's file in the next project's IDE", async () => {
      const h = harness();
      h.launch.mockResolvedValue(session('running'));
      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

      h.open('p2', null);
      await vi.waitFor(() => expect(h.frames).toHaveLength(2));
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

      expect(h.frames[1]?.sent()[0]).toMatchObject({ type: 'studio.init', workspaceId: 'p2' });
      expect(h.frames[1]?.types()).not.toContain('studio.openInEditor');
    });

    it('is told a renewed token with the viewer, and the portal theme when it changes', async () => {
      const h = harness();
      h.launch.mockResolvedValue(session('running'));
      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

      h.renewToken('T2');
      h.setTheme('dracula');

      expect(h.frames[0]?.sent().slice(-2)).toEqual([
        { type: 'studio.token', apiToken: 'T2', viewer: VIEWER, workspaceName: 'Web' },
        { type: 'studio.theme', theme: 'dark' },
      ]);
    });

    it('opens the file in its checkout directory, once, and again when the editor shows another', async () => {
      const h = harness();
      h.launch.mockResolvedValue(session('running'));
      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));
      const opens = (): unknown[] =>
        (h.frames[0]?.sent() ?? []).filter((message) => message.type === 'studio.openInEditor');
      expect(opens()).toEqual([{ type: 'studio.openInEditor', path: 'web/src/main.ts' }]);

      h.open(PROJECT, { ...FILE });
      expect(opens()).toHaveLength(1);

      h.open(PROJECT, { ...FILE, artifactId: 'a2', path: 'README.md' });
      h.open(PROJECT, { ...FILE, artifactId: 'i1', kind: 'issue', path: '' });
      expect(opens()).toEqual([
        { type: 'studio.openInEditor', path: 'web/src/main.ts' },
        { type: 'studio.openInEditor', path: 'web/README.md' },
      ]);
    });

    it('opens a file of a repository the project does not list by its path alone', async () => {
      const h = harness();
      h.launch.mockResolvedValue(session('running'));

      h.open(PROJECT, { ...FILE, repository: 'acme/elsewhere' });
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

      expect(h.frames[0]?.sent()).toContainEqual({ type: 'studio.openInEditor', path: 'src/main.ts' });
    });

    it("says the catalogue is not in the portal when the IDE asks for a component's page", async () => {
      const h = harness();
      h.launch.mockResolvedValue(session('running'));
      h.open();
      await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

      h.frames[0]?.answer({ type: 'studio.openComponent', name: 'cf-gears-api-gateway' });

      expect(toastInfo).toHaveBeenCalledWith('shell:editor_component_unavailable');
    });

    it("attaches to the entry space-mfe declares", () => {
      const manifest = join(dirname(fileURLToPath(import.meta.url)), '../../mfe_packages/space-mfe/mfe.json');
      const { entries } = JSON.parse(readFileSync(manifest, 'utf-8')) as { entries: { id: string }[] };

      expect(entries.map((declared) => declared.id)).toContain(EDITOR_FRAME_ENTRY);
    });

    it("attaches to the editor's frame only", () => {
      const h = harness();
      const other = stubFrame(ADDRESS, () => h.ide.answers);

      expect(h.editor.frame(other.frame, entry('gts.frontx.mfes.mfe.entry.v1~acme.fixture.v1'))).toBeUndefined();
      other.load();
      expect(other.sent()).toEqual([]);
    });

    describe('with the clock held', () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      it('fails as unanswered two minutes after the address, and a late answer still opens the editor', async () => {
        const h = harness();
        h.ide.answers = false;
        h.launch.mockResolvedValue(session('running'));
        h.open();
        await vi.waitFor(() => expect(published()).toEqual([ADDRESS]));

        await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS - 1_000);
        expect(h.state().phase).toBe('launching');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.state().failure).toEqual({ kind: 'unanswered' });

        answered(h);
        expect(h.state().phase).toBe('ready');
      });

      it('does not call a session unanswered while its launch is still out', async () => {
        const h = harness();
        h.ide.answers = false;
        h.launch.mockResolvedValue(session('running'));
        h.open();
        await vi.waitFor(() => expect(published()).toEqual([ADDRESS]));
        answered(h);

        // Coming back while the session has to start again: the old address mounts at once.
        const relaunch = deferred<ReturnType<typeof session>>();
        h.launch.mockReturnValue(relaunch.promise);
        h.leave();
        h.unmount();
        h.open();
        h.mount();
        await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS * 2);
        expect(h.state().phase).toBe('launching');

        relaunch.resolve(session('running'));
        await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS);
        expect(h.state().failure).toEqual({ kind: 'unanswered' });
      });

      it('sets no deadline for a launch that ends after the member left, and waits again on the way back', async () => {
        const h = harness();
        h.ide.answers = false;
        const first = deferred<ReturnType<typeof session>>();
        h.launch.mockReturnValueOnce(first.promise).mockResolvedValue(session('running'));
        h.open();
        await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(1));

        h.leave();
        h.unmount();
        first.resolve(session('running'));
        await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS * 2);
        expect(published()).toEqual([ADDRESS]);
        expect(h.state().phase).toBe('launching');

        h.open();
        h.mount();
        await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS);
        expect(h.state().failure).toEqual({ kind: 'unanswered' });
      });

      it('is launching again while the IDE reloads, and unanswered if it never comes back', async () => {
        const h = harness();
        h.launch.mockResolvedValue(session('running'));
        h.open();
        await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

        h.ide.answers = false;
        h.frames[0]?.load();
        expect(h.state().phase).toBe('launching');

        await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS);
        expect(h.state().failure).toEqual({ kind: 'unanswered' });
      });

      it('gives Try again a new frame', async () => {
        const h = harness();
        h.ide.answers = false;
        h.launch.mockResolvedValue(session('running'));
        h.open();
        await vi.waitFor(() => expect(published()).toEqual([ADDRESS]));
        await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS);
        expect(h.state().failure).toEqual({ kind: 'unanswered' });

        h.ide.answers = true;
        h.editor.retry();
        await vi.waitFor(() => expect(h.state().phase).toBe('ready'));

        expect(published()).toEqual([ADDRESS, null, ADDRESS]);
        expect(h.frames).toHaveLength(2);
      });
    });
  });
});
