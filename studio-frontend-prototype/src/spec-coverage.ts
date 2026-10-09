/* What the specs ask for, against what the product has: the rules behind
 * "1 · What your specs ask for" on a project's Components tab.
 *
 * Two questions a person brings to that section, and the server's plan
 * (`GET /studio-spec-mapping/v1/plan?project_id=`) carries the facts for both:
 *   - why is this capability asked for, and why is this gear offered for it?
 *   - which capabilities does the product I picked actually close?
 *
 * Coverage is checked against `providers` -- every gear that fills the
 * capability, not the five candidates shown -- so a pick ranked sixth still
 * counts. Only a contract, a declaration or a member's confirmation closes a
 * capability; a gear found by its words alone talks about the subject, which
 * does not prove it does the job, and is reported as such. */

import type { Candidate, ComponentTier, PlanRow } from "./api";

/** How a capability stands against the product's picks. `profile`: answered
 *  by where the product runs, not by a gear. */
export type Cover = "covered" | "weak" | "open" | "profile";

export interface RowCoverage {
  cover: Cover;
  /** Picks that close it: contract, declared, or confirmed. */
  strong: string[];
  /** Picks that only mention its words. */
  weak: string[];
}

/** Whether a candidate is a sure answer or a guess from its words. */
export function candidateStrength(c: Candidate): "strong" | "weak" {
  const decided = c.decision && !c.decision.needs_review ? c.decision.decision : null;
  return c.step === "contract" || c.declared || decided === "confirmed" ? "strong" : "weak";
}

/** A plan read from a server older than `providers` has only the shortlist. */
function providersOf(row: PlanRow): { name: string; strong: boolean }[] {
  if (row.providers) return row.providers;
  return row.candidates
    .filter((c) => !(c.decision && !c.decision.needs_review && c.decision.decision === "rejected"))
    .map((c) => ({ name: c.name, strong: candidateStrength(c) === "strong" }));
}

export function rowCoverage(row: PlanRow, picks: readonly string[]): RowCoverage {
  if (row.nonfunctional) return { cover: "profile", strong: [], weak: [] };
  const inProduct = providersOf(row).filter((p) => picks.includes(p.name));
  const strong = inProduct.filter((p) => p.strong).map((p) => p.name);
  const weak = inProduct.filter((p) => !p.strong).map((p) => p.name);
  return { cover: strong.length > 0 ? "covered" : weak.length > 0 ? "weak" : "open", strong, weak };
}

export interface CoverageSummary {
  /** Capabilities a gear is asked for; profile ones are not counted. */
  total: number;
  covered: number;
  weak: number;
  open: number;
}

export function coverageSummary(plan: readonly PlanRow[], picks: readonly string[]): CoverageSummary {
  const out: CoverageSummary = { total: 0, covered: 0, weak: 0, open: 0 };
  for (const row of plan) {
    const { cover } = rowCoverage(row, picks);
    if (cover === "profile") continue;
    out.total += 1;
    out[cover] += 1;
  }
  return out;
}

/** Product gears that close a capability but are not among the candidates
 *  shown for it, so the row can still name them. */
export function picksBeyondShortlist(row: PlanRow, picks: readonly string[]): { name: string; strong: boolean }[] {
  const shown = new Set(row.candidates.map((c) => c.name));
  return providersOf(row).filter((p) => picks.includes(p.name) && !shown.has(p.name));
}

const quote = (w: string) => `“${w}”`;

/** Why the specs ask for a capability, one entry per document that does. */
export function specReasons(row: PlanRow): { document: string; lines: string[] }[] {
  return (row.sources ?? []).map((src) => {
    const lines: string[] = [];
    if (!src.inferred) {
      lines.push("Declared in its front matter (capabilities:).");
    } else {
      const n = src.requirements ?? src.because?.length ?? 0;
      const heads = src.because ?? [];
      lines.push(
        n > 0
          ? `Implied by ${n} functional requirement${n === 1 ? "" : "s"}` +
              (heads.length > 0 ? `: ${heads.map(quote).join(", ")}${n > heads.length ? ` and ${n - heads.length} more` : ""}.` : ".")
          : "Implied by its functional requirements.",
      );
      if (src.terms && src.terms.length > 0) lines.push(`They use the words ${src.terms.map(quote).join(", ")}.`);
    }
    if (src.confirmed === false) lines.push("The file is not confirmed as a spec on the Specs tab yet.");
    return { document: src.label, lines };
  });
}

/** What a gear is looked for with, for this capability. */
export function lookingFor(row: PlanRow): string {
  const words = row.terms && row.terms.length > 0 ? row.terms : [row.capability];
  const parts = [`words ${words.map(quote).join(", ")}`];
  if (row.contracts && row.contracts.length > 0) parts.unshift(`contracts ${row.contracts.join(", ")}`);
  return `Gears are matched by ${parts.join(", then by ")}.`;
}

/** Code in the project's own repository that is not a gear yet: the
 *  organization's registry found it looks like one (ADR-0041 P3). */
export function couldBecomeGear(c: Candidate): boolean {
  return c.origin === "project" && c.registry_state === "candidate";
}

/** Whose component a candidate is (ADR-0042). A server older than the tiers
 *  says only whether the project's own repository declares it. */
export function candidateTier(c: Candidate): ComponentTier | null {
  if (c.tier) return c.tier;
  return c.origin === "project" ? "project" : null;
}

/** The chip's tag for a tier. */
export function tierTag(tier: ComponentTier): string {
  return tier === "platform" ? "PLATFORM" : tier === "organization" ? "OURS" : "THIS PROJECT";
}

/** What a tier means, in a sentence for the "?" panel. */
export function tierReason(tier: ComponentTier): string {
  switch (tier) {
    case "platform":
      return "From the platform: the shared components every organization builds on.";
    case "organization":
      return "Your organization's own component. Offered before an equally strong platform gear: it was written for you.";
    case "project":
      return "This project's own: declared in its repositories.";
  }
}

/** Why a candidate is offered for a capability, and what stands in its way. */
export function candidateReasons(c: Candidate, capability: string): string[] {
  const lines: string[] = [];
  const tier = candidateTier(c);
  if (tier && tier !== "project") lines.push(tierReason(tier));
  if (couldBecomeGear(c)) {
    lines.push(
      `Found in this project's own code${c.path ? `, at ${c.path}` : ""}, and not a gear yet: it looks like one, so it could become a gear. Declare it to open a pull request adding its gear.toml.`,
    );
  } else if (c.origin === "project") {
    lines.push(`Declared in this project's own repository${c.path ? `, at ${c.path}` : ""}: you already have it.`);
  }
  if (c.registry_state === "deprecated") {
    lines.push(
      c.replaced_by
        ? `Deprecated in the organization's registry — use ${c.replaced_by} instead.`
        : "Deprecated in the organization's registry: no longer to be chosen.",
    );
  }
  if (c.step === "contract") {
    lines.push(`Provides ${(c.contracts ?? []).join(", ")}: a contract ${quote(capability)} is satisfied by.`);
  }
  if (c.declared) lines.push(`Declares ${quote(capability)} itself, in its gear.toml or on its catalogue page.`);
  if (c.decision) {
    lines.push(
      c.decision.needs_review
        ? `A member ${c.decision.decision} it, but the document or the gear changed since: decide again.`
        : `A member ${c.decision.decision} it for ${quote(capability)}.`,
    );
  }
  const words = c.why.filter((w) => w !== "declared");
  if (c.step !== "contract" && words.length > 0) {
    lines.push(`Its ${c.cites ? "own documentation" : "catalogue description"} uses ${words.map(quote).join(", ")}.`);
    if (c.passage) lines.push(`“…${c.passage}…”`);
  }
  if (candidateStrength(c) === "weak") {
    lines.push("Found by its words only: it talks about the subject, which does not prove it does the job.");
  }
  if (c.built === "built") lines.push("Built: the catalogue found its crate.");
  if (c.built === "docs-only") lines.push("Docs only: there is no crate under this component yet.");
  if (c.composable === "runs") lines.push("The Gearbox engine can put it into a product.");
  if (c.composable === "blocked") lines.push(`The Gearbox engine cannot run it${c.composable_why ? `: ${c.composable_why}` : ""}.`);
  if (c.composable === "undescribed") lines.push("No gear.gdl describes it, so the Gearbox engine cannot compose it yet.");
  return lines;
}

/** The opening sentence of a gear made for a capability nothing closes: what
 *  the specs ask of it, naming the documents and requirements that do. It
 *  becomes the new gear's PRD problem, so the gear starts from the spec. */
export function gearProblem(row: PlanRow): string {
  const name =
    row.label && row.label.toLowerCase() !== row.capability ? `${row.label} (${row.capability})` : row.capability;
  const asked = (row.sources ?? []).map((s) =>
    s.inferred && s.because && s.because.length > 0 ? `${s.label}: ${s.because.map(quote).join(", ")}` : s.label,
  );
  const docs = asked.length > 0 ? ` The specs that ask for it: ${asked.join("; ")}.` : "";
  return `The project needs ${name}, and no gear in the catalogue closes it.${docs}`;
}
