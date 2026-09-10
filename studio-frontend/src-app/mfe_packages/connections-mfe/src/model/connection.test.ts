import { describe, expect, it } from 'vitest';
import { Github, Plug, Slack, Webhook } from 'lucide-react';
import { healthTone, iconFor } from './connection';

describe('provider glyphs', () => {
  it('draws a known provider with its own icon', () => {
    expect(iconFor('github')).toBe(Github);
    expect(iconFor('slack')).toBe(Slack);
  });

  it('draws every webhook variant as a webhook, not as its platform', () => {
    // The row names the provider already; the glyph is there to say which of
    // the two credentials this connection holds.
    for (const code of ['slack_webhook', 'zulip_webhook', 'discord_webhook']) {
      expect(iconFor(code)).toBe(Webhook);
    }
  });

  it('falls back rather than failing on a provider newer than this screen', () => {
    expect(iconFor('perforce')).toBe(Plug);
  });
});

describe('health tone', () => {
  it('maps each state to the badge variant the design uses', () => {
    expect(healthTone('healthy')).toBe('success');
    expect(healthTone('unusable')).toBe('warning');
  });
});
