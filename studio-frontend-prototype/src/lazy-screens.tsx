/** The screens that do not have to be in the first download.
 *
 *  Every screen used to be in one chunk: opening the sign-in page fetched the
 *  components catalogue, the document editor, the four spec-quality detectors
 *  and the domain-model graph, so the slowest moment in the product was the
 *  one before anybody had done anything.
 *
 *  What is split and what is not follows one rule: **a screen you reach by
 *  choosing it can load when you choose it; the shell cannot.** The bar, the
 *  navigation, the portfolio and the project overview are what somebody sees
 *  first and are therefore not here. Everything below sits behind a tab, an
 *  admin view or a section the reader has to ask for, and asking for it is a
 *  perfectly good moment to fetch it.
 *
 *  `Suspense` is not per-screen. One boundary around the work area means one
 *  fallback to look at and one place to reason about, and the fallback says
 *  what it is waiting for rather than spinning anonymously.
 */

import { Suspense, lazy } from "react";
import type { ComponentProps, ReactNode } from "react";

/* ── The heavy four ──────────────────────────────────────────────────────── */

/** ~2,800 lines plus the Mermaid loader. */
export const ComponentsCatalog = lazy(() =>
  import("./components-catalog").then((m) => ({ default: m.ComponentsCatalog })),
);

/** The platform's catalogue sources and sync, on Platform › Repositories:
 *  the same chunk as the catalogue. */
export const PlatformSourcesPanel = lazy(() =>
  import("./components-catalog").then((m) => ({ default: m.PlatformSourcesPanel })),
);

/** The reports, their sources and the roadmap report's tables. */
export const ReportsScreen = lazy(() => import("./reports").then((m) => ({ default: m.ReportsScreen })));

/** ~4,000 lines: the Specs list, the editor, the publish flow. */
export const DocumentsTab = lazy(() =>
  import("./documents").then((m) => ({ default: m.DocumentsTab })),
);
export const DocumentTypesTab = lazy(() =>
  import("./documents").then((m) => ({ default: m.DocumentTypesTab })),
);

/** ~2,300 lines: four detectors and everything that reads their results. */
export const SpecQuality = lazy(() =>
  import("./spec-quality").then((m) => ({ default: m.SpecQuality })),
);

/* ── Admin and object screens ────────────────────────────────────────────── */

/** Saved views over the domain model (views.tsx). */
export const ViewsScreen = lazy(() => import("./views").then((m) => ({ default: m.ViewsScreen })));
export const DomainModelAdmin = lazy(() =>
  import("./domain-model-admin").then((m) => ({ default: m.DomainModelAdmin })),
);
export const DomainModelGraph = lazy(() =>
  import("./domain-model-graph").then((m) => ({ default: m.DomainModelGraph })),
);
export const GtsEntitiesTable = lazy(() =>
  import("./gts-entities").then((m) => ({ default: m.GtsEntitiesTable })),
);
export const ObjectTypes = lazy(() =>
  import("./object-types").then((m) => ({ default: m.ObjectTypes })),
);
export const ProcessCatalogTab = lazy(() =>
  import("./process-catalog").then((m) => ({ default: m.ProcessCatalogTab })),
);
export const IdentityDirectory = lazy(() =>
  import("./identity-directory").then((m) => ({ default: m.IdentityDirectory })),
);
export const ProjectKits = lazy(() =>
  import("./kits").then((m) => ({ default: m.ProjectKits })),
);

/** What a reader sees while a screen arrives.
 *
 *  Named rather than anonymous: on a slow connection "Loading Components…" is
 *  the difference between waiting and wondering whether the click registered.
 *  It reuses the same `.empty` the screens themselves use for their own
 *  loading states, so the transition does not change shape twice.
 */
export function ScreenLoading({ what }: { what?: string }) {
  return <p className="empty">Loading{what ? ` ${what}` : ""}…</p>;
}

/** One boundary around whatever the work area is showing. */
export function LazyScreens({ children, what }: { children: ReactNode; what?: string }) {
  return <Suspense fallback={<ScreenLoading what={what} />}>{children}</Suspense>;
}

/** Props, re-exported so call sites keep their types without importing the
 *  heavy modules for them — a `import type` would be erased, but a reader
 *  reaching for the type should not have to know which module it came from. */
export type ComponentsCatalogProps = ComponentProps<typeof ComponentsCatalog>;
