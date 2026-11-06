import React from 'react';
import { render, screen } from '@testing-library/react';
import { FrontXProvider } from '@gears-frontx/react';
import { createTestApp } from '@frontx-test-utils/createTestApp';
import { STUDIO_SHARED_PROPERTY_CONTEXT_SECTION } from '@constructor-studio/mfe-shared';
import {
  FRONTX_SHARED_PROPERTY_LANGUAGE,
  FRONTX_SHARED_PROPERTY_THEME,
} from '@gears-frontx/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMfeBridgeFixture,
  mfeContextValue,
} from '../../../__test-utils__/createMfeBridgeFixture';

// `./init` is mocked, so this is the runtime's one FrontX app.
const app = createTestApp();

type BridgeFixture = ReturnType<typeof createMfeBridgeFixture>;
type TestBridge = BridgeFixture['bridge'];
type TestApp = { id: string };

const superMountSpy = vi.fn();
const {
  getServiceMock,
  useApiQueryMock,
  useScreenTranslationsMock,
} = vi.hoisted(() => ({
  getServiceMock: vi.fn(),
  useApiQueryMock: vi.fn(),
  useScreenTranslationsMock: vi.fn(),
}));

vi.mock('@gears-frontx/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gears-frontx/react')>();
  return {
    ...actual,
    apiRegistry: {
      getService: getServiceMock,
    },
    useApiQuery: useApiQueryMock,
  };
});

vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  StudioMfeLifecycle: class StudioMfeLifecycle {
    constructor(public readonly app: TestApp) {}

    mount(container: Element | ShadowRoot, bridge: TestBridge): void {
      superMountSpy(container, bridge);
    }
  },
}));

vi.mock('./init', () => ({
  mfeApp: { id: 'blank-mfe-app' },
}));

vi.mock('./api/_BlankApiService', () => ({
  _BlankApiService: class MockBlankApiService {
    static {
      void 0;
    }
  },
}));

// Only the home screen's text is stubbed; the other screens keep the real module.
vi.mock('./i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./i18n')>()),
  useHomeTranslations: useScreenTranslationsMock,
}));

describe('organization-mfe lifecycle', () => {
  beforeEach(() => {
    getServiceMock.mockReturnValue({ getStatus: { type: 'status' } });
    useScreenTranslationsMock.mockReturnValue({ t: (key: string) => key, loading: false });
    useApiQueryMock.mockReturnValue({
      data: {
        message: 'Blank MFE query example is active.',
        generatedAt: '2026-03-23T12:00:00.000Z',
        capabilities: ['query-key-factory'],
      },
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('binds the shared MFE app to the lifecycle instance', async () => {
    const module = await import('./lifecycle');
    const lifecycle = module.default;

    expect(Reflect.get(lifecycle, 'app')).toEqual({ id: 'blank-mfe-app' } satisfies TestApp);
  });

  it('opens on the workspaces, which is also the fallback when no section is relayed', async () => {
    const module = await import('./lifecycle');
    const lifecycle = module.default;
    const renderContent = Reflect.get(lifecycle, 'renderContent');
    const { bridge } = createMfeBridgeFixture({
      domainId: 'organization-domain',
      instanceId: 'organization-instance',
      initialProperties: {
        [FRONTX_SHARED_PROPERTY_THEME]: 'blank-theme',
        [FRONTX_SHARED_PROPERTY_LANGUAGE]: 'en',
      },
    });

    expect(typeof renderContent).toBe('function');
    // The root reads the shell's section property, so it needs the MFE context
    // the real lifecycle puts around it.
    render(
      <FrontXProvider app={app} mfeBridge={mfeContextValue(bridge)}>
        {renderContent(bridge) as React.ReactNode}
      </FrontXProvider>
    );

    expect(await screen.findByRole('button', { name: 'New workspace' })).toBeTruthy();
  });

  it('renders the settings screen when the shell relays that section', async () => {
    const module = await import('./lifecycle');
    const lifecycle = module.default;
    const renderContent = Reflect.get(lifecycle, 'renderContent');
    const { bridge } = createMfeBridgeFixture({
      domainId: 'organization-domain',
      instanceId: 'organization-instance',
      initialProperties: {
        [FRONTX_SHARED_PROPERTY_THEME]: 'blank-theme',
        [FRONTX_SHARED_PROPERTY_LANGUAGE]: 'en',
        [STUDIO_SHARED_PROPERTY_CONTEXT_SECTION]: 'settings',
      },
    });

    render(
      <FrontXProvider app={app} mfeBridge={mfeContextValue(bridge)}>
        {renderContent(bridge) as React.ReactNode}
      </FrontXProvider>
    );

    // The key-echoing translation mock makes the placeholder's i18n keys
    // directly assertable.
    expect(await screen.findByText('title')).toBeTruthy();
    expect(screen.getByText('description')).toBeTruthy();
  });

  it('inherits base mount behavior from StudioMfeLifecycle', async () => {
    const module = await import('./lifecycle');
    const lifecycle = module.default as {
      mount: (container: Element, bridge: TestBridge) => void;
    };
    const container = document.createElement('div');
    const { bridge } = createMfeBridgeFixture({
      domainId: 'blank-domain',
      instanceId: 'blank-instance',
    });

    lifecycle.mount(container, bridge);

    expect(superMountSpy).toHaveBeenCalledWith(container, bridge);
  });
});
