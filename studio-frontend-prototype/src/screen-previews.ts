/* The pictures a build took of a micro-frontend's screens
 * (scripts/mfe-screen-previews.mjs), as the product map shows them. */

import type { ScreenPreview } from "./api";

/** One build's pictures of one micro-frontend: its screens in the build's order. */
export type PreviewBuild = { commit: string; version: string | null; capturedAt: string; screens: ScreenPreview[] };

/**
 * The build whose pictures a card shows for the version the catalogue lists.
 *
 * `items` are the newest build first, as the catalogue answers them. With a
 * version, the newest build of that version, or none: a picture of another
 * version is not this one. Without one (a package the catalogue knows no
 * version of), the newest build.
 */
export function previewBuild(items: readonly ScreenPreview[], version: string | null): PreviewBuild | null {
  const usable = items.filter((p) => p.image.startsWith("data:image/") && (version === null || p.version === version));
  const first = usable[0];
  if (!first) return null;
  const screens = usable.filter((p) => p.commit === first.commit).sort((a, b) => a.order - b.order || a.route.localeCompare(b.route));
  const capturedAt = screens.reduce((at, p) => (p.captured_at > at ? p.captured_at : at), "");
  return { commit: first.commit, version: first.version, capturedAt, screens };
}

/** A commit as a tag shows it: a hash cut to seven, a name as it is. */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{8,}$/i.test(commit) ? commit.slice(0, 7) : commit;
}

/**
 * The picture of one place a micro-frontend shows, out of a build's: by its
 * route, or by its label when it has no route. A place the build did not
 * open (an overlay, a popup, a screen added since) has none.
 */
export function pictureOf(build: PreviewBuild | null, place: { route: string | null; label: string | null }): ScreenPreview | null {
  if (!build) return null;
  if (place.route) return build.screens.find((s) => s.route === place.route) ?? null;
  const label = place.label?.trim().toLowerCase();
  return (label && build.screens.find((s) => s.label?.trim().toLowerCase() === label)) || null;
}
