/* The Specs header's status line (ui-standard.tsx PageHeader): how many specs,
 * what waits for review, what the detectors found open, and how far the
 * workspace's journey is -- read from what the list already holds. Pure, so it
 * is tested without a backend; documents.tsx draws it. */

import type { StageStatus } from "./api";

/** How far the journey is: the stages that ask for something, how many are
 *  complete, and the document types none of the project's documents is.
 *  Null when no stage asks for anything -- then there is nothing to say. */
export function journeyProgress(
  stages: readonly StageStatus[],
): { complete: number; total: number; missing: string[] } | null {
  const asking = stages.filter((s) => s.requirements.length > 0);
  if (asking.length === 0) return null;
  const missing = [...new Set(asking.flatMap((s) => s.requirements.filter((r) => !r.present).map((r) => r.type_key)))];
  return { complete: asking.filter((s) => s.complete).length, total: asking.length, missing };
}

export interface SpecsChip {
  id: "review" | "findings" | "journey";
  text: string;
  tone: "ok" | "warn" | "danger" | "neutral";
}

/** "155 specs", then a chip each for review, findings and the journey.
 *  `findings` is null when the verdicts could not be read: then no chip, not
 *  a zero. */
export function specsStatus(f: {
  bound: number;
  needsReview: number;
  findings: number | null;
  journey: { complete: number; total: number } | null;
}): { lead: string; chips: SpecsChip[] } {
  const chips: SpecsChip[] = [];
  if (f.needsReview > 0) chips.push({ id: "review", text: `${f.needsReview} need review`, tone: "warn" });
  if (f.findings !== null && f.bound > 0)
    chips.push(
      f.findings > 0
        ? { id: "findings", text: `${f.findings} open finding${f.findings === 1 ? "" : "s"}`, tone: "danger" }
        : { id: "findings", text: "no open findings", tone: "ok" },
    );
  if (f.journey)
    chips.push({
      id: "journey",
      text: `journey ${f.journey.complete}/${f.journey.total}`,
      tone: f.journey.complete === f.journey.total ? "ok" : "warn",
    });
  return { lead: `${f.bound} spec${f.bound === 1 ? "" : "s"}`, chips };
}
