import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/** Sources: a skeleton until its own dictionary loads, then the note. */

const { translations } = vi.hoisted(() => ({
  translations: { isLoaded: false, error: null as Error | null },
}));

vi.mock('../../../i18n', () => {
  const text = () => (key: string) => key;
  const load = () => translations;
  return {
    useProjectText: text,
    useSourcesText: text,
    useSourcesSectionTranslations: load,
  };
});

vi.mock('../../../shared/useSyncRefusals', () => ({ useSyncRefusals: () => undefined }));

import { SourcesSection } from './sources/SourcesSection';

describe('Sources section', () => {
  it('shows a skeleton while its dictionary loads', () => {
    Object.assign(translations, { isLoaded: false, error: null });
    const { container } = render(<SourcesSection projectId="p-1" />);

    expect(container.querySelector('[class*="skeleton"]')).not.toBeNull();
    expect(screen.queryByText('placeholder')).toBeNull();
  });

  it('shows its note once the dictionary has loaded', () => {
    Object.assign(translations, { isLoaded: true, error: null });
    render(<SourcesSection projectId="p-1" />);

    expect(screen.getByText('placeholder')).toBeTruthy();
  });

  it('shows its note when the dictionary failed to load', () => {
    Object.assign(translations, { isLoaded: false, error: new Error('offline') });
    const { container } = render(<SourcesSection projectId="p-1" />);

    expect(screen.getByText('placeholder')).toBeTruthy();
    expect(container.querySelector('[class*="skeleton"]')).toBeNull();
  });
});
