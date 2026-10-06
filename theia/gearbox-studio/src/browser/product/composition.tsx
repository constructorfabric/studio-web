import React from "@theia/core/shared/react";
import type { ProductState } from "../product-store";
import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import { pointKey, pointsOf } from "../../common/extension-points";
import { describeInclusion } from "./inclusion";
import type { Selection } from "../shell/selection-service";
import { RevealLink } from "../reveal-link";
import type { RevealService } from "../reveal-service";

export interface CompositionProps {
  state: ProductState;
  descriptors: readonly GearDescriptor[];
  selection: Selection | undefined;
  select: (selection: Selection) => void;
  add: (host?: string, point?: string) => void;
  remove: (host: string, entryIndex?: number) => void;
  settings: React.ReactNode;
  /** Which hosts are folded shut, and how to change that. Widget state. */
  folded: ReadonlySet<string>;
  toggleFold: (host: string) => void;
  /** For the links from a gear to its own `gear.gdl`. */
  reveals: RevealService;
}

/**
 * A gear id, as a link to its own `gear.gdl`.
 *
 * `source` and `gdl_path` come from the resolution, so a gear the resolution
 * does not know about renders as plain text rather than a dead link -- which is
 * the ordinary case here, unlike on the old Gears stage: this tree is built from
 * the intent and shows gears whose resolution failed or has not arrived.
 */
function GearLink({ state, id, reveals, select }: {
  state: ProductState; id: string; reveals: RevealService; select: (selection: Selection) => void;
}): React.ReactElement {
  const gear = state.resolution?.product?.gears?.[id];
  if (gear === undefined) return <code>{id}</code>;
  return <span className="gbx-gear-link">
    <RevealLink reveals={reveals} source={gear.source} target={gear.gdl_path} label={id}
      onActivate={() => select({ kind: "gear", id })} />
  </span>;
}

/** The saved intent is the tree; resolution only annotates it. */
export function Composition({ state, descriptors, selection, select, add, remove, settings, reveals, folded, toggleFold }: CompositionProps): React.ReactElement {
  // A composition is a view of one open document; without one there is nothing
  // to address a connection in. `explicit` is empty in that case anyway, so the
  // tree renders its empty state rather than a non-null assertion.
  const openPath = state.open?.path ?? "";
  const explicit = state.intent?.selected_gears ?? [];
  const descriptor = (id: string) => descriptors.find(d => d.id === id);
  const named = new Set(explicit.map(g => g.gear));
  const plugins = new Set(explicit.flatMap(g => (g.plugins ?? []).map(p => p.gear)));
  const automatic = Object.entries(state.resolution?.product?.gears ?? {}).filter(([id]) => !named.has(id) && !plugins.has(id));
  return <div className="gbx-composition" data-composition>
    <nav className="gbx-composition-tree" aria-label="Product composition">
      <h3>Selected gears{explicit.length === 0 && (state.status === "loading" || state.status === "resolving") ? "" : ` (${explicit.length})`}</h3>
      {/* **An empty intent is not an empty product while one is being read.**
          `open()` sets `status: "loading"` with no intent yet, so a product
          with six gears rendered `Selected gears (0)` and "your product has no
          gears yet" for as long as the read took, and then filled in. A screen
          that says a product is empty must be sure it is. */}
      {explicit.length === 0 && (state.status === "loading" || state.status === "resolving") &&
        <div className="gbx-empty" role="status" data-composition-loading={state.status}>
          {state.status === "loading" ? "Reading the description…" : "Resolving…"}
        </div>}
      {explicit.length === 0 && state.status !== "loading" && state.status !== "resolving" && <div className="gbx-empty">Your product has no gears yet. Choose a gear, then configure it here.
        <button type="button" className="gbx-start-primary" onClick={() => add()}>Add gear</button>
      </div>}
      {explicit.map(host => {
        const d = descriptor(host.gear);
        const points = d ? pointsOf(d).map(p => ({ key: pointKey(p), label: p.trait_ident })) : [];
        // Keyed by `entry_index`, the position the entry is written at, because
        // that is the address the editor resolves. It equals the array position
        // for every product that loads today -- an entry evaluation cannot use
        // takes the whole intent down with it -- but reading the field keeps the
        // tree and the editor speaking about the same entry if that changes.
        const connections = (host.plugins ?? []).map(p => ({
          p,
          entryIndex: p.entry_index,
          spec: descriptor(p.gear)?.implements?.spec,
        }));
        const unassigned = connections.filter(c => !c.spec || !points.some(p => p.key === c.spec));
        const renderConnections = (entries: typeof connections) => entries.map(({ p, entryIndex }) => {
          const active = !p.profiles?.length || p.profiles.includes(state.profile ?? "");
          const selected =
            selection?.kind === "plugin" &&
            selection.host === host.gear &&
            selection.entryIndex === entryIndex;
          return <div className="gbx-composition-connection" key={entryIndex} data-plugin-host={host.gear} data-plugin-index={entryIndex} data-plugin-id={p.gear} data-plugin-active={active}>
            <button type="button" aria-pressed={selected} className={`gbx-choice ${selected ? "gbx-choice-on" : ""}`} onClick={() => select({ kind: "plugin", host: host.gear, id: p.gear, entryIndex, path: openPath })}>{p.gear}</button>
            <small>Profiles: {p.profiles?.join(", ") || "All profiles"}{!active ? " · inactive here" : ""}</small>
          </div>;
        });
        const chosen = selection?.kind === "gear" && selection.id === host.gear;
        const shut = folded.has(host.gear);
        // **Not a `<details>` any more, and the reason is not stylistic.**
        // Toggling is what activating a `<summary>` *does*: a click on anything
        // inside it bubbles there and folds the branch unless something cancels
        // the default. So a summary cannot both name the gear and select it, and
        // the tree grew a separate `Configure <gear>` button to do the selecting
        // -- three different actions where a person expects one, and the name of
        // the thing was the one that did the least.
        //
        // The disclosure is its own control now, which is the pattern the
        // catalogue's groups and the topology tree already use.
        return <div key={host.gear} className="gbx-composition-host" data-asked-for={host.gear} data-collapsed={shut ? "true" : "false"}>
          <div className="gbx-composition-host-row">
            <button type="button" className={`gbx-twistie codicon codicon-chevron-${shut ? "right" : "down"}`}
              aria-expanded={!shut} aria-label={`${shut ? "Expand" : "Collapse"} ${host.gear}`}
              data-composition-expand={host.gear} onClick={() => toggleFold(host.gear)} />
            {/* The row is the selector. `data-composition-gear` stays on it, so
                the act it names -- configure this gear -- is addressed the same
                way it always was.

                The icon says what kind of gear this is, read from the resolution
                rather than from the id: `*-plugin` is a naming convention, being
                a plugin is a fact about what selected it. */}
            {/* Name and id share a column so they may wrap together; `Remove`
                keeps its own. As flat flex items, a long display name pushed the
                button onto the next line for some gears and not others -- the
                catalogue row's lesson, one panel over. */}
            <span className="gbx-composition-host-main">
            <button type="button" data-composition-gear={host.gear} aria-pressed={chosen}
              className={`gbx-composition-host-name gbx-choice ${chosen ? "gbx-choice-on" : ""}`}
              onClick={() => select({ kind: "gear", id: host.gear })}>
              <span className="gbx-leaf-icon codicon codicon-package" />
              <span>{d?.display_name || host.gear}</span>
            </button>
            {/* Secondary, both of them: opening the description and removing the
                gear are things done *to* a gear that has been chosen, not ways
                of choosing it. `GearLink` still selects as well as opens --
                dropping that would make the id a worse control than the row. */}
            <GearLink state={state} id={host.gear} reveals={reveals} select={select} />
            </span>
            <button type="button" aria-label={`Remove ${host.gear} from product`} onClick={() => remove(host.gear)}>Remove</button>
          </div>
          {!shut && <>
            {!d && <small>Descriptor unavailable or still loading. This gear remains in your product.</small>}
            {points.map(point => <section className="gbx-composition-slot" key={point.key}>
              <h4>{point.label}</h4>
              {renderConnections(connections.filter(c => c.spec === point.key))}
              {/* Marked so the dialog can hand the keyboard back to it: Theia
                  restores focus to the *node* that was active, and this tree
                  re-renders while the dialog is up. */}
              <button type="button" data-add-plugin-for={`${host.gear}:${point.key}`}
                onClick={() => add(host.gear, point.key)}>Add compatible plugin</button>
            </section>)}
            {unassigned.length > 0 && <section className="gbx-composition-slot"><h4>Connections needing review</h4>{renderConnections(unassigned)}</section>}
          </>}
        </div>;
      })}
      {/* Open by default. The group is *collapsible* because a long closure is
          noise once it is understood -- not because what the product pulled in
          should be hidden until asked for. Closed by default also put every
          pulled-in gear behind a click, which is one more than the old Gears
          stage needed to show the same thing. */}
      {automatic.length > 0 && <details open className="gbx-composition-automatic"><summary>Automatically included ({automatic.length})</summary>
        {automatic.map(([id, gear]) => <div key={id} className="gbx-leaf" data-pulled-in={id}>
          <span className={`gbx-leaf-icon codicon codicon-${gear.selected_by.some(r => r.reason === "plugin_of") ? "plug" : "package"}`} />
          <GearLink state={state} id={id} reveals={reveals} select={select} />
          {/* The words are `describeInclusion`'s in every case -- a co-location
              reason additionally *goes* to the gear it names, but saying so is
              not the same as saying something else, and "why is this here" is
              answered by the sentence rather than by the button being there. */}
          {gear.selected_by.map((reason, i) => <div key={i} className="gbx-leaf-why">
            {reason.reason === "colocated_by"
              ? <button type="button" className="gbx-choice" onClick={() => select({ kind: "gear", id: reason.gear })}>{describeInclusion(reason)}</button>
              : describeInclusion(reason)}
          </div>)}
          {descriptor(id)?.extension_points?.length ? <button type="button" onClick={() => add(id)}>Add plugin (select host explicitly)</button> : null}
        </div>)}
      </details>}
    </nav>
    <section className="gbx-composition-settings" aria-label="Selected object settings" tabIndex={-1}>{settings}</section>
  </div>;
}
