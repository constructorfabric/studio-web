// The catalogue tree, rendered as it arrives.
//
// A `ReactWidget` rather than Theia's `TreeWidget`: the staged behaviour is the
// substance here -- a row changing kind under the reader without the tree
// reshuffling -- and expressing that is clearer with a render function than with
// a tree model whose node identity would have to be taught the same rule.
//
// The widget starts no load. It is closable and transient, so `postConstruct`
// running a load meant closing and reopening the panel mid-projection started a
// second one over the first. The load belongs to the application
// (`CatalogueViewContribution`) and to the reload command; this only subscribes.

import { codicon, ReactWidget } from "@theia/core/lib/browser";
import { CommandRegistry } from "@theia/core/lib/common";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
// The shim is `export = React`, so a namespace import is rejected under
// esModuleInterop; a default import is the form that works.
import React from "@theia/core/shared/react";

import type { Diagnostic } from "../../common/generated/Diagnostic";
import type { FailedRoot } from "../../common/generated/FailedRoot";
import { Row, rowKey } from "../../common/protocol";
import { CatalogueStore } from "../catalogue-store";
import { DiagnosticsList } from "../diagnostics/diagnostics-list";
import { ProductEditService } from "../product-edit-service";
import { ProductStore } from "../product-store";
import { RevealService } from "../reveal-service";
import { ADD_GEAR, SHOW_PRODUCT } from "../shell/session-command-ids";
import { GEARBOX_DRAG_MIME } from "../ai/gearbox-context";
import type { Message } from "@theia/core/shared/@lumino/messaging";

@injectable()
export class CatalogueWidget extends ReactWidget {
  static readonly ID = "gearbox.catalogue";
  static readonly LABEL = "Gearbox Catalogue";

  @inject(CatalogueStore) protected readonly store!: CatalogueStore;
  @inject(RevealService) protected readonly reveals!: RevealService;
  @inject(ProductEditService) protected readonly edits!: ProductEditService;
  @inject(ProductStore) protected readonly product!: ProductStore;
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;

  /**
   * The filter text, and which categories are folded away.
   *
   * Widget state rather than store state: neither survives a reload and neither
   * is anyone else's business. `gears-rust` has 62 crates carrying
   * `#[toolkit::gear]` against the 14 described today, so this list is going to
   * quadruple -- which is what makes folding and filtering worth having before
   * it does.
   */
  protected filter = "";
  protected collapsed = new Set<string>();

  /**
   * The visible rows in the order the eye reads them, rebuilt on every render.
   *
   * Needed because the tree is not one list: it is a listbox per category, and
   * arrow-key navigation has to cross a group boundary the way the reader's eye
   * does. A flat array of keys is the smallest thing that can answer "what is
   * below this row" when the answer is in the next group -- or nowhere, because
   * the group after it is folded.
   */
  protected navigable: string[] = [];

  @postConstruct()
  protected init(): void {
    this.id = CatalogueWidget.ID;
    this.title.label = CatalogueWidget.LABEL;
    this.title.iconClass = codicon("library");
    this.title.caption = CatalogueWidget.LABEL;
    this.title.closable = true;
    this.addClass("gbx-widget-catalogue");
    this.node.tabIndex = -1;
    this.toDispose.push(this.store.onChanged(() => this.update()));
    // And the product's, because each row now shows whether *this product* names
    // the gear. Without this the toggles would appear only after some unrelated
    // catalogue change, which is how they failed to appear at all the first time.
    this.toDispose.push(this.product.onChanged(() => this.update()));
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
    const state = this.store.current;
    const matching = state.rows.filter((row) => matches(row, this.filter));
    const groups = groupByCategory(matching);
    this.navigable = groups
      .filter(([category]) => !this.isFolded(category))
      .flatMap(([, rows]) => rows.map(rowKey));
    const loading = state.status === "loading";
    // A row still pending once the load is over did not project. Saying so is
    // the difference between "still working" and "this gear failed, and the
    // diagnostics below say why".
    const unprojected = state.status === "ready" ? state.rows.filter(isPending).length : 0;

    return (
      <div className="gbx-root">
        <div className="gbx-header">
          <strong>{matching.length}</strong>
          {matching.length === state.rows.length ? " gear(s)" : ` of ${state.rows.length} gear(s)`}
          {loading && (
            <span className="gbx-progress">
              {" "}
              projecting {state.completed}/{state.total}
            </span>
          )}
          {unprojected > 0 && (
            <span className="gbx-error">
              {" "}
              — {unprojected} did not project
            </span>
          )}
        </div>

        {/* A plain substring filter over name, id and category. Not Theia's
            `fuzzySearch`: on 62 entries fuzziness mostly buys surprising matches,
            and a predictable filter is easier to trust when what you are looking
            for is an id you already know. */}
        <input
          className="gbx-filter"
          type="search"
          placeholder="Filter gears"
          aria-label="Filter gears"
          value={this.filter}
          onChange={(event) => {
            this.filter = event.target.value;
            this.update();
          }}
        />

        {state.status === "error" && (
          <div className="gbx-error" role="alert">
            The catalogue could not be loaded: {state.error}
          </div>
        )}

        {state.failedRoots.map((root) => this.renderFailedRoot(root))}

        {state.remote !== undefined && this.renderRemote(state.remote)}

        {state.rows.length === 0 && state.status === "ready" && (
          <div className="gbx-empty">No gear.gdl in this workspace's repositories.</div>
        )}

        {matching.length === 0 && state.rows.length > 0 && (
          <div className="gbx-empty">Nothing matches “{this.filter}”.</div>
        )}

        {groups.map(([category, rows]) => this.renderGroup(category, rows, state.status))}

        {state.diagnostics.length > 0 && this.renderDiagnostics(state.diagnostics)}
      </div>
    );
  }

  /**
   * Constructor Studio: rows the Studio backend listed, because this workspace
   * holds no corpus. They open nothing until a copy is here; the button brings
   * one -- once per machine and commit, shared by every project.
   */
  protected renderRemote(corpus: string): React.ReactNode {
    const bringable = this.store.corpusBringable;
    const { busy, error } = this.store.corpusBringing;
    return (
      <div className="gbx-empty">
        <div>Listed by Studio from {corpus}, read-only.</div>
        {bringable === true ? (
          <>
            <div>To open a gear, resolve or generate, bring a copy here. One copy serves every project on this machine.</div>
            <button
              type="button"
              className="theia-button secondary"
              disabled={busy}
              onClick={() => void this.store.bringCorpusHere()}
            >
              {busy ? "Bringing the gears here…" : "Bring the gears here"}
            </button>
          </>
        ) : (
          bringable !== undefined && <div>{bringable} Add its repository to the workspace to open or edit a gear.</div>
        )}
        {error !== undefined && (
          <div className="gbx-error" role="alert">
            {error}
          </div>
        )}
      </div>
    );
  }

  /**
   * The "in this product" control.
   *
   * Only on a projected row: adding a gear needs its id, and a pending row has
   * none -- `GearId` is projected at S2 (ADR
   * `cpt-gearbox-adr-staged-catalogue-loading`). And only when a product is open,
   * because otherwise the control would promise something it cannot do, which is
   * the mistake the Product view's fake links already made once.
   *
   * **Status and action are two things, and the row shows them as two.** A gear
   * already in the product wears a badge saying so and the button offers the one
   * thing the click does; a gear that is not wears the button alone. One control
   * carrying both used to read `In product · Show in product`, which is a
   * sentence, not a label.
   *
   * `stopPropagation`, because the row's own click selects it and this button
   * sits inside the row: without it, adding a gear would also move the selection.
   */
  protected renderInProduct(row: Row): React.ReactNode {
    if (row.kind !== "projected" || !this.edits.editable) {
      // **Rendered empty rather than omitted.** The slot reserves the space, so
      // a list where only some rows carry a control does not step in and out at
      // the right margin.
      return <span className="gbx-row-action" />;
    }
    const id = row.gear.id;
    const inside = this.edits.inProduct(id);
    const product = this.product.current.open?.label ?? "the product";
    // **The whole sentence, as the accessible name, and it has to describe what
    // the click does.** It read `Remove <gear> from <product>` while inside --
    // over a handler that focuses the gear and shows the product, and never
    // removed anything. A tooltip that is merely stale costs a reader a second
    // look; an accessible name is the *only* thing a screen-reader user has, so
    // that one promised an action the button does not have.
    const label = inside
      ? `Show ${row.gear.display_name} in ${product}`
      : `Add ${row.gear.display_name} to ${product}`;
    return (
      <span className="gbx-row-action">
        {inside && (
          <span className="gbx-badge gbx-badge-in-product" data-in-product-badge={id}>
            in product
          </span>
        )}
        <button
          type="button"
          aria-label={label}
          className="gbx-in-product"
          data-in-product={inside ? "true" : "false"}
          // `data-toggle-gear` rather than `data-gear`: the graph widget's nodes
          // carry `data-gear`, and the co-location tests reach them with an
          // unscoped `querySelector`. Reusing the name here made a click meant
          // for a graph node land on a catalogue button instead -- and that
          // button opens a write confirmation, so the collision was worse than a
          // wrong selection. One attribute, one meaning per document.
          data-toggle-gear={id}
          title={label}
          // No `aria-pressed`: the *name* already changes with the state, and a
          // toggle that announces both "Show ... in Payments Demo" and "pressed"
          // says the same thing twice in opposite words.
          onClick={(event) => {
            event.stopPropagation();
            if (inside) {
              this.product.setFocus({ kind: "gear", id });
              void this.commands.executeCommand(SHOW_PRODUCT.id, "composition");
              return;
            }
            void this.commands.executeCommand(ADD_GEAR.id, { gearId: id });
          }}
        >
          {inside ? "Show" : "Add"}
        </button>
      </span>
    );
  }

  protected renderGroup(category: string, rows: Row[], status: string): React.ReactNode {
    const folded = this.isFolded(category);
    const selectedKey = this.store.selected;
    return (
      <div className="gbx-group" key={category} data-category={category}>
        <div
          className="gbx-group-label"
          role="button"
          tabIndex={0}
          aria-expanded={!folded}
          data-collapsed={folded ? "true" : "false"}
          onClick={() => this.toggle(category)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              this.toggle(category);
            }
          }}
        >
          <span
            className={`gbx-twistie codicon codicon-chevron-${folded ? "right" : "down"}`}
          />
          {category}
          <span className="gbx-group-count">{rows.length}</span>
        </div>
        {!folded && (
          <div role="listbox" aria-label={category}>
            {/* `selected` read once for the group rather than once per row: it
                resolves a gear selection by scanning the rows, so asking per row
                made the render quadratic in the catalogue's size. Fourteen gears
                today, sixty-two crates carrying `#[toolkit::gear]` in the corpus. */}
            {rows.map((row) => this.renderRow(row, status, selectedKey))}
          </div>
        )}
      </div>
    );
  }

  /**
   * Whether a category is folded away.
   *
   * Folding is ignored while a filter is active. A match hidden inside a
   * collapsed category is the one thing a filter must never do: the reader
   * concludes the gear is not there.
   */
  protected isFolded(category: string): boolean {
    return this.filter.length === 0 && this.collapsed.has(category);
  }

  protected toggle(category: string): void {
    if (!this.collapsed.delete(category)) {
      this.collapsed.add(category);
    }
    this.update();
  }

  protected renderRow(row: Row, status: string, selectedKey: string | undefined): React.ReactNode {
    const key = rowKey(row);
    const selected = selectedKey === key;
    const label =
      row.kind === "pending"
        ? (row.gear.display_name ?? row.gear.gdl_path)
        : row.gear.display_name;
    // Pending after the load finished is a failure, not a stage.
    const stalled = row.kind === "pending" && status === "ready";

    return (
      <div
        key={key}
        className={`gbx-row ${row.kind === "pending" ? "gbx-pending" : ""} ${
          selected ? "gbx-selected" : ""
        } ${stalled ? "gbx-stalled" : ""}`}
        // Operable from the keyboard, because a panel in an IDE that only
        // answers the mouse is unusable for anyone who does not use one.
        // Enter/Space select; Enter on an already-selected row reveals, which is
        // the keyboard counterpart of the double-click.
        role="option"
        aria-selected={selected}
        data-row-key={key}
        // Draggable into the chat, which is the only consumer: a projected row
        // carries its `GearId`, a pending one has none yet (ADR-0009) and so is
        // not worth dragging anywhere. The payload is the id rather than the
        // label, because the chat resolves ids and labels collide.
        draggable={row.kind === "projected"}
        onDragStart={(event) => {
          if (row.kind !== "projected") return;
          event.dataTransfer.setData(
            GEARBOX_DRAG_MIME,
            JSON.stringify({ kind: "gear", id: row.gear.id }),
          );
          // Plain text too, so dropping on anything else leaves something
          // readable rather than nothing.
          event.dataTransfer.setData("text/plain", row.gear.id);
          event.dataTransfer.effectAllowed = "copy";
        }}
        // One tab stop for the whole tree, not one per row. `tabIndex={0}`
        // everywhere put 62 stops between the filter box and the rest of the
        // shell today and will put hundreds there as the catalogue grows, which
        // is the ARIA listbox pattern's whole reason for existing: Tab reaches
        // the list, the arrow keys move inside it.
        tabIndex={this.isTabbable(key) ? 0 : -1}
        onClick={() => {
          this.store.select(key);
        }}
        onKeyDown={(event) => this.onRowKey(event, row, key, selected)}
        // A pending row is never inert: `gdl_path` is known from discovery, so
        // revealing the description works before anything is parsed.
        onDoubleClick={() => void this.reveals.reveal(row.gear.source, row.gear.gdl_path)}
        title={row.gear.gdl_path}
      >
        {/* **The facts in one box, so the action can be beside them rather than
            after them.** The row is a grid of two columns: everything that
            describes the gear wraps freely inside this one, and the control
            keeps the second to itself. As flat flex items with `flex-wrap`, a
            row whose badges filled the line pushed its own action onto the next
            one -- where it sat directly above the *following* gear's name and
            read as belonging to it. */}
        <span className="gbx-row-main">
          <span className="gbx-row-name">{label}</span>
          {row.kind === "projected" ? (
            <>
              <span className="gbx-id">{row.gear.id}</span>
              {(row.gear.runtime_caps ?? []).map((cap) => (
                <span className="gbx-badge" key={cap}>
                  {cap}
                </span>
              ))}
            </>
          ) : (
            // No id and no badges, because neither exists yet. Saying so beats an
            // empty space that reads as "this gear has none".
            <span className="gbx-waiting">{stalled ? "did not project" : "parsing…"}</span>
          )}
        </span>
        {/* **Last, and in its own column.** It was first, ahead of the name,
            which put a control where a reader expects the subject and pushed
            every row's text right by a different amount depending on whether
            the control was there at all. A row reads as "what this gear is",
            then "what I can do about it". */}
        {this.renderInProduct(row)}
      </div>
    );
  }

  /**
   * Which row carries the tree's single tab stop.
   *
   * The selected row, so returning to the list by Tab lands where the reader
   * left off; the first row otherwise, because a list no key can reach is a list
   * that is not keyboard-operable at all. Falling back matters when the
   * selection is filtered out or sits in a folded group -- the selection
   * survives both, and the tab stop cannot.
   */
  protected isTabbable(key: string): boolean {
    const selected = this.store.selected;
    if (selected !== undefined && this.navigable.includes(selected)) {
      return key === selected;
    }
    return key === this.navigable[0];
  }

  protected onRowKey(
    event: React.KeyboardEvent<HTMLDivElement>,
    row: Row,
    key: string,
    selected: boolean,
  ): void {
    const moved = this.neighbour(event.key, key);
    if (moved !== undefined) {
      event.preventDefault();
      this.store.select(moved);
      // Focused now rather than after the re-render. React keeps the same DOM
      // node for the same row key, so the element is already there and moving
      // focus into it survives the patch -- whereas focusing afterwards needs a
      // hook into an update that `select()` only schedules.
      this.focusRow(moved);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    if (event.key === "Enter" && selected) {
      void this.reveals.reveal(row.gear.source, row.gear.gdl_path);
      return;
    }
    this.store.select(key);
  }

  /**
   * The row a navigation key moves to, or `undefined` if the key is not one.
   *
   * Clamped rather than wrapped at both ends: a list that jumps from the last
   * gear back to the first reads as a bug the first time it happens, and there
   * is no long list here to make wrapping worth the surprise.
   */
  protected neighbour(pressed: string, from: string): string | undefined {
    const rows = this.navigable;
    if (rows.length === 0) {
      return undefined;
    }
    const at = rows.indexOf(from);
    const last = rows.length - 1;
    switch (pressed) {
      case "ArrowDown":
        return rows[Math.min(at + 1, last)];
      case "ArrowUp":
        return at <= 0 ? rows[0] : rows[at - 1];
      case "Home":
        return rows[0];
      case "End":
        return rows[last];
      default:
        return undefined;
    }
  }

  protected focusRow(key: string): void {
    // Matched on the dataset rather than interpolated into a selector. A row key
    // is `<source>:<gdl_path>`, so it carries `:` and `/` and whatever else the
    // filesystem allows, and getting CSS string escaping right for arbitrary
    // path text is a worse problem than a loop over a few dozen elements.
    const rows = Array.from(this.node.querySelectorAll<HTMLElement>("[data-row-key]"));
    rows.find((node) => node.dataset["rowKey"] === key)?.focus();
  }

  protected renderFailedRoot(root: FailedRoot): React.ReactNode {
    return (
      <div className="gbx-error" role="alert" key={root.path}>
        Source root <code>{root.path}</code> could not be opened: {root.error}
      </div>
    );
  }

  /**
   * What the engine had to say about the tree.
   *
   * These used to be stored and never rendered, which is how a gear that fails
   * to project became a row that says `parsing…` under a finished progress bar
   * with no explanation anywhere.
   */
  /**
   * What the load could not do, in the same rows every other panel uses.
   *
   * The wrapper keeps a class of its own -- not `gbx-group-label`, which means "a
   * category of gears" and is read as exactly that by the suite -- but the title
   * is no longer `gbx-diagnostics-label`. That class belongs to the Product
   * view's one-line summary, and having both meant an unscoped read of it picked
   * whichever panel happened to render first.
   *
   * `compact`, because this is an aside inside a tree rather than a screen. It is
   * spacing only: a catalogue diagnostic keeps its location link, which points at
   * the `gear.gdl` that failed to project -- the most actionable thing about it,
   * and previously not shown at all.
   */
  protected renderDiagnostics(diagnostics: readonly Diagnostic[]): React.ReactNode {
    return (
      <div className="gbx-diagnostics" data-catalogue-diagnostics={diagnostics.length}>
        <div className="gbx-diagnostics-title">diagnostics ({diagnostics.length})</div>
        <DiagnosticsList
          diagnostics={diagnostics}
          density="compact"
          onReveal={(location) => void this.reveals.revealLocation(location)}
        />
      </div>
    );
  }
}

/**
 * Whether a row survives the filter.
 *
 * Matches the display name, the id and the category, because those are the three
 * things a person has in hand when they go looking. A pending row has no id yet,
 * which is why this reads what the row actually carries rather than assuming a
 * projected one.
 */
function matches(row: Row, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = [
    row.kind === "pending" ? (row.gear.display_name ?? "") : row.gear.display_name,
    row.kind === "projected" ? row.gear.id : "",
    row.gear.category ?? "",
    row.gear.gdl_path,
  ];
  return haystack.some((field) => field.toLowerCase().includes(needle));
}

function isPending(row: Row): boolean {
  return row.kind === "pending";
}

function groupByCategory(rows: readonly Row[]): [string, Row[]][] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const category = row.gear.category ?? "uncategorised";
    const list = groups.get(category) ?? [];
    list.push(row);
    groups.set(category, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}
