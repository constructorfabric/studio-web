/**
 * The two-level catalogue (ADR-0061), as the Components page shows it.
 *
 * - The organization's catalogue: the platform's components (which it sees,
 *   cannot hide, and may pin to a version: its "platform release") and its
 *   own.
 * - A project's catalogue: the organization's and the project's own
 *   components, found in its repositories by their passports (`gear.gdl`,
 *   `frontx.gdl`, `service.gdl`, `kit.gdl`) and visible to that project only.
 *   A project proposes one of its own to the organization at a version.
 *
 * Pure: what to show for a node and its profile. The view is
 * `catalogue-levels-view.tsx`.
 */
import type { CatalogNode, ComponentTier, PlatformPinSource } from "./api";

export const SERVICE_TYPE = "gts.cf.studio.catalog.service.v1~";
export const KIT_TYPE = "gts.cf.studio.catalog.kit.v1~";
export const FRONTX_TYPE = "gts.cf.studio.catalog.frontx.v1~";
export const GEAR_TYPE = "gts.cf.studio.catalog.gear.v1~";

/** Which passport a node was read from. */
export function passportFile(node: CatalogNode): "service.gdl" | "kit.gdl" | "frontx.gdl" | "gear.gdl" | null {
  if (node.type_id === SERVICE_TYPE) return "service.gdl";
  if (node.type_id === KIT_TYPE) return node.value.passport_path ? "kit.gdl" : null;
  if (node.type_id === FRONTX_TYPE) return "frontx.gdl";
  if (node.type_id === GEAR_TYPE) return node.value.synced_from ? "gear.gdl" : null;
  return null;
}

/** The node's tier; a node that says none is the organization's. */
export function tierOf(node: CatalogNode): ComponentTier {
  const t = node.value.tier;
  return t === "platform" || t === "project" ? t : "organization";
}

/** What the tiers are called on the page. */
export const TIER_LABEL: Record<ComponentTier, string> = {
  platform: "Platform",
  organization: "Organization",
  project: "This project",
};

/** Nodes by tier, platform first, each sorted by name. */
export function byTier(nodes: CatalogNode[]): { tier: ComponentTier; nodes: CatalogNode[] }[] {
  const order: ComponentTier[] = ["project", "organization", "platform"];
  return order
    .map((tier) => ({
      tier,
      nodes: nodes
        .filter((n) => tierOf(n) === tier)
        .sort((a, b) => String(a.value.name ?? "").localeCompare(String(b.value.name ?? ""))),
    }))
    .filter((g) => g.nodes.length > 0);
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** A profile field's value as text: the scan writes `{ v, b }` cells. */
function cell(auto: Record<string, unknown> | undefined, key: string): string | null {
  const v = auto?.[key];
  if (typeof v === "string") return text(v);
  if (Array.isArray(v)) return strings(v).join(", ") || null;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return text(o.b) ?? text(o.v) ?? (Array.isArray(o.v) ? strings(o.v).join(", ") : null);
  }
  return null;
}

/** The passport's facts worth a row, label to value, in a fixed order. */
export function passportFacts(node: CatalogNode, profile?: Record<string, unknown>): [string, string][] {
  const v = node.value;
  const auto = (profile?.auto ?? undefined) as Record<string, unknown> | undefined;
  const out: [string, string | null][] = [];
  const dict = (d: unknown) =>
    d && typeof d === "object" && !Array.isArray(d)
      ? Object.entries(d as Record<string, unknown>)
          .map(([k, x]) => `${k}: ${String(x)}`)
          .join(", ") || null
      : null;
  if (node.type_id === SERVICE_TYPE) {
    out.push(
      ["Version", text(v.version)],
      ["Image", text(v.image)],
      ["Dockerfile", text(v.dockerfile)],
      ["Context", text(v.context)],
      ["Ports", dict(v.ports)],
      ["Health", text(v.health)],
      ["Environment", dict(v.env)],
      ["Requires", strings(v.requires).join(", ") || null],
      ["Provides", strings(v.provides).join(", ") || null],
    );
  } else if (node.type_id === KIT_TYPE) {
    out.push(
      ["Version", text(v.version)],
      ["Publisher", text(v.publisher)],
      ["Visibility", text(v.visibility)],
      ["Artifact kinds", strings(v.kinds).join(", ") || null],
      ["Manifest", text(v.manifest_path)],
    );
  } else if (node.type_id === FRONTX_TYPE) {
    out.push(
      ["Kind", cell(auto, "frontx_kind")],
      ["Version", cell(auto, "version")],
      ["FrontX", cell(auto, "mfe_frontx")],
      ["Requires", cell(auto, "mfe_calls")],
      ["Roles", cell(auto, "mfe_roles")],
      ["Preview", cell(auto, "mfe_preview")],
      ["Signs in", auto && "shell_signin" in auto ? cell(auto, "shell_signin") : null],
      ["Runtime env", cell(auto, "shell_runtime_env_path")],
      ["API prefix", cell(auto, "shell_api_prefix")],
      ["Node", cell(auto, "shell_node")],
      ["Build", cell(auto, "shell_build")],
      ["Passport drift", cell(auto, "frontx_passport_drift")],
      ["Passport error", cell(auto, "frontx_gdl_error")],
    );
  } else {
    out.push(
      ["Kind", text(v.kind)],
      ["Version", text(v.max_version) ?? text(v.newest_version) ?? text(v.version)],
      ["Path", text(v.repo_path)],
    );
  }
  if (v.pinned_ref) out.push(["Pinned at", text(v.pinned_ref)]);
  const from = v.published_from as Record<string, unknown> | undefined;
  if (from) out.push(["Published from", `${text(from.project_name) ?? text(from.project_id) ?? "a project"} @ ${text(from.git_ref) ?? "?"}`]);
  return out.filter((r): r is [string, string] => r[1] !== null);
}

/** The component's documents, from the repository root. */
export function docsOf(node: CatalogNode): string[] {
  return strings(node.value.docs);
}

/** Where a document is on the host, without reading it. */
export function docLink(node: CatalogNode, path: string): string | null {
  const repo = text(node.value.synced_from);
  if (!repo || repo.startsWith("publication:")) return null;
  const ref = text(node.value.git_ref) ?? "HEAD";
  return `https://github.com/${repo}/blob/${ref}/${path}`;
}

/** Only a project's own component is proposed to the organization. */
export function mayPropose(node: CatalogNode): boolean {
  return tierOf(node) === "project";
}

/** One row of the platform-release editor: a platform source and the ref
 *  typed for it ("" follows the platform). */
export interface PinRow {
  repo: string;
  platformRef: string;
  pinned: string;
}

export function pinRows(sources: PlatformPinSource[]): PinRow[] {
  return sources.map((s) => ({ repo: s.repo, platformRef: s.git_ref, pinned: s.pinned_ref ?? "" }));
}

/** The pins to save from the rows: one per row with a ref typed. */
export function pinsFrom(rows: PinRow[]): { repo: string; git_ref: string }[] {
  return rows.filter((r) => r.pinned.trim()).map((r) => ({ repo: r.repo, git_ref: r.pinned.trim() }));
}
