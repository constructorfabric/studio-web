// Constructor Studio: the window names the open product while Building shows it.
//
// From Gearbox Studio (constructorfabric/gearbox#14), where the title is
// `Gearbox Studio — <product>` whatever panel is active: editing a product's
// sources should not make the window read as some file. Here Gearbox is one
// perspective among Studio's, so the product (or the gear being authored)
// stands in for the active editor only inside a Gearbox perspective; anywhere
// else the title is Theia's own, the project and the active file.

import { FrontendApplication, Saveable, Widget } from "@theia/core/lib/browser";
import { PerspectiveService } from "@theia/core/lib/browser/perspective-service";
import { WindowTitleUpdater } from "@theia/core/lib/browser/window/window-title-updater";
import { inject, injectable } from "@theia/core/shared/inversify";

import { ProductStore } from "../product-store";
import { gearboxOwnsLayout } from "./gearbox-shell-gate";
import { GearSessionService } from "./gear-session-service";

@injectable()
export class StudioWindowTitleUpdater extends WindowTitleUpdater {
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(GearSessionService) protected readonly gears!: GearSessionService;
  @inject(PerspectiveService) protected readonly perspectives!: PerspectiveService;

  protected active: Widget | undefined;

  override onStart(app: FrontendApplication): void {
    super.onStart(app);
    // Opening or renaming a product, and switching perspective, can leave the
    // same widget active, so nothing else would say the title changed.
    const again = (): void => this.updateTitleWidget(this.active);
    this.products.onChanged(again);
    this.gears.onDidChange(again);
    this.perspectives.onDidChangePerspective(again);
  }

  protected override updateTitleWidget(widget?: Widget): void {
    this.active = widget;
    const subject = this.subject();
    if (subject === undefined) {
      super.updateTitleWidget(widget);
      return;
    }
    this.windowTitleService.update({
      activeEditorShort: subject,
      dirty: Saveable.isDirty(widget) ? "●" : "",
    });
  }

  /** The product or gear Building is on, or `undefined` outside a Gearbox perspective. */
  protected subject(): string | undefined {
    if (!gearboxOwnsLayout(this.perspectives)) return undefined;
    const gear = this.gears.current;
    if (gear) return gear.label;
    const { open, intent } = this.products.current;
    return open ? intent?.display_name ?? open.label : undefined;
  }
}
