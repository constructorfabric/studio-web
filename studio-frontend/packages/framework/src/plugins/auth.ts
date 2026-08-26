// @cpt-FEATURE:cpt-frontx-feature-auth-plugin:p1
// @cpt-begin:cpt-frontx-dod-auth-plugin:p1:inst-module
// @cpt-begin:cpt-frontx-state-auth-plugin-refresh:p1:inst-module
import type {
  AuthCallbackInput,
  AuthCheckResult,
  AuthContext,
  AccessConstraint,
  AccessDecision,
  AccessEvaluation,
  AccessQuery,
  AccessReason,
  AccessRecord,
  AuthCapabilitiesResolved,
  AuthIdentity,
  AuthLoginInput,
  AuthPermissions,
  AuthProvider,
  AuthSession,
  AuthStateListener,
  AuthUnsubscribe,
  AuthTransition,
} from '@gears-frontx/auth';
import {
  RestPlugin,
  RestProtocol,
} from '@gears-frontx/api';
import type { FrontXPlugin } from '../types';
import {
  BaseAuthRestPlugin,
  type ResolvedAuthTransport,
} from './authTransportCore';
import {
  clearSharedAuthSession,
  publishSharedAuthSession,
  type SharedAuthSessionAccessor,
} from './authShared';

export type AuthRuntime = {
  provider: AuthProvider;
  /** Resolved capability flags built by method-presence probe at provider-attach time. */
  capabilities: AuthCapabilitiesResolved;
  getSession: (ctx?: AuthContext) => Promise<AuthSession | null>;
  checkAuth: (ctx?: AuthContext) => Promise<AuthCheckResult>;
  logout: (ctx?: AuthContext) => Promise<AuthTransition>;
  login?: (input: AuthLoginInput, ctx?: AuthContext) => Promise<AuthTransition>;
  handleCallback?: (input: AuthCallbackInput, ctx?: AuthContext) => Promise<AuthTransition>;
  refresh?: (ctx?: AuthContext) => Promise<AuthSession | null>;
  getIdentity?: (ctx?: AuthContext) => Promise<AuthIdentity | null>;
  getPermissions?: (ctx?: AuthContext) => Promise<AuthPermissions>;
  /** Fail-closed: always resolves to 'allow' | 'deny'. Never throws. */
  canAccess: <TRecord extends AccessRecord = AccessRecord>(
    query: AccessQuery<TRecord>,
    ctx?: AuthContext,
  ) => Promise<AccessDecision>;
  /** Fail-closed: always resolves to ReadonlyArray<AccessDecision>. Never throws. Order preserved. */
  canAccessMany: (
    queries: ReadonlyArray<AccessQuery>,
    ctx?: AuthContext,
  ) => Promise<ReadonlyArray<AccessDecision>>;
  /** Fail-closed: always resolves to AccessEvaluation with deny+reason on any error path. Never throws. */
  evaluateAccess: <TRecord extends AccessRecord = AccessRecord>(
    query: AccessQuery<TRecord>,
    ctx?: AuthContext,
  ) => Promise<AccessEvaluation>;
  /** Fail-closed: always resolves to ReadonlyArray<AccessEvaluation>. Never throws. Order preserved. */
  evaluateMany: (
    queries: ReadonlyArray<AccessQuery>,
    ctx?: AuthContext,
  ) => Promise<ReadonlyArray<AccessEvaluation>>;
  subscribe?: (listener: AuthStateListener) => AuthUnsubscribe;
};

export type AuthTransportBinding = {
  destroy: () => void;
};

export type AuthTransportBinder = (args: {
  provider: AuthProvider;
  csrfHeaderName?: string;
  allowedCookieOrigins?: string[];
  addRestPlugin: (plugin: RestPlugin) => void;
  removeRestPlugin: (pluginClass: new (...args: never[]) => RestPlugin) => void;
}) => AuthTransportBinding;

export type Hai3ApiAuthTransportConfig = {
  allowedCookieOrigins?: string[];
  csrfHeaderName?: string;
};

export type AuthPluginConfig = {
  provider: AuthProvider;
  /**
   * Optional transport binder.
   * If omitted, the default `frontxApiTransport()` binding is used.
   */
  transport?: AuthTransportBinder;
  /**
   * Configuration for the default @gears-frontx/api binding.
   * Ignored when `transport` is provided.
   */
  frontxApi?: Hai3ApiAuthTransportConfig;
};

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

function buildCapabilities(provider: AuthProvider): AuthCapabilitiesResolved {
  return {
    hasGetIdentity: typeof provider.getIdentity === 'function',
    hasGetPermissions: typeof provider.getPermissions === 'function',
    hasCanAccess: typeof provider.canAccess === 'function',
    hasCanAccessMany: typeof provider.canAccessMany === 'function',
    hasEvaluateAccess: typeof provider.evaluateAccess === 'function',
    hasEvaluateMany: typeof provider.evaluateMany === 'function',
    hasRefresh: typeof provider.refresh === 'function',
    hasSubscribe: typeof provider.subscribe === 'function',
  };
}

// ---------------------------------------------------------------------------
// Fail-closed access wrappers
// ---------------------------------------------------------------------------

function classifyAbortReason(signal: AbortSignal): AccessReason {
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === 'TimeoutError') return 'timeout';
  return 'aborted';
}

function isAccessDecision(value: unknown): value is AccessDecision {
  return value === 'allow' || value === 'deny';
}

function normalizeDecision(value: unknown): AccessDecision {
  return value === 'allow' ? 'allow' : 'deny';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAccessReason(value: unknown): value is AccessReason {
  return typeof value === 'string';
}

function isAccessJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return true;
  }

  if (typeof value === 'number') {
    // JSON forbids NaN / ±Infinity — fail closed so meta/constraints stay round-trippable.
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.every((entry) => isAccessJsonValue(entry, seen));
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).every((entry) => isAccessJsonValue(entry, seen));
  }

  return false;
}

function isAccessConstraint(value: unknown): value is AccessConstraint {
  return isPlainObject(value)
    && Object.values(value).every((entry) => isAccessJsonValue(entry));
}

function isAccessConstraints(value: unknown): value is ReadonlyArray<AccessConstraint> {
  return Array.isArray(value) && value.every((entry) => isAccessConstraint(entry));
}

function isAccessMeta(value: unknown): value is NonNullable<AccessEvaluation['meta']> {
  return isPlainObject(value)
    && Object.values(value).every((entry) => isAccessJsonValue(entry));
}

function normalizeEvaluation(value: unknown): AccessEvaluation {
  // @cpt-begin:cpt-frontx-algo-auth-plugin-rbac-normalize:p1:inst-shape-guard
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { decision: 'deny', reason: 'provider_error' };
  }
  // @cpt-end:cpt-frontx-algo-auth-plugin-rbac-normalize:p1:inst-shape-guard

  const maybeEvaluation = value as {
    decision?: unknown;
    constraints?: unknown;
    reason?: unknown;
    meta?: unknown;
  };
  // @cpt-begin:cpt-frontx-algo-auth-plugin-rbac-normalize:p1:inst-decision-guard
  if (!isAccessDecision(maybeEvaluation.decision)) {
    return { decision: 'deny', reason: 'provider_error' };
  }
  // @cpt-end:cpt-frontx-algo-auth-plugin-rbac-normalize:p1:inst-decision-guard

  // @cpt-begin:cpt-frontx-algo-auth-plugin-rbac-normalize:p1:inst-constraints-guard
  if (maybeEvaluation.constraints !== undefined && !isAccessConstraints(maybeEvaluation.constraints)) {
    return { decision: 'deny', reason: 'provider_error' };
  }
  // @cpt-end:cpt-frontx-algo-auth-plugin-rbac-normalize:p1:inst-constraints-guard

  // @cpt-begin:cpt-frontx-algo-auth-plugin-rbac-normalize:p1:inst-reason-guard
  if (maybeEvaluation.reason !== undefined && !isAccessReason(maybeEvaluation.reason)) {
    return { decision: 'deny', reason: 'provider_error' };
  }
  // @cpt-end:cpt-frontx-algo-auth-plugin-rbac-normalize:p1:inst-reason-guard

  // @cpt-begin:cpt-frontx-algo-auth-plugin-rbac-normalize:p1:inst-meta-guard
  if (maybeEvaluation.meta !== undefined && !isAccessMeta(maybeEvaluation.meta)) {
    return { decision: 'deny', reason: 'provider_error' };
  }
  // @cpt-end:cpt-frontx-algo-auth-plugin-rbac-normalize:p1:inst-meta-guard

  // @cpt-begin:cpt-frontx-algo-auth-plugin-rbac-normalize:p1:inst-build-normalized
  const normalized: AccessEvaluation = { decision: maybeEvaluation.decision };
  if (maybeEvaluation.constraints !== undefined) {
    normalized.constraints = maybeEvaluation.constraints;
  }
  if (maybeEvaluation.reason !== undefined) {
    normalized.reason = maybeEvaluation.reason;
  }
  if (maybeEvaluation.meta !== undefined) {
    normalized.meta = maybeEvaluation.meta;
  }
  return normalized;
  // @cpt-end:cpt-frontx-algo-auth-plugin-rbac-normalize:p1:inst-build-normalized
}

async function safeCanAccess(
  provider: AuthProvider,
  caps: AuthCapabilitiesResolved,
  query: AccessQuery,
  ctx?: AuthContext,
): Promise<AccessDecision> {
  if (!query.action || !query.resource) return 'deny';
  if (!caps.hasCanAccess) return 'deny';

  let session: AuthSession | null;
  try {
    session = await provider.getSession(ctx);
  } catch {
    return 'deny';
  }
  if (session === null) return 'deny';

  try {
    return normalizeDecision(await provider.canAccess?.(query, ctx));
  } catch {
    return 'deny';
  }
}

async function safeEvaluateAccess(
  provider: AuthProvider,
  caps: AuthCapabilitiesResolved,
  query: AccessQuery,
  ctx?: AuthContext,
): Promise<AccessEvaluation> {
  // @cpt-begin:cpt-frontx-algo-auth-plugin-rbac-safe-evaluate:p1:inst-query-guard
  if (!query.action || !query.resource) {
    return { decision: 'deny', reason: 'malformed' };
  }
  // @cpt-end:cpt-frontx-algo-auth-plugin-rbac-safe-evaluate:p1:inst-query-guard
  // @cpt-begin:cpt-frontx-algo-auth-plugin-rbac-safe-evaluate:p1:inst-capability-guard
  if (!caps.hasEvaluateAccess) {
    return { decision: 'deny', reason: 'unsupported' };
  }
  // @cpt-end:cpt-frontx-algo-auth-plugin-rbac-safe-evaluate:p1:inst-capability-guard

  // @cpt-begin:cpt-frontx-algo-auth-plugin-rbac-safe-evaluate:p1:inst-session-guard
  let session: AuthSession | null;
  try {
    session = await provider.getSession(ctx);
  } catch {
    return { decision: 'deny', reason: 'unauthenticated' };
  }
  if (session === null) {
    return { decision: 'deny', reason: 'unauthenticated' };
  }
  // @cpt-end:cpt-frontx-algo-auth-plugin-rbac-safe-evaluate:p1:inst-session-guard

  try {
    // @cpt-begin:cpt-frontx-algo-auth-plugin-rbac-safe-evaluate:p1:inst-delegate-normalize
    return normalizeEvaluation(await provider.evaluateAccess?.(query, ctx));
    // @cpt-end:cpt-frontx-algo-auth-plugin-rbac-safe-evaluate:p1:inst-delegate-normalize
  } catch {
    // @cpt-begin:cpt-frontx-algo-auth-plugin-rbac-safe-evaluate:p1:inst-error-classify
    const signal = ctx?.signal;
    if (signal?.aborted) {
      return { decision: 'deny', reason: classifyAbortReason(signal) };
    }
    return { decision: 'deny', reason: 'provider_error' };
    // @cpt-end:cpt-frontx-algo-auth-plugin-rbac-safe-evaluate:p1:inst-error-classify
  }
}

async function safeCanAccessMany(
  provider: AuthProvider,
  caps: AuthCapabilitiesResolved,
  queries: ReadonlyArray<AccessQuery>,
  ctx?: AuthContext,
): Promise<ReadonlyArray<AccessDecision>> {
  if (queries.length === 0) return [];

  // Fail-closed contract parity with safeCanAccess: a single malformed query
  // forces the whole batch through the per-query safe wrapper so the provider's
  // bulk method cannot return 'allow' for an entry without action/resource.
  if (queries.some((query) => !query.action || !query.resource)) {
    const decisions: AccessDecision[] = [];
    for (const query of queries) {
      decisions.push(await safeCanAccess(provider, caps, query, ctx));
    }
    return decisions;
  }

  if (caps.hasCanAccessMany) {
    let session: AuthSession | null;
    try {
      session = await provider.getSession(ctx);
    } catch {
      return queries.map(() => 'deny' as const);
    }
    if (session === null) return queries.map(() => 'deny' as const);

    try {
      const decisions = await provider.canAccessMany?.(queries, ctx);
      if (!Array.isArray(decisions) || decisions.length !== queries.length) {
        return queries.map(() => 'deny' as const);
      }
      return decisions.map((decision) => normalizeDecision(decision));
    } catch {
      return queries.map(() => 'deny' as const);
    }
  }

  const results: AccessDecision[] = [];
  for (const query of queries) {
    results.push(await safeCanAccess(provider, caps, query, ctx));
  }
  return results;
}

async function safeEvaluateMany(
  provider: AuthProvider,
  caps: AuthCapabilitiesResolved,
  queries: ReadonlyArray<AccessQuery>,
  ctx?: AuthContext,
): Promise<ReadonlyArray<AccessEvaluation>> {
  if (queries.length === 0) return [];

  // Same fail-closed parity as safeCanAccessMany: route any malformed query
  // through the per-query safe wrapper so the bulk path cannot leak 'allow'
  // for entries with empty action/resource.
  if (queries.some((query) => !query.action || !query.resource)) {
    const evaluations: AccessEvaluation[] = [];
    for (const query of queries) {
      evaluations.push(await safeEvaluateAccess(provider, caps, query, ctx));
    }
    return evaluations;
  }

  // @cpt-begin:cpt-frontx-algo-auth-plugin-rbac-safe-evaluate:p1:inst-many-fallback
  if (caps.hasEvaluateMany) {
    let session: AuthSession | null;
    try {
      session = await provider.getSession(ctx);
    } catch {
      return queries.map(() => ({ decision: 'deny' as const, reason: 'unauthenticated' as const }));
    }
    if (session === null) {
      return queries.map(() => ({ decision: 'deny' as const, reason: 'unauthenticated' as const }));
    }

    try {
      const evaluations = await provider.evaluateMany?.(queries, ctx);
      if (!Array.isArray(evaluations) || evaluations.length !== queries.length) {
        return queries.map(() => ({ decision: 'deny' as const, reason: 'provider_error' as const }));
      }
      return evaluations.map((evaluation) => normalizeEvaluation(evaluation));
    } catch {
      const signal = ctx?.signal;
      if (signal?.aborted) {
        const reason = classifyAbortReason(signal);
        return queries.map(() => ({ decision: 'deny' as const, reason }));
      }
      return queries.map(() => ({ decision: 'deny' as const, reason: 'provider_error' as const }));
    }
  }

  const results: AccessEvaluation[] = [];
  for (const query of queries) {
    results.push(await safeEvaluateAccess(provider, caps, query, ctx));
  }
  return results;
  // @cpt-end:cpt-frontx-algo-auth-plugin-rbac-safe-evaluate:p1:inst-many-fallback
}

// ---------------------------------------------------------------------------
// REST transport
// ---------------------------------------------------------------------------

/**
 * The host's binding of the shared transport: session from the provider, cookie
 * policy from this plugin's config.
 *
 * Its own named class, because `frontxApiTransport()` unregisters BY CLASS and
 * the registry removes the first `instanceof` match — this identity is what
 * keeps a host teardown from unregistering a child's plugin.
 */
class AuthRestPlugin extends BaseAuthRestPlugin {
  constructor(private readonly config: AuthPluginConfig) {
    super();
  }

  protected resolveTransport(): ResolvedAuthTransport {
    return {
      source: {
        getSession: (ctx) => this.config.provider.getSession(ctx),
        refresh: this.config.provider.refresh?.bind(this.config.provider),
        onTransportError: this.config.provider.onTransportError?.bind(this.config.provider),
      },
      options: {
        allowedCookieOrigins: this.config.frontxApi?.allowedCookieOrigins,
        csrfHeaderName: this.config.frontxApi?.csrfHeaderName,
      },
    };
  }
}

// @cpt-begin:cpt-frontx-flow-auth-plugin-refresh-retry:p1:inst-plugin-factory
export function frontxApiTransport(): AuthTransportBinder {
  return (args) => {
    const restPlugin = new AuthRestPlugin({
      provider: args.provider,
      frontxApi: {
        allowedCookieOrigins: args.allowedCookieOrigins,
        csrfHeaderName: args.csrfHeaderName,
      },
    });
    args.addRestPlugin(restPlugin);
    return {
      destroy: () => {
        args.removeRestPlugin(AuthRestPlugin);
      },
    };
  };
}
// @cpt-end:cpt-frontx-flow-auth-plugin-refresh-retry:p1:inst-plugin-factory

/**
 * Auth plugin.
 *
 * Wires a headless AuthProvider into @gears-frontx/api protocol plugins and exposes `app.auth`.
 *
 * **Scope:** REST transport only. SSE (Server-Sent Events) auth is out-of-scope for the
 * default `frontxApiTransport()` binding. SSE connections requiring auth should use a custom
 * transport binder via the `transport` option.
 */
export function auth(config: AuthPluginConfig): FrontXPlugin {
  const transport = config.transport ?? frontxApiTransport();
  let binding: AuthTransportBinding | null = null;
  let sharedAccessor: SharedAuthSessionAccessor | null = null;
  const caps = buildCapabilities(config.provider);

  return {
    name: 'auth',
    // @cpt-begin:cpt-frontx-flow-auth-plugin-transport-binding:p1:inst-provides
    provides: {
      app: {
        auth: {
          provider: config.provider,
          capabilities: caps,
          getSession: (ctx?: AuthContext) => config.provider.getSession(ctx),
          checkAuth: (ctx?: AuthContext) => config.provider.checkAuth(ctx),
          logout: (ctx?: AuthContext) => config.provider.logout(ctx),
          login: config.provider.login?.bind(config.provider),
          handleCallback: config.provider.handleCallback?.bind(config.provider),
          refresh: config.provider.refresh?.bind(config.provider),
          getIdentity: config.provider.getIdentity?.bind(config.provider),
          getPermissions: config.provider.getPermissions?.bind(config.provider),
          canAccess: <TRecord extends AccessRecord = AccessRecord>(
            query: AccessQuery<TRecord>,
            ctx?: AuthContext,
          ) => safeCanAccess(config.provider, caps, query as AccessQuery, ctx),
          canAccessMany: (queries, ctx) =>
            safeCanAccessMany(config.provider, caps, queries, ctx),
          evaluateAccess: <TRecord extends AccessRecord = AccessRecord>(
            query: AccessQuery<TRecord>,
            ctx?: AuthContext,
          ) => safeEvaluateAccess(config.provider, caps, query as AccessQuery, ctx),
          evaluateMany: (queries, ctx) =>
            safeEvaluateMany(config.provider, caps, queries, ctx),
          subscribe: config.provider.subscribe?.bind(config.provider),
        } satisfies AuthRuntime,
      },
    },
    // @cpt-end:cpt-frontx-flow-auth-plugin-transport-binding:p1:inst-provides
    // @cpt-begin:cpt-frontx-flow-auth-plugin-transport-binding:p1:inst-on-init
    onInit(app) {
      // Isolated module realms (see authShared.ts) mean MFEs cannot see the
      // REST plugin bound below. Publish the session for them to read; the
      // host stays the only owner of login, logout and refresh.
      //
      // Refresh is published ALREADY DEDUPLICATED: the promise lives in this
      // closure, so every child shares it. Each MFE's own plugin dedups only
      // within its realm, which alone would let N mounted MFEs fire N refreshes
      // off one expired token — collapsing them here makes "one token request" a
      // property of this plugin rather than of whichever provider is configured.
      let refreshInFlight: Promise<AuthSession | null> | null = null;
      const providerRefresh = config.provider.refresh?.bind(config.provider);
      sharedAccessor = {
        getSession: (ctx?: AuthContext) => config.provider.getSession(ctx),
        refresh: providerRefresh
          ? () => {
              // No AbortSignal, for the same reason the transport's dedup takes
              // none: one caller's abort must not cancel the shared refresh.
              refreshInFlight ??= providerRefresh().finally(() => {
                refreshInFlight = null;
              });
              return refreshInFlight;
            }
          : undefined,
        onTransportError: config.provider.onTransportError?.bind(config.provider),
        transport: {
          allowedCookieOrigins: config.frontxApi?.allowedCookieOrigins,
          csrfHeaderName: config.frontxApi?.csrfHeaderName,
        },
      };
      publishSharedAuthSession(sharedAccessor);
      binding = transport({
        provider: config.provider,
        allowedCookieOrigins: config.frontxApi?.allowedCookieOrigins,
        csrfHeaderName: config.frontxApi?.csrfHeaderName,
        addRestPlugin: (plugin) => app.apiRegistry.plugins.add(RestProtocol, plugin),
        removeRestPlugin: (pluginClass) => app.apiRegistry.plugins.remove(RestProtocol, pluginClass),
      });
    },
    // @cpt-end:cpt-frontx-flow-auth-plugin-transport-binding:p1:inst-on-init
    // @cpt-begin:cpt-frontx-flow-auth-plugin-transport-binding:p1:inst-on-destroy
    onDestroy(_app) {
      binding?.destroy();
      binding = null;
      if (sharedAccessor) {
        clearSharedAuthSession(sharedAccessor);
        sharedAccessor = null;
      }
      const providerDestroyResult = config.provider.destroy?.();
      if (providerDestroyResult && typeof providerDestroyResult === 'object' && 'catch' in providerDestroyResult) {
        void providerDestroyResult.catch(() => undefined);
      }
    },
    // @cpt-end:cpt-frontx-flow-auth-plugin-transport-binding:p1:inst-on-destroy
  };
}

// @cpt-end:cpt-frontx-state-auth-plugin-refresh:p1:inst-module
// @cpt-end:cpt-frontx-dod-auth-plugin:p1:inst-module

declare module '../types' {
  interface FrontXAppRuntimeExtensions {
    auth?: AuthRuntime;
  }
}
