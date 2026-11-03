import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMfeBridgeFixture } from '../../../__test-utils__/createMfeBridgeFixture';

type BridgeFixture = ReturnType<typeof createMfeBridgeFixture>;
type TestBridge = BridgeFixture['bridge'];
type TestApp = { id: string };

const superMountSpy = vi.fn();

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
  mfeApp: { id: 'projects-mfe-app' },
}));

// The root's own behaviour (bridge properties, store-driven view) is not this
// test's subject: here it stands in for "whatever the lifecycle renders". It
// takes no props — the bridge reaches the tree through `MfeProvider` now.
vi.mock('./ProjectsRoot', () => ({
  ProjectsRoot: () => <div data-testid="projects-root" />,
}));

describe('projects-mfe lifecycle', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('binds the shared MFE app to the lifecycle instance', async () => {
    const module = await import('./lifecycle');

    expect(Reflect.get(module.default, 'app')).toEqual({
      id: 'projects-mfe-app',
    } satisfies TestApp);
  });

  it('renders the projects root', async () => {
    const module = await import('./lifecycle');
    const renderContent = Reflect.get(module.default, 'renderContent');

    expect(typeof renderContent).toBe('function');
    render(<>{renderContent() as React.ReactNode}</>);

    expect(screen.getByTestId('projects-root')).toBeTruthy();
  });

  it('inherits base mount behavior from StudioMfeLifecycle', async () => {
    const module = await import('./lifecycle');
    const lifecycle = module.default as {
      mount: (container: Element, bridge: TestBridge) => void;
    };
    const container = document.createElement('div');
    const { bridge } = createMfeBridgeFixture({
      domainId: 'projects-domain',
      instanceId: 'projects-instance',
    });

    lifecycle.mount(container, bridge);

    expect(superMountSpy).toHaveBeenCalledWith(container, bridge);
  });
});
