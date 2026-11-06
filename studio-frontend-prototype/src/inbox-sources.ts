// The inbox's sources (inbox.ts): each reads one kind of fact Studio holds,
// through the same REST routes the rest of the portal reads, and says what
// waits for the person. A kit adds one with `registerInboxSource`; the
// studio-mcp `inbox` tool reads the same facts for an agent
// (studio-backend/src/user_profile/mcp.rs).

import { api, type OpenPullRequest } from "./api";
import {
  deployEntries,
  pullEntries,
  reviewEntries,
  runEntries,
  type InboxEntry,
} from "./inbox";
import type { ReviewRequest } from "./review-requests";

/** What a source is given to read with. */
export interface InboxContext {
  token: string;
  /** The organization in view. */
  orgId: string;
  /** Its workspaces: reviews and pull requests are read per workspace. */
  workspaces: { id: string; name: string }[];
  /** The ids the person is known by: their Studio profile and their sign-in
   *  subject. A run names whoever asked for it by one of them. */
  me: string[];
}

export interface InboxSource {
  id: string;
  /** "Deploys": the filter chip's word. */
  label: string;
  read: (ctx: InboxContext) => Promise<InboxEntry[]>;
}

async function reviews(ctx: InboxContext): Promise<InboxEntry[]> {
  const per = await Promise.all(
    ctx.workspaces.map(async (ws) => {
      // A backend from before reviews answers 404: there are simply none.
      const items = await api
        .reviewRequestsWaitingOnMe(ctx.token, ws.id)
        .then((r) => r.items)
        .catch(() => [] as ReviewRequest[]);
      return reviewEntries(items, ws.id);
    }),
  );
  return per.flat();
}

async function pulls(ctx: InboxContext): Promise<InboxEntry[]> {
  const per = await Promise.all(
    ctx.workspaces.map(async (ws) => {
      const items: OpenPullRequest[] = [];
      for (let offset = 0; ; ) {
        const page = await api.pullRequestsWaitingOnMe(ctx.token, ws.id, offset);
        items.push(...page.items);
        offset += page.items.length;
        if (page.items.length === 0 || offset >= page.total) break;
      }
      return pullEntries(items, ws.id);
    }),
  );
  return per.flat();
}

async function deploys(ctx: InboxContext): Promise<InboxEntry[]> {
  const page = await api.deployments(ctx.token, { org: ctx.orgId });
  return deployEntries(page.items ?? [], async (d, action, reason) => {
    await api.decideDeployment(ctx.token, ctx.orgId, d.id, action, reason);
  });
}

async function runs(ctx: InboxContext): Promise<InboxEntry[]> {
  const page = await api.taskRuns(ctx.token, { state: "failed", limit: 100 });
  return runEntries(page.items ?? [], ctx.me, new Date());
}

const SOURCES: InboxSource[] = [
  { id: "deploy", label: "Deploys", read: deploys },
  { id: "review", label: "Reviews", read: reviews },
  { id: "pull", label: "Pull requests", read: pulls },
  { id: "run", label: "Notifications", read: runs },
];

/** Add a source, or replace the one with its id. */
export function registerInboxSource(source: InboxSource): void {
  const at = SOURCES.findIndex((s) => s.id === source.id);
  if (at >= 0) SOURCES[at] = source;
  else SOURCES.push(source);
}

/** The sources registered now, in their order. */
export function inboxSources(): readonly InboxSource[] {
  return SOURCES;
}
