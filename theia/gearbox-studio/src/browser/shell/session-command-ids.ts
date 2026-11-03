// Command ids shared without pulling in contributions — breaks the cycle
// StartWidget → session-commands → CreateProductViewContribution → StartWidget.

export const NEW_PRODUCT = {
  id: "gearbox.product.new",
  label: "Gearbox: New Product…",
};

export const OPEN_PRODUCT = {
  id: "gearbox.product.open",
  label: "Gearbox: Open Product…",
};

export const CLOSE_PRODUCT = {
  id: "gearbox.product.close",
  label: "Gearbox: Close Product",
  shortTitle: "Close",
};

export const NEW_GEAR = {
  id: "gearbox.gear.new",
  label: "Gearbox: New Gear…",
};

export const OPEN_GEAR = {
  id: "gearbox.gear.open",
  label: "Gearbox: Open Gear…",
};

export const CLOSE_GEAR = {
  id: "gearbox.gear.close",
  label: "Gearbox: Close Gear",
  shortTitle: "Close",
};

export const ADD_GEAR = {
  id: "gearbox.product.addGear",
  label: "Gearbox: Add Gear…",
  shortTitle: "Add Gear",
};

export const BROWSE_CATALOGUE = {
  id: "gearbox.catalogue.browse",
  label: "Gearbox: Browse Catalogue",
  shortTitle: "Browse Catalogue",
};

/**
 * Show the Conflicts screen, for a caller that means *show* it.
 *
 * `gearbox.conflicts.toggle` is what `AbstractViewContribution` registers, and a
 * toggle closes an open view. That is right for a View-menu entry and wrong for
 * the Product view's diagnostics summary: clicking "2 conflicts" to make them
 * disappear is the same defect `BROWSE_CATALOGUE` exists to avoid, and it is
 * worse here, because the thing being hidden is the reason the line is on screen.
 */
/**
 * Bring the Product workspace forward, for a flow that has just finished with it.
 *
 * The wizards end by opening a product (create) or editing one (create a gear for
 * it) and then closing themselves. `ProductViewContribution.mayTakeTheFront`
 * refuses to steal the front from a Gearbox surface a person navigated to -- that
 * rule is what keeps a late activation off the Add Gear panel -- so a flow that
 * *wants* the product in front says so.
 */
export const SHOW_PRODUCT = {
  id: "gearbox.product.show",
  label: "Gearbox: Show Product",
  shortTitle: "Product",
};

export const SHOW_CONFLICTS = {
  id: "gearbox.conflicts.show",
  label: "Gearbox: Show Conflicts",
  shortTitle: "Conflicts",
};

/** Open the catalogue load's diagnostics in the bottom area; opens, never toggles. */
export const SHOW_CATALOGUE_DIAGNOSTICS = {
  id: "gearbox.catalogue.diagnostics.show",
  label: "Gearbox: Show Catalogue Diagnostics",
  shortTitle: "Diagnostics",
};

/**
 * Show Generate, for a caller that means *show* it.
 *
 * Same defect `SHOW_CONFLICTS` exists to avoid: `gearbox.generate.toggle` closes
 * an open view, and the Product strip's "Generate →" is navigation, not a
 * toggle. A click that hides the plan because the plan was already open is the
 * opposite of what the arrow says.
 */
export const SHOW_GENERATE = {
  id: "gearbox.generate.show",
  label: "Gearbox: Show Generate",
  shortTitle: "Generate",
};

/**
 * Constructor Studio: Generate the open product and press the Build its
 * profile shows -- `cargo build` for a local one, Build images for a
 * kubernetes one. The portal's Builds tab runs it through a `cfstudio://`
 * link with `build=1` ("On my machine").
 */
export const GENERATE_AND_BUILD = {
  id: "gearbox.product.generateAndBuild",
  label: "Gearbox: Generate and Build",
};

/**
 * Constructor Studio: write the open product's debug configurations -- one
 * CodeLLDB configuration per application Run starts -- into the workspace's
 * `.vscode/launch.json`, so F5 debugs what Run runs. The Run & Deploy view's
 * "Debug configurations" button does the same.
 */
export const ADD_DEBUG_CONFIGURATIONS = {
  id: "gearbox.product.addDebugConfigurations",
  label: "Gearbox: Add Debug Configurations",
};

/**
 * Constructor Studio: show the Resolution Lock, for a caller that means *show*
 * it -- the ribbon and the Gearbox menu. Same reason as `SHOW_CONFLICTS`:
 * `gearbox.lock.toggle` closes an open lock, which is right in `View > Views`
 * and wrong for a button a person presses to see it.
 */
export const SHOW_LOCK = {
  id: "gearbox.lock.show",
  label: "Gearbox: Show Resolution Lock",
  shortTitle: "Lock",
};

/**
 * Constructor Studio: the Product view's own acts, as commands, so that its
 * "⋯" menu is a registered Theia menu (`GearboxMenus.PRODUCT_ACTIONS`) rather
 * than buttons in a hand-built popup. Each opens the Product view and asks it.
 */
export const SHOW_PRODUCT_SETTINGS = {
  id: "gearbox.product.settings",
  label: "Gearbox: Product Settings",
};

export const ADD_PROFILE = {
  id: "gearbox.product.addProfile",
  label: "Gearbox: Add Profile…",
};

/** The open product's description, in the editor. */
export const OPEN_PRODUCT_DESCRIPTION = {
  id: "gearbox.product.openDescription",
  label: "Gearbox: Open Product GDL",
};
