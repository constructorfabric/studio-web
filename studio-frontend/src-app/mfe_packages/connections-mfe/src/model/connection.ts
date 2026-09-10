/**
 * The vocabulary of a connection as this screen shows it.
 */

// @cpt-dod:cpt-studiofrontend-dod-connection-list-glyph:p1
import {
  Bot,
  GitBranch,
  Github,
  Gitlab,
  MessageCircle,
  MessageSquare,
  Plug,
  Slack,
  Sparkles,
  Webhook,
  type LucideIcon,
} from 'lucide-react';

export type ProviderCode =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'anthropic'
  | 'openai'
  | 'slack'
  | 'slack_webhook'
  | 'zulip'
  | 'zulip_webhook'
  | 'discord'
  | 'discord_webhook';

/** The single place that knows which provider looks like what. */
const ICONS = {
  github: Github,
  gitlab: Gitlab,
  // lucide has no Bitbucket mark; a repository glyph is the honest stand-in.
  bitbucket: GitBranch,
  anthropic: Sparkles,
  openai: Bot,
  slack: Slack,
  // No Zulip or Discord mark either, so a chat glyph each, distinct enough to
  // tell apart in a list.
  zulip: MessageSquare,
  discord: MessageCircle,
  // Every webhook variant draws as a webhook rather than as its platform: the
  // row already names the provider, and what a reader needs at a glance is
  // which of the two credentials this connection holds — one channel fixed in
  // a URL, or a bot that reaches many.
  slack_webhook: Webhook,
  zulip_webhook: Webhook,
  discord_webhook: Webhook,
} satisfies Record<ProviderCode, LucideIcon>;


export function iconFor(code: string): LucideIcon {
  return (ICONS as Record<string, LucideIcon>)[code] ?? Plug;
}

/** Every connection this screen creates is inherited by the whole organization. */
export const CONNECTION_SCOPE = 'organization';

export type ConnectionHealth = 'healthy' | 'unusable';

export function healthTone(health: ConnectionHealth): 'success' | 'warning' {
  return health === 'healthy' ? 'success' : 'warning';
}
