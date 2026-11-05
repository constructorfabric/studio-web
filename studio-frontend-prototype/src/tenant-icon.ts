// A workspace's or a project's icon: a glyph and a colour somebody chose, or
// an image they uploaded, so one is told from another at a glance in the path
// bar, the switchers, the lists and the pinned rail.
//
// The choice is a preset — `{ glyph, color }`, two names this file defines —
// kept in the project's config (`cf.studio.project.config.v1`) or the
// workspace's settings (`cf.studio.workspace.settings.v1`). Both documents
// are free-form server-side, so their shape is this file's to keep: a value
// that names a glyph or a colour nobody defines reads as no choice. When
// there is none the icon is the one the project's kind implies.
//
// An uploaded image is not in either document — they are read in lists, and
// a list should not carry pictures. It is kept by studio-organizations as the
// tenant's logo (`/studio-organizations/v1/logo?tenant_id=`), read on first
// use per tenant (`useTenantIcon`, org-logo.ts), and wins over the preset.

import { useEffect, useSyncExternalStore } from "react";

import { api } from "./api";

export interface TenantIcon {
  glyph: string;
  color: string;
}

export type IconLevel = "workspace" | "project";

/** The glyphs one may choose, in the picker's order. Drawn by
 *  tenant-glyphs.tsx from icons.tsx. */
export const ICON_GLYPHS = [
  "folder",
  "box",
  "gear",
  "code",
  "grid",
  "layers",
  "database",
  "globe",
  "rocket",
  "sparkle",
  "star",
  "heart",
  "flag",
  "bolt",
  "leaf",
  "flask",
  "chart",
  "cloud",
  "lock",
  "shield",
  "users",
  "book",
  "bell",
  "sliders",
] as const;

/** The colours, each a `--ticon-<name>` token in styles.css. The first four
 *  are the levels' own (`--level-*-fg`). */
export const ICON_COLORS = ["violet", "blue", "green", "slate", "teal", "amber", "red", "pink"] as const;

export const ICON_COLOR_LABEL: Record<(typeof ICON_COLORS)[number], string> = {
  violet: "Violet",
  blue: "Blue",
  green: "Green",
  slate: "Slate",
  teal: "Teal",
  amber: "Amber",
  red: "Red",
  pink: "Pink",
};

/** A stored value as an icon, or null when it is not one this portal draws. */
export function parseIcon(value: unknown): TenantIcon | null {
  if (!value || typeof value !== "object") return null;
  const { glyph, color } = value as Record<string, unknown>;
  if (typeof glyph !== "string" || typeof color !== "string") return null;
  if (!(ICON_GLYPHS as readonly string[]).includes(glyph)) return null;
  if (!(ICON_COLORS as readonly string[]).includes(color)) return null;
  return { glyph, color };
}

/** The icon nobody chose: a workspace is a folder in the workspace colour; a
 *  project wears its kind — gears to build, a product to assemble, an
 *  existing app imported — in the project colour, and a project of no known
 *  kind a grid. */
export function defaultIcon(level: IconLevel, kind?: string | null): TenantIcon {
  if (level === "workspace") return { glyph: "folder", color: "blue" };
  switch (kind) {
    case "new_gears":
      return { glyph: "gear", color: "violet" };
    case "product":
      return { glyph: "box", color: "green" };
    case "existing":
      return { glyph: "code", color: "amber" };
    default:
      return { glyph: "grid", color: "violet" };
  }
}

/** The icon a tenant shows: the one chosen, else its kind's. */
export function iconOf(level: IconLevel, chosen: unknown, kind?: string | null): TenantIcon {
  return parseIcon(chosen) ?? defaultIcon(level, kind);
}

export function sameIcon(a: TenantIcon | null | undefined, b: TenantIcon | null | undefined): boolean {
  return !!a && !!b && a.glyph === b.glyph && a.color === b.color;
}

/* ── What is known of each tenant's choice, shared by every mark ── */

interface Known {
  /** The chosen icon, or null when none was chosen. */
  chosen: TenantIcon | null;
  /** A project's kind, for the default. */
  kind?: string | null;
}

const known = new Map<string, Known>();
const reading = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const l of listeners) l();
}

/** Record what a list or a config said about a tenant's icon. `kind` is
 *  kept from before when not given. */
export function rememberIcon(tenantId: string, chosen: unknown, kind?: string | null) {
  const before = known.get(tenantId);
  const next: Known = { chosen: parseIcon(chosen), kind: kind === undefined ? before?.kind : kind };
  const same =
    !!before &&
    before.kind === next.kind &&
    (before.chosen === null ? next.chosen === null : sameIcon(before.chosen, next.chosen));
  if (same) return;
  known.set(tenantId, next);
  changed();
}

/** For tests: forget everything. */
export function forgetIcons() {
  known.clear();
  reading.clear();
  changed();
}

/** What is known, or undefined when nothing has been read yet. */
export function knownIcon(tenantId: string): Known | undefined {
  return known.get(tenantId);
}

function read(token: string, level: IconLevel, tenantId: string) {
  if (known.has(tenantId) || reading.has(tenantId)) return;
  reading.add(tenantId);
  const config: Promise<{ icon?: unknown; kind?: string } | null> =
    level === "project" ? api.projectConfig(token, tenantId) : api.workspaceSettings(token, tenantId);
  config
    .then((c) => rememberIcon(tenantId, c?.icon, c?.kind ?? null))
    // Not readable here: the default, and not asked again on every render.
    .catch(() => rememberIcon(tenantId, null))
    .finally(() => reading.delete(tenantId));
}

function useIconVersion() {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

/** The icon a workspace or project shows, read from its config on first use
 *  unless a list already said. `kind` is what the caller knows of a
 *  project's kind, for the default while its config is read. */
export function usePresetIcon(
  token: string,
  level: IconLevel,
  tenantId: string | null | undefined,
  kind?: string | null,
): TenantIcon {
  useIconVersion();
  useEffect(() => {
    if (tenantId) read(token, level, tenantId);
  }, [token, level, tenantId]);
  const k = tenantId ? known.get(tenantId) : undefined;
  return k?.chosen ?? defaultIcon(level, k?.kind ?? kind);
}

/** Keep a choice, or clear it with null, in the tenant's own document: read,
 *  changed, written back whole, as every other writer of it does. */
export async function saveIcon(token: string, level: IconLevel, tenantId: string, icon: TenantIcon | null) {
  if (level === "project") {
    const current = (await api.projectConfig(token, tenantId)) ?? {};
    const next = { ...current };
    if (icon) next.icon = icon;
    else delete next.icon;
    await api.putProjectConfig(token, tenantId, next);
    rememberIcon(tenantId, icon, current.kind ?? null);
  } else {
    const current = (await api.workspaceSettings(token, tenantId)) ?? {};
    const next = { ...current };
    if (icon) next.icon = icon;
    else delete next.icon;
    await api.putWorkspaceSettings(token, tenantId, next);
    rememberIcon(tenantId, icon);
  }
}
