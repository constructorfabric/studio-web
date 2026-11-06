/* How a project builds (ADR-0054 §7): on gears, from its product.gdl, or
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
    const paths = valuesPathsProblem(i);
    if (paths) return paths;
  }
  if (!isRepoPath(b.chart ?? "")) return "Name the folder of the Helm chart in the repository, e.g. chart/shop.";
  return null;
}

/** The values paths of an image a chart may read elsewhere than Gearbox's
 *  convention, each with its default. */
export const VALUES_PATHS = [
  { key: "repository_path", label: "Repository", fallback: (app: string) => `${app}.image.repository` },
  { key: "tag_path", label: "Tag", fallback: (app: string) => `${app}.image.tag` },
  { key: "image_path", label: "Whole image", fallback: () => "" },
  { key: "secret_name_path", label: "Secret name", fallback: (app: string) => `${app}.existingSecret` },
  { key: "secret_keys_path", label: "Secret keys", fallback: (app: string) => `${app}.secretKeys` },
] as const;

const VALUES_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,11}$/;

/** What is wrong with where an image's chart reads it, as the server says it. */
export function valuesPathsProblem(i: OwnImage): string | null {
  const given = (p?: string | null) => (p ?? "").trim();
  for (const { key } of VALUES_PATHS) {
    const p = given(i[key]);
    if (p !== "" && (p.length > 200 || !VALUES_PATH.test(p)))
      return `"${p}" (${i.app}) is not a values path: keys of letters, digits, '_' and '-' joined by '.', e.g. backend.image.repository.`;
  }
  if (given(i.image_path) !== "" && (given(i.repository_path) !== "" || given(i.tag_path) !== ""))
    return `${i.app}: the chart reads its image as one string or as repository and tag, not both.`;
  const app = i.app.trim();
  const at = (key: (typeof VALUES_PATHS)[number]["key"]) => given(i[key]) || VALUES_PATHS.find((v) => v.key === key)!.fallback(app);
  const used =
    given(i.image_path) !== ""
      ? [given(i.image_path), at("secret_name_path"), at("secret_keys_path")]
      : [at("repository_path"), at("tag_path"), at("secret_name_path"), at("secret_keys_path")];
  const twice = used.find((p, n) => used.indexOf(p) !== n);
  return twice ? `${i.app}: values path "${twice}" is named twice.` : null;
}

/** The sentence Build in Studio says for a build of the repository's own. */
export function ownBuildSummary(b: ProjectBuildSetting): string {
  const files = b.images.map((i) => i.dockerfile).join(", ");
  return `${b.images.length === 1 ? "the Dockerfile" : "the Dockerfiles"} ${files} and the chart ${b.chart ?? ""}`;
}
