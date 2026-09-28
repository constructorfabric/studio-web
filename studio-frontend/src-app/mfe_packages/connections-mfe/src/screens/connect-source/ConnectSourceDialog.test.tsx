import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FrontXProvider, createFrontXApp, i18nRegistry } from '@gears-frontx/react';
import {
  createMfeBridgeFixture,
  mfeContextValue,
} from '../../../../../__test-utils__/createMfeBridgeFixture';
import { CONNECT_SOURCE_NAMESPACE } from '../../i18n';
import { submitFailed } from '../../slices/connectSlice';
import en from './i18n/en.json';
import { ConnectSourceDialog } from './ConnectSourceDialog';

/**
 * What this asserts is the shape of the form, not the write: the four fields
 * the gear's body needs, the two that must NOT be there, and the gate on the
 * primary action. The provider list is stubbed because the point is the form,
 * and a real `useApiQuery` here would be a request.
 */
const providers = [
  {
    provider: 'github',
    display_name: 'GitHub',
    default_base_url: 'https://api.github.com',
    instance_id: 'i',
    category: 'source_code',
    credential_label: 'Personal access token',
    credential_hint: 'ghp_…',
  },
];

/** What the dictionary hook reports, when a case overrules the real one. */
const { translations } = vi.hoisted(() => ({
  translations: { override: null as { isLoaded: boolean; error: Error | null } | null },
}));

vi.mock('../../i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../i18n')>();
  return {
    ...actual,
    useConnectSourceScreenTranslations: () => {
      const reported = actual.useConnectSourceScreenTranslations();
      return translations.override ?? reported;
    },
  };
});

vi.mock('@gears-frontx/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gears-frontx/react')>();
  return {
    ...actual,
    useApiQuery: () => ({
      data: { items: providers },
      isLoading: false,
      isError: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});

async function renderDialog(organization: unknown = { id: 'org-1', name: 'Acme' }) {
  createFrontXApp({});
  const { mfeApp } = await import('../../init');
  const { STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION } = await import(
    '@constructor-studio/mfe-shared'
  );
  const { bridge } = createMfeBridgeFixture({
    domainId: 'overlay',
    instanceId: 'inst',
    // See `organization.test.tsx`: the fixture types properties as strings and
    // the shell publishes this one as an object. `null` is a published "there
    // is none", which is not the same as never publishing at all.
    initialProperties: {
      [STUDIO_SHARED_PROPERTY_CONTEXT_ORGANIZATION]: organization as unknown as string,
    },
  });
  i18nRegistry.register(CONNECT_SOURCE_NAMESPACE, 'en' as never, en);

  const tree = () => (
    <FrontXProvider app={mfeApp} mfeBridge={mfeContextValue(bridge)}>
      <ConnectSourceDialog />
    </FrontXProvider>
  );
  const view = render(tree());

  return { mfeApp, rerender: () => view.rerender(tree()) };
}

/**
 * The form is behind a first-load skeleton now, so every case that asserts on
 * the form starts by waiting for the dictionary to land — `register` above
 * seeds the registry, but `useScreenTranslations` still reports `isLoaded` a
 * tick later.
 */
async function mount(organization: unknown = { id: 'org-1', name: 'Acme' }) {
  const { mfeApp } = await renderDialog(organization);
  await screen.findByLabelText(en.field_provider);
  return mfeApp;
}

describe('ConnectSourceDialog', () => {
  beforeEach(() => {
    translations.override = null;
  });

  it('asks for exactly the four fields the gear needs', async () => {
    await mount();

    expect(screen.getByLabelText(en.field_provider)).toBeTruthy();
    expect(screen.getByLabelText(en.field_label)).toBeTruthy();
    expect(screen.getByLabelText(en.field_base_url)).toBeTruthy();
    // The credential's label comes from the chosen provider once one is picked;
    // before that it is the generic one.
    expect(screen.getByLabelText(en.field_token)).toBeTruthy();
  });

  it('offers no scope, no owner and no test button', async () => {
    await mount();

    expect(screen.queryByText(/scope/i)).toBeNull();
    expect(screen.queryByText(/owner/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /test/i })).toBeNull();
  });

  it('keeps Create inert until the draft can be sent', async () => {
    await mount();

    expect((screen.getByRole('button', { name: en.create }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('refuses and says why when the shell has published no organization', async () => {
    await mount(null);

    expect(screen.getByRole('alert').textContent).toBe(en.error_no_org);
    expect((screen.getByRole('button', { name: en.create }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('draws a placeholder instead of the fields until the dictionary lands', async () => {
    // Why the placeholder exists: the shell's frame is `h-fit`, so this card's
    // height is the overlay's height. Fields appearing from nothing moved the
    // centred card. jsdom computes no layout, so what is asserted here is the
    // swap itself — nothing of the form on the first paint, all of it after —
    // and the card's stated height in the stylesheet is what makes the swap
    // free of movement.
    const { rerender } = await renderDialog();

    expect(screen.queryByLabelText(en.field_provider)).toBeNull();
    expect(screen.queryByLabelText(en.field_token)).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();

    expect(await screen.findByLabelText(en.field_provider)).toBeTruthy();
    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy();

    // A language change loads the dictionary again; the fields stay.
    translations.override = { isLoaded: false, error: null };
    rerender();
    expect(screen.getByLabelText(en.field_provider)).toBeTruthy();
  });

  it('shows the failure, not the placeholder, when the dictionary does not load', async () => {
    translations.override = { isLoaded: false, error: new Error('no dictionary') };
    await renderDialog();

    expect(screen.getByRole('alert').textContent).toBe('Could not load this screen.');
    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy();
  });

  it('opens the provider list without locking the document', async () => {
    /*
     * The twitch: Base UI's `modal` defaults to `true`, and the kit's `Select`
     * is `Select.Root` unwrapped, so opening the list used to lock document
     * scroll — from a `setTimeout(0)`, a tick after the popup paints, which is
     * what made it read as a twitch rather than a jump. Modality belongs to the
     * shell's frame, which owns the scrim and `aria-modal`.
     *
     * jsdom reports no inset scrollbars, so the lock it would take here is the
     * overflow one; the `position`/`100vw` body restyle is the same lock's
     * other branch. Asserting on overflow is asserting on the lock.
     */
    await mount();

    fireEvent.click(screen.getByLabelText(en.field_provider));
    expect(screen.getByRole('listbox')).toBeTruthy();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(document.documentElement.style.overflowY).toBe('');
    expect(document.body.style.overflowY).toBe('');
    expect(document.body.style.position).toBe('');
  });

  it('answers a refused credential on the credential field', async () => {
    const mfeApp = await mount();

    await act(async () => {
      mfeApp.store.dispatch(submitFailed({ kind: 'provider', text: 'GitHub 401: bad credentials' }));
    });

    expect(screen.getByText('GitHub 401: bad credentials')).toBeTruthy();
    expect(screen.getByLabelText(en.field_token).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText(en.field_base_url).getAttribute('aria-invalid')).toBeNull();
  });

  it('portals the provider popover inside this root instead of document.body', async () => {
    // `SelectContent`'s `container` prop is read at render time; without the
    // ref-mirroring fix in `ConnectSourceDialog`, the very first render (the
    // only one guaranteed before an opening) bakes in `container={undefined}`
    // and Base UI falls back to portalling into `document.body` — outside the
    // real shadow root's styles. Regression-tested by reverting the fix
    // locally and confirming this assertion fails: with the old
    // `containerRef.current ?? undefined` read, the popover lands as a
    // sibling of the root at `document.body`, not nested inside it.
    await mount();

    const dialogRoot = document.querySelector('[data-theme]');
    expect(dialogRoot).not.toBeNull();

    fireEvent.click(screen.getByLabelText(en.field_provider));

    const listbox = screen.getByRole('listbox');
    expect(dialogRoot?.contains(listbox)).toBe(true);
  });
});
