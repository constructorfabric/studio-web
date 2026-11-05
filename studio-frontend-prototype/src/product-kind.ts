/* ── What the product is, proposed from the specs ────────────────────────────
 *
 * A project no longer says at creation what it will be. What it is built on,
 * and so how it is built and rolled out, is decided once its specs say what
 * is wanted: Studio proposes a kind with the reasons it read, and a member
 * confirms it or picks another. The choice is kept in the project's
 * configuration as `product_kind`.
 *
 *   - a full product on the platform's gears: gears and a FrontX frontend,
 *     assembled by Gearbox from product.gdl, built and deployed by Studio;
 *   - a gear service: gears and their APIs, no screens;
 *   - a FrontX app: screens in a FrontX shell over gears that already run;
 *   - built from its own source: its own Dockerfiles and CI, which Studio
 *     does not compose.
 *
 * No backend route proposes a kind yet, so the proposal is read here, from
 * what the project already holds: its brief, the capabilities and
 * requirements its documents declare, the components its own repositories
 * hold (their passports, ADR-0061), and the product record. Experimental: the
 * rules are word matches and counts, and say so in their reasons.
 *
 * Pure, so it is tested without a backend; product-kind-view.tsx reads the
 * facts and draws the step. */

export type ProductKind = "gear_product" | "gear_service" | "frontx_app" | "source_built";

export interface ProductKindInfo {
  id: ProductKind;
  title: string;
  /** What it is, in a line. */
  what: string;
  /** How it is built and rolled out. */
  builds: string;
}

export const PRODUCT_KINDS: readonly ProductKindInfo[] = [
  {
    id: "gear_product",
    title: "Full product on gears",
    what: "Gears for the backend and a FrontX shell with micro-frontends for the screens.",
    builds: "Gearbox assembles it from product.gdl; Studio builds the images and the chart and deploys them.",
  },
  {
    id: "gear_service",
    title: "Gear service",
    what: "Gears and their APIs, with no screens of its own.",
    builds: "Gearbox assembles it from product.gdl, with gears only; Studio builds and deploys it.",
  },
  {
    id: "frontx_app",
    title: "FrontX app",
    what: "Screens in a FrontX shell over gears the platform or the organization already runs.",
    builds: "The FrontX shell and its micro-frontends are built into one image; product.gdl names the frontend.",
  },
  {
    id: "source_built",
    title: "Built from its own source",
    what: "Its own services, with their own Dockerfiles or CI, not composed from gears.",
    builds: "Its own CI or a BuildKit build of its Dockerfiles; Studio records the images and deploys them.",
  },
];

export const KIND_TITLE: Record<ProductKind, string> = Object.fromEntries(
  PRODUCT_KINDS.map((k) => [k.id, k.title]),
) as Record<ProductKind, string>;

/** The confirmed kind, as the project's configuration keeps it. */
export interface ProductKindChoice {
  kind: ProductKind;
  /** What Studio proposed when it was confirmed: a confirmed kind that
   *  differs from it is somebody's decision against the reading. */
  proposed?: ProductKind | null;
  confirmed_by?: string | null;
  /** RFC 3339. */
  confirmed_at: string;
}

const KIND_IDS = new Set<string>(PRODUCT_KINDS.map((k) => k.id));

/** A stored choice, or null when there is none or it cannot be read. */
export function readKindChoice(raw: unknown): ProductKindChoice | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string" || !KIND_IDS.has(r.kind)) return null;
  return {
    kind: r.kind as ProductKind,
    proposed: typeof r.proposed === "string" && KIND_IDS.has(r.proposed) ? (r.proposed as ProductKind) : null,
    confirmed_by: typeof r.confirmed_by === "string" ? r.confirmed_by : null,
    confirmed_at: typeof r.confirmed_at === "string" ? r.confirmed_at : "",
  };
}

/** What the proposal reads. `null` for a read that failed: it then counts as
 *  nothing, and the reasons say what could not be read. */
export interface KindFacts {
  /** The brief the project was created with. */
  brief?: string | null;
  /** The capabilities its documents declare, with the titles of the documents
   *  that declare them. */
  capabilities: { key: string; from: string[] }[] | null;
  /** The non-functional statements its documents make. */
  requirements: string[] | null;
  /** The components the project's own repositories hold, by passport. */
  ownComponents: { gears: number; frontx: number; services: number } | null;
  /** The product record. */
  product: { gears: number; frontend: boolean } | null;
}

export interface KindProposal {
  kind: ProductKind;
  /** Why, one sentence each, in the order they weigh. */
  reasons: string[];
  /** How much there was to read: `none` proposes the default. */
  basis: "specs" | "sources" | "none";
  /** The kinds after it, best first. */
  alternatives: ProductKind[];
}

const SCREEN_WORDS =
  /\b(ui|screens?|pages?|dashboards?|portal|web ?app|frontend|front-end|user interface|forms?|wizard|log ?in|sign[- ]in|mobile|browser|admin panel)\b/gi;
const API_WORDS =
  /\b(apis?|services?|endpoints?|rest|grpc|graphql|backend|back-end|integrations?|webhooks?|workers?|queues?|events?|storage|database|persist\w*|tenants?|authori[sz]\w*)\b/gi;
const SOURCE_WORDS =
  /\b(dockerfiles?|docker|helm|existing (?:app|application|service|system|codebase)|legacy|monolith|spring|django|rails|laravel|\.net|java|node\.?js|golang|python service)\b/gi;

/** The distinct words a pattern found, lower-cased, at most `n`. */
function found(re: RegExp, text: string, n = 3): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) {
    seen.add(m[0].toLowerCase());
    if (seen.size >= n) break;
  }
  return [...seen];
}

const quoted = (words: string[]) => words.map((w) => `“${w}”`).join(", ");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Studio's proposal: the kind the facts point to, and why. */
export function proposeKind(f: KindFacts): KindProposal {
  const score: Record<ProductKind, number> = { gear_product: 0, gear_service: 0, frontx_app: 0, source_built: 0 };
  const reasons: string[] = [];
  let screens = 0;
  let apis = 0;
  let source = 0;

  // The specs: the brief, the capabilities and their documents, the
  // requirements. Words only: a capability is named by what it does.
  const specText = [
    f.brief ?? "",
    ...(f.capabilities ?? []).flatMap((c) => [c.key.replace(/[._-]+/g, " "), ...c.from]),
    ...(f.requirements ?? []),
  ].join("\n");
  const s = found(SCREEN_WORDS, specText);
  const a = found(API_WORDS, specText);
  const o = found(SOURCE_WORDS, specText);
  if (s.length) {
    screens += s.length;
    reasons.push(`The specs speak of screens: ${quoted(s)}.`);
  }
  if (a.length) {
    apis += a.length;
    reasons.push(`They speak of services and data: ${quoted(a)}.`);
  }
  if (o.length) {
    source += o.length * 2;
    reasons.push(`They speak of code of its own: ${quoted(o)}.`);
  }
  const caps = f.capabilities?.length ?? 0;
  if (caps > 0) {
    apis += 1;
    reasons.push(`Its documents declare ${plural(caps, "capability", "capabilities")}, which gears can cover.`);
  }

  // The repositories: what their passports say they hold.
  const own = f.ownComponents;
  if (own) {
    if (own.gears > 0) {
      apis += 2;
      reasons.push(`Its repositories hold ${plural(own.gears, "gear")} (gear.gdl).`);
    }
    if (own.frontx > 0) {
      screens += 2;
      reasons.push(`They hold ${plural(own.frontx, "FrontX package")} (frontx.gdl).`);
    }
    if (own.services > 0) {
      source += 3;
      reasons.push(`They hold ${plural(own.services, "service")} of their own, not gears (service.gdl).`);
    }
  }

  // The product as configured so far.
  if (f.product) {
    if (f.product.gears > 0) {
      apis += 2;
      reasons.push(`The product already picks ${plural(f.product.gears, "gear")}.`);
    }
    if (f.product.frontend) {
      screens += 2;
      reasons.push("The product already has a frontend.");
    }
  }

  const unread = [
    f.capabilities === null ? "the declared capabilities" : "",
    f.requirements === null ? "the requirements" : "",
    f.ownComponents === null ? "the project's own components" : "",
    f.product === null ? "the product" : "",
  ].filter(Boolean);
  if (unread.length) reasons.push(`Could not read ${unread.join(", ")}.`);

  const specsSaid = s.length + a.length + o.length + caps > 0;
  const sourcesSaid = !!own && own.gears + own.frontx + own.services > 0;
  const basis: KindProposal["basis"] = specsSaid ? "specs" : sourcesSaid || (f.product?.gears ?? 0) > 0 ? "sources" : "none";

  // Own code without gears is built from its own source; gears beside it
  // still make it a product on gears.
  score.source_built = source - (own?.gears ?? 0) * 2 - (f.product?.gears ?? 0);
  score.gear_product = Math.min(screens, apis) * 2 + (screens > 0 && apis > 0 ? 2 : 0);
  score.frontx_app = screens - apis;
  score.gear_service = apis - screens;

  let kind: ProductKind;
  if (basis === "none") {
    kind = "gear_product";
    reasons.unshift("The specs say too little yet to tell; a full product on gears is where most projects start.");
  } else {
    kind = (Object.entries(score) as [ProductKind, number][]).sort((x, y) => y[1] - x[1])[0][0];
    if (score[kind] <= 0) kind = "gear_product";
  }
  const alternatives = PRODUCT_KINDS.map((k) => k.id)
    .filter((k) => k !== kind)
    .sort((x, y) => score[y] - score[x]);
  return { kind, reasons, basis, alternatives };
}

/** The step as the project's path shows it: confirmed, proposed, or waiting
 *  for the specs. */
export function kindStatus(choice: ProductKindChoice | null, proposal: KindProposal | null): {
  done: boolean;
  text: string;
} {
  if (choice) {
    const against = choice.proposed && choice.proposed !== choice.kind ? ` (Studio proposed ${KIND_TITLE[choice.proposed]})` : "";
    return { done: true, text: `${KIND_TITLE[choice.kind]}, confirmed${against}.` };
  }
  if (!proposal) return { done: false, text: "Not decided yet." };
  return {
    done: false,
    text:
      proposal.basis === "none"
        ? `Not decided yet: the specs say too little, so Studio proposes ${KIND_TITLE[proposal.kind]}.`
        : `Not decided yet: Studio proposes ${KIND_TITLE[proposal.kind]}. Confirm it or pick another.`,
  };
}

/** The configuration with the choice in it. */
export function withKind<T extends object>(cfg: T, kind: ProductKind, proposed: ProductKind | null, by: string | null, now = new Date()): T & {
  product_kind: ProductKindChoice;
} {
  return { ...cfg, product_kind: { kind, proposed, confirmed_by: by, confirmed_at: now.toISOString() } };
}
