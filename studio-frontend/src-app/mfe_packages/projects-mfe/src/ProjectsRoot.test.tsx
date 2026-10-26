import { act, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FrontXProvider, createFrontXApp } from '@gears-frontx/react';
import {
  createMfeBridgeFixture,
  mfeContextValue,
} from '../../../__test-utils__/createMfeBridgeFixture';

/**
 * Which screen shows is `projects/nav.projectId` and nothing else — there is no
 * router. This pins the swap itself, so "clicking a project does not open it"
 * can be answered without a browser: either the store never got the id (the
 * row's own test covers that) or this swap is broken.
 *
 * No API mocks on purpose: both screens fire their queries, both fail in jsdom,
 * and the chrome asserted here renders regardless of query state. The gears'
 * clients are stubbed so those failures are immediate rather than real sockets.
 */
class SilentService {
  private readonly refuse = () => ({ fetch: () => Promise.reject(new Error('no gear in jsdom')) });
  readonly getTenant = this.refuse;
  readonly getProjects = this.refuse;
  readonly getWorkspaces = this.refuse;
  readonly getTenantMetadata = this.refuse;
  readonly findTenantUser = this.refuse;
  readonly nodes = this.refuse;
  readonly stages = this.refuse;
  readonly connections = this.refuse;
  readonly providers = this.refuse();
}

vi.mock('./api/ArtifactIngestApiService', () => ({ ArtifactIngestApiService: SilentService }));
vi.mock('./api/DocumentsApiService', () => ({ DocumentsApiService: SilentService }));
// Both gears' clients live in the shared package now, so one mock covers them.
vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  AccountsApiService: SilentService,
  ConnectorsApiService: SilentService,
}));

describe('ProjectsRoot', () => {
  // Once per file: a second app re-runs the mock plugin against the stubbed services.
  beforeAll(() => {
    createFrontXApp({});
  });

  it('swaps the list for the project frame when a project is open', async () => {
    const { mfeApp } = await import('./init');
    const { ProjectsRoot } = await import('./ProjectsRoot');
    const { openProject, closeProject } = await import('./slices/navSlice');
    const { bridge } = createMfeBridgeFixture({ domainId: 'screen', instanceId: 'inst' });

    render(
      <FrontXProvider app={mfeApp} mfeBridge={mfeContextValue(bridge)}>
        <ProjectsRoot />
      </FrontXProvider>
    );

    // The list screen owns the search box; the project frame has no such thing.
    expect(await screen.findByRole('searchbox')).toBeTruthy();

    await act(async () => {
      mfeApp.store.dispatch(openProject('11111111-1111-4111-8111-111111111111'));
    });

    // The frame's own chrome is its <header> (`banner`); the section navigation
    // that used to stand in for it here is the shell's now, so it is not asserted.
    expect(await screen.findByRole('banner')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();

    await act(async () => {
      mfeApp.store.dispatch(closeProject());
    });

    expect(await screen.findByRole('searchbox')).toBeTruthy();
    // Two full renders of the kit's chrome in jsdom, measured at 14-15s against
    // vitest's 15s default -- a coin flip, and a CI flake waiting to happen. The
    // budget is raised rather than the work reduced because none of what takes
    // the time is what this test asserts: it pins which screen shows, and the
    // chrome around it renders regardless.
  }, 45_000);

  // #881: the tabs showed Specs, the body Overview.
  it('opens a project on the section the shell published before it', async () => {
    const { mfeApp } = await import('./init');
    const { ProjectsRoot } = await import('./ProjectsRoot');
    const { STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT, STUDIO_SHARED_PROPERTY_CONTEXT_SECTION } =
      await import('@constructor-studio/mfe-shared');
    const { bridge, setProperty } = createMfeBridgeFixture({
      domainId: 'screen',
      instanceId: 'inst',
    });

    const { container } = render(
      <FrontXProvider app={mfeApp} mfeBridge={mfeContextValue(bridge)}>
        <ProjectsRoot />
      </FrontXProvider>
    );

    // A direct link: the shell publishes the section at once, and the project
    // only once the workspace list has vouched for its workspace (ADR-0028).
    await act(async () => {
      setProperty(STUDIO_SHARED_PROPERTY_CONTEXT_SECTION, 'specs');
    });
    await act(async () => {
      setProperty(STUDIO_SHARED_PROPERTY_CONTEXT_PROJECT, '11111111-1111-4111-8111-111111111111');
    });

    expect(container.querySelector('[data-section]')?.getAttribute('data-section')).toBe('specs');
  }, 45_000);
});
