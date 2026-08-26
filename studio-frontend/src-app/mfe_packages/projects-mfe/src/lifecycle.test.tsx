import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMfeBridgeFixture } from '../../../__test-utils__/createMfeBridgeFixture';

type BridgeFixture = ReturnType<typeof createMfeBridgeFixture>;
type TestBridge = BridgeFixture['bridge'];
type TestApp = { id: string };

const superMountSpy = vi.fn();

vi.mock('@gears-frontx/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gears-frontx/react')>();
  return {
    ...actual,
    ThemeAwareReactLifecycle: class ThemeAwareReactLifecycle {
      constructor(public readonly app: TestApp) {}

      mount(container: Element | ShadowRoot, bridge: TestBridge): void {
        superMountSpy(container, bridge);
      }
    },
  };
});

vi.mock('./init', () => ({
  mfeApp: { id: 'projects-mfe-app' },
}));

// The root's own behaviour (bridge properties, store-driven view) is not this
// test's subject: here it stands in for "whatever the lifecycle renders".
vi.mock('./ProjectsRoot', () => ({
  ProjectsRoot: ({ bridge }: { bridge: TestBridge }) => (
    <div data-testid="projects-root">{bridge.instanceId}</div>
  ),
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

  it('renders the projects root with the provided bridge', async () => {
    const module = await import('./lifecycle');
    const renderContent = Reflect.get(module.default, 'renderContent');
    const { bridge } = createMfeBridgeFixture({
      domainId: 'projects-domain',
      instanceId: 'projects-instance',
    });

    expect(typeof renderContent).toBe('function');
    render(<>{renderContent(bridge) as React.ReactNode}</>);

    expect(screen.getByTestId('projects-root').textContent).toBe('projects-instance');
  });

  it('inherits base mount behavior from ThemeAwareReactLifecycle', async () => {
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
