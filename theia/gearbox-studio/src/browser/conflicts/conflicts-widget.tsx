// The resolution's complaints, as a screen of their own.
//
// eCos's Config Tool makes conflicts a domain screen rather than a status line,
// and it is right to: a conflict is the thing a person is *working on* when there
// is one -- read it, go to what caused it, change the description, resolve again.
// A list squeezed under a tree is a list nobody reads.
//
// **A second consumer of `ProductStore.diagnostics`, not a second source.**
// `ResolutionMarkers` already turns the same array into Problems markers, and
// keeping one array with two renderers is what makes the Problems view and this
// panel unable to disagree.
//
// **And the row itself is no longer this file's.** It moved to
// `diagnostics/diagnostics-list.tsx` unchanged, because the Product view's
// Validation stage needs the same row and had been reduced to two counts and a
// button pointing here -- a screen whose whole content was a way to leave it.
// What this file keeps is what is particular to a *screen* of conflicts: the
// profile it is about, and `Resolve again`.
//
// `Resolve again` means exactly that. There is no automatic resolver and none is
// promised: the engine reports what it cannot decide, a person edits the
// description, and the next resolution is the answer.

import { codicon, ReactWidget } from "@theia/core/lib/browser";
import { CommandRegistry } from "@theia/core/lib/common";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import {
  DiagnosticsList,
  errorsIn,
  summarise,
  worstFirst,
} from "../diagnostics/diagnostics-list";
import { ProductStore } from "../product-store";
import { RevealService } from "../reveal-service";
import { SelectionService } from "../shell/selection-service";
import { RESOLVE_PRODUCT } from "../view-contributions";
import type { Message } from "@theia/core/shared/@lumino/messaging";

@injectable()
export class ConflictsWidget extends ReactWidget {
  static readonly ID = "gearbox.conflicts";
  static readonly LABEL = "Gearbox Conflicts";

  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(RevealService) protected readonly reveals!: RevealService;
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;

  @postConstruct()
  protected init(): void {
    this.id = ConflictsWidget.ID;
    this.title.label = ConflictsWidget.LABEL;
    this.title.iconClass = codicon("warning");
    this.title.caption = ConflictsWidget.LABEL;
    this.title.closable = true;
    this.addClass("gbx-widget-conflicts");
    this.toDispose.push(this.products.onChanged(() => this.update()));
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
    const state = this.products.current;
    if (state.open === undefined) {
      return (
        <div className="gbx-conflicts gbx-empty">
          Open a product. Conflicts are what one resolution could not decide.
        </div>
      );
    }

    const diagnostics = worstFirst(state.diagnostics);

    return (
      <div className="gbx-conflicts" data-conflicts-count={diagnostics.length}>
        <div className="gbx-conflicts-head">
          <span className="gbx-conflicts-summary">
            {summarise(diagnostics.length, errorsIn(diagnostics))}
          </span>
          <span className="gbx-badge" data-conflicts-profile={state.profile ?? ""}>
            {state.profile ?? "—"}
          </span>
          <button
            type="button"
            className="gbx-choice"
            data-command={RESOLVE_PRODUCT.id}
            disabled={!this.commands.isEnabled(RESOLVE_PRODUCT.id)}
            // Not "Fix": there is no automatic resolver, and a button that implied
            // one would be the most expensive kind of wrong label. This re-runs the
            // resolution, which is what answers whether an edit worked.
            title="Resolve again, after editing the description"
            onClick={() => void this.commands.executeCommand(RESOLVE_PRODUCT.id)}
          >
            Resolve again
          </button>
        </div>

        {state.status === "error" && diagnostics.length === 0 ? (
          /* **"No conflicts" is the wrong answer for a product that did not
             load.** The diagnostics this panel draws are a *resolution's*, and a
             failed load produced none -- so an empty list here used to read as a
             clean bill of health for a file the engine had just refused. It read
             worse than that before `ProductStore.fail` stopped keeping the
             previous resolution's diagnostics: the panel reported the product
             before this one as though it were this one. The reason itself lives
             in the Product panel, which is where the file and the retry are. */
          <div className="gbx-empty" data-conflicts-unavailable="true">
            This product did not load, so there is no resolution to report on.{" "}
            {state.error ?? "The Product view has the reason."}
          </div>
        ) : diagnostics.length === 0 ? (
          <div className="gbx-empty">
            Nothing to report: the <code>{state.profile}</code> resolution raised no diagnostics.
          </div>
        ) : (
          <DiagnosticsList
            diagnostics={diagnostics}
            sorted
            onReveal={(location) => void this.reveals.revealLocation(location)}
            onExplain={(selection) => this.selection.select(selection)}
          />
        )}
      </div>
    );
  }
}
