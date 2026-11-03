import { withOwnQueryCache } from '@frontx-test-utils/withOwnQueryCache';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrontXProvider, i18nRegistry } from '@gears-frontx/react';
import { CONNECTION_LIST_NAMESPACE } from '../../../i18n';
import en from '../i18n/en.json';

/**
 * The four outcomes of `cpt-studiofrontend-algo-connection-list-health`, one
 * test each. The case that matters most is the third: the gear answers the same
 * `failed_precondition` for every cause, and a deployment with no connector
 * driver plugin answers 503 for every row, so a status-based test would tell
 * every member in the table that their credential is broken.
 */
const { useQueryMock, getServiceMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
  getServiceMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...actual, useQuery: useQueryMock };
});

vi.mock('@gears-frontx/react', (importOriginal) =>
  withOwnQueryCache(importOriginal, (actual) => {
    // Spy in place: `register`/`initialize` live on the prototype, so a spread
    // copy of the singleton would drop what `./init` needs.
    vi.spyOn(actual.apiRegistry, 'getService').mockImplementation(getServiceMock);
    return {};
  })
);

/** The gears' RFC 7807 body, with their own vocabulary under `context`. */
function problem(status: number, violations?: readonly unknown[]) {
  return {
    response: {
      status,
      data: {
        status,
        detail: 'the category sentence',
        context: violations ? { violations } : {},
      },
    },
  };
}

const REFUSAL = {
  type: 'CONNECTOR_CREDENTIAL_UNUSABLE',
  subject: 'c-1',
  description: 'the token was rotated',
};

async function mount(query: Record<string, unknown>) {
  getServiceMock.mockReturnValue({
    connectionTest: () => ({ fetch: vi.fn() }),
  });
  useQueryMock.mockReturnValue({ isPending: false, isError: false, error: null, ...query });

  const { mfeApp } = await import('../../../init');
  const { HealthInline } = await import('./HealthInline');
  i18nRegistry.register(CONNECTION_LIST_NAMESPACE, 'en' as never, en);

  render(
    <FrontXProvider app={mfeApp}>
      <HealthInline connectionId="c-1" tenantId="org-1" />
    </FrontXProvider>
  );
}

describe('HealthInline', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('says nothing about health while the check is still out', async () => {
    await mount({ isPending: true });

    expect(screen.queryByText(en.health_healthy)).toBeNull();
    expect(screen.queryByText(en.health_unusable)).toBeNull();
    expect(screen.queryByText(en.load_failed)).toBeNull();
  });

  it('reports the gear’s refusal as unusable, carrying its reason', async () => {
    await mount({ isError: true, error: problem(412, [REFUSAL]) });

    expect(screen.getByText(en.health_unusable)).toBeTruthy();
    expect(screen.getByTitle(REFUSAL.description)).toBeTruthy();
    expect(screen.queryByText(en.load_failed)).toBeNull();
  });

  it('does not call a credential unusable when the gear never judged it', async () => {
    // 503 from a deployment with no connector driver plugin: no violation, so
    // no verdict — the health could not be read, and that is all the cell says.
    await mount({ isError: true, error: problem(503) });

    expect(screen.getByText(en.load_failed)).toBeTruthy();
    expect(screen.queryByText(en.health_unusable)).toBeNull();
  });

  it('does not call a credential unusable when the request never arrived', async () => {
    // No `response` at all: a dropped network, the 30s timeout, an abort.
    await mount({ isError: true, error: { message: 'Network Error' } });

    expect(screen.getByText(en.load_failed)).toBeTruthy();
    expect(screen.queryByText(en.health_unusable)).toBeNull();
  });

  it('reports a check that answered as healthy', async () => {
    await mount({});

    expect(screen.getByText(en.health_healthy)).toBeTruthy();
  });
});
