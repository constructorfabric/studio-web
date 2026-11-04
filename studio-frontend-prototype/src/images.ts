/* A project's images (studio-environments `/images`): every image and chart
 * its builds, promotions and imports put in a registry, as Studio recorded
 * them -- where each runs, whether it may be deleted, where it may be
 * promoted to, and how long the retention keeps it. Releases shows them in
 * its Images step (project-images.tsx).
 *
 * Pure, so it is tested without a backend. The server checks every rule here
 * again; these say why a button is off before anybody presses it. */

import type { DeployEnvironment, ImageRetention, ImageRunning, ProjectImage } from "./api";

/** The images of one app, or one chart, newest first. */
export interface ImageGroup {
  key: string;
  /** The values key the build gave it; the repository's last segment when it has none. */
  name: string;
  kind: ProjectImage["kind"];
  images: ProjectImage[];
}

/** The last segment of a repository: `acme/web/api` is `api`. */
function lastSegment(repository: string): string {
  return repository.split("/").filter(Boolean).at(-1) ?? repository;
}

/** Images grouped by app, then charts, each group by name and newest first
 *  inside it. An image the build named no app for is grouped by its
 *  repository, so an imported `mirror/postgres` is a group of its own. */
export function groupImages(images: readonly ProjectImage[]): ImageGroup[] {
  const groups = new Map<string, ImageGroup>();
  for (const i of images) {
    const name = i.app || lastSegment(i.repository);
    const key = `${i.kind}:${i.app ? `app:${i.app}` : `repo:${i.repository}`}`;
    const g = groups.get(key) ?? { key, name, kind: i.kind, images: [] };
    g.images.push(i);
    groups.set(key, g);
  }
  const out = [...groups.values()];
  for (const g of out) g.images.sort((a, b) => b.pushed_at.localeCompare(a.pushed_at));
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "image" ? -1 : 1));
}

/** `sha256:0123456789ab`: enough of a digest to tell two apart. */
export function shortDigest(digest: string): string {
  const [algo, hex] = digest.includes(":") ? digest.split(":", 2) : ["", digest];
  return algo ? `${algo}:${hex.slice(0, 12)}` : hex.slice(0, 12);
}

/** Where something runs, in a sentence: the environments by name, each
 *  once, with the namespace when one environment has it in two. */
export function whereItRuns(running: readonly ImageRunning[]): string {
  if (running.length === 0) return "Runs nowhere.";
  const names = [...new Set(running.map((r) => r.environment_name))];
  const twice = names.length < running.length;
  const parts = twice ? running.map((r) => `${r.environment_name} (${r.namespace})`) : names;
  return `Runs in ${listWords(parts)}.`;
}

/** `a`, `a and b`, `a, b and c`. */
function listWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Whether an action may be taken, and why not when it may not. */
export interface Allowed {
  allowed: boolean;
  reason: string | null;
}

/** What may be done with an image: delete it, promote it and where to, pin it. */
export interface ImageActions {
  delete: Allowed;
  promote: Allowed;
  /** The environments it may be copied to: those that pull from another registry. */
  promoteTargets: DeployEnvironment[];
  /** Pin keeps it whatever the retention says; Unpin lets the retention decide again. */
  pin: "pin" | "unpin" | null;
}

/** The host a registry prefix names: `ghcr.io/acme` is `ghcr.io`. */
export function prefixHost(prefix: string): string {
  return prefix.trim().split("/")[0] ?? "";
}

/** Whether an environment pulls from the registry an image is in: the same
 *  registry connection, or, when the image names none, the same host. */
export function inRegistryOf(image: Pick<ProjectImage, "registry_connection_id" | "registry_host">, e: DeployEnvironment): boolean {
  if (image.registry_connection_id && e.registry_connection_id) return image.registry_connection_id === e.registry_connection_id;
  return prefixHost(e.registry) === image.registry_host;
}

/** Gone from the registry, or never found there: nothing can be done with it
 *  but read its record. */
function gone(image: Pick<ProjectImage, "state">): boolean {
  return image.state === "deleted" || image.state === "missing";
}

/** What may be done with an image: a running or pinned one is not deleted --
 *  a pod restarting would pull nothing -- and a promotion goes to an
 *  environment whose registry is another one, as a copy into the same one
 *  would change nothing. */
export function imageActions(image: ProjectImage, environments: readonly DeployEnvironment[]): ImageActions {
  const targets = environments.filter((e) => e.kind !== "research" && e.registry.trim() !== "" && !inRegistryOf(image, e));
  const deletion: Allowed = gone(image)
    ? { allowed: false, reason: image.state === "deleted" ? "It is deleted already." : "The registry no longer has it." }
    : image.running_in.length > 0
      ? { allowed: false, reason: `${whereItRuns(image.running_in)} Deploy something else there first.` }
      : image.pinned
        ? { allowed: false, reason: "It is pinned: unpin it first." }
        : { allowed: true, reason: null };
  const promote: Allowed = gone(image)
    ? { allowed: false, reason: "The registry no longer has it." }
    : targets.length === 0
      ? { allowed: false, reason: "No environment pulls from another registry." }
      : { allowed: true, reason: null };
  return { delete: deletion, promote, promoteTargets: targets, pin: gone(image) ? null : image.pinned ? "unpin" : "pin" };
}

/** What the retention keeps, in a sentence, and whose setting it is. */
export function retentionSummary(r: ImageRetention | null | undefined): string {
  if (!r) return "Every image is kept.";
  const last = r.keep_last ?? null;
  const days = r.keep_days ?? null;
  const whose = r.inherited || r.scope === "organization" ? " This is the organization's setting." : "";
  let what: string;
  if (last === null && days === null) what = "Every image is kept.";
  else if (last !== null && days !== null)
    what = `Keeps the newest ${last} of each app and anything pushed in the last ${days} day${days === 1 ? "" : "s"}.`;
  else if (last !== null) what = `Keeps the newest ${last} of each app.`;
  else what = `Keeps what was pushed in the last ${days} day${days === 1 ? "" : "s"}.`;
  const always = last !== null || days !== null ? " What runs somewhere and what is pinned is always kept." : "";
  return `${what}${always}${whose}`;
}

/** What is wrong with a retention form; `null` when it can be saved. An
 *  empty field is no limit. */
export function retentionProblem(keepLast: string, keepDays: string): string | null {
  const bad = (s: string, most: number) => {
    if (s.trim() === "") return false;
    const n = Number(s);
    return !Number.isInteger(n) || n < 1 || n > most;
  };
  if (bad(keepLast, 1000)) return "Keep from 1 to 1000 images of each app, or leave it empty.";
  if (bad(keepDays, 3650)) return "Keep from 1 to 3650 days, or leave it empty.";
  return null;
}

const HOST = /^(localhost|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+)(:\d{1,5})?$/;
const COMPONENT = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** An image reference taken apart: `host/path[:tag][@digest]`. */
export interface ImageRef {
  host: string;
  path: string;
  tag: string | null;
  digest: string | null;
}

/** `docker.io/library/postgres:16` taken apart; `null` when it is not one. */
export function parseImageRef(source: string): ImageRef | null {
  const s = source.trim();
  if (s === "" || s.includes("://") || /\s/.test(s)) return null;
  const [name, digest = null, ...more] = s.split("@");
  if (more.length > 0) return null;
  const slash = name.indexOf("/");
  if (slash < 0) return null;
  const host = name.slice(0, slash);
  let rest = name.slice(slash + 1);
  let tag: string | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  return { host, path: rest, tag, digest };
}

/** What is wrong with an external image to import, in the words a person
 *  reads; `null` when it can be asked for. A tag or a digest is required:
 *  `latest` moves, and a mirror is kept for what it was. */
export function importSourceProblem(source: string): string | null {
  const s = source.trim();
  if (s === "") return "Name the image, e.g. docker.io/library/postgres:16.";
  if (s.includes("://")) return "Write the image without a scheme, e.g. docker.io/library/postgres:16.";
  const ref = parseImageRef(s);
  if (!ref || !HOST.test(ref.host))
    return "Name the registry too, e.g. docker.io/library/postgres:16, quay.io/org/name@sha256:… or ghcr.io/org/name:tag.";
  if (ref.path === "" || !ref.path.split("/").every((c) => COMPONENT.test(c)))
    return "The image's path takes lowercase letters, digits and . _ - between slashes.";
  if (ref.tag !== null && !TAG.test(ref.tag)) return `"${ref.tag}" is not a tag.`;
  if (ref.digest !== null && !DIGEST.test(ref.digest)) return "A digest is sha256: and 64 lowercase hex digits.";
  if (ref.tag === null && ref.digest === null) return "Name a tag or a digest, e.g. :16: latest moves under the mirror.";
  return null;
}

/** The name an imported image is mirrored under, unless another is given:
 *  the last segment of its path, without tag or digest. */
export function defaultMirrorName(source: string): string {
  const ref = parseImageRef(source);
  if (ref) return lastSegment(ref.path);
  const bare = source.trim().split("@")[0].split("/").at(-1) ?? "";
  return bare.split(":")[0];
}

/** What is wrong with a mirror name; `null` when it will do. */
export function mirrorNameProblem(name: string): string | null {
  const n = name.trim();
  if (n === "") return null;
  return n.split("/").every((c) => COMPONENT.test(c)) ? null : "Lowercase letters, digits and . _ - only, like postgres.";
}

/** Where an import lands: the project's own path of the environment's
 *  registry, under `mirror/`. */
export function mirrorPath(registryPrefix: string, projectSlug: string, name: string): string {
  return [registryPrefix.replace(/\/+$/, ""), projectSlug, "mirror", name].filter(Boolean).join("/");
}

/** The record of one image a build published, matched to its row: by the
 *  build and the app, or by the reference itself. */
export function recordFor(
  output: { app: string; image: string },
  records: readonly ProjectImage[],
  buildId?: string,
): ProjectImage | null {
  const digestOf = (ref: string) => ref.split("@")[1] ?? null;
  return (
    records.find((r) => r.reference === output.image) ??
    records.find((r) => !!digestOf(output.image) && r.digest === digestOf(output.image)) ??
    records.find((r) => r.app === output.app && (!buildId || r.build_id === buildId) && r.kind === "image") ??
    null
  );
}

/** A size as people read it. */
export function sizeText(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let n = bytes / 1024;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

/** What the server refuses an image's deletion with (a 409): what it means. */
export const IMAGE_REFUSALS: Record<string, string> = {
  IMAGE_RUNNING: "It runs in an environment: deploy something else there first.",
  IMAGE_PINNED: "It is pinned: unpin it first.",
};

/** The image refusal a failed request carries, as a sentence; `null` for
 *  any other failure. A failed precondition names its code in a violation. */
export function imageRefusalText(e: unknown): string | null {
  const carrier = e as { problem?: { context?: { violations?: unknown[] } }; body?: { context?: { violations?: unknown[]; code?: unknown }; code?: unknown } } | null;
  const violations = carrier?.problem?.context?.violations ?? carrier?.body?.context?.violations ?? [];
  const codes = [
    ...violations.flatMap((v) => {
      const r = v as Record<string, unknown> | null;
      return ["type", "type_", "subject", "code"].map((k) => r?.[k]);
    }),
    carrier?.body?.code,
  ];
  for (const code of codes) if (typeof code === "string" && code in IMAGE_REFUSALS) return IMAGE_REFUSALS[code];
  return null;
}
