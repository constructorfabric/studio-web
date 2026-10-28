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

import type { FailedRoot } from "../../common/generated/FailedRoot";
import { rowKey } from "../../common/protocol";
import { CatalogueStore } from "../catalogue-store";
import { ProductEditService } from "../product-edit-service";
import { ProductStore } from "../product-store";
import { RevealService } from "../reveal-service";
import { ADD_GEAR, SHOW_CATALOGUE_DIAGNOSTICS, SHOW_PRODUCT } from "../shell/session-command-ids";
import { CONFIGURE_SOURCES } from "../shell/configure-sources-contribution";
import { CatalogueGrouping } from "./catalogue-grouping";
import type { CatalogueNode } from "./catalogue-model";
import { CatalogueTree } from "./catalogue-tree";
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
   * The search text. Widget state rather than store state: it survives no
   * reload and is nobody else's business. Folding lives in the tree
   * (`catalogue-tree.tsx`), which Add Gear shares.
   */
  protected filter = "";

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
    // A row still pending once the load is over did not project. Saying so is
    // the difference between "still working" and "this gear failed, and the
    // diagnostics below say why".
    const unprojected = state.status === "ready" ? state.rows.filter((row) => row.kind === "pending").length : 0;

    return (
      <div className="gbx-root">
        <div className="gbx-header">
          {state.status === "loading" && (
            <span className="gbx-progress">
              projecting {state.completed}/{state.total}
            </span>
          )}
          {unprojected > 0 && <span className="gbx-error">{unprojected} did not project</span>}
          {/* The list itself is a screen beside Conflicts (`catalogue-diagnostics-widget.tsx`):
              a warning about the tree is read while looking at the tree. */}
          {state.diagnostics.length > 0 && (
            <button
              type="button"
              className="gbx-catalogue-diagnostics-link"
              data-catalogue-diagnostics={state.diagnostics.length}
              onClick={() => void this.commands.executeCommand(SHOW_CATALOGUE_DIAGNOSTICS.id)}
            >
              {state.diagnostics.length} diagnostic(s) →
            </button>
          )}
        </div>

        <input
          className="gbx-filter"
          type="search"
          placeholder="Search gears and plugins"
          aria-label="Filter gears"
          value={this.filter}
          onChange={(event) => {
            this.filter = event.target.value;
            this.update();
          }}
        />
        <CatalogueGrouping value={this.store.groupPlugins} onChange={(value) => this.store.setGroupPlugins(value)} />

        {state.status === "error" && (
          <div className="gbx-error" role="alert">
            The catalogue could not be loaded: {state.error}
          </div>
        )}

        {state.failedRoots.map((root) => this.renderFailedRoot(root))}

        {state.remote !== undefined && this.renderRemote(state.remote)}

        {state.rows.length === 0 && state.status === "ready" && state.unavailable !== undefined && (
          <div className="gbx-error" role="alert">
            <div>The Studio backend is unavailable: {state.unavailable}.</div>
            <div>This workspace has no gear.gdl of its own, so its gears are the ones Studio lists.</div>
            <button type="button" className="theia-button secondary" onClick={() => void this.store.load()}>
              Retry
            </button>{" "}
            {this.renderConfigureSources()}
          </div>
        )}

        {state.rows.length === 0 && state.status === "ready" && state.unavailable === undefined && (
          <div className="gbx-empty">
            <div>No gear.gdl in this workspace&apos;s repositories.</div>
            {this.renderConfigureSources()}
          </div>
        )}

        {state.rows.length > 0 && (
          <CatalogueTree
            surface="catalogue"
            rows={state.rows}
            grouped={this.store.groupPlugins}
            search={this.filter}
            loading={state.status === "loading"}
            selectedKey={this.store.selected}
            inProduct={(id) => this.edits.inProduct(id)}
            onSelect={(node) => {
              if (node.row) this.store.select(rowKey(node.row));
            }}
            onReveal={(row) => void this.reveals.reveal(row.gear.source, row.gear.gdl_path)}
            actions={(node, selected) => this.renderAction(node, selected)}
          />
        )}

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
   * The "in this product" control. Under a host's extension point it attaches
   * the plugin to that host, which Add Gear previews -- adding the host too when
   * the product does not select it yet.
   *
   * Only on a projected row: adding a gear needs its id, and a pending row has
   * none -- `GearId` is projected at S2 (ADR
   * `cpt-gearbox-adr-staged-catalogue-loading`). And only when a product is open,
   * because otherwise the control would promise something it cannot do, which is
   * the mistake the Product view's fake links already made once.
   *
   * **Status and action are two things, and the row shows them as two.** The
   * tree's row wears the "in product" badge; the button offers the one thing the
   * click does. One control carrying both used to read `In product · Show in
   * product`, which is a sentence, not a label.
   *
   * `stopPropagation`, because the row's own click selects it and this button
   * sits inside the row: without it, adding a gear would also move the selection.
   */
  protected renderAction(node: CatalogueNode, selected: boolean): React.ReactNode {
    const row = node.row;
    if (!row || row.kind !== "projected" || !this.edits.editable) return undefined;
    const id = row.gear.id;
    const inside = this.edits.inProduct(id);
    const product = this.product.current.open?.label ?? "the product";
    // The whole sentence, as the accessible name: it is the only thing a
    // screen-reader user has, so it has to describe what the click does.
    const label = inside
      ? `Show ${row.gear.display_name} in ${product}`
      : node.host
        ? `Attach ${row.gear.display_name} to ${node.host.display_name}`
        : `Add ${row.gear.display_name} to ${product}`;
    return (
      <span className="gbx-row-action">
        <button
          type="button"
          aria-label={label}
          className="gbx-in-product"
          data-in-product={inside ? "true" : "false"}
          // `data-toggle-gear` rather than `data-gear`: the graph widget's nodes
          // carry `data-gear`, and the co-location tests reach them with an
          // unscoped `querySelector`. One attribute, one meaning per document.
          data-toggle-gear={id}
          title={label}
          tabIndex={selected ? 0 : -1}
          onClick={(event) => {
            event.stopPropagation();
            if (inside) {
              this.product.setFocus({ kind: "gear", id });
              void this.commands.executeCommand(SHOW_PRODUCT.id, "composition");
              return;
            }
            void this.commands.executeCommand(ADD_GEAR.id, { gearId: id, host: node.host?.id, point: node.point, origin: node.key });
          }}
        >
          {inside ? "Show" : "Add"}
        </button>
      </span>
    );
  }

  protected renderFailedRoot(root: FailedRoot): React.ReactNode {
    return (
      <div className="gbx-error" role="alert" key={root.path}>
        Source root <code>{root.path}</code> could not be opened: {root.error}
      </div>
    );
  }

  /**
   * Constructor Studio: the way to this machine's own gears checkout, offered
   * where the catalogue has none -- no Studio server to list them, or a
   * workspace without them.
   */
  protected renderConfigureSources(): React.ReactNode {
    return (
      <button
        type="button"
        className="theia-button secondary"
        data-configure-sources
        onClick={() => void this.commands.executeCommand(CONFIGURE_SOURCES.id)}
      >
        Use a local checkout…
      </button>
    );
  }
}
