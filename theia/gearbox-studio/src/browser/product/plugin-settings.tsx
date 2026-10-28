import React from "@theia/core/shared/react";
import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import type { ConfigValue } from "../../common/generated/ConfigValue";
import type { PluginTarget } from "../../common/generated/PluginTarget";
import type { Selection } from "../shell/selection-service";
import type { ProductState } from "../product-store";
import type { ProductEditService } from "../product-edit-service";
import { ConfigFields } from "../add-gear/config-fields";
import { ProfileScope } from "./profile-scope";

export function PluginSettings({ selection, state, descriptor, edits, openGdl, remove }: {
  selection: Extract<Selection, { kind: "plugin" }>; state: ProductState; descriptor?: GearDescriptor;
  edits: ProductEditService; openGdl: () => void; remove: () => void;
}): React.ReactElement {
  const [key, setKey] = React.useState("");
  const [value, setValue] = React.useState("");
  // Found by the written position, not by array position: `entry_index` is the
  // address the editor resolves, and looking it up the same way here is what
  // keeps this form and the edit it queues pointing at one entry.
  const plugin = state.intent?.selected_gears
    .find(g => g.gear === selection.host)
    ?.plugins?.find(p => p.entry_index === selection.entryIndex);
  if (!plugin || plugin.gear !== selection.id || selection.path !== state.open?.path) {
    return <div role="alert">This connection changed. Select it again in the product.</div>;
  }
  const target: PluginTarget = {
    gear: selection.host,
    plugin: selection.id,
    entry_index: selection.entryIndex,
  };
  const draft = edits
    .draftEdits()
    .filter(e => "target" in e && e.target.gear === target.gear && e.target.entry_index === target.entry_index);
  const config: Record<string, unknown> = { ...plugin.config };
  let profiles = plugin.profiles ?? [];
  for (const e of draft) {
    if (e.kind === "set_plugin_config") { if (e.value === null) delete config[e.key]; else config[e.key] = e.value; }
    if (e.kind === "set_plugin_profiles") profiles = e.profiles;
  }
  const fields = descriptor?.config_schema?.fields ?? [];
  const values = new Map<string, ConfigValue>();
  for (const [k, v] of Object.entries(config)) if (typeof v === "string" || typeof v === "boolean" || typeof v === "number") values.set(k, v);
  const queue = (key: string, value: ConfigValue | undefined): void => { edits.queueDraft({ kind: "set_plugin_config", target, key, value: value ?? null }); };
  const setProfiles = (profiles: string[]): void => { edits.queueDraft({ kind: "set_plugin_profiles", target, profiles }); };
  const profileIds = [...new Set([...Object.keys(state.intent!.profiles), ...profiles])];
  return <div data-plugin-settings={selection.id}>
    <h3>{selection.host} / {selection.id}</h3>
    <p className="gbx-settings-scope">Viewing <strong>{state.profile}</strong> · Changes affect: {profiles.join(", ") || "all profiles"}.</p>
    <p>{descriptor?.description || "Plugin descriptor unavailable. Saved settings remain editable."}</p>
    <ProfileScope profiles={profiles} available={profileIds} viewing={state.profile ?? undefined}
      declared={id => state.intent!.profiles[id] !== undefined} onChange={setProfiles} />
    <h4>Configuration</h4>
    <ConfigFields fields={fields} values={values} onChange={queue} onReset={k => queue(k, undefined)} provenanceOf={k => k in config ? "explicit" : "default"} isDrafted={k => draft.some(e => e.kind === "set_plugin_config" && e.key === k)} />
    {Object.entries(config).filter(([k]) => !fields.some(f => f.name === k)).map(([k, v]) => <div key={k}>
      <label>{k}{typeof v === "object" ? <><pre>{JSON.stringify(v, null, 2)}</pre><button type="button" onClick={openGdl}>Edit structured value in GDL</button></> :
        typeof v === "boolean" ? <input type="checkbox" checked={v} onChange={e => queue(k, e.target.checked)} /> :
        <input value={String(v)} type={typeof v === "number" ? "number" : "text"} onChange={e => { if (typeof v !== "number" || e.target.value !== "") queue(k, typeof v === "number" ? Number(e.target.value) : e.target.value); }} />}</label>
      <button type="button" onClick={() => queue(k, undefined)}>Remove {k}</button>
    </div>)}
    <div><input aria-label="Plugin config key" placeholder="Config key" value={key} onChange={e => setKey(e.target.value)} /><input aria-label="Plugin config value" placeholder="String value" value={value} onChange={e => setValue(e.target.value)} /><button type="button" disabled={!key.trim()} onClick={() => { queue(key.trim(), value); setKey(""); setValue(""); }}>Add key</button></div>
    <button type="button" onClick={openGdl}>Open GDL</button><button type="button" onClick={remove}>Remove this connection</button>
  </div>;
}
