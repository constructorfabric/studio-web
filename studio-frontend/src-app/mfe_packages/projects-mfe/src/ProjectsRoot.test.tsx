import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  readonly tenant = this.refuse;
  readonly children = this.refuse;
  readonly projectConfig = this.refuse;
  readonly nodes = this.refuse;
  readonly connections = this.refuse;
  readonly providers = this.refuse();
}

vi.mock('./api/AccountsApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/AccountsApiService')>()),
  AccountsApiService: SilentService,
}));
vi.mock('./api/ArtifactIngestApiService', () => ({ ArtifactIngestApiService: SilentService }));
vi.mock('@constructor-studio/mfe-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@constructor-studio/mfe-shared')>()),
  ConnectorsApiService: SilentService,
}));

describe('ProjectsRoot', () => {
  // The frame's rail is the kit's Sidebar, which measures the viewport. jsdom
  // has no matchMedia; `vi.unstubAllGlobals` in the shared teardown restores it.
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList
    );
  });

  it('swaps the list for the project frame when a project is open', async () => {
    createFrontXApp({});
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

    // The frame's own chrome is its <header> (`banner`); the rail that used to
    // stand in for it here now comes from the kit, so it is not asserted.
    expect(await screen.findByRole('banner')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();

    await act(async () => {
      mfeApp.store.dispatch(closeProject());
    });

    expect(await screen.findByRole('searchbox')).toBeTruthy();
  });
});
