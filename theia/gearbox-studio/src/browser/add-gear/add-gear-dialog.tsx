import React from "@theia/core/shared/react";
import { ReactDialog } from "@theia/core/lib/browser/dialogs/react-dialog";
import type { CommandRegistry } from "@theia/core/lib/common";
import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import type { EditGearResult } from "../../common/generated/EditGearResult";
import type { ProductEdit } from "../../common/generated/ProductEdit";
import type { CatalogueStore } from "../catalogue-store";
import type { ProductStore } from "../product-store";
import type { ProductEditService } from "../product-edit-service";
import type { SelectionService } from "../shell/selection-service";
import { SHOW_PRODUCT } from "../shell/session-command-ids";
import { implementsLabel, implementsPointOf, pluginsByPoint, pointsOf } from "../../common/extension-points";
import { productIdentity } from "../shell/screens";
import { impactOf, type Impact } from "./impact";
import { DiagnosticsList } from "../diagnostics/diagnostics-list";
import { diffText } from "../product-edit-service";
import { ProfileScope } from "../product/profile-scope";
import { ProductSessionService } from "../shell/product-session-service";
import { isSessionLost } from "../engine-failure";

export interface AddGearChoice { gearId?: string; host?: string; point?: string }

/**
 * One plugin staged onto the gear being added, with the scope it is staged at.
 *
 * **The scope was hardcoded to every profile**, which is what `profiles: []`
 * means: `gearbox_ir::intent::applies` is `scoped_to.is_empty() ||
 * scoped_to.contains(profile)`. So a plugin attached here landed in every
 * profile of the product, silently, while the *other* path to the same edit --
 * attaching a plugin to a host already in the product -- has had a scope control
 * since the connection editor got one. Two routes to one edit, disagreeing about
 * what the edit means.
 *
 * A record rather than an id, because two staged plugins can want different
 * answers: that is the whole point of a per-connection scope, and a list of ids
 * cannot hold it.
 */
interface StagedPlugin {
  readonly plugin: string;
  /** As written. Empty means every profile -- see `ProfileScope`. */
  readonly profiles: readonly string[];
}

/** Candidate selection stays local until the confirmed write succeeds. */
export class AddGearDialog extends ReactDialog<boolean> {
  private search = "";
  private category = "";
  private candidate?: string;
  private host?: string;
  private profiles: string[] = [];
  /**
   * Plugins staged onto the gear being added, before it exists.
   *
   * A plugin is a gear, so attaching one changes the closure -- which is a
   * consequence of *this* addition and therefore belongs in this preview rather
   * than being discovered after the write. Config and features do not work that
   * way: they change nothing about which gears arrive, so they wait for the
   * product (§2.4 of the composition ADR).
   */
  private staged: StagedPlugin[] = [];
  private pluginPick = "";
  private preview?: EditGearResult;
  private impact?: Impact;
  private error?: string;
  private resolving = false;
  private writing = false;
  private token = 0;
  private accepted = false;
  private readonly path: string;

  constructor(private readonly catalogue: CatalogueStore, private readonly products: ProductStore,
    private readonly edits: ProductEditService, private readonly selection: SelectionService,
    private readonly commands: CommandRegistry, private readonly session: ProductSessionService,
    private readonly initial: AddGearChoice = {}) {
    super({ title: initial.host ? `Add plugin to ${initial.host}` : "Add gear to product", maxWidth: 1120 });
    this.node.classList.add("gbx-add-dialog");
    this.path = products.current.open!.path;
    this.candidate = initial.gearId;
    this.host = initial.host;
    // Theia builds these two, so the markers the old panel's own buttons carried
    // are stamped on afterwards. `submit` and `apply` were two names for the one
    // act even then -- the panel staged a proposal and wrote it with one click.
    this.appendCloseButton("Cancel").setAttribute("data-add-gear-cancel", "");
    const accept = this.appendAcceptButton("Add to product");
    accept.setAttribute("data-add-gear-submit", "");
    accept.setAttribute("data-add-gear-apply", "");
    // **One notion of "still my product", shared with the write boundary.**
    // This compared raw paths while `previewStagedAdd` and `commitAddGear`
    // compare `productIdentity(...)`, which canonicalises. Both were right
    // because both sides came from the same store field, but a guard and the
    // boundary it guards should not be able to disagree about identity.
    const mine = productIdentity(this.path);
    this.toDispose.push(products.onChanged(() => {
      const open = products.current.open;
      if (open === undefined || productIdentity(open.path) !== mine) {
        this.token++;
        this.close();
      }
      this.update();
    }));
    this.toDispose.push(catalogue.onChanged(() => this.update()));
    void this.refreshPreview();
  }
  get value(): boolean { return this.accepted; }
  private descriptors(): GearDescriptor[] { return this.catalogue.current.rows.flatMap(row => row.kind === "projected" ? [row.gear] : []); }
  private chosen(): GearDescriptor | undefined { return this.descriptors().find(d => `${d.source}:${d.id}` === this.candidate || d.id === this.candidate); }
  private hosts(plugin: GearDescriptor): GearDescriptor[] {
    const state = this.products.current;
    return this.descriptors().filter(host => implementsPointOf(plugin, host) &&
      (state.intent?.selected_gears.some(g => g.gear === host.id) || !!state.resolution?.product?.gears[host.id]));
  }
  /**
   * Whether this host already has this plugin for a profile the proposal claims.
   *
   * **Overlap, not equality, and the rule is the engine's.** An empty scope
   * means *every* profile (`ProductIntent::applies`), so proposing an unscoped
   * `plugin("oidc-authn-plugin")` beside an existing `profiles = ["prod"]` entry
   * is the same implementation twice under one host in one profile -- which the
   * evaluator reports as a collision, so the write is refused and no intent
   * comes back. Asking here turns that into a sentence instead of a refusal
   * whose reason is two layers away.
   *
   * Disjoint scopes are the case this must *not* catch: `["dev"]` beside
   * `["prod"]` is a pair of legitimate entries, and offering them is the whole
   * reason connections carry a scope.
   */
  private alreadyAttached(host: string, plugin: string, profiles: string[]): boolean {
    const entries = this.products.current.intent?.selected_gears.find(g => g.gear === host)?.plugins ?? [];
    return entries.some(entry => {
      if (entry.gear !== plugin) return false;
      const mine = entry.profiles ?? [];
      // Either side empty is "every profile", which overlaps anything.
      return mine.length === 0 || profiles.length === 0 || mine.some(p => profiles.includes(p));
    });
  }

  /** The catalogue's plugins that fill one of this host's own points. */
  private compatible(host: GearDescriptor): GearDescriptor[] {
    return this.descriptors().filter(plugin => implementsPointOf(plugin, host));
  }
  /**
   * Why there is nothing to write yet, or nothing to change.
   *
   * **The two panes must not disagree.** The panel they replace asked the engine
   * what a top-level `use_gear` of a plugin would do while the batch it would
   * write was an `add_plugin` -- so for a plugin with no eligible host it said
   * "nothing declares this interface" *and* "1 gear joins the closure", and
   * offered "you can still add it" beside a disabled button. One proposal, two
   * descriptions. Both sections read this one sentence instead.
   */
  private pending(): string {
    const gear = this.chosen();
    if (!gear) return "Choose a gear to see what it adds to your product.";
    if (gear.implements) {
      const hosts = this.hosts(gear);
      if (!hosts.length) {
        return `Nothing in this product declares ${implementsLabel(gear.implements)}, ` +
          "so there is no gear for this plugin to fill a point on.";
      }
      if (!this.host) return "Choose the gear that will host this plugin.";
      if (this.alreadyAttached(this.host, gear.id, this.profiles)) {
        return `\`${gear.id}\` is already attached to ${this.host} for these profiles, ` +
          "so nothing would be written. Narrow the scope to add it for another profile.";
      }
    }
    if (this.resolving) return "Calculating changes…";
    if (this.preview && !this.preview.changed) {
      return gear.implements && this.host
        ? `\`${gear.id}\` is already attached to ${this.host}, so nothing would be written.`
        : `\`${gear.id}\` is already in this product, so nothing would be written.`;
    }
    return "Nothing to write yet.";
  }
  private proposal(): ProductEdit[] {
    const gear = this.chosen();
    if (!gear) return [];
    if (!gear.implements) {
      return [
        { kind: "add_gear", gear: gear.id, source: gear.source },
        // Each staged plugin, attached to the gear the same batch adds, **at the
        // scope it was staged at**. Order matters: `add_plugin_selection`
        // refuses a host that is not selected.
        ...this.staged.map(entry => ({
          kind: "add_plugin_selection" as const,
          gear: gear.id,
          plugin: entry.plugin,
          profiles: [...entry.profiles],
        })),
      ];
    }
    const host = this.hosts(gear).find(h => h.id === this.host);
    if (!host) return [];
    if (this.alreadyAttached(host.id, gear.id, this.profiles)) return [];
    return [
      ...(this.products.current.intent?.selected_gears.some(g => g.gear === host.id) ? [] : [{ kind: "add_gear" as const, gear: host.id, source: host.source }]),
      { kind: "add_plugin_selection", gear: host.id, plugin: gear.id, profiles: this.profiles },
    ];
  }
  /**
   * Put the session back and recompute this proposal against it.
   *
   * The whole open sequence, through `ProductSessionService.reconnect` -- the
   * same one the panel offers -- so there is one definition of what a session
   * is. The dialog stays open throughout: `products.onChanged` closes it only
   * when the product is gone or a *different* one is open, and a re-read of the
   * same product is neither.
   */
  private async recover(): Promise<void> {
    this.error = undefined;
    this.resolving = true;
    this.update();
    await this.session.reconnect();
    if (this.isDisposed) return;
    await this.refreshPreview();
  }

  private async refreshPreview(): Promise<void> {
    const token = ++this.token;
    this.preview = undefined; this.impact = undefined; this.error = undefined;
    const proposal = this.proposal();
    if (!proposal.length) { this.resolving = false; this.update(); return; }
    this.resolving = true; this.update();
    const [staged, resolved] = await Promise.all([
      this.edits.previewStagedAdd(proposal, productIdentity(this.path)), this.edits.previewResolution(proposal),
    ]);
    if (token !== this.token || this.isDisposed) return;
    this.resolving = false;
    this.preview = staged.ok ? staged.preview : undefined;
    // **The reason it gave, not a sentence about reasons.** This showed "this
    // proposal cannot be written" whatever had happened, while the actual
    // refusal went past as a notification — which also took the Escape key.
    if (!staged.ok) this.error = staged.reason;
    if (resolved.ok && resolved.resolution.product) this.impact = impactOf(this.products.current.resolution?.product ?? undefined,
      resolved.resolution.product, this.products.current.diagnostics, resolved.resolution.diagnostics ?? []);
    else if (!resolved.ok) this.error = resolved.reason;
    this.update();
  }
  protected override async accept(): Promise<void> {
    if (!this.preview?.changed || this.writing || this.resolving) return;
    const gear = this.chosen(); if (!gear) return;
    const proposal = this.proposal(), expected = this.preview;
    this.writing = true; this.update();
    const again = await this.edits.previewStagedAdd(proposal, productIdentity(this.path));
    const fresh = again.ok ? again.preview : undefined;
    if (!fresh || fresh.before !== expected.before || fresh.after !== expected.after) {
      this.writing = false; await this.refreshPreview();
      this.error = "The document changed. Review the updated preview and confirm again.";
      this.update(); return;
    }
    const ok = await this.edits.commitAddGear(gear.id, proposal, productIdentity(this.path), expected.before);
    this.writing = false;
    if (!ok) { this.error = "Nothing was added. Refresh the preview and try again."; this.update(); return; }
    this.accepted = true;
    if (gear.implements && this.host) {
      // The entry just appended is the last one written, so its own
      // `entry_index` is the address -- not its position in this array, which is
      // only the same while nothing in the list is unusable.
      const plugins = this.products.current.intent?.selected_gears.find(g => g.gear === this.host)?.plugins ?? [];
      const mine = plugins.filter(p => p.gear === gear.id);
      const added = mine[mine.length - 1];
      if (added) {
        this.selection.select({ kind: "plugin", host: this.host, id: gear.id, entryIndex: added.entry_index, path: this.path });
      } else this.selection.select({ kind: "gear", id: this.host });
    } else this.selection.select({ kind: "gear", id: gear.id });
    await super.accept();
    await this.commands.executeCommand(SHOW_PRODUCT.id, "composition");
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".gbx-composition-settings")?.focus());
  }
  /**
   * Whether **Add to product** may be pressed.
   *
   * **Theia's hook, because assigning `acceptButton.disabled` does not hold.**
   * `AbstractDialog.onUpdateRequest` renders *then* calls `validate()`, which
   * calls `setErrorMessage` and sets `disabled` from the result -- so a render
   * that disabled the button had it re-enabled a moment later, every time. The
   * button was therefore always live, including while the dialog said in two
   * places that nothing would be written.
   *
   * `false` rather than a message: the reason is already on screen, in the
   * `changes` and `closure` sections, and Theia would print a second copy of it
   * into its own error node.
   *
   * An error the *proposal introduces* is not a reason to refuse -- building a
   * product is add-a-gear-then-configure-it, so a resolution that complains in
   * between is a waypoint. That is what the warning beside the button is for.
   */
  protected override isValid(): boolean | string {
    if (this.writing || this.resolving) return false;
    return this.preview?.changed === true;
  }

  protected render(): React.ReactNode {
    const chosen = this.chosen(), all = this.descriptors();
    const filtered = all.filter(d => (!this.initial.point || (d.implements && d.implements.spec === this.initial.point)) &&
      (!this.initial.host || !!d.implements) && (!this.category || d.category === this.category) &&
      `${d.id} ${d.display_name} ${d.description}`.toLowerCase().includes(this.search.toLowerCase()));
    const introduced = this.impact?.newDiagnostics.length ?? 0;
    // `data-add-gear-flow` is the marker the old Add Gear *panel* carried, kept
    // because this dialog is that flow now: the specs ask "is the add-gear flow
    // on screen", and the answer is still yes -- only the surface changed.
    return <div className="gbx-add-dialog-content" data-add-gear-flow>
      <div className="gbx-add-dialog-search"><label>Find a gear<input autoFocus aria-label="Search gear catalogue" value={this.search} onChange={e => { this.search = e.target.value; this.update(); }} /></label>
        <label>Category<select value={this.category} onChange={e => { this.category = e.target.value; this.update(); }}><option value="">All categories</option>{[...new Set(all.map(d => d.category).filter((c): c is string => !!c))].sort().map(c => <option key={c} value={c}>{c}</option>)}</select></label></div>
      <div className="gbx-add-dialog-columns"><nav aria-label="Available gears" data-add-gear-picker>
        {filtered.map(d => <button type="button" key={`${d.source}:${d.id}`} data-add-gear-select={d.id} aria-pressed={chosen === d} className="gbx-catalogue-choice" onClick={() => { this.candidate = `${d.source}:${d.id}`; this.host = this.initial.host; this.profiles = []; this.staged = []; this.pluginPick = ""; void this.refreshPreview(); }}>
          <strong>{d.display_name || d.id}</strong><small>{d.id} · {d.source}{this.edits.inProduct(d.id) ? " · In product" : ""}</small>
        </button>)}
        {!filtered.length && <p>No matching gears. Entries still being projected become available when ready.</p>}
      </nav><section aria-label="Addition preview">
        {!chosen ? <p>Choose a gear to see what it adds to your product.</p> : <>
          {/* Each fact on its own line. `<small>` and the `Host` label below it
              are both inline-level with nothing between them, so they rendered
              as `Source: gears-rustHost` -- two facts read as one word. */}
          <h3>{chosen.display_name || chosen.id}</h3><p>{chosen.description}</p>
          <div className="gbx-kv"><span>source</span><span>{chosen.source}</span></div>
          {chosen.implements && <><label data-add-gear-host data-add-gear-plugin={chosen.id}>Host<select data-add-gear-host-pick aria-label="Plugin host" value={this.host ?? ""} disabled={!!this.initial.host} onChange={e => { this.host = e.target.value; void this.refreshPreview(); }}><option value="">Choose a host</option>{this.hosts(chosen).map(h => <option key={h.id} value={h.id}>{h.id}</option>)}</select></label>
            {!this.hosts(chosen).length && <p data-add-gear-host-none>{this.pending()}</p>}
            <ProfileScope legend="Profiles for this connection" profiles={this.profiles}
              available={Object.keys(this.products.current.intent?.profiles ?? {})}
              viewing={this.products.current.profile ?? undefined}
              onChange={(next: string[]) => { this.profiles = next; void this.refreshPreview(); }} />
            {/* Addressable, because it is the one statement that says this
                addition is two edits rather than one. */}
            {this.host && !this.edits.inProduct(this.host) && <p data-add-gear-host-joins={this.host}>The host {this.host} will become an explicitly selected gear.</p>}
          </>}
          {!chosen.implements && (() => {
            const points = pointsOf(chosen), offer = this.compatible(chosen).filter(p => !this.staged.some(entry => entry.plugin === p.id));
            return <section className="gbx-features-list" data-add-gear-plugins data-add-gear-section="plugins">
              <h4>Plugins</h4>
              {/* **Extension points first, and the offer only if there are any.**
                  A UX pass read "Extension points: none declared." three lines
                  above a list of every plugin in the catalogue, chose one, and
                  was told it would join the closure. The data to refuse that was
                  already on the wire both ways -- the host's `extension_points`
                  and the plugin's `implements.point` -- so the offer was the defect. */}
              {!points.length ? <p data-add-gear-plugins-none>Extension points: none declared. This gear takes no plugins.</p> : <>
                <p>Extension points: {points.map(point => point.trait_ident).join(", ")}</p>
                {this.staged.map(entry => <div key={entry.plugin} data-add-gear-staged={entry.plugin}>
                  <p data-add-gear-plugin={entry.plugin}>{entry.plugin}
                  <button type="button" data-add-gear-plugin-remove={entry.plugin} onClick={() => { this.staged = this.staged.filter(v => v.plugin !== entry.plugin); void this.refreshPreview(); }}>Remove</button></p>
                  {/* **A legend per plugin, and it is not decoration.**
                      `ProfileScope` names its radio group after the legend, so
                      two controls sharing one would be one group: choosing a
                      narrow scope for the second plugin would clear the first
                      back to "all profiles" with nothing on screen saying so. */}
                  <ProfileScope legend={`Profiles for ${entry.plugin}`} profiles={entry.profiles}
                    available={Object.keys(this.products.current.intent?.profiles ?? {})}
                    viewing={this.products.current.profile ?? undefined}
                    onChange={(next: string[]) => {
                      this.staged = this.staged.map(v => v.plugin === entry.plugin ? { plugin: v.plugin, profiles: next } : v);
                      void this.refreshPreview();
                    }} />
                </div>)}
                {offer.length ? <>
                  <select data-add-gear-plugin-pick aria-label="Plugin to attach" value={this.pluginPick}
                    onChange={e => { this.pluginPick = e.target.value; this.update(); }}>
                    <option value="">Choose a plugin</option>
                    {/* **Grouped by the point it implements when there is more than
                        one** -- mini-chat declares two, and a flat list left a
                        person to know which plugin answers which trait. One
                        point needs no heading. */}
                    {points.length > 1
                      ? pluginsByPoint(chosen, offer)
                          .filter(group => group.plugins.length > 0)
                          .map(group => (
                            <optgroup key={group.point.spec} label={group.point.trait_ident}>
                              {group.plugins.map(p => <option key={p.id} value={p.id}>{p.id}</option>)}
                            </optgroup>
                          ))
                      : offer.map(p => <option key={p.id} value={p.id}>{p.id}</option>)}
                  </select>
                  <button type="button" data-add-gear-plugin-add disabled={!this.pluginPick}
                    onClick={() => { if (this.pluginPick) { this.staged = [...this.staged, { plugin: this.pluginPick, profiles: [] }]; this.pluginPick = ""; void this.refreshPreview(); } }}>Attach plugin</button>
                </> : <p data-add-gear-plugins-unfilled>Every plugin that implements these points is already staged.</p>}
              </>}
            </section>;
          })()}
          {this.edits.hasDraft() && <p role="note">Impact uses the saved product. Pending configuration changes stay in your draft and are not applied by Add.</p>}
          {this.resolving && <p role="status">Calculating changes…</p>}
          {/* **Two different failures, two different offers.** `Refresh preview`
              re-asks the engine, which is the right thing when the engine
              answered and the answer was a refusal. When the session is what
              went -- a missed deadline, a child that died -- re-asking is asking
              nothing, and the panel's own Reconnect button is underneath this
              dialog. So recovery is offered here, and the proposal on screen
              (the candidate, the host, the staged plugins and each one's profile
              scope) is untouched by it: they are fields of this dialog, and a
              re-read of the product does not go near them. */}
          {this.error && <p role="alert" data-add-gear-impact-error>{this.error}
            {isSessionLost(this.error)
              ? <button type="button" data-add-gear-reconnect onClick={() => void this.recover()}>Reconnect engine</button>
              : <button type="button" data-add-gear-refresh onClick={() => void this.refreshPreview()}>Refresh preview</button>}
          </p>}
          {/* **Said beside the button, and the button stays live.** Building a
              product is add-a-gear-then-configure-it, so a resolution that
              complains in between is a waypoint: refusing the write would make
              the ordinary order impossible. What must not happen is writing it
              silently, so the count of what this addition *introduces* -- the
              subtraction `impactOf` performs, not the diagnostics the product
              already had -- is stated here. */}
          {introduced > 0 && (
            <p role="alert" className="gbx-add-gear-note" data-add-gear-error-warning={introduced}>
              This addition introduces {introduced} new{" "}
              {introduced === 1 ? "diagnostic" : "diagnostics"}. You can still add it and fix
              them in the product.
            </p>
          )}
          <section data-add-gear-impact data-add-gear-section="changes"><h4>What changes</h4>
            {!this.impact && <p>{this.pending()}</p>}
            {this.impact?.arriving.map(g => <p key={g.id} data-add-gear-impact-closure={g.id} data-impact-gear={g.id}>+ {g.id} · {g.why}</p>)}
            {this.impact?.applicationsAdded.map(a => <p key={`+${a}`} data-add-gear-impact-applications={a}>+ Application {a}</p>)}
            {this.impact?.applicationsRemoved.map(a => <p key={`-${a}`}>− Application {a}</p>)}
            {this.impact?.moved.map(m => <p key={m.gear}>{m.gear}: {m.from} → {m.to}</p>)}
            {this.impact && [...this.impact.bindingsAdded, ...this.impact.bindingsChanged].map(b => <p key={`${b.consumer}:${b.contract}`} data-add-gear-impact-bindings={`${b.consumer}:${b.contract}`}>{b.consumer} / {b.contract}: {b.before} → {b.after}</p>)}
            {this.impact && <span data-add-gear-impact-diagnostics={this.impact.newDiagnostics.length}><DiagnosticsList diagnostics={this.impact.newDiagnostics} density="compact" /></span>}
          </section>
          {/* `gbx-edit-preview` is the class the old panel's preview carried:
              the specs ask what *would be written*, and this is still that. */}
          {/* `closure` is the section that answers "what would be written", which
              is the serialization itself rather than a description of it. */}
          <section data-add-gear-section="closure">
            {/* **The lines that change, not the file that contains them.** This
                rendered `preview.after`, which is the whole `product.gdl` --
                comments and all -- open by default, so the one line being added
                was somewhere in a hundred. The full text stays, one click away,
                because "what exactly will my description look like" is a fair
                question; it is just not the first one. */}
            {this.preview?.changed
              ? <>
                  <pre className="gbx-edit-preview" data-add-gear-diff>{diffText(this.preview)}</pre>
                  <details><summary>The whole description, as it would be written</summary>
                    <pre className="gbx-edit-preview" data-add-gear-after>{this.preview.after}</pre>
                  </details>
                </>
              : <p>{this.pending()}</p>}
          </section>
          <p>Configuration continues in the product after adding.</p>
        </>}
      </section></div>
    </div>;
  }
}
