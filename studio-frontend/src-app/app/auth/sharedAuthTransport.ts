/**
 * The host's auth transport plus the session MFEs read. FrontX's own REST
 * binding does the host's requests; the accessor goes on `globalThis` for
 * `authShared()`, since nothing else reaches an MFE's isolated realm. A refresh
 * MFEs ask for is deduplicated here, so any number of them make one token
 * request, and reported to the auth plugin through `trackRefresh`.
 */
import { frontxApiTransport, type AuthPluginConfig, type AuthSession } from '@gears-frontx/react';
import {
  clearSharedAuthSession,
  publishSharedAuthSession,
  type SharedAuthSessionAccessor,
} from '@constructor-studio/mfe-shared';

type AuthTransportBinder = NonNullable<AuthPluginConfig['transport']>;

export function sharedAuthTransport(): AuthTransportBinder {
  const rest = frontxApiTransport();
  return (args) => {
    const binding = rest(args);
    const providerRefresh = args.provider.refresh?.bind(args.provider);
    let inFlight: Promise<AuthSession | null> | null = null;
    // No AbortSignal: one MFE's abort must not cancel the refresh the others wait on.
    const refresh = providerRefresh
      ? () => {
          inFlight ??= (async () => {
            const report = args.trackRefresh?.();
            try {
              const session = await providerRefresh();
              await report?.({ session });
              return session;
            } catch (rejected) {
              await report?.({ rejected });
              throw rejected;
            } finally {
              inFlight = null;
            }
          })();
          return inFlight;
        }
      : undefined;
    const accessor: SharedAuthSessionAccessor = {
      getSession: (ctx) => args.provider.getSession(ctx),
      refresh,
      onTransportError: args.provider.onTransportError?.bind(args.provider),
      transport: { allowedCookieOrigins: args.allowedCookieOrigins, csrfHeaderName: args.csrfHeaderName },
    };
    publishSharedAuthSession(accessor);
    return {
      destroy: () => {
        clearSharedAuthSession(accessor);
        binding.destroy();
      },
    };
  };
}
