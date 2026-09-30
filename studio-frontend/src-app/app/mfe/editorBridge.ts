// @cpt-algo:cpt-studiofrontend-algo-editor-bridge-handshake:p1
// @cpt-state:cpt-studiofrontend-state-editor-bridge:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-bridge-handshake:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-bridge-sender:p1
// @cpt-dod:cpt-studiofrontend-dod-editor-bridge-theme:p1
/**
 * The portal's half of the editor's `postMessage` channel
 * (docs/theia-bridge-contract-v1.md §6, docs/feature/editor-bridge.md).
 *
 * It knows one frame and the messages, and nothing of the shell: what to say
 * is handed in by whoever attaches it (effects/editorSessionEffects.ts), so it
 * can move into the frame handler unchanged. It reads no `location` either:
 * the frame is another realm, and its origin is the one of its own `src`.
 */

export type EditorTheme = 'light' | 'dark';

/** Who is at the keyboard, as the IDE's `PortalViewer` takes it. */
export interface EditorViewer {
  sub: string;
  name?: string;
  email?: string;
  kind: 'person';
}

/** `studio.init`, read afresh for every repeat so a late one carries what is current. */
export interface EditorInit {
  theme: EditorTheme;
  workspaceId: string;
  apiToken?: string;
  workspaceName?: string;
  viewer?: EditorViewer;
}

/**
 * Everything else the portal says. `studio.token` goes with `viewer`: the IDE
 * takes the viewer from every message that carries a token, and one without
 * it makes the IDE forget who is at the keyboard.
 */
export type EditorMessage =
  | { type: 'studio.theme'; theme: EditorTheme }
  | { type: 'studio.token'; apiToken: string; viewer?: EditorViewer; workspaceName?: string }
  | { type: 'studio.openInEditor'; path: string };

export interface EditorBridgeOptions {
  init: () => EditorInit;
  /** The IDE answered: once for each document the frame loads. */
  onAnswer: () => void;
  /** The frame loaded again after an answer; its new document has not answered yet. */
  onReload: () => void;
  /** The IDE asks for a component's page (`studio.openComponent`). */
  onOpenComponent: (name: string) => void;
}

/**
 * How often `studio.init` goes out until it is answered. The IDE listens only
 * once its session has answered over the websocket and drops what came
 * before, and until the IDE binds its port the frame shows the gate's splash.
 */
export const INIT_REPEAT_MS = 2_000;

/** The portal's light themes (`src-app/app/themes/`); the IDE takes anything but `'light'` as dark. */
export function editorTheme(portalThemeId: string | undefined): EditorTheme {
  return portalThemeId === 'default' || portalThemeId === 'light' ? 'light' : 'dark';
}

export function connectEditorBridge(frame: HTMLIFrameElement, options: EditorBridgeOptions) {
  const portal = frame.ownerDocument.defaultView;
  // Every document the frame shows is on its address's origin: the gate
  // redirects relatively, and serves its splash at the same address.
  const origin = new URL(frame.src).origin;
  const waiting = new Map<EditorMessage['type'], EditorMessage>();
  let answered = false;
  let repeat: ReturnType<typeof setInterval> | undefined;

  // Never `*`: the init carries the member's token.
  const send = (message: object): void => frame.contentWindow?.postMessage(message, origin);
  const sendInit = (): void => send({ type: 'studio.init', ...options.init() });

  const onLoad = (): void => {
    // A new document whose bridge has not answered: the gate's splash, the
    // IDE, or the IDE again after a reload. What it was told before is not
    // told again — a reloaded IDE restores its own layout.
    if (answered) {
      answered = false;
      options.onReload();
    }
    clearInterval(repeat);
    // Armed first: an answer to this very init stops it.
    repeat = setInterval(sendInit, INIT_REPEAT_MS);
    sendInit();
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow || event.origin !== origin) return;
    const { type, name } = (event.data ?? {}) as { type?: unknown; name?: unknown };
    if (typeof type !== 'string' || !type.startsWith('studio.')) return;
    if (!answered) {
      // Any `studio.*` is the answer: the IDE replies to the first init it
      // takes, and to no repeat of it.
      answered = true;
      clearInterval(repeat);
      waiting.forEach((message) => send(message));
      waiting.clear();
      options.onAnswer();
    }
    if (type === 'studio.openComponent' && typeof name === 'string' && name.length > 0) {
      options.onOpenComponent(name);
    }
  };

  frame.addEventListener('load', onLoad);
  portal?.addEventListener('message', onMessage);

  return {
    /** Sent at once after the answer; until then only the latest of each type waits. */
    post(message: EditorMessage): void {
      if (answered) {
        send(message);
        return;
      }
      // A file switched twice before the answer opens one tab, not two.
      waiting.set(message.type, message);
    },
    dispose(): void {
      clearInterval(repeat);
      waiting.clear();
      frame.removeEventListener('load', onLoad);
      portal?.removeEventListener('message', onMessage);
    },
  };
}
