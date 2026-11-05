//! What the New project card asks for, decided apart from the card.
//!
//! A project is no longer created as a kind. What the product is gets
//! proposed from its specs once they are read (product-kind.ts); creating a
//! project asks only what it starts with: a name, optionally a template that
//! fills the rest in, where its code lives (a new repository, one it already
//! has, or none yet), whether a starter gear is written there, a brief and the
//! kits it takes.
//!
//! Which section shows is therefore a decision, not styling, and it lives here
//! for the same reason `tabTarget` lives in modal.ts: the branches are where it
//! goes wrong, and the rest is JSX.

/** Where the project's code starts: a repository created now, one attached
 *  now, or none yet (Sources adds them later). */
export type RepoRoad = "new" | "existing" | "none";

/** The repository road under its older name: a starter gear's two roads. */
export type RepoMode = Exclude<RepoRoad, "none">;

/** What the card was told so far that changes which sections it shows. */
export interface CreateChoices {
  road: RepoRoad;
  /** Write a starter gear into the repository. Only with a repository. */
  starterGear: boolean;
}

export interface CreateFormLayout {
  /** The repository page: a road other than "none yet". */
  repository: boolean;
  /** The starter gear's own fields: its name, directory, kind. */
  starterGear: boolean;
  /** The kit picker. */
  components: boolean;
  /** One line saying why there is no kit picker, when there is not. */
  componentsNote: boolean;
}

/** Which sections the card shows. */
export function createFormLayout(c: CreateChoices): CreateFormLayout {
  const repository = c.road !== "none";
  const starterGear = repository && c.starterGear;
  // A gear written into a store somebody else keeps is not offered a kit: a
  // kit installs with `copy` across every repository the project has, and
  // that one already belongs to the gears in it.
  const sharedStore = starterGear && c.road === "existing";
  return { repository, starterGear, components: !sharedStore, componentsNote: sharedStore };
}

/** One page of the New project card. */
export type StepKey = "project" | "repository" | "brief" | "components";

export interface CreateStep {
  key: StepKey;
  label: string;
  /** What this page is for, under its title — a wizard that only numbers its
   *  pages makes people click through to find out what each one wants. */
  hint: string;
}

/** The pages the card walks, in order.
 *
 *  Not a fixed list: the kit page goes when a gear is written into a shared
 *  store (see `createFormLayout`). The page count therefore changes with the
 *  answers, which is why nothing may hold on to a page INDEX across such a
 *  change — `clampStep` exists for exactly that. */
export function createSteps(c: CreateChoices): CreateStep[] {
  const layout = createFormLayout(c);
  const steps: CreateStep[] = [
    {
      key: "project",
      label: "Project",
      hint: "What to call it, and a template to start from if one fits. What the product is, is decided later, from its specs.",
    },
    {
      key: "repository",
      label: "Sources",
      hint: "Where its code lives: a new repository, one it already has, or none yet. A starter gear can be written there.",
    },
    {
      key: "brief",
      label: "Brief",
      hint: layout.starterGear
        ? "What is being built. Becomes the problem statement in the starter gear's PRD."
        : "What is being built. Becomes the PRD's first answer, which is what the specs and the product's kind are read from.",
    },
  ];
  if (layout.components) {
    steps.push({
      key: "components",
      label: "Components",
      hint: "What the project takes from the shared catalogue. All optional.",
    });
  }
  return steps;
}

/** Keep a page index inside a list that just changed length. */
export function clampStep(index: number, steps: readonly CreateStep[]): number {
  if (steps.length === 0) return 0;
  return Math.min(Math.max(index, 0), steps.length - 1);
}

/** Why this page cannot be left yet, as a sentence, or `null`.
 *
 *  Per page rather than per form: a wizard that validates everything on the
 *  last page is a long form with extra clicks. */
export function stepBlocker(
  step: StepKey,
  form: CreateChoices & {
    name: string;
    connectionId: string;
    repoPicked: boolean;
    /** Why the plugin gear cannot be scaffolded as asked (see
     *  `pluginBlocker`), or null/absent when it can or is not a plugin. */
    pluginProblem?: string | null;
  },
): string | null {
  if (step === "project") return form.name.trim() ? null : "Name the project.";
  if (step === "repository") {
    const repo = repoBlocker(form.road, form.connectionId, form.repoPicked);
    if (repo) return repo;
    return form.starterGear && form.road !== "none" ? (form.pluginProblem ?? null) : null;
  }
  return null;
}

/** Why the repository road cannot be taken yet, as a sentence for the button
 *  to show, or `null` when nothing is missing.
 *
 *  Creating a repository needs neither: the backend resolves "the first GitHub
 *  connection" itself and names the repository after the project. Attaching an
 *  existing one needs both, because there is no listing without a connection
 *  to list through and no target without a row picked from it. */
export function repoBlocker(road: RepoRoad, connectionId: string, repoPicked: boolean): string | null {
  if (road !== "existing") return null;
  if (!connectionId) return "Pick the connection that holds the repository.";
  if (!repoPicked) return "Pick the repository.";
  return null;
}

/** The mode a project is created in: attaching code it already has is a
 *  modernization, unless only a starter gear goes into it. */
export function createMode(c: CreateChoices): "greenfield" | "modernize" {
  return c.road === "existing" && !c.starterGear ? "modernize" : "greenfield";
}

/** `https://github.com/Owner/Repo.git`, `owner/repo` -> `owner/repo`. The
 *  backend's `repo_key`, so both sides agree on what "the same repository" is. */
export function repoKey(value: string): string {
  let v = value.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const scheme = v.indexOf("://");
  if (scheme >= 0) v = v.slice(scheme + 3);
  const parts = v.split("/").filter(Boolean);
  return parts.slice(-2).join("/").toLowerCase();
}

/** Why a plugin gear cannot be scaffolded as the form stands, or null.
 *
 *  A plugin names the point it fills by the point's GTS spec, and the engine
 *  joins that across sources -- so it can live in the project's own repository
 *  or in the corpus alike. What it cannot do without is an engine to list the
 *  hosts, and a host picked from that list. `repoMode` and `storeRepo` are kept
 *  in the signature for the caller's form state; neither decides anything now. */
export function pluginBlocker(form: {
  repoMode: RepoRoad;
  storeRepo: string | null;
  /** The corpus the hosts come from, as the engine status reports it. */
  corpusUrl: string | null;
  host: string;
}): string | null {
  if (!form.corpusUrl) return "The Gearbox engine is not configured here, so there is no host to fill.";
  if (!form.host) return "Pick the host whose extension point the plugin fills.";
  return null;
}
