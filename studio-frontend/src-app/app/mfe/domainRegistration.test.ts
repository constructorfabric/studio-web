/**
 * Registers the shell's domains on a REAL registry. `bootstrap.test.ts` mocks
 * `registerDomain`, so it cannot see the registry's own checks — the one that
 * refuses a domain declaring an action without a handler once took the whole
 * screen slot down (#319) with every unit test green.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFrontX,
  gtsPlugin,
  hasSlice,
  microfrontends,
  presets,
  registerSlice,
  screenDomain,
  FRONTX_ACTION_MOUNT_EXT,
  type ChildMfeBridge,
  type ExtensionDomain,
  type MfeEntryLifecycle,
} from '@gears-frontx/react';
import {
  STUDIO_ACTION_CHAIN_DONE,
  STUDIO_ACTION_CHAIN_FAILED,
  STUDIO_ACTION_NOTIFY,
  STUDIO_MFE_ENTRY_IFRAME,
  STUDIO_SHARED_PROPERTY_SPACE_FRAME_URL,
  requestFromHost,
} from '@constructor-studio/mfe-shared';
import { freshNavigationHistory } from '@frontx-test-utils/memoryNavigationHistory';
import {
  APP_CONTEXT_SLICE_KEY,
  appContextSlice,
  setContextAccess,
  setContextOrganizations,
} from '@/app/slices/appContextSlice';
import { createMaterializer } from '@/app/routing/materialize';
import { createShellNavigation } from '@/app/routing/navigation';
import { groupScreens } from '@/app/routing/screenTokens';
import { SHELL_SCHEMAS } from './schemas';
import { bootstrapMFE } from './bootstrap';
import { occupancyOf } from './domainOccupancy';
import { MfeHandlerIframe, type MfeEntryIframe } from './MfeHandlerIframe';
import type { StudioScreenExtension } from './screenLevels';
import { executeAndSettle } from './shellOutcomes';

// What main.tsx registers before constructing the app.
for (const schema of SHELL_SCHEMAS) gtsPlugin.registerSchema(schema);

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const fixtureEntry = (name: string) => `${STUDIO_MFE_ENTRY_IFRAME}constructor_studio.fixture.mfe.${name}.v1`;
const fixtureScreen = (name: string) =>
  `gts.frontx.mfes.ext.extension.v1~frontx.screensets.layout.screen.v1~constructor_studio.screensets.layout.leveled_screen.v1~constructor_studio.fixture.screens.${name}.v1`;
const WORKING_SCREEN = fixtureScreen('working');
const BROKEN_SCREEN = fixtureScreen('broken');

/** What a recorded fixture was last mounted with, by entry id; `null` until it mounts. */
const recorded = new Map<string, { container: Element | ShadowRoot; bridge: ChildMfeBridge } | null>();

/** Loads frames; the `broken` one then fails to mount, a recorded one keeps its container and bridge. */
class FixtureFrameHandler extends MfeHandlerIframe {
  override load(entry: MfeEntryIframe, extensionId: string): Promise<MfeEntryLifecycle<ChildMfeBridge>> {
    if (entry.id === fixtureEntry('broken')) {
      return Promise.resolve({
        mount: () => Promise.reject(new Error('broken screen')),
        unmount: () => Promise.resolve(),
      });
    }
    if (recorded.has(entry.id)) {
      return Promise.resolve({
        mount: (container, bridge) => {
          recorded.set(entry.id, { container, bridge });
        },
        unmount: () => Promise.resolve(),
      });
    }
    return super.load(entry, extensionId);
  }
}

// A runtime builds one FrontX app and its registry takes each domain once, so
// the file shares one app, bootstrapped by the first test that needs it.
const app = createFrontX()
  .useAll(presets.full())
  .use(microfrontends({ typeSystem: gtsPlugin, mfeHandlers: [new FixtureFrameHandler(STUDIO_MFE_ENTRY_IFRAME)] }))
  .build();
const registry = app.mfeRegistry!;

/** Every domain declaration the shell hands the registry. */
const declarations: ExtensionDomain[] = [];
let bootstrap: Promise<void> | undefined;

function bootstrapped(): Promise<void> {
  bootstrap ??= (async () => {
    const registerDomain = registry.registerDomain.bind(registry);
    registry.registerDomain = (domain, factory) => {
      declarations.push(domain);
      registerDomain(domain, factory);
    };
    await bootstrapMFE(app);
    // What ExtensionDomainSlot does once the screen slot is in the page.
    registry.getMounter(screenDomain.id).attach(document.createElement('div'));
  })();
  return bootstrap;
}

const screens = new Map<string, Promise<void>>();

interface FixtureScreen {
  /** Its first segment is the screen's token. */
  route?: string;
  /** The reply actions the entry accepts, and the actions it sends its domain. */
  actions?: string[];
  domainActions?: string[];
  /** Mounts a lifecycle that keeps its container and bridge instead of a frame. */
  record?: boolean;
}

/** The file's registry, with the frame screen `name` registered. */
async function registryWithScreen(
  name: string,
  { route = '/fixture', actions = [], domainActions = [], record = false }: FixtureScreen = {}
) {
  await bootstrapped();
  if (!screens.has(name)) {
    if (record) recorded.set(fixtureEntry(name), null);
    registry.typeSystem.register({
      id: fixtureEntry(name),
      requiredProperties: [STUDIO_SHARED_PROPERTY_SPACE_FRAME_URL],
      actions,
      domainActions,
      urlProperty: STUDIO_SHARED_PROPERTY_SPACE_FRAME_URL,
    });
    screens.set(
      name,
      registry.registerExtension({
        id: fixtureScreen(name),
        domain: screenDomain.id,
        entry: fixtureEntry(name),
        presentation: { label: 'Fixture', route, order: 1, level: 'organization' },
      } as never)
    );
  }
  await screens.get(name);
  return registry;
}

const mount = (subject: string) => ({ type: FRONTX_ACTION_MOUNT_EXT, target: screenDomain.id, payload: { subject } });

describe('shell domains on a real registry', () => {
  it('register — every declared action has a handler, and every handler a declaration', async () => {
    await expect(bootstrapped()).resolves.toBeUndefined();
  });

  it('no domain is registered with a route, so the framework router stays out of the address', async () => {
    await bootstrapped();

    expect(declarations).toHaveLength(4);
    for (const declaration of declarations) expect(declaration).not.toHaveProperty('route');
  });

  it('a failed mount leaves nothing mounted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = await registryWithScreen('broken');
    const occupancy = occupancyOf(registry);
    const seen: Array<readonly string[]> = [];
    occupancy.subscribe(() => seen.push(occupancy.mounted(screenDomain.id)));

    await executeAndSettle(registry, mount(BROKEN_SCREEN)).catch(() => undefined);

    // Counted while its container existed, gone once the mount failed.
    expect(seen).toContainEqual([BROKEN_SCREEN]);
    expect(occupancy.mounted(screenDomain.id)).toEqual([]);
  });

  it('a mount that succeeds resolves executeAndSettle', async () => {
    const registry = await registryWithScreen('working');

    await expect(executeAndSettle(registry, mount(WORKING_SCREEN))).resolves.toBeUndefined();
    expect(occupancyOf(registry).mounted(screenDomain.id)).toEqual([WORKING_SCREEN]);
  });

  it('a mount whose lifecycle throws rejects executeAndSettle', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = await registryWithScreen('broken');

    await expect(executeAndSettle(registry, mount(BROKEN_SCREEN))).rejects.toThrow();
  });

  // The runtime's occupancy queue: one mount running, one pending; a newer
  // request replaces the pending one, which takes its fallback.
  it('of mounts queued behind a running one, the newest wins and the one it replaced is rejected', async () => {
    await registryWithScreen('first');
    await registryWithScreen('second');
    await registryWithScreen('third');

    const [first, second, third] = ['first', 'second', 'third'].map((name) =>
      executeAndSettle(registry, mount(fixtureScreen(name)))
    );

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow();
    await expect(third).resolves.toBeUndefined();
    expect(occupancyOf(registry).mounted(screenDomain.id)).toEqual([fixtureScreen('third')]);
  });

  it('a mount of an extension nobody registered rejects executeAndSettle', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = await registryWithScreen('working');

    await expect(executeAndSettle(registry, mount(fixtureScreen('nobody')))).rejects.toThrow();
  });
});

describe('an MFE request to the shell on a real registry', () => {
  const notice = { type: STUDIO_ACTION_NOTIFY, target: screenDomain.id, payload: { kind: 'info', text: 'Saved' } };

  /** The bridge the runtime handed screen `name`, whose entry accepts `replies`. */
  async function bridgeOf(name: string, replies: string[]): Promise<ChildMfeBridge> {
    await registryWithScreen(name, { actions: replies, domainActions: [STUDIO_ACTION_NOTIFY], record: true });
    await executeAndSettle(registry, mount(fixtureScreen(name)));
    return recorded.get(fixtureEntry(name))!.bridge;
  }

  it('settles when the entry declares the two replies', async () => {
    const bridge = await bridgeOf('requesting', [STUDIO_ACTION_CHAIN_DONE, STUDIO_ACTION_CHAIN_FAILED]);

    await expect(requestFromHost(bridge, notice)).resolves.toBeUndefined();
  });

  // Why projects-mfe's workspace_create declares them: the runtime refuses a
  // reply its target does not declare and says nothing, and nothing times out.
  it('never settles when the entry does not declare them', async () => {
    const bridge = await bridgeOf('deaf', []);
    const settled = vi.fn();

    void requestFromHost(bridge, notice).then(settled, settled);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(settled).not.toHaveBeenCalled();
  });
});

describe('the screen slot re-attaching on a real registry', () => {
  const ORG = { id: 'o1', name: 'Org' };

  /** What startRouting builds for this file's registry, at screen `name`. */
  async function routedTo(name: string) {
    await registryWithScreen(name, { route: `/${name}`, record: true });
    if (!hasSlice(APP_CONTEXT_SLICE_KEY)) registerSlice(appContextSlice);
    app.store.dispatch(setContextOrganizations([ORG]));
    app.store.dispatch(setContextAccess('ready'));
    const screen = registry
      .getExtensionsForDomain(screenDomain.id)
      .filter((extension) => extension.id === fixtureScreen(name)) as StudioScreenExtension[];
    const catalogs = { loadOrganizations: vi.fn(), loadWorkspaces: vi.fn(), loadProjects: vi.fn(), resolveProject: vi.fn() };
    return createMaterializer({
      app,
      navigation: createShellNavigation(freshNavigationHistory(`/?screen=${name};org=${ORG.id}`).history),
      groups: () => groupScreens(screen),
      catalogs,
      warn: vi.fn(),
    });
  }

  /**
   * What a remount of the slot does: ExtensionDomainSlot detaches (the release
   * of what it held still running) and attaches the new root, and
   * MfeScreenContainer's onAttached sends app/routing/start, which retries.
   */
  function reattach(retry: () => void): HTMLElement {
    const root = document.createElement('div');
    const mounter = registry.getMounter(screenDomain.id);
    void mounter.detach();
    mounter.attach(root);
    retry();
    return root;
  }

  function mountedIn(root: Element, name: string): boolean {
    const container = recorded.get(fixtureEntry(name))?.container;
    if (!container) return false;
    return root.contains(container instanceof ShadowRoot ? container.host : container);
  }

  const mounted = () => occupancyOf(registry).mounted(screenDomain.id);

  it('a screen mounted when the slot re-attaches is mounted again, in the new root', async () => {
    const { materialize, retry } = await routedTo('kept');
    materialize();
    await vi.waitFor(() => expect(mounted()).toEqual([fixtureScreen('kept')]));

    const root = reattach(retry);

    await vi.waitFor(() => expect(mountedIn(root, 'kept')).toBe(true));
    expect(mounted()).toEqual([fixtureScreen('kept')]);
  });

  // StrictMode's double effect at startup: the first mount is still on its way.
  it('a mount still on its way when the slot re-attaches lands in the new root', async () => {
    const { materialize, retry } = await routedTo('arriving');
    materialize();

    const root = reattach(retry);

    await vi.waitFor(() => expect(mountedIn(root, 'arriving')).toBe(true));
    expect(mounted()).toEqual([fixtureScreen('arriving')]);
  });
});
