// What the catalogue load had to say, as a screen in the bottom area.
//
// It used to be an aside at the foot of the Catalogue tree, which put a list
// that grows with every source root under a list that already scrolls -- and a
// warning about the tree is read *while* looking at the tree, not instead of
// it. So it sits beside Conflicts: the same rows, a different load.
//
// **A second consumer of `CatalogueStore.diagnostics`, not a second source**,
// for the same reason `ConflictsWidget` reads `ProductStore`'s.

import { codicon, ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import { CatalogueStore } from "../catalogue-store";
import { RevealService } from "../reveal-service";
import { DiagnosticsList, errorsIn, summarise, worstFirst } from "./diagnostics-list";

@injectable()
export class CatalogueDiagnosticsWidget extends ReactWidget {
  static readonly ID = "gearbox.catalogue-diagnostics";
  static readonly LABEL = "Gearbox Diagnostics";

  @inject(CatalogueStore) protected readonly store!: CatalogueStore;
  @inject(RevealService) protected readonly reveals!: RevealService;

  @postConstruct()
  protected init(): void {
    this.id = CatalogueDiagnosticsWidget.ID;
    this.title.label = CatalogueDiagnosticsWidget.LABEL;
    this.title.iconClass = codicon("output");
    this.title.caption = "What the catalogue load reported";
    this.title.closable = true;
    this.addClass("gbx-widget-catalogue-diagnostics");
    this.toDispose.push(this.store.onChanged(() => this.update()));
    this.update();
  }

  protected render(): React.ReactNode {
    const diagnostics = worstFirst(this.store.current.diagnostics);
    return (
      <div className="gbx-conflicts" data-catalogue-diagnostics={diagnostics.length}>
        <div className="gbx-conflicts-head">
          <span className="gbx-conflicts-summary">
            {summarise(diagnostics.length, errorsIn(diagnostics))}
          </span>
        </div>
        {diagnostics.length === 0 ? (
          <div className="gbx-empty">Nothing to report: the catalogue loaded cleanly.</div>
        ) : (
          <DiagnosticsList
            diagnostics={diagnostics}
            sorted
            onReveal={(location) => void this.reveals.revealLocation(location)}
          />
        )}
      </div>
    );
  }
}
