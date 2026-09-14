/**
 * SseAuthPlugin - authenticated, self-healing SSE transport
 *
 * The framework's default SSE path is `new EventSource(url)`, which can carry
 * no `Authorization` header — and the gateway accepts no token from the query
 * string, so every authenticated stream is unreachable that way. `auth.ts`
 * says as much: the default `frontxApiTransport()` binding is REST-only and an
 * authenticated SSE connection needs its own transport. This is that
 * transport, plugged in where the protocol already allows it — `onConnect`
 * short-circuits with an `EventSourceLike` of our own ({@link FetchEventSource}),
 * exactly as `SseMockPlugin` does with a mock.
 *
 * Registered per service (`this.registerPlugin(sseProtocol, ...)`), because
 * the resume policy below is a property of one endpoint, not of the app.
 *
 * SDK Layer: L1 (Zero dependencies)
 */

import {
  SsePluginWithConfig,
  type SseConnectContext,
  type SseShortCircuitResponse,
} from '@gears-frontx/api';
import { FetchEventSource, type FetchEventSourceResume } from '../sse/FetchEventSource';

/**
 * The part of the framework's `SharedAuthSession` this plugin uses,
 * declared structurally rather than imported.
 *
 * `@gears-frontx/framework` imports this package, so importing it back would
 * close a build cycle — and this file is L1 (zero @gears-frontx dependencies)
 * for exactly that reason. Structural typing keeps it honest: whatever the
 * host publishes still has to have this shape.
 */
interface SharedAuthSession {
  getSession: () => Promise<{ kind?: string; token?: string } | null | undefined>;
}

/**
 * The host's session, published by the `auth()` plugin under a `Symbol.for()`
 * key on `globalThis`.
 *
 * Read directly rather than through an import because services are
 * instantiated by `apiRegistry.register(ServiceClass)` with no arguments —
 * there is no constructor to inject a token into — and because an MFE lives in
 * its own module realm, where this symbol is the only thing that crosses. It
 * is the same handoff `authShared()` uses for REST.
 */
const SHARED_AUTH_SESSION_SYMBOL = Symbol.for('frontx:auth:shared-session');

type SharedAuthHost = typeof globalThis & {
  [SHARED_AUTH_SESSION_SYMBOL]?: SharedAuthSession;
};

export interface SseAuthConfig {
  /**
   * Where the bearer token comes from. Omitted = the host's published session,
   * which is what an app with `auth()` installed should use: one owner of
   * login, logout and refresh.
   */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Gap-free resume policy for this endpoint. Without it a reconnect silently
   * loses whatever was published while the connection was down.
   */
  resume?: FetchEventSourceResume;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class SseAuthPlugin extends SsePluginWithConfig<SseAuthConfig> {
  /** Live connections, so `destroy()` does not leave readers running. */
  private readonly open = new Set<FetchEventSource>();

  async onConnect(
    context: SseConnectContext,
  ): Promise<SseConnectContext | SseShortCircuitResponse> {
    const session = readSharedSession();
    const source = new FetchEventSource(context.url, {
      getToken: this.config.getToken ?? (() => bearerOf(session)),
      headers: context.headers,
      // A cookie session has no token to attach; the credentials go instead.
      withCredentials: this.config.getToken ? false : await isCookieSession(session),
      resume: withStartCursor(this.config.resume, context.url),
      fetchImpl: this.config.fetchImpl,
    });
    this.open.add(source);
    return { shortCircuit: source };
  }

  destroy(): void {
    for (const source of this.open) source.close();
    this.open.clear();
  }
}

/**
 * The query parameter a subscriber uses to say "I already know everything up
 * to cursor N, replay from there".
 *
 * It is read HERE and never sent as a filter the server interprets: the server
 * ignores it, and the descriptor key of `stream('/stream?resume_from=42')`
 * differs from `stream('/stream')`, which is exactly what makes `useApiStream`
 * open a fresh connection when the starting cursor changes. Carrying it in the
 * URL rather than in plugin config also keeps two subscribers with different
 * starting points from fighting over one shared field.
 */
const RESUME_FROM_PARAM = 'resume_from';

/** The resume policy with its starting cursor taken from the URL, if present. */
function withStartCursor(
  resume: FetchEventSourceResume | undefined,
  url: string,
): FetchEventSourceResume | undefined {
  if (!resume) return undefined;
  const query = url.slice(url.indexOf('?') + 1);
  const raw = url.includes('?') ? new URLSearchParams(query).get(RESUME_FROM_PARAM) : null;
  const from = raw === null ? NaN : Number(raw);
  return Number.isFinite(from) ? { ...resume, from } : resume;
}

function readSharedSession(): SharedAuthSession | undefined {
  return (globalThis as SharedAuthHost)[SHARED_AUTH_SESSION_SYMBOL];
}

/** The bearer token of the host's current session, or `null`. */
async function bearerOf(session: SharedAuthSession | undefined): Promise<string | null> {
  const current = await session?.getSession();
  return current?.kind === 'bearer' && current.token ? current.token : null;
}

async function isCookieSession(session: SharedAuthSession | undefined): Promise<boolean> {
  const current = await session?.getSession();
  return current?.kind === 'cookie';
}
