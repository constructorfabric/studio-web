/* The top of the /architecture/ page: Studio in one picture, the legend every
 * view below uses, and the tabs that hold those views. The picture is five
 * layers read top to bottom — who uses Studio, its backend by domain, the
 * platform under it, where the data lives, and what is outside — so a reader
 * gets the whole before any detail. Counts come from the running backend. */

import type { ReactNode } from "react";

import { dataSummary } from "./architecture";
import type { GroupedDomain, ManifestData, ManifestGear } from "./architecture";
import { FLOW_STATE_WORDS } from "./architecture-flow";

/** The views below the picture, in reading order. */
export const TABS = [
  { id: "flow", title: "Path of a product", hint: "the steps from a spec to a running product, and where each runs" },
  { id: "map", title: "Screens and gears", hint: "every place in the portal and the gears it calls" },
  { id: "uses", title: "Who uses whom", hint: "how Studio's gears depend on each other and on the platform" },
  { id: "leaks", title: "Boundaries", hint: "gears that reach into another gear's private code" },
  { id: "data", title: "Data", hint: "where each gear keeps its records" },
  { id: "doors", title: "Integrations", hint: "how another platform reads Studio or is read by it" },
] as const;

export type TabId = (typeof TABS)[number]["id"];

export function tabFromHash(hash: string): TabId | null {
  const id = hash.replace(/^#/, "");
  return TABS.some((t) => t.id === id) ? (id as TabId) : null;
}

function Box({
  title,
  note,
  detail,
  onOpen,
  kind,
}: {
  title: string;
  note?: ReactNode;
  detail?: string;
  onOpen?: () => void;
  kind: "people" | "studio" | "platform" | "data" | "outside";
}) {
  const body = (
    <>
      <span className="arch-ov-box-title">
        {title}
        {note !== undefined && <span className="arch-ov-box-note">{note}</span>}
      </span>
      {detail && <span className="arch-ov-box-detail">{detail}</span>}
    </>
  );
  return onOpen ? (
    <button type="button" className={`arch-ov-box kind-${kind}`} onClick={onOpen} title={detail}>
      {body}
    </button>
  ) : (
    <div className={`arch-ov-box kind-${kind}`}>{body}</div>
  );
}

function Layer({ title, where, children }: { title: string; where: ReactNode; children: ReactNode }) {
  return (
    <div className="arch-ov-layer">
      <div className="arch-ov-label">
        <strong>{title}</strong>
        <span className="arch-muted">{where}</span>
      </div>
      <div className="arch-ov-boxes">{children}</div>
    </div>
  );
}

function Link({ children }: { children: ReactNode }) {
  return (
    <div className="arch-ov-link" aria-hidden="true">
      <span className="arch-ov-arrow">↓</span> {children}
    </div>
  );
}

export function Overview({
  studio,
  platform,
  data,
  onTab,
}: {
  studio: GroupedDomain[];
  platform: { title: string; gears: ManifestGear[] }[];
  data: ManifestData[] | undefined;
  onTab: (tab: TabId, domain?: string) => void;
}) {
  const studioCount = studio.reduce((n, d) => n + d.gears.length, 0);
  const platformCount = platform.reduce((n, g) => n + g.gears.length, 0);
  const kinds = data ? dataSummary(data).inModel : null;
  return (
    <section className="card arch-overview" aria-labelledby="overview-title">
      <h2 id="overview-title">Studio in one picture</h2>
      <p className="arch-muted arch-intro">
        Read it top to bottom: people work in the portal or the IDE, which talk to one backend; the backend is built
        from Studio's gears on top of the platform's; the gears keep their data in a few stores and reach outside
        services through connections. Choose a box to open the view that explains it.
      </p>
      <div className="arch-ov">
        <Layer title="People" where="in a browser or the desktop app">
          <Box kind="people" title="Portal" detail="the web portal: projects, specs, components, deploys" onOpen={() => onTab("map")} />
          <Box kind="people" title="IDE in the browser" detail="one Theia per workspace, started by the backend, with AI agents" onOpen={() => onTab("flow")} />
          <Box kind="people" title="Desktop app" detail="the same IDE on the person's machine" onOpen={() => onTab("flow")} />
        </Layer>
        <Link>HTTPS: the portal and the IDE call the backend's REST API</Link>
        <Layer title="Studio backend" where={<>one Rust program · {studioCount} Studio gears</>}>
          {studio.map((d) => (
            <Box
              key={d.domain.id}
              kind="studio"
              title={d.domain.title}
              note={d.gears.length}
              detail={d.domain.blurb}
              onOpen={() => onTab("uses", d.domain.id)}
            />
          ))}
        </Layer>
        <Link>calls inside the same program, through the platform's SDKs</Link>
        <Layer title="Platform" where={<>gears-rust · {platformCount} gears</>}>
          {platform
            .filter((g) => g.gears.length > 0)
            .map((g) => (
              <Box key={g.title} kind="platform" title={g.title} note={g.gears.length} onOpen={() => onTab("uses")} />
            ))}
        </Layer>
        <Link>SQL and graph queries</Link>
        <Layer title="Data" where="Postgres and the platform's stores">
          <Box
            kind="data"
            title="Account management"
            detail="the core: organizations, workspaces, projects, people and their roles"
            onOpen={() => onTab("data")}
          />
          <Box
            kind="data"
            title="Domain model"
            note={kinds ?? undefined}
            detail="every other record a gear keeps, as objects of the organization's model (graph storage); the number is kinds of records"
            onOpen={() => onTab("data")}
          />
          <Box kind="data" title="Postgres" detail="each gear's own tables, and a read copy of the domain model for queries" onOpen={() => onTab("data")} />
          <Box kind="data" title="File storage" detail="the bytes of build outputs and uploads (S3)" onOpen={() => onTab("data")} />
        </Layer>
        <Link>connections an organization makes, with its own keys</Link>
        <Layer title="Outside Studio" where="services Studio uses but does not run">
          <Box kind="outside" title="Git hosts and CI" detail="the product's repositories; their CI builds it — Studio never builds" onOpen={() => onTab("flow")} />
          <Box kind="outside" title="Organization's cluster" detail="where the products are deployed" onOpen={() => onTab("flow")} />
          <Box kind="outside" title="AI model vendors" detail="Anthropic, OpenAI: every call through the LLM proxy" onOpen={() => onTab("flow")} />
          <Box kind="outside" title="Chats and analytics" detail="Slack, Discord, Zulip; Constructor Insight" onOpen={() => onTab("doors")} />
        </Layer>
      </div>
    </section>
  );
}

/** What the marks on this page mean. */
export function Legend() {
  return (
    <section className="card arch-legend-card" aria-label="Legend">
      <h2 className="arch-legend-title">Legend</h2>
      <dl className="arch-key">
        <div>
          <dt>
            <span className="arch-gear origin-studio">studio-…</span>
          </dt>
          <dd>Studio gear: a part of Studio's backend with one job, its API and its data</dd>
        </div>
        <div>
          <dt>
            <span className="arch-gear origin-platform">account-management</span>
          </dt>
          <dd>Platform gear (gears-rust): sign-in, accounts, storage, runtime under Studio</dd>
        </div>
        <div>
          <dt>
            <span className="arch-gear origin-studio role-plugin">github</span>
          </dt>
          <dd>Plugin (dashed): plugs into the gear it is listed under</dd>
        </div>
        <div>
          <dt>
            <span className="arch-gear origin-studio">
              gear <span className="arch-chip-note">5</span>
            </span>
          </dt>
          <dd>Number on a gear: how many places in the portal call it</dd>
        </div>
        <div>
          <dt>
            <span className="arch-via via-port">port</span> <span className="arch-via via-surface">surface</span>{" "}
            <span className="arch-via via-internal">internal</span>
          </dt>
          <dd>How one gear uses another: through its port (intended), its top-level exports (tolerable), its private code (to fix)</dd>
        </div>
        <div>
          <dt>
            <span className="arch-flow-state is-built">{FLOW_STATE_WORDS.built}</span>{" "}
            <span className="arch-flow-state is-partial">{FLOW_STATE_WORDS.partial}</span>{" "}
            <span className="arch-flow-state is-gap">{FLOW_STATE_WORDS.gap}</span>
          </dt>
          <dd>Whether a step or a door is there today</dd>
        </div>
        <div>
          <dt>
            <span className="arch-via via-port">model</span>
          </dt>
          <dd>Data kept as objects of the domain model; another word names the store it is still in</dd>
        </div>
      </dl>
    </section>
  );
}

/** How to read one view: what it shows and what to choose, in order. */
export const HOW_TO_READ: Record<TabId, string[]> = {
  flow: [
    "The left column is the path one application takes, from signing in to watching it run. Choose a step.",
    "The boxes it passes light up; the numbers on a box are the steps that pass through it.",
    "A yellow or red tag on a step says it works with a limit or is not built yet, and the step says what is missing.",
  ],
  map: [
    "The left column lists every place in the portal, the IDE and the desktop app. Choose one.",
    "The gears it calls light up on the right; the number on a gear is how many places call it.",
    "Choose a gear to read what it does, what it uses and every place that relies on it, in the panel on the right.",
  ],
  uses: [
    "Each card is one Studio gear: what it is for, which Studio gears it uses, and how many use it.",
    "Choose a gear to draw a line to each partner: solid through its port (as intended), dashed through its top-level exports, dotted red into its private code.",
    "The grey rows at the bottom are the platform's gears; a chosen gear outlines the ones it needs.",
  ],
  leaks: [
    "Each entry is a gear whose private modules other gears import directly.",
    "It names the modules and the gears that import them: those gears break when the module changes.",
    "The fix is a port on the owner, and the callers moved onto it — the longest lists first.",
  ],
  data: [
    "The steps say how one record travels: the gear writes it, everyone sees it, the organization extends it.",
    "The table has one row per gear that keeps records: each kind of record, where it lives now, and the model types only that gear writes.",
  ],
  doors: [
    "Each door is a way another platform reads Studio or is read by it, with whether it works today and its address.",
    "The table below it is one worked example: what a research platform would read, and through which door.",
  ],
};

export function HowToRead({ tab }: { tab: TabId }) {
  return (
    <div className="arch-howto" role="note">
      <strong>How to read this</strong>
      <ol>
        {HOW_TO_READ[tab].map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

export function Tabs({
  active,
  onTab,
  hidden,
}: {
  active: TabId;
  onTab: (tab: TabId) => void;
  hidden?: TabId[];
}) {
  const shown = TABS.filter((t) => !hidden?.includes(t.id));
  const current = TABS.find((t) => t.id === active);
  return (
    <div className="arch-tabs-wrap">
      <div className="arch-tabs" role="tablist" aria-label="Views">
        {shown.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === active}
            aria-controls={t.id}
            className={`arch-tab${t.id === active ? " is-active" : ""}`}
            onClick={() => onTab(t.id)}
          >
            {t.title}
          </button>
        ))}
      </div>
      {current && <p className="arch-muted arch-tab-hint">Here: {current.hint}.</p>}
    </div>
  );
}
