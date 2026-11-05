/* What a build in Studio will do, said before Build is pressed
 * (`POST /builds/plan`): where its Job runs, with which builder, from which
 * sources through whose connections, into which repositories -- and, when
 * Studio would refuse it, why, so the Build button is off with the reason
 * beside it instead of failing a moment after it is pressed.
 *
 * Pure, so it is tested without a backend; deploy-actions.tsx draws it. */

import type { BuildPlan, BuildPlanSource } from "./api";
import { BUILD_REFUSALS } from "./builds";

/** One labelled line of the plan. */
export interface PlanLine {
  label: string;
  value: string;
  /** Worth a second look: an unpinned builder, a personal connection. */
  warn?: boolean;
}

/** The connection a source is cloned through, in words: its label, whose it
 *  is when it is a person's, else its scope. */
export function sourceConnectionText(s: BuildPlanSource): string {
  if (!s.connection_id && !s.connection_label) return "no connection: the repository is public";
  const label = s.connection_label || s.connection_id || "";
  if (s.connection_scope === "personal") return `${label}, ${s.connection_holder ? `${s.connection_holder}'s` : "a person's"} own`;
  return s.connection_scope ? `${label} (${s.connection_scope})` : label;
}

/** A source as one line: `owner/repo at main (abc1234)`. */
export function sourceText(s: BuildPlanSource): string {
  return `${s.repository} at ${s.ref || "its own branch"}${s.commit ? ` (${s.commit.slice(0, 7)})` : ""}`;
}

/** The plan as short labelled lines, in the order the build goes. */
export function planLines(p: BuildPlan): PlanLine[] {
  const lines: PlanLine[] = [];
  const product = `${p.product_file}${p.description_revision != null ? ` (revision ${p.description_revision})` : ""} for profile ${p.profile}`;
  lines.push({ label: "builds", value: product });
  lines.push({ label: "checked as", value: p.strictness === "prod" ? "a production profile" : "a development profile" });
  lines.push({ label: "runs in", value: `${p.environment} · namespace ${p.build_namespace}` });
  lines.push({
    label: "builder",
    value: p.builder_pinned ? p.builder_image : `${p.builder_image} (not pinned by digest)`,
    warn: !p.builder_pinned,
  });
  if (p.gearbox_version) lines.push({ label: "Gearbox", value: p.gearbox_version });
  for (const s of p.sources)
    lines.push({
      label: s.id === "product" || p.sources.length === 1 ? "code" : `code (${s.id})`,
      value: `${sourceText(s)} · through ${sourceConnectionText(s)}`,
      warn: s.connection_scope === "personal",
    });
  if (p.image_repositories.length > 0) lines.push({ label: "images", value: p.image_repositories.join(", ") });
  if (p.chart_repository) lines.push({ label: "chart", value: p.chart_repository });
  lines.push({ label: "deploys to", value: `namespace ${p.namespace}` });
  return lines;
}

/** Why Studio would refuse the build, as a person reads it: the title and
 *  what to do for a refusal it knows, with the server's sentence between. */
export function planRefusalText(refusal: BuildPlan["refusal"]): string | null {
  if (!refusal) return null;
  const known = BUILD_REFUSALS[refusal.code];
  if (!known) return refusal.message || refusal.code;
  return [`${known.title}.`, refusal.message?.trim(), known.next].filter(Boolean).join(" ");
}

/** The fields of a plan request that change its answer: asked again only
 *  when one of them changes. */
export function planKey(body: { environment_id: string; profile?: string; product_file?: string; ref?: string }): string {
  return [body.environment_id, body.profile ?? "", body.product_file ?? "", body.ref ?? ""].join("\u0000");
}
