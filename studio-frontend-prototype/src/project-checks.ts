// The project's document checks on its open pull requests (studio-documents
// `/pull-request-checks`), and the components of its repositories beyond its
// gears (studio-components-catalog `/project-components`).

export interface PullRequestFileCheck {
  path: string;
  type_key: string;
  conforms: boolean;
  issues: string[];
}

export interface PullRequestCheck {
  repo: string;
  number: number;
  title: string;
  url?: string | null;
  head: string;
  state: "success" | "failure";
  description: string;
  files: PullRequestFileCheck[];
  published: boolean;
  publish_error?: string | null;
}

export interface PullRequestChecks {
  items: PullRequestCheck[];
  total: number;
  pulls: number;
  reached: boolean;
}

export interface ProjectComponent {
  repo: string;
  dir: string;
  name: string;
  kind: string;
  manifests: string[];
  contracts: string[];
  has_tests: boolean;
  has_readme: boolean;
  owners: string[];
  last_change?: string | null;
  open_pulls: number;
  /** `open_pulls` is a lower bound: not every open pull request was read. */
  open_pulls_partial?: boolean;
  readiness: "ready" | "caution" | "not_ready";
  reasons: string[];
}

export const READINESS_LABEL: Record<ProjectComponent["readiness"], string> = {
  ready: "Ready to take",
  caution: "Ask first",
  not_ready: "Not ready",
};

/** "3 pull requests checked: 1 fails" or what else happened. */
export function checksSummary(r: PullRequestChecks): string {
  if (!r.reached) return "No repository connection of this project can be asked.";
  if (r.total === 0) return `None of the ${r.pulls} open pull requests changes a document of a known type.`;
  const failing = r.items.filter((i) => i.state === "failure").length;
  const unpublished = r.items.filter((i) => !i.published).length;
  const parts = [`${r.total} pull request${r.total === 1 ? "" : "s"} checked`];
  parts.push(failing === 0 ? "all pass" : `${failing} fail${failing === 1 ? "s" : ""}`);
  if (unpublished > 0) parts.push(`${unpublished} status${unpublished === 1 ? "" : "es"} not set on the host`);
  return parts.join(" · ");
}

/** The Specs header's chip for the last run of the checks: a few words and
 *  a tone; checksSummary has the sentence. */
export function checksChip(r: PullRequestChecks): { text: string; tone: "ok" | "danger" | "neutral" } {
  if (!r.reached) return { text: "PR checks: no connection", tone: "neutral" };
  if (r.total === 0) return { text: "PR checks: nothing to check", tone: "neutral" };
  const failing = r.items.filter((i) => i.state === "failure").length;
  return failing === 0
    ? { text: `PR checks: ${r.total} pass`, tone: "ok" }
    : { text: `PR checks: ${failing} of ${r.total} fail`, tone: "danger" };
}

/** Not ready first, then ask-first, then ready; by name within each. */
export function orderComponents(items: ProjectComponent[]): ProjectComponent[] {
  const rank = { not_ready: 0, caution: 1, ready: 2 } as const;
  return [...items].sort((a, b) => rank[a.readiness] - rank[b.readiness] || a.name.localeCompare(b.name));
}
