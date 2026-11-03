/**
 * The key on `globalThis` the host publishes its session under, the one channel
 * isolated module realms share. The shell's `sharedAuthTransport()` writes it;
 * mfe-shared's `authShared()` (REST) and `SseAuthPlugin` (studio events) read it.
 */
export const SHARED_AUTH_SESSION_SYMBOL = Symbol.for('frontx:auth:shared-session');
