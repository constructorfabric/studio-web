import { withOwnQueryCache } from '@frontx-test-utils/withOwnQueryCache';
import React from 'react';
import { render, screen } from '@testing-library/react';
import {
  FRONTX_SHARED_PROPERTY_LANGUAGE,
  FRONTX_SHARED_PROPERTY_THEME,
  FrontXProvider,
  i18nRegistry,
} from '@gears-frontx/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMfeBridgeFixture,
  mfeContextValue,
} from '../../../__test-utils__/createMfeBridgeFixture';
import { STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION } from '@constructor-studio/mfe-shared';
import { CONNECTION_LIST_NAMESPACE } from './i18n';
import en from './screens/connection-list/i18n/en.json';

type BridgeFixture = ReturnType<typeof createMfeBridgeFixture>;
type TestBridge = BridgeFixture['bridge'];
type TestApp = { id: string };

const superMountSpy = vi.fn();
const { getServiceMock, useApiQueryMock, useScreenTranslationsMock, useTanstackQueryMock } =
  vi.hoisted(() => ({
    getServiceMock: vi.fn(),
    useApiQueryMock: vi.fn(),
    useScreenTranslationsMock: vi.fn(),
    useTanstackQueryMock: vi.fn(),
  }));

// `useConnectionList` and `useConnectionHealth` both call `useQuery` straight
// from `@tanstack/react-query` (not the `useApiQuery` wrapper), so they need
// a real QueryClientProvider or a mock of their own — mounting a real client
// here would let the connections query fire for real once `enabled` turns
// true (the test publishes an organization), which is exactly the race this
// suite exists to avoid. Mocked the same deterministic way as `useApiQuery`.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: useTanstackQueryMock,
  };
});

vi.mock('@gears-frontx/react', (importOriginal) =>
  withOwnQueryCache(importOriginal, (actual) => {
    // `apiRegistry` is a singleton instance — `register`/`initialize` (called by
    // the real `./init`) live on its prototype, so replacing the object with a
    // spread copy would silently drop them. Spying in place keeps the instance,
    // and with it every method `./init` needs, while only `getService` is faked.
    vi.spyOn(actual.apiRegistry, 'getService').mockImplementation(getServiceMock);
    return {
      useApiQuery: useApiQueryMock,
      // The screen-level loader is a real `@gears-frontx/react` export now (the
      // scaffold's own `useScreenTranslations` is gone) — overridden the same
      // way `useApiQuery` is, so the screen's busy/error gate stays deterministic
      // instead of racing a real dynamic import.
      useScreenTranslations: useScreenTranslationsMock,
    };
  })
);

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  StudioMfeLifecycle: class StudioMfeLifecycle {
    constructor(public readonly app: TestApp) {}

    mount(container: Element | ShadowRoot, bridge: TestBridge): void {
      superMountSpy(container, bridge);
    }
  },
}));

describe('connections-mfe lifecycle', () => {
  beforeEach(() => {
    // `useConnectionList` reads `listing.key`/`listing.fetch` at the call
    // site — evaluated even though `useQuery` itself is mocked below — so the
    // fake service has to return descriptor-shaped objects, not bare strings.
    getServiceMock.mockReturnValue({
      providers: 'providers-descriptor',
      connections: () => ({ key: ['connections-descriptor'], fetch: vi.fn() }),
      connectionTest: () => ({ key: ['connection-test-descriptor'], fetch: vi.fn() }),
    });
    useScreenTranslationsMock.mockReturnValue({ isLoaded: true, error: null });
    useApiQueryMock.mockReturnValue({
      data: { items: [] },
      isLoading: false,
      isError: false,
      error: null,
    });
    // Covers both call sites: `useConnectionList` reads `data`/`isLoading`/
    // `isError`; `useConnectionHealth` reads `isError`/`isSuccess`/`error`.
    // With an empty row set neither the health query nor the connection list's
    // "loading" branch actually depends on this shape being exact, but both
    // fields are provided so the mock cannot accidentally undercut whichever
    // branch runs.
    useTanstackQueryMock.mockReturnValue({
      data: { items: [] },
      isLoading: false,
      isError: false,
      isSuccess: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('binds the shared MFE app to the lifecycle instance', async () => {
    const initModule = await import('./init');
    const module = await import('./lifecycle');
    const lifecycle = module.default;

    expect(Reflect.get(lifecycle, 'app')).toBe(initModule.mfeApp);
  });

  it('renders the connections list screen with the provided bridge', async () => {
    const initModule = await import('./init');
    const module = await import('./lifecycle');
    const lifecycle = module.default;
    const renderContent = Reflect.get(lifecycle, 'renderContent');
    const { bridge } = createMfeBridgeFixture({
      domainId: 'connections-domain',
      instanceId: 'connections-instance',
      initialProperties: {
        [FRONTX_SHARED_PROPERTY_THEME]: 'connections-theme',
        [FRONTX_SHARED_PROPERTY_LANGUAGE]: 'en',
        // The fixture types every property as a string while the shell
        // publishes this one as an object; the bridge itself does not care.
        [STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION]: { id: 'org-1', name: 'Acme' } as unknown as string,
      },
    });

    // Translations are registered synchronously: the registry's default and
    // fallback language are both English, so this resolves every key without
    // racing the async loader.
    i18nRegistry.register(CONNECTION_LIST_NAMESPACE, 'en' as never, en);

    expect(typeof renderContent).toBe('function');
    render(
      <FrontXProvider app={initModule.mfeApp} mfeBridge={mfeContextValue(bridge)}>
        {renderContent() as React.ReactNode}
      </FrontXProvider>
    );

    // The scaffold's HomeScreen is gone; the toolbar and the empty state are
    // what prove the lifecycle now mounts the connections list instead.
    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: en.search_placeholder })).toBeTruthy();
    expect(screen.getByText(en.empty_title)).toBeTruthy();
  });

  it('inherits base mount behavior from StudioMfeLifecycle', async () => {
    const module = await import('./lifecycle');
    const lifecycle = module.default as {
      mount: (container: Element, bridge: TestBridge) => void;
    };
    const container = document.createElement('div');
    const { bridge } = createMfeBridgeFixture({
      domainId: 'connections-domain',
      instanceId: 'connections-instance',
    });

    lifecycle.mount(container, bridge);

    expect(superMountSpy).toHaveBeenCalledWith(container, bridge);
  });
});
