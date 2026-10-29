/* How a project builds (ADR-0052 §7): on gears, from its product.gdl, or
 * from the repository's own Dockerfiles and Helm chart. The rules behind the
 * Builds tab's "How it builds", kept apart from the React for their tests. */

import type { OwnImage, ProjectBuildSetting } from "./api";

/** A project builds on gears until it says otherwise. */
export const ON_GEARS: ProjectBuildSetting = { kind: "gears", images: [], chart: null };

/** A first image row: the repository's root Dockerfile. */
export function firstImage(projectName: string): OwnImage {
  const name = slug(projectName) || "app";
  return { app: "app", name, dockerfile: "Dockerfile", context: "." };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IMAGE_NAME = /^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$/;

/** A path inside the repository: relative, no `..`, no backslash. */
export function isRepoPath(p: string): boolean {
  const t = p.trim().replace(/^\.\//, "");
  return t !== "" && !t.startsWith("/") && !t.includes("\\") && !t.includes(":") && !t.split("/").includes("..");
}

/** What is wrong with a build of the repository's own, as the server would
 *  say it; `null` when it can be saved. */
export function ownBuildProblem(b: ProjectBuildSetting): string | null {
  if (b.kind !== "own") return null;
  if (b.images.length === 0) return "Name at least one Dockerfile.";
  const seen = new Set<string>();
  for (const i of b.images) {
    if (!DNS_LABEL.test(i.app.trim())) return `"${i.app}" is not a values key: lowercase letters, digits and '-'.`;
    if (seen.has(i.app.trim())) return `"${i.app}" is named twice.`;
    seen.add(i.app.trim());
    if (!IMAGE_NAME.test(i.name.trim())) return `"${i.name}" is not an image name, e.g. shop-api.`;
    if (!isRepoPath(i.dockerfile)) return `"${i.dockerfile}" is not a Dockerfile in the repository.`;
    const context = (i.context ?? ".").trim() || ".";
    if (context !== "." && !isRepoPath(context)) return `"${context}" is not a folder in the repository.`;
  }
  if (!isRepoPath(b.chart ?? "")) return "Name the folder of the Helm chart in the repository, e.g. chart/shop.";
  return null;
}

/** The sentence Build in Studio says for a build of the repository's own. */
export function ownBuildSummary(b: ProjectBuildSetting): string {
  const files = b.images.map((i) => i.dockerfile).join(", ");
  return `${b.images.length === 1 ? "the Dockerfile" : "the Dockerfiles"} ${files} and the chart ${b.chart ?? ""}`;
}
