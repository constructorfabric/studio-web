// @cpt-flow:cpt-studiofrontend-flow-editor-session-open:p1
// @cpt-flow:cpt-studiofrontend-flow-editor-session-retry:p1
// @cpt-algo:cpt-studiofrontend-algo-editor-session-launch:p1
// @cpt-algo:cpt-studiofrontend-algo-editor-session-wait:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-session-reuse-or-launch:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-session-ready:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-session-retry:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-session-switch:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-session-address:p1
// @cpt-flow:cpt-studiofrontend-flow-editor-bridge-open:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-bridge-answer:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-bridge-init:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-bridge-theme:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-bridge-file:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-bridge-component:p1

import { apiRegistry, type AuthSession, type FrontXApp } from '@gears-frontx/react';
import { toast } from 'sonner';
import {
  AccountsApiService,
  ConnectorsApiService,
  PROJECT_CONFIG_TYPE,
  checkoutDirectory,
  errorMessage,
  isNotFound,
  parseProblemDetails,
  sessionSources,
  type ProjectConfig,
  type ProjectSource,
  type SessionSource,
  type StudioArtifact,
} from '@constructor-studio/mfe-shared';
import {
  StudioEventsApiService,
  StudioSessionApiService,
  StudioTasksApiService,
  type StudioRun,
  type StudioRunEvent,
  type StudioRunState,
  type StudioSession,
} from '@/app/api';
import { connectEditorBridge, type EditorMessage, type EditorTheme } from '@/app/mfe/editorBridge';
import type { FrameHook } from '@/app/mfe/MfeHandlerIframe';
import { publishFrameUrl } from '@/app/mfe/sharedContext';
import { readAppContext } from '@/app/slices/appContextSlice';
import { readSessionProfile } from '@/app/slices/appSessionSlice';
import { DEFAULT_THEME_ID } from '@/app/themes/default';
import { LIGHT_THEME_ID } from '@/app/themes/light';
import {
  editorSessionFailed,
  editorSessionLaunching,
  editorSessionReady,
  editorSessionReset,
  editorSessionShown,
  readEditorSession,
  type EditorSessionFailure,
} from '@/app/slices/editorSessionSlice';

const POLL_INTERVAL_MS = 2_000;
const RECORD_DEADLINE_MS = 3 * 60_000;
/** Consecutive reads of the run or the record that may fail (not 404) before the wait ends: ten seconds of 401, 403 or 5xx. */
const MAX_READ_FAILURES = 5;
/**
 * How long the IDE in the frame may stay silent once the session is up. The
 * backend calls a session ready when its gate takes a connection, which is
 * before Theia is serving: a new session can show the gate's splash for tens
 * of seconds before the IDE loads and answers.
 */
const ANSWER_DEADLINE_MS = 2 * 60_000;

/** `space-mfe`'s entry (`src-app/mfe_packages/space-mfe/mfe.json`, checked by the tests): the one frame the editor's bridge attaches to. */
export const EDITOR_FRAME_ENTRY =
  'gts.frontx.mfes.mfe.entry.v1~constructor_studio.mfes.mfe.entry_iframe.v1~constructor_studio.space.mfe.main.v1';

/** The portal's light themes; the IDE has one light theme, and every other portal theme is dark there. */
const LIGHT_THEMES: ReadonlySet<string> = new Set([DEFAULT_THEME_ID, LIGHT_THEME_ID]);

export interface EditorScope {
  projectId: string | null;
  orgId: string | null;
  editor: boolean;
  /** What the editor shows; only a file is told to the IDE. */
  artifact: StudioArtifact | null;
}

export interface EditorSession {
  sync(scope: EditorScope): void;
  retry(): void;
  /** `MfeHandlerIframe`'s `onFrame`: attaches the bridge to the editor's frame. */
  frame: FrameHook;
}

type Outcome = { ready: true } | { ready: false; failure: EditorSessionFailure };
type Launched = { ready: true; url: string } | { ready: false; failure: EditorSessionFailure };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function runOutcome(state: StudioRunState, error: string | null | undefined): Outcome | null {
  if (state === 'succeeded') return { ready: true };
  if (state === 'failed' || state === 'cancelled') {
    return { ready: false, failure: { kind: 'run', error: error ?? null } };
  }
  return null;
}

const RUN_GONE: Outcome = { ready: false, failure: { kind: 'run', error: null } };
const UNREADABLE: Outcome = { ready: false, failure: { kind: 'read' } };

function endOf(read: StudioRun | 'gone' | null): Outcome | null {
  if (read === 'gone') return RUN_GONE;
  return read ? runOutcome(read.state, read.last_error) : null;
}


function launchRefusal(error: unknown): EditorSessionFailure {
  return isNotFound(error)
    ? { kind: 'unavailable' }
    : { kind: 'refused', detail: parseProblemDetails(error).detail };
}

export function createEditorSession(app: FrontXApp): EditorSession {
  const dispatch = app.store.dispatch;
  const events = () => apiRegistry.getService(StudioEventsApiService);
  const sessions = () => apiRegistry.getService(StudioSessionApiService);
  const tasks = () => apiRegistry.getService(StudioTasksApiService);

  let project: string | null = null;
  let org: string | null = null;
  /** The editor is on screen and its session was asked for; a file switch inside it asks nothing. */
  let entered = false;
  let generation = 0;
  let inFlight = false;
  /** Ends the wait in flight at once, closing its stream. */
  let stopWait: (() => void) | null = null;
  /** The project's sources as last read: where each repository is checked out. */
  let projectSources: readonly ProjectSource[] = [];
  /** The file the editor shows, told to the IDE when it changes and to every new frame. */
  let file: StudioArtifact | null = null;
  /** The bridge to the editor's frame, and whether the IDE in it has answered. */
  let bridge: ReturnType<typeof connectEditorBridge> | null = null;
  let answered = false;
  let answerTimer: ReturnType<typeof setTimeout> | undefined;
  let token: string | undefined;

  const readCursor = async (): Promise<number | null> => {
    try {
      return (await events().cursor.fetch({ staleTime: 0 })).latest_seq;
    } catch (error) {
      console.warn('[editor-session] no event cursor:', errorMessage(error));
      return null;
    }
  };

  /** `gone` for a 404; `null` for any other failure, its message kept for the one log line. */
  let lastReadError: string | null = null;
  const readRun = async (runId: string): Promise<StudioRun | 'gone' | null> => {
    try {
      return await tasks().run({ runId }).fetch({ staleTime: 0 });
    } catch (error) {
      if (isNotFound(error)) return 'gone';
      lastReadError = errorMessage(error);
      return null;
    }
  };

  const readSources = async (
    projectId: string,
    orgId: string
  ): Promise<{ repos: SessionSource[]; sources: readonly ProjectSource[] }> => {
    const [config, connections] = await Promise.all([
      apiRegistry
        .getService(AccountsApiService)
        .getTenantMetadata<ProjectConfig>({ tenantId: projectId, metadataType: PROJECT_CONFIG_TYPE })
        .fetch(),
      apiRegistry.getService(ConnectorsApiService).connections({ tenantId: orgId }).fetch(),
    ]);
    const sources = config?.value?.sources ?? [];
    return { repos: sessionSources(sources, connections.items), sources };
  };

  /** The run on the stream from `cursor`; read every two seconds when the stream cannot answer */
  const waitForRun = (runId: string, cursor: number | null, superseded: () => boolean): Promise<Outcome | null> =>
    new Promise((resolve) => {
      const stream = cursor === null ? null : events().streamFrom(cursor);
      let connection: Promise<string> | null = null;
      let settled = false;
      let polling = false;
      const settle = (outcome: Outcome | null): void => {
        if (settled) return;
        settled = true;
        if (stopWait === stop) stopWait = null;
        if (stream && connection) void connection.then((id) => stream.disconnect(id), () => undefined);
        resolve(outcome);
      };
      const stop = (): void => settle(null);
      stopWait = stop;

      const answer = (state: StudioRunState, error: string | null | undefined): void => {
        // A late event or read, after the answer or a switch, is nobody's.
        if (settled) return;
        if (superseded()) return settle(null);
        const outcome = runOutcome(state, error);
        if (outcome) settle(outcome);
      };

      const poll = async (): Promise<void> => {
        if (polling) return;
        polling = true;
        let failures = 0;
        while (!settled) {
          await sleep(POLL_INTERVAL_MS);
          if (settled) return;
          const run = await readRun(runId);
          if (run === 'gone') settle(RUN_GONE);
          else if (run) {
            failures = 0;
            answer(run.state, run.last_error);
          } else {
            // Not a deadline on the run: reads that keep failing would otherwise spin here unseen.
            failures += 1;
            if (failures === 1) console.warn('[editor-session] run unreadable:', lastReadError);
            if (failures >= MAX_READ_FAILURES) settle(UNREADABLE);
          }
        }
      };

      if (!stream) {
        void poll();
        return;
      }
      connection = stream.connect(
        (event) => {
          if (!event.kind.startsWith('task.') || event.subject_id !== runId) return;
          const run = event.payload as StudioRunEvent;
          answer(run.state, run.error);
        },
        () => void poll()
      );
      connection.catch(() => void poll());
    });

  const waitForRecord = async (sessionId: string, superseded: () => boolean): Promise<Outcome | null> => {
    const deadline = Date.now() + RECORD_DEADLINE_MS;
    let failures = 0;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (superseded()) return null;
      try {
        // The read itself probes the container.
        const record = await sessions().session({ sessionId }).fetch({ staleTime: 0 });
        failures = 0;
        if (record.state === 'running') return { ready: true };
        if (record.state === 'stopped') return { ready: false, failure: { kind: 'stopped' } };
      } catch (error) {
        if (isNotFound(error)) return { ready: false, failure: { kind: 'stopped' } };
        failures += 1;
        if (failures === 1) console.warn('[editor-session] session record unreadable:', errorMessage(error));
        if (failures >= MAX_READ_FAILURES) return UNREADABLE;
      }
    }
    return { ready: false, failure: { kind: 'timeout' } };
  };

  const followRun = async (
    runId: string,
    cursor: number | null,
    retrying: boolean,
    superseded: () => boolean
  ): Promise<Outcome | null> => {
    let read = await readRun(runId);
    if (read === null) console.warn('[editor-session] run unreadable before the wait:', lastReadError);
    // Try again needs this read: a run that ended is put back on the queue here, and the poll below would only report it.
    for (let failures = 1; read === null && retrying && failures < MAX_READ_FAILURES; failures += 1) {
      await sleep(POLL_INTERVAL_MS);
      if (superseded()) return null;
      read = await readRun(runId);
    }
    if (superseded()) return null;
    // Unreadable is not "not ended yet": the run may have ended before the cursor, and the stream would never say. Poll.
    if (read === null) return waitForRun(runId, null, superseded);
    const ended = endOf(read);
    if (!ended) return waitForRun(runId, cursor, superseded);
    if (ended.ready || !retrying || ended === RUN_GONE) return ended;

    const from = await readCursor();
    if (superseded()) return null;
    try {
      await tasks().retry(runId).fetch(undefined);
    } catch {
      // Refused: somebody else put it back, or it ended meanwhile. The run says which.
      const now = await readRun(runId);
      if (superseded()) return null;
      const answered = now === null ? ended : endOf(now);
      if (answered) return answered;
    }
    if (superseded()) return null;
    return waitForRun(runId, from, superseded);
  };

  const reuseOrLaunch = async (
    projectId: string,
    orgId: string,
    retrying: boolean,
    superseded: () => boolean
  ): Promise<Launched | null> => {
    const cursor = await readCursor();
    let read: Awaited<ReturnType<typeof readSources>>;
    try {
      read = await readSources(projectId, orgId);
    } catch (error) {
      // A session launched without its sources would be reused as it is.
      console.warn('[editor-session] sources unreadable:', errorMessage(error));
      return { ready: false, failure: { kind: 'sources' } };
    }
    if (superseded()) return null;
    projectSources = read.sources;

    let session: StudioSession;
    try {
      // @cpt-dod:cpt-studiofrontend-dod-editor-session-per-project:p1
      // The session is the project's (backend, 2026-09-29): its tenant id is the workspace id.
      session = await sessions().launch.fetch({ workspace_id: projectId, repos: read.repos });
    } catch (error) {
      return { ready: false, failure: launchRefusal(error) };
    }
    if (superseded()) return null;

    const { url } = session;
    if (session.state === 'running') return { ready: true, url };
    if (session.state !== 'starting') return { ready: false, failure: { kind: 'stopped' } };
    dispatch(editorSessionLaunching());
    const waited = session.ready_run_id
      ? await followRun(session.ready_run_id, cursor, retrying, superseded)
      : await waitForRecord(session.id, superseded);
    if (!waited) return null;
    return waited.ready ? { ready: true, url } : waited;
  };

  const launch = async (projectId: string, orgId: string, retrying: boolean): Promise<void> => {
    if (!apiRegistry.has(StudioSessionApiService)) return;
    generation += 1;
    const mine = generation;
    const superseded = (): boolean => generation !== mine;
    inFlight = true;
    // Drawn at once only when somebody is waiting on an answer; otherwise from the address on, until the IDE answers.
    if (retrying || readEditorSession(app).phase === 'failed') dispatch(editorSessionLaunching());
    try {
      const outcome = await reuseOrLaunch(projectId, orgId, retrying, superseded);
      if (!outcome || superseded()) return;
      if (outcome.ready) {
        publishFrameUrl(app, outcome.url);
        // Up for the backend; ready once the IDE in the frame says so.
        awaitAnswer();
      } else {
        clearAnswerTimer();
        dispatch(editorSessionFailed(outcome.failure));
      }
    } catch (error) {
      // The portal's own fault — a bug, a malformed answer — not the backend giving up.
      console.error('[editor-session] launch failed:', error);
      if (!superseded()) {
        clearAnswerTimer();
        dispatch(editorSessionFailed({ kind: 'unexpected' }));
      }
    } finally {
      if (!superseded()) inFlight = false;
    }
  };

  const clearAnswerTimer = (): void => clearTimeout(answerTimer);

  const armAnswerTimer = (): void => {
    clearAnswerTimer();
    answerTimer = setTimeout(() => {
      // A launch in flight speaks for itself, and waits again once it publishes.
      if (answered || inFlight) return;
      dispatch(editorSessionFailed({ kind: 'unanswered' }));
    }, ANSWER_DEADLINE_MS);
  };

  // @cpt-begin:cpt-studiofrontend-flow-editor-bridge-open:p1:inst-3
  /** Launching until the IDE in the frame answers; the bridge keeps asking, so a late answer still wins. */
  const awaitAnswer = (): void => {
    if (answered) {
      dispatch(editorSessionReady());
      return;
    }
    dispatch(editorSessionLaunching());
    // Nobody waits on a hidden editor: coming back mounts a frame, and the frame arms its own.
    if (readEditorSession(app).shown) armAnswerTimer();
  };
  // @cpt-end:cpt-studiofrontend-flow-editor-bridge-open:p1:inst-3

  const abandon = (): void => {
    generation += 1;
    inFlight = false;
    stopWait?.();
    clearAnswerTimer();
  };

  /** Without its directory the IDE looks in every root and one level below, and the first match wins. */
  const openMessage = (artifact: StudioArtifact): EditorMessage => {
    const directory = checkoutDirectory(projectSources, artifact.repository);
    return { type: 'studio.openInEditor', path: directory ? `${directory}/${artifact.path}` : artifact.path };
  };

  // @cpt-begin:cpt-studiofrontend-flow-editor-bridge-open:p1:inst-5
  const showFile = (artifact: StudioArtifact | null): void => {
    const next = artifact?.kind === 'file' && artifact.path ? artifact : null;
    if (next?.repository === file?.repository && next?.path === file?.path) return;
    file = next;
    if (next) bridge?.post(openMessage(next));
  };
  // @cpt-end:cpt-studiofrontend-flow-editor-bridge-open:p1:inst-5

  /**
   * Who the IDE is working for, and what to call the workspace: an empty name
   * would rename it "workspace". Read when a message goes out: the profile is
   * in the store long before an IDE answers (bootstrap reads it), and one that
   * came later would reach the IDE with the next token.
   */
  const person = () => {
    const profile = readSessionProfile(app);
    return {
      viewer: profile ? { sub: profile.id, name: profile.displayName, email: profile.email, kind: 'person' as const } : undefined,
      workspaceName: readAppContext(app).project?.name || undefined,
    };
  };

  const theme = (): EditorTheme => (LIGHT_THEMES.has(app.themeRegistry.getCurrent()?.id ?? '') ? 'light' : 'dark');

  const adoptToken = (session: AuthSession | null | undefined): void => {
    const next = session?.kind === 'bearer' ? session.token : undefined;
    if (next === token) return;
    token = next;
    // With the viewer, always: a token without one makes the IDE forget who is at the keyboard.
    // A session that ends is not told: the bridge has no message that takes a token back, and the
    // sign-in screen that follows replaces the shell, the frame with it.
    if (next) bridge?.post({ type: 'studio.token', apiToken: next, ...person() });
  };

  // @cpt-begin:cpt-studiofrontend-flow-editor-bridge-open:p1:inst-4
  const frame: FrameHook = (element, entry) => {
    if (entry.id !== EDITOR_FRAME_ENTRY) return undefined;
    bridge?.dispose();
    answered = false;
    const mine = connectEditorBridge(element, {
      init: () => ({
        theme: theme(),
        workspaceId: project ?? '',
        ...(token ? { apiToken: token } : {}),
        ...person(),
      }),
      // A disposed bridge reports nothing, so these come from the current frame only.
      onAnswer: () => {
        answered = true;
        clearAnswerTimer();
        dispatch(editorSessionReady());
      },
      onReload: () => {
        answered = false;
        dispatch(editorSessionLaunching());
        armAnswerTimer();
      },
      onOpenComponent: () => {
        // TODO(#583): open the component's page once the portal has one.
        toast.info(app.i18nRegistry.t('shell:editor_component_unavailable'));
      },
    });
    bridge = mine;
    if (file) mine.post(openMessage(file));
    const unsubscribeTheme = app.themeRegistry.subscribe(() => mine.post({ type: 'studio.theme', theme: theme() }));
    // Every renewal; the read only until one is heard, and only for this frame.
    let heard = false;
    const unsubscribeAuth = app.auth?.subscribe?.((event) => {
      heard = true;
      adoptToken(event.state === 'authenticated' ? event.session : null);
    });
    void app.auth?.getSession().then(
      (session) => {
        if (!heard && bridge === mine) adoptToken(session);
      },
      (error: unknown) => console.warn('[editor-session] no session for the editor:', errorMessage(error))
    );
    // A frame that has just been made has not answered yet.
    dispatch(editorSessionLaunching());
    armAnswerTimer();

    return () => {
      unsubscribeTheme();
      unsubscribeAuth?.();
      mine.dispose();
      if (bridge !== mine) return;
      bridge = null;
      answered = false;
      clearAnswerTimer();
    };
  };
  // @cpt-end:cpt-studiofrontend-flow-editor-bridge-open:p1:inst-4

  const sync = ({ projectId, orgId, editor, artifact }: EditorScope): void => {
    if (projectId !== project) {
      if (project !== null) publishFrameUrl(app, null);
      abandon();
      project = projectId;
      entered = false;
      dispatch(editorSessionReset());
    }
    org = orgId;
    const shown = editor && projectId !== null;
    if (readEditorSession(app).shown !== shown) dispatch(editorSessionShown(shown));
    if (!shown) {
      entered = false;
      return;
    }
    showFile(artifact);
    if (entered || !projectId || !orgId) return;
    entered = true;
    if (!inFlight) void launch(projectId, orgId, false);
  };

  const retry = (): void => {
    if (!project || !org || inFlight) return;
    // A new frame for whatever comes back: the one that failed may hold an IDE that never answered.
    publishFrameUrl(app, null);
    void launch(project, org, true);
  };

  return { sync, retry, frame };
}
