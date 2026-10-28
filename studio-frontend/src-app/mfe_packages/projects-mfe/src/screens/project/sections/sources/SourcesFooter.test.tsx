import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from './i18n/en.json';
import ru from './i18n/ru.json';
import type { SourcesFooter as FooterCounts } from '../../../../model/sourceRows';

/** The Sources footer: the whole project's counts, missing ones as missing (#688). */

const { dictionary } = vi.hoisted(() => ({
  dictionary: { current: { words: {} as Record<string, string>, language: 'en' } },
}));

vi.mock('../../../../i18n', async () => {
  const { dictionaryText } = await import('@frontx-test-utils/dictionaryText');
  return {
    useSourcesText: () => dictionaryText(dictionary.current.words, dictionary.current.language),
  };
});

import { SourcesFooter } from './SourcesFooter';

function footer(counts: FooterCounts, language: 'en' | 'ru' = 'en') {
  dictionary.current = { words: language === 'en' ? en : ru, language };
  return render(<SourcesFooter footer={counts} />).container.textContent;
}

describe('SourcesFooter', () => {
  afterEach(cleanup);

  it('counts the sources, their specs and the open pull requests', () => {
    expect(footer({ sources: 3, specs: 12, openPullRequests: 2 })).toBe(
      '3 sources · 12 specs from sources · 2 open pull requests'
    );
  });

  it('says one in the singular', () => {
    expect(footer({ sources: 1, specs: 1, openPullRequests: 1 })).toBe(
      '1 source · 1 spec from sources · 1 open pull request'
    );
  });

  it('takes the Russian forms for a few and for many', () => {
    expect(footer({ sources: 3, specs: 22, openPullRequests: 2 }, 'ru')).toBe(
      '3 источника · 22 спецификации из источников · 2 открытых пул-реквеста'
    );
    cleanup();
    expect(footer({ sources: 5, specs: 11, openPullRequests: 0 }, 'ru')).toBe(
      '5 источников · 11 спецификаций из источников · 0 открытых пул-реквестов'
    );
  });

  it('shows a number that could not be read as missing, never as zero', () => {
    expect(footer({ sources: 0, specs: null, openPullRequests: null })).toBe(
      '0 sources · — specs from sources · Pull request activity unavailable'
    );
  });
});
