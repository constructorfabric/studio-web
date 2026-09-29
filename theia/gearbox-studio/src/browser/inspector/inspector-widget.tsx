// What is selected, and why it is in the product.
//
// One panel, and it used to be two. `Gearbox Gear` rendered a `GearDescriptor`
// from a catalogue row; `Gearbox Explain` rendered the resolver's `because`
// sentences from a product focus. They sat side by side in the bottom bar and
// answered about two different selections, so the ordinary case -- click a gear
// in the product tree -- filled one and left the other saying "select a gear in
// the catalogue". Two panels, one of them always apologising.
//
// Merged, on one selection (`SelectionService`), the ordinary case finally works:
// choosing `api-gateway` anywhere says both what it is and why it is here. That
// pairing is the point of the panel and it was not previously reachable at all.
//
// The two sections keep their old class names, `gbx-detail` and `gbx-explain`.
// Not laziness: they *are* the detail and the explanation, now sections of one
// panel rather than two widgets, and every claim written against their markup
// keeps testing the same thing.
//
// Neither section composes anything. The facts are projected by the macro
// (ADR `cpt-gearbox-adr-macro-projected-catalogue`) and every step is a sentence
// the resolver wrote when it created the edge, while it still knew the specifics
// (`cpt-gearbox-fr-explain`). This walks and prints.

import { fillLabel, pointKey, pointLabel, specSegment } from "../../common/extension-points";
import { codicon, ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import { CommandRegistry } from "@theia/core";
import React from "@theia/core/shared/react";

import { GearBlurb, GearDocs, GearHeading } from "../gear/gear-facts";
import type { ExplanationGraph } from "../../common/generated/ExplanationGraph";
import type { ExplanationNode } from "../../common/generated/ExplanationNode";
import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import type { Location } from "../../common/generated/Location";
import type { ProvenanceEdge } from "../../common/generated/ProvenanceEdge";
import type { ResolvedProduct } from "../../common/generated/ResolvedProduct";
import type { Row } from "../../common/protocol";
import { CatalogueStore } from "../catalogue-store";
import { Focus, ProductStore } from "../product-store";
import { describeFocus, nodeIdOf } from "./effective-config";
import { RevealLink } from "../reveal-link";
import { RevealService } from "../reveal-service";
import { ADD_GEAR, SHOW_PRODUCT } from "../shell/session-command-ids";
import { gearIdOf, Selection, SelectionService } from "../shell/selection-service";
import { inPortal, OPEN_COMPONENT_IN_PORTAL } from "../shell/portal-link";
import type { Message } from "@theia/core/shared/@lumino/messaging";

/** One rendered step: an edge, with both of its nodes resolved. */
interface Step {
  readonly edge: ProvenanceEdge;
  readonly from: ExplanationNode | undefined;
  readonly to: ExplanationNode | undefined;
  /** How many edges from the focus. Used only to indent. */
  readonly depth: number;
}


/**
 * Every reason reachable from `start`, nearest first.
 *
 * Breadth-first, and the direction matters: an edge runs *from* the thing being
 * explained *to* what explains it, so `gear:x -> profile:prod` reads "x is
 * selected-by prod". Following `from === current` therefore walks towards the
 * reasons; following the other way would walk towards the consequences, which
 * answers a different question.
 *
 * Nodes are visited once. The graph is a DAG by construction, but a repeated node
 * would still produce a repeated subtree, and "because api-gateway declares it"
 * printed four times is noise that hides the one line that matters.
 */
function reasonsFrom(graph: ExplanationGraph, start: string): Step[] {
  const steps: Step[] = [];
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let depth = 0; frontier.length > 0 && depth < 12; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of graph.edges) {
        if (edge.from !== current) continue;
        steps.push({
          edge,
          from: graph.nodes[edge.from],
          to: graph.nodes[edge.to],
          depth,
        });
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          next.push(edge.to);
        }
      }
    }
    frontier = next;
  }
  return steps;
}

/** Whether the resolution on screen contains the thing being explained. */
function isInResolution(product: ResolvedProduct, focus: Focus): boolean {
  switch (focus.kind) {
    case "gear":
      return Object.prototype.hasOwnProperty.call(product.gears, focus.id);
    case "application":
      return product.applications.some((application) => application.name === focus.id);
    case "binding":
      return (product.bindings ?? []).some(
        (binding) => binding.consumer === focus.consumer && binding.contract === focus.contract,
      );
  }
}

@injectable()
export class InspectorWidget extends ReactWidget {
  static readonly ID = "gearbox.inspector";
  static readonly LABEL = "Gearbox Inspector";

  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(RevealService) protected readonly reveals!: RevealService;
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;

  @postConstruct()
  protected init(): void {
    this.id = InspectorWidget.ID;
    this.title.label = InspectorWidget.LABEL;
    this.title.iconClass = codicon("info");
    this.title.caption = InspectorWidget.LABEL;
    this.title.closable = true;
    this.addClass("gbx-widget-inspector");
    // Both stores, not the selection service alone. The selection can stay the
    // same while what is known about it changes -- a pending row projecting, a
    // re-resolve producing a different explanation -- and both of those change
    // what this panel should say.
    this.toDispose.push(this.selection.onDidChange(() => this.update()));
    this.toDispose.push(this.catalogue.onChanged(() => this.update()));
    this.toDispose.push(this.products.onChanged(() => this.update()));
    // No draft subscription: nothing here is edited any more, so a draft
    // changing changes nothing this panel says.
    this.update();
  }

  /**
   * Take the focus when the shell activates this view. Theia waits up to two
   * seconds for an activated widget to accept focus, and a mode switch
   * activates its views one after another: without this, entering Building
   * cost ten seconds, and the rail showed the previous mode's tabs meanwhile.
   */
  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    if (!this.node.hasAttribute("tabindex")) {
      this.node.tabIndex = -1;
    }
    this.node.focus();
  }

  protected render(): React.ReactNode {
    const selection = this.selection.current;
    if (selection === undefined) {
      return (
        <div className="gbx-inspector gbx-empty">
          Select a gear in the catalogue, or a gear, application or binding in the Product view.
        </div>
      );
    }

    return (
      <div className="gbx-inspector" data-inspecting={keyOf(selection)}>
        {this.renderWhat(selection)}
        {this.renderWhy()}
      </div>
    );
  }

  /** The row a selection points at, whichever way it was made. */
  protected rowFor(selection: Selection): Row | undefined {
    if (selection.kind === "catalogue-row") return this.catalogue.row(selection.key);
    // Either act: this panel explains a gear, and it is the same gear either way.
    const id = gearIdOf(selection);
    if (id === undefined) return undefined;
    return this.catalogue.current.rows.find(row => row.kind === "projected" && row.gear.id === id);
  }

  // ---- what it is --------------------------------------------------------

  protected renderWhat(selection: Selection): React.ReactNode {
    if (selection.kind === "plugin") {
      const descriptor = this.catalogue.current.rows.find(row => row.kind === "projected" && row.gear.id === selection.id);
      return <>
        <div className="gbx-kv"><span>connected to</span><span>{selection.host}, connection {selection.entryIndex + 1}</span></div>
        {descriptor?.kind === "projected" && this.renderProjected(descriptor.gear)}
      </>;
    }
    const row = this.rowFor(selection);
    if (row === undefined) {
      // An application and a binding are not catalogue entries -- they are things the
      // resolver *made*, out of gears. So there is no descriptor to show, and
      // saying that is better than an empty box which reads as a load that
      // failed. What such a selection has instead is the section below.
      const noun = selection.kind === "catalogue-row" ? "row" : selection.kind;
      return (
        <div className="gbx-detail gbx-empty" data-no-descriptor={noun}>
          {selection.kind === "catalogue-row"
            ? "This row is no longer in the catalogue."
            : `A ${selection.kind} has no available catalogue descriptor: the resolver derives it from gears. ` +
              `What it is made of is in the Product view; why it exists is below.`}
        </div>
      );
    }

    if (row.kind === "pending") {
      // A pending row is not an error state, so it does not read like one. Its
      // description and path are known from S0/S1; the rest is genuinely not
      // known yet, and saying which is which is the whole point of the stage.
      return (
        <div className="gbx-detail">
          <div className="gbx-detail-title">
            {row.gear.display_name ?? row.gear.gdl_path}
            <span className="gbx-waiting">parsing…</span>
          </div>
          <div className="gbx-kv">
            <span>description</span>
            <span>{row.gear.description ?? "—"}</span>
          </div>
          <div className="gbx-kv">
            <span>category</span>
            <span>{row.gear.category ?? "—"}</span>
          </div>
          {this.renderPath(row.gear.source, row.gear.gdl_path)}
          <div className="gbx-empty">
            Capabilities, co-location, contracts and GTS types come from this gear's Rust
            attributes, which have not been read yet.
          </div>
        </div>
      );
    }

    return (
      <>
        {this.renderProjected(row.gear)}
        {this.renderWayIn(row.gear.id)}
      </>
    );
  }

  /**
   * The way from reading about a gear to setting it up.
   *
   * **This panel no longer edits, and that is the decision this button pays
   * for.** It rendered `GearSettings` for a gear the product asks for, which
   * put a second editable copy of the Composition pane's form on screen over
   * one draft -- two surfaces, one Apply, and no way to tell which of them an
   * Apply belonged to. Configuring is the Composition pane's act now
   * (`cpt-gearbox-adr-product-composition`, amended).
   *
   * So the panel keeps what Composition does not show -- the catalogue's facts
   * and the explanation graph -- and offers one click back. Without it the split
   * would merely have taken something away.
   *
   * Nothing is offered with no product open: a button that names a product there
   * is none of is the fake link this codebase has already regretted once.
   */
  protected renderWayIn(id: string): React.ReactNode {
    const state = this.products.current;
    if (state.open === undefined) return undefined;
    const picked = state.intent?.selected_gears.some((entry) => entry.gear === id) === true;
    // Select first, then show the stage: the pane renders from the selection, so
    // the other order paints the previous subject for a frame. The sequence is
    // the Add Gear dialog's, which lands on the same pane.
    const go = (): void => {
      this.selection.select({ kind: "gear", id });
      void this.commands.executeCommand(SHOW_PRODUCT.id, "composition");
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(".gbx-composition-settings")?.focus(),
      );
    };
    return picked ? (
      <button type="button" className="gbx-choice" data-configure-in-product={id} onClick={go}>
        Configure in product
      </button>
    ) : (
      <button
        type="button"
        className="gbx-choice"
        data-add-to-product={id}
        onClick={() => void this.commands.executeCommand(ADD_GEAR.id, { gearId: id })}
      >
        Add to product
      </button>
    );
  }

  protected renderProjected(gear: GearDescriptor): React.ReactNode {
    const capabilities = this.catalogue.engineCapabilities;
    return (
      <div className="gbx-detail">
        {/* The heading and the blurb are the two things every surface showing a
            gear needs, so they are components rather than markup repeated here
            and in the settings pane. The rows below them are catalogue facts and
            stay. */}
        <GearHeading id={gear.id} descriptor={gear} />
        {/* Constructor Studio: the gear's page in the portal's component
            catalogue -- owners, activity, documents, versions -- which this
            panel does not repeat. Only inside the portal, which is where the
            page is. */}
        {inPortal() && (
          <div className="gbx-kv">
            <span>catalogue</span>
            <span>
              <a
                href="#"
                title={`Open ${gear.package.crate_name} in Constructor Studio's component catalogue`}
                onClick={(event) => {
                  event.preventDefault();
                  void this.commands.executeCommand(OPEN_COMPONENT_IN_PORTAL, gear.package.crate_name);
                }}
              >
                {gear.package.crate_name} ↗
              </a>
            </span>
          </div>
        )}
        <GearBlurb descriptor={gear} />
        <div className="gbx-kv">
          <span>capabilities</span>
          <span>
            {(gear.runtime_caps ?? []).map((cap) => (
              <span className="gbx-badge" key={cap}>
                {cap}
              </span>
            ))}
            {(gear.runtime_caps ?? []).length === 0 && "—"}
          </span>
        </div>
        <div className="gbx-kv">
          {/* Named "co-located with", not "depends on": these edges are link-time
              and the resolver can never sever them. */}
          <span>co-located with</span>
          <span>{(gear.colocated_deps ?? []).join(", ") || "—"}</span>
        </div>

        {(gear.extension_points ?? []).length > 0 && (
          <div className="gbx-kv">
            <span>extension points</span>
            <span>
              {(gear.extension_points ?? []).map((point) => (
                <div key={pointKey(point)} data-extension-point={specSegment(point.spec)}>
                  <code>{pointLabel(point)}</code>{" "}
                  <span className="gbx-muted">spec {specSegment(point.spec)}</span>
                  {gear.vendor_selector !== null && gear.vendor_selector !== undefined && (
                    <>
                      {" "}
                      selects vendor <code>{gear.vendor_selector}</code>
                    </>
                  )}
                </div>
              ))}
            </span>
          </div>
        )}

        {gear.fills && (
          <div className="gbx-kv">
            <span>fills</span>
            <span>
              <code>{fillLabel(gear.fills)}</code>
              {!gear.fills.point && (
                <span className="gbx-muted" data-fills-unjoined="true">
                  {" "}
                  -- no described host declares it
                </span>
              )}
              {gear.fills.default_vendor !== null && gear.fills.default_vendor !== undefined && (
                <>
                  {" "}
                  as vendor <code>{gear.fills.default_vendor}</code>
                </>
              )}
              {gear.fills.default_priority !== null && gear.fills.default_priority !== undefined && (
                <>, priority {gear.fills.default_priority}</>
              )}
            </span>
          </div>
        )}

        {(gear.provides ?? []).length > 0 && (
          <div className="gbx-kv">
            {/* The transports here are what this provider wires up, which is not
                the same as what the contract could support: api-contracts has a
                gRPC projection but leaves it behind an opt-in Cargo feature. */}
            <span>provides</span>
            <span>
              {(gear.provides ?? []).map((provide) => (
                <div key={provide.contract}>
                  <code>{provide.contract}</code> over{" "}
                  {provide.transports.map((t) => (
                    <span className="gbx-badge" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              ))}
            </span>
          </div>
        )}

        {(gear.gts_types ?? []).length > 0 && (
          <div className="gbx-kv">
            <span>GTS types</span>
            <span>
              {(gear.gts_types ?? []).map((type) => (
                <div key={type.type_id}>
                  <code>{type.type_id}</code>
                </div>
              ))}
            </span>
          </div>
        )}

        <GearDocs descriptor={gear} reveals={this.reveals} />

        {this.renderPath(gear.source, gear.gdl_path)}

        {gear.config_schema !== null && gear.config_schema !== undefined && (
          <div className="gbx-kv">
            <span>config</span>
            <span>
              {(gear.config_schema.fields ?? []).length} setting
              {(gear.config_schema.fields ?? []).length === 1 ? "" : "s"} from{" "}
              <code>{gear.config_schema.rust}</code>
            </span>
          </div>
        )}

        {capabilities && !capabilities.resolve && (
          // Honest about the gap rather than showing an empty panel that reads as
          // a bug: the engine says it cannot resolve yet, so the UI says so too.
          <div className="gbx-gap">
            Bindings, applications and the lock need the resolver (M4). The engine reports{" "}
            <code>resolve: false</code>, so those panels are disabled rather than empty.
          </div>
        )}
      </div>
    );
  }

  protected renderPath(source: string, gdlPath: string): React.ReactNode {
    return (
      <div className="gbx-kv">
        <span>description file</span>
        <span className="gbx-links">{this.renderLink(source, gdlPath, gdlPath)}</span>
      </div>
    );
  }

  /**
   * One link, opened through the opener rather than by the browser.
   *
   * Shared with the Product view. The reasoning for a real `href` rather than a
   * div with an `onClick` lives with the component.
   */
  protected renderLink(source: string, target: string, label: string): React.ReactNode {
    return (
      <RevealLink key={target} reveals={this.reveals} source={source} target={target} label={label} />
    );
  }

  // ---- why it is here ---------------------------------------------------

  /**
   * What "why" is asked about, which is not always what is selected.
   *
   * A plugin *connection* is a position in the description, and the explanation
   * graph is keyed by gear id -- so `ProductStore.focus` excludes it and would
   * leave this whole half blank whenever a connection is selected. It is asked
   * about the implementation the connection names, which is the thing the graph
   * has a node for, and whose node already says which host selected it and for
   * which profile. That is the question a person is asking anyway.
   */
  protected explainFocus(): Focus | undefined {
    const selection = this.selection.current;
    if (selection?.kind === "plugin") return { kind: "gear", id: selection.id };
    return this.products.focus;
  }

  protected renderWhy(): React.ReactNode {
    const focus = this.explainFocus();
    const graph = this.products.current.resolution?.explanation ?? undefined;

    if (graph === undefined) {
      return (
        <div className="gbx-explain gbx-empty">
          Resolve a product to ask why. The explanation arrives with the resolution.
        </div>
      );
    }
    if (focus === undefined) {
      // Reachable with something selected: a pending catalogue row has no
      // `GearId`, and the graph is keyed by id.
      return (
        <div className="gbx-explain gbx-empty">
          This row has not been parsed yet, so there is no id to ask about. The explanation is
          keyed by gear id.
        </div>
      );
    }

    const id = nodeIdOf(focus);
    const node = graph.nodes[id];
    if (node === undefined) {
      // Three different situations used to share one alarming message, and the
      // ordinary one is by far the most common: a selection survives a profile
      // switch, and `oidc-authn-plugin` simply is not in the dev resolution. That
      // is not a fault, and reading like one trains people to ignore the message
      // that does matter.
      const product = this.products.current.resolution?.product ?? undefined;
      const profile = product?.product.profile ?? this.products.current.profile ?? "this profile";
      if (product !== undefined && !isInResolution(product, focus)) {
        return (
          <div className="gbx-explain gbx-empty" data-not-in-profile={id}>
            {describeFocus(focus)} is not part of the <code>{profile}</code> resolution. Select
            something in this profile, or switch back.
          </div>
        );
      }
      // In the resolution and still absent from the graph: either the resolver
      // recorded no provenance for it, or the `{kind}:{payload}` convention --
      // which the client writes down a second time -- has drifted. Worth an
      // alarm, because both are defects.
      return (
        <div className="gbx-explain">
          <div className="gbx-error" role="alert">
            <code>{id}</code> is in the {profile} resolution but has no node in its explanation
            graph, which has {Object.keys(graph.nodes).length}. Either no provenance was recorded
            for it or the node-id convention has changed.
          </div>
        </div>
      );
    }

    const steps = reasonsFrom(graph, id);
    return (
      <div className="gbx-explain" data-explaining={id}>
        <div className="gbx-detail-title">
          why {describeFocus(focus)} <span className="gbx-id">{node.kind}</span>
        </div>
        {steps.length === 0 ? (
          <div className="gbx-empty">
            Nothing follows from this node: it is a root of the explanation.
          </div>
        ) : (
          <ol className="gbx-narrative">{steps.map((step, index) => this.renderStep(step, index))}</ol>
        )}
      </div>
    );
  }

  protected renderStep(step: Step, index: number): React.ReactNode {
    const { edge, from, to, depth } = step;
    const downgrade = edge.kind === "downgraded-by";
    return (
      <li
        className={`gbx-step ${downgrade ? "gbx-step-downgrade" : ""}`}
        key={`${edge.from}->${edge.to}-${edge.kind}-${index}`}
        style={{ marginLeft: `${depth * 14}px` }}
        data-step-kind={edge.kind}
        data-step-to={edge.to}
      >
        {/* The sentence first and the machinery second. The `because` string is
            the answer; the kind and the target are how to check it. */}
        <div className="gbx-step-because">{edge.because}</div>
        <div className="gbx-step-meta">
          <span className="gbx-badge">{edge.kind}</span>
          <span className="gbx-id">{to?.label ?? edge.to}</span>
          {this.renderOrigin(from?.origin ?? undefined)}
        </div>
      </li>
    );
  }

  /**
   * A link to the file the fact was declared in.
   *
   * An `<a>` with a real `href`, not a div with an onClick: the href is what gives
   * keyboard activation, a focus ring, a status-bar target and something for a
   * screen reader to announce. `preventDefault` keeps the navigation inside Theia.
   */
  protected renderOrigin(origin: Location | undefined): React.ReactNode {
    if (origin === undefined || origin === null) return undefined;
    const line = origin.range.start.line + 1;
    const name = origin.uri.split("/").pop() ?? origin.uri;
    return (
      <a
        className="gbx-step-origin"
        href={origin.uri}
        onClick={(event) => {
          event.preventDefault();
          void this.reveals.revealLocation(origin);
        }}
      >
        {name}:{line}
      </a>
    );
  }
}

/** A stable attribute value for whatever is selected, for tests and for debugging. */
function keyOf(selection: Selection): string {
  switch (selection.kind) {
    case "gear":
    case "application":
      return `${selection.kind}:${selection.id}`;
    // Distinct from `gear:`, because the two are distinct selections and this
    // value is how a test says which one it means.
    case "catalogue-gear":
      return `catalogue-gear:${selection.id}`;
    case "plugin":
      return `plugin:${selection.path}:${selection.host}:${selection.entryIndex}`;
    case "binding":
      return `binding:${selection.consumer}|${selection.contract}`;
    case "catalogue-row":
      return `row:${selection.key}`;
  }
}

