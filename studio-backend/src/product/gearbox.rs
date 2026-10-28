//! Product preview through the Gearbox engine.
//!
//! Gearbox (<https://github.com/constructorfabric/gearbox>) resolves a product out
//! of gears: which gears a selection really pulls in, which applications they
//! land in, and what cannot work, as `GBX…` diagnostics. Its input is a
//! `product.gdl` plus the `gear.gdl` descriptors beside the gears. This module
//! turns the gears a person picked into a `product.gdl`, runs the engine's CLI
//! over it against a checkout of the gear corpus, and hands back what the
//! engine said. It holds no composition rule of its own beyond one: a plugin is
//! written under the host whose extension point it fills, because that is how
//! `product.gdl` spells it and the engine refuses a plugin selected alone.
//!
//! The CLI's JSON is its stable contract for tooling, so this reads
//! `catalogue`, `validate` and `resolve` with `--format json` rather than
//! holding a JSON-RPC session: a preview is one question, not a conversation.
//!
//! Off unless `STUDIO_GEARBOX_WORKDIR` is set. Configuration:
//!
//! | Variable | Default |
//! |---|---|
//! | `STUDIO_GEARBOX_WORKDIR` | unset: previews are unavailable |
//! | `STUDIO_GEARBOX_BIN` | `gearbox` |
//! | `STUDIO_GEARBOX_CORPUS_URL` | unset: no corpus until the platform has a gear repository |
//! | `STUDIO_GEARBOX_CORPUS_REF` | `main` |
//! | `STUDIO_GEARBOX_REFRESH_SECS` | `600` |
//!
//! The corpus is the platform's gears (ADR-0042), read from the platform's
//! gear repositories (ADR-0046): connections of the `gear-repository` kind in
//! the root tenant, in the order they were added, each checked out and handed
//! to the engine as its own `--root`, under a directory named by its source
//! id. They are read together, because a gear in one may need a gear in
//! another. While the platform has none, the deployment's corpus
//! (`STUDIO_GEARBOX_CORPUS_URL` / `_REF`) is the one root, under the source id
//! `gears-rust`. No organization's settings or sync can change either.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, anyhow, bail};
use futures_util::StreamExt as _;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex;
use tracing::warn;

/// The source id every generated `product.gdl` names its gears from. It is
/// also the directory the gear corpus is checked out under in a session
/// workspace, which is what makes `path("../gears-rust")` resolve there.
pub const CORPUS_SOURCE_ID: &str = "gears-rust";

const DEFAULT_CORPUS_REF: &str = "main";
const DEFAULT_REFRESH: Duration = Duration::from_secs(600);
/// How often the platform's gear repositories are listed again. A list read
/// is one metadata row; a change is checked out on the next use.
const ROOTS_RECHECK: Duration = Duration::from_secs(60);
/// A catalogue load plus a resolve is well under a second on the corpus; a
/// minute is for a cold disk, not for a healthy run.
const ENGINE_TIMEOUT: Duration = Duration::from_secs(60);
/// How many roots are fetched or cloned at once when a corpus is refreshed.
/// Each is a git process mostly waiting on the network; one after another,
/// a corpus of several repositories took their sum.
const PARALLEL_CHECKOUTS: usize = 4;
/// How many previews' engine answers are kept, and for how long. A person
/// toggling gears back and forth asks the same question again within
/// minutes; the answer cannot change while the corpus stays at its commits.
const EVALUATIONS_KEPT: usize = 64;
const EVALUATION_TTL: Duration = Duration::from_secs(600);

/// The three deployment profiles a generated description declares, by id.
/// Every one is declared so the file can be resolved for any of them later;
/// the preview resolves the one asked for.
pub const PROFILES: [&str; 3] = ["dev", "local", "prod"];

#[derive(Debug, Clone)]
pub struct GearboxConfig {
    pub bin: PathBuf,
    pub workdir: PathBuf,
    pub corpus_url: String,
    pub corpus_ref: String,
    pub refresh: Duration,
}

impl GearboxConfig {
    /// `None` when `STUDIO_GEARBOX_WORKDIR` is unset: without a place for the
    /// corpus there is nothing to resolve against. A deployment that names no
    /// corpus has none until the platform connects a gear repository.
    pub fn from_env() -> Option<Self> {
        let var = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let workdir = PathBuf::from(var("STUDIO_GEARBOX_WORKDIR")?);
        let corpus_url = var("STUDIO_GEARBOX_CORPUS_URL").unwrap_or_default();
        Some(Self {
            bin: PathBuf::from(var("STUDIO_GEARBOX_BIN").unwrap_or_else(|| "gearbox".into())),
            workdir,
            corpus_url,
            corpus_ref: var("STUDIO_GEARBOX_CORPUS_REF")
                .unwrap_or_else(|| DEFAULT_CORPUS_REF.into()),
            refresh: var("STUDIO_GEARBOX_REFRESH_SECS")
                .and_then(|s| s.parse().ok())
                .map(Duration::from_secs)
                .unwrap_or(DEFAULT_REFRESH),
        })
    }
}

// ── The engine's catalogue, as much of it as composing needs ──────────────

#[derive(Debug, Clone, Deserialize)]
pub struct EngineCatalogue {
    #[serde(default)]
    pub gears: BTreeMap<String, EngineGear>,
    /// What the engine refused or warned about while reading the roots.
    #[serde(default)]
    pub diagnostics: Vec<CatalogueDiagnostic>,
}

/// A diagnostic as the catalogue prints it; [`parse_diagnostics`] makes the
/// repository-relative [`EngineDiagnostic`] a person reads.
#[derive(Debug, Clone, Deserialize)]
pub struct CatalogueDiagnostic {
    pub code: String,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub location: Option<CatalogueLocation>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogueLocation {
    pub uri: String,
}

impl EngineCatalogue {
    /// A root the engine read no gear from while refusing files in it: the
    /// engine cannot read that root's GDL (a corpus moved past the pinned
    /// engine reads like this: GBX0102 on every gear.gdl and zero gears).
    /// Without this the catalogue loads with the root's gears silently gone.
    pub fn unreadable_root(&self, roots: &[(String, PathBuf)]) -> Option<String> {
        roots.iter().find_map(|(id, dir)| {
            if self
                .gears
                .values()
                .any(|g| g.source.as_deref() == Some(id.as_str()))
            {
                return None;
            }
            let dir = dir.to_string_lossy().replace('\\', "/");
            let dir = dir.trim_end_matches('/');
            let errors: Vec<&CatalogueDiagnostic> = self
                .diagnostics
                .iter()
                .filter(|d| d.severity == "error")
                .filter(|d| d.location.as_ref().is_some_and(|l| l.uri.contains(dir)))
                .collect();
            let first = errors.first()?;
            let mut codes: BTreeMap<&str, usize> = BTreeMap::new();
            for d in &errors {
                *codes.entry(d.code.as_str()).or_default() += 1;
            }
            let codes: Vec<String> = codes
                .iter()
                .map(|(c, n)| format!("{c} \u{d7}{n}"))
                .collect();
            Some(format!(
                "the gear engine read no gear from the repository `{id}`: {} error(s) ({}), \
                 first: {}. The repository has likely moved to a GDL this engine cannot read; \
                 point the deployment at a ref this engine reads, or move the engine",
                errors.len(),
                codes.join(", "),
                first.message
            ))
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct EngineGear {
    pub id: String,
    pub package: EnginePackage,
    /// Set on a plugin: the extension point it fills, named by its SDK crate.
    ///
    /// The engine calls it `implements` since gearbox#2 (`fills` renamed, no
    /// alias on its side). Both are read: under `serde(default)` an unknown
    /// name is not an error, it is every plugin silently becoming a gear.
    #[serde(default, alias = "implements")]
    pub fills: Option<EngineFills>,
    /// Set on a host: the extension points plugins fill.
    #[serde(default)]
    pub extension_points: Vec<EnginePoint>,
    /// The contracts it provides, projected from `#[toolkit::provides]`.
    #[serde(default)]
    pub provides: Vec<EngineProvide>,
    /// `rest`, `rest_host`, `grpc_hub`, … — projected from `#[toolkit::gear]`.
    #[serde(default)]
    pub runtime_caps: Vec<String>,
    /// Gears that must share a binary with this one, by engine id.
    #[serde(default)]
    pub colocated_deps: Vec<String>,
    /// Endpoints; their `config_key` is written by generation, not by a person.
    #[serde(default)]
    pub serves: Vec<EngineEndpoint>,
    #[serde(default)]
    pub config_schema: Option<EngineConfigSchema>,
    /// Set on a host: the vendor it selects among its plugins by default. A
    /// plugin registers under its own `vendor` (a config field with a
    /// default); the two must agree or the engine refuses (GBX0512).
    #[serde(default)]
    pub vendor_selector: Option<String>,
    /// The root (gear repository) the engine found it in, by source id.
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct EngineEndpoint {
    #[serde(default)]
    pub config_key: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct EngineConfigSchema {
    #[serde(default)]
    pub fields: Vec<EngineConfigField>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EngineConfigField {
    pub name: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EnginePackage {
    pub crate_name: String,
    #[serde(default)]
    pub lib_ident: Option<String>,
    /// Relative to the corpus root.
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EngineProvide {
    /// The engine's contract id, `<owner gear>/<Trait>@v<major>`.
    pub contract: String,
}

impl EngineGear {
    /// Everything the engine checks that this gear does for others:
    /// - the contracts it provides;
    /// - the spec of each extension point it hosts;
    /// - the spec of the point it implements, when it is a plugin.
    ///
    /// The composer matches a capability's contracts against these
    /// (`cpt-studio-fr-spec-gear-mapping`).
    pub fn contracts(&self) -> Vec<String> {
        let mut out: Vec<String> = self.provides.iter().map(|p| p.contract.clone()).collect();
        out.extend(self.extension_points.iter().filter_map(|p| p.spec.clone()));
        out.extend(
            self.fills
                .as_ref()
                .and_then(|f| f.spec().map(str::to_owned)),
        );
        out.sort();
        out.dedup();
        out
    }
}

impl EngineGear {
    /// The config fields generation writes from the topology: each endpoint's
    /// `config_key` (an address). A person never sets these.
    fn derived_config(&self) -> BTreeSet<&str> {
        self.serves
            .iter()
            .filter_map(|e| e.config_key.as_deref())
            .collect()
    }
}

/// One field of a gear's configuration, as a form asks for it.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigFieldInfo {
    pub name: String,
    pub required: bool,
    /// What the gear falls back to; `None` when it has none (a JSON `null`
    /// default is no default).
    pub default: Option<Value>,
    /// Written by generation from the topology (`serves[].config_key`), so
    /// not the product's to set.
    pub derived: bool,
}

/// One requested gear's configuration schema.
#[derive(Debug, Clone, PartialEq)]
pub struct GearConfigSchema {
    /// The name as it was asked for (crate name or engine id), so a caller
    /// joins it to its own picks and config keys unchanged.
    pub gear: String,
    /// The engine id; `None` when no `gear.gdl` in the corpus describes it.
    pub id: Option<String>,
    /// In the order the gear declares them.
    pub fields: Vec<ConfigFieldInfo>,
}

/// The config schema of each named gear, in the order asked, duplicates
/// dropped. A name the corpus does not describe answers with `id: None` and
/// no fields rather than failing the rest.
pub fn config_schemas(catalogue: &EngineCatalogue, names: &[String]) -> Vec<GearConfigSchema> {
    let mut seen = BTreeSet::new();
    names
        .iter()
        .filter(|n| seen.insert(n.as_str()))
        .map(|name| {
            let Some(g) = catalogue.find(name) else {
                return GearConfigSchema {
                    gear: name.clone(),
                    id: None,
                    fields: Vec::new(),
                };
            };
            let derived = g.derived_config();
            let fields = g
                .config_schema
                .as_ref()
                .map(|s| {
                    s.fields
                        .iter()
                        .map(|f| ConfigFieldInfo {
                            name: f.name.clone(),
                            required: f.required,
                            default: f.default.clone().filter(|v| !v.is_null()),
                            derived: derived.contains(f.name.as_str()),
                        })
                        .collect()
                })
                .unwrap_or_default();
            GearConfigSchema {
                gear: name.clone(),
                id: Some(g.id.clone()),
                fields,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Deserialize)]
pub struct EngineFills {
    /// The full GTS type id of the spec it implements. The engine states it
    /// on every plugin since gearbox#2; the old `fills` only had `point`.
    #[serde(default)]
    pub spec: Option<String>,
    /// The host's declaration of that point. The engine leaves it out when no
    /// gear in the corpus declares the spec (GBX0519), so one such plugin
    /// must not fail the whole catalogue: it is a plugin without a host.
    #[serde(default)]
    pub point: Option<EnginePoint>,
    /// Lower wins, as the runtime's plugin selector reads it.
    #[serde(default)]
    pub default_priority: Option<i64>,
}

impl EngineFills {
    /// The spec of the point it implements, wherever the engine stated it.
    pub fn spec(&self) -> Option<&str> {
        self.spec
            .as_deref()
            .or_else(|| self.point.as_ref().and_then(|p| p.spec.as_deref()))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct EnginePoint {
    pub sdk: EnginePackage,
    /// The full GTS type id of the plugin spec — the point's identity. Two
    /// points can share a trait; only their specs tell them apart.
    #[serde(default)]
    pub spec: Option<String>,
    /// The interface plugins register under, as written in the SDK.
    #[serde(default)]
    pub trait_ident: Option<String>,
}

impl EngineCatalogue {
    /// A gear by its engine id or its crate name. The portal knows gears by
    /// crate (`cf-gears-api-gateway`), the engine by `#[toolkit::gear(name)]`
    /// (`api-gateway`); both spellings are accepted so neither side translates.
    ///
    /// A crate can hold several gears (`cf-gears-mini-chat` is mini-chat and
    /// its two static plugins); its name then means the gear that is not a
    /// plugin, and the others are named by id -- see [`Self::pick_name`].
    fn find(&self, name: &str) -> Option<&EngineGear> {
        self.gears.get(name).or_else(|| {
            let mut same = self.gears.values().filter(|g| g.package.crate_name == name);
            let first = same.next()?;
            Some(if first.fills.is_none() {
                first
            } else {
                same.find(|g| g.fills.is_none()).unwrap_or(first)
            })
        })
    }

    /// How the portal names a gear: its crate when the crate finds it, else
    /// its engine id -- so the name finds this gear and no other, and a
    /// plugin sharing its host's crate never folds into the host.
    fn pick_name(&self, g: &EngineGear) -> String {
        if self
            .find(&g.package.crate_name)
            .is_some_and(|f| f.id == g.id)
        {
            g.package.crate_name.clone()
        } else {
            g.id.clone()
        }
    }

    /// The portal's name for an engine id; the id itself when unknown.
    fn pick_name_of(&self, id: &str) -> String {
        self.gears
            .get(id)
            .map_or(id.to_string(), |g| self.pick_name(g))
    }

    /// Every gear filling one of `host`'s extension points, by the portal's
    /// name for it, so an offer reads like a suggestion.
    fn implementers_of(&self, host: &EngineGear) -> Vec<String> {
        self.implementers(host)
            .into_iter()
            .map(|g| self.pick_name(g))
            .collect()
    }

    /// The gear whose extension point `plugin` fills.
    fn host_of(&self, plugin: &EngineGear) -> Option<&EngineGear> {
        self.gears.values().find(|g| {
            g.id != plugin.id && g.extension_points.iter().any(|p| fills_point(plugin, p))
        })
    }
}

// ── Composition: the picked gears as product.gdl declarations ─────────────

/// One `use_gear(...)` line, with the plugins written under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GearUse {
    pub id: String,
    pub plugins: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Composition {
    pub gears: Vec<GearUse>,
    /// Hosts added because a picked plugin needs one: `(host, plugin)`.
    pub added_hosts: Vec<(String, String)>,
    /// Picked names no `gear.gdl` in the corpus declares. The engine cannot
    /// see these at all, so they are reported rather than written.
    pub not_described: Vec<String>,
    /// Picked hosts with an extension point nothing picked fills, and the
    /// corpus gears that could: `(host, [plugin, ...])`. The engine refuses
    /// such a host (GBX0511); this is the list to choose the fix from.
    pub plugin_options: Vec<(String, Vec<String>)>,
}

pub fn compose(catalogue: &EngineCatalogue, picked: &[String]) -> Composition {
    let mut out = Composition::default();
    let mut uses: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut add = |id: &str, uses: &mut BTreeMap<String, BTreeSet<String>>| {
        if !uses.contains_key(id) {
            uses.insert(id.to_string(), BTreeSet::new());
            order.push(id.to_string());
        }
    };
    for name in picked {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let Some(gear) = catalogue.find(name) else {
            if !out.not_described.iter().any(|n| n == name) {
                out.not_described.push(name.to_string());
            }
            continue;
        };
        match catalogue.host_of(gear) {
            Some(host) => {
                if !uses.contains_key(&host.id)
                    && !picked
                        .iter()
                        .any(|p| catalogue.find(p).is_some_and(|g| g.id == host.id))
                {
                    out.added_hosts.push((host.id.clone(), gear.id.clone()));
                }
                add(&host.id, &mut uses);
                uses.get_mut(&host.id)
                    .expect("host was just added")
                    .insert(gear.id.clone());
            }
            // Not a plugin, or a plugin whose host is not in the corpus:
            // selected as itself, and the engine says what is wrong with that.
            None => add(&gear.id, &mut uses),
        }
    }
    out.gears = order
        .into_iter()
        .map(|id| GearUse {
            plugins: uses.remove(&id).unwrap_or_default().into_iter().collect(),
            id,
        })
        .collect();
    for g in &out.gears {
        let Some(host) = catalogue.gears.get(&g.id) else {
            continue;
        };
        if host.extension_points.is_empty() || !g.plugins.is_empty() {
            continue;
        }
        let available = catalogue.implementers_of(host);
        if !available.is_empty() {
            out.plugin_options.push((g.id.clone(), available));
        }
    }
    out
}

// ── Completion: from picks to a set the engine can resolve ────────────────

/// One thing [`complete`] did to a pick, and why — shown to the person, who
/// is entitled to undo any of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    /// Crate name, like every pick.
    pub gear: String,
    pub added: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Completion {
    /// The completed picks, by crate name, in pick order with additions last.
    pub gears: Vec<String>,
    pub changes: Vec<Change>,
    /// Configuration the product sets on its gears, by crate name: what was
    /// passed in, plus what completion had to set for the result to resolve.
    pub config: GearConfig,
}

/// A product's configuration of its gears: crate name -> field -> value.
/// Written into `product.gdl` as `use_gear(..., config = {...})` for a gear
/// and `plugin(..., config = {...})` for a plugin.
pub type GearConfig = BTreeMap<String, serde_json::Map<String, Value>>;

/// Read a `GearConfig` from JSON: an object of objects. Anything else is the
/// caller's mistake, named.
pub fn gear_config_from(value: Option<&Value>) -> anyhow::Result<GearConfig> {
    let Some(value) = value else {
        return Ok(GearConfig::new());
    };
    if value.is_null() {
        return Ok(GearConfig::new());
    }
    let Some(obj) = value.as_object() else {
        bail!("config is an object of gear name -> {{field: value}}");
    };
    let mut out = GearConfig::new();
    for (gear, fields) in obj {
        let Some(fields) = fields.as_object() else {
            bail!("config for `{gear}` is an object of field -> value");
        };
        if !fields.is_empty() {
            out.insert(gear.clone(), fields.clone());
        }
    }
    Ok(out)
}

/// The vendor a plugin registers under: its `vendor` config field, as the
/// product sets it or else as the gear defaults it.
fn plugin_vendor(
    plugin: &EngineGear,
    config: Option<&serde_json::Map<String, Value>>,
) -> Option<String> {
    if let Some(v) = config.and_then(|c| c.get("vendor")).and_then(Value::as_str) {
        return Some(v.to_string());
    }
    plugin
        .config_schema
        .as_ref()?
        .fields
        .iter()
        .find(|f| f.name == "vendor")?
        .default
        .as_ref()?
        .as_str()
        .map(str::to_string)
}

/// Whether the host would find this plugin by vendor. A host that selects no
/// vendor, or a plugin that declares none, agrees with anything.
fn vendor_agrees(
    host: &EngineGear,
    plugin: &EngineGear,
    config: Option<&serde_json::Map<String, Value>>,
) -> bool {
    match (
        host.vendor_selector.as_deref(),
        plugin_vendor(plugin, config),
    ) {
        (Some(want), Some(have)) => want == have,
        _ => true,
    }
}

/// Why a gear cannot be part of a product built from this corpus as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Dead {
    /// Required configuration with no default; nobody has supplied it.
    NeedsConfig(Vec<String>),
    /// A host no gear in the corpus can plug into.
    NoPlugin,
    /// A plugin for an extension point no gear in the corpus hosts.
    NoHost,
    /// Must share a binary with a gear that is itself dead.
    Dep(String),
}

impl EngineCatalogue {
    /// Required fields a person would have to write: required, no default,
    /// and not an address generation writes from the topology.
    fn unset_config(&self, g: &EngineGear) -> Vec<String> {
        let derived = g.derived_config();
        g.config_schema
            .as_ref()
            .map(|s| {
                s.fields
                    .iter()
                    .filter(|f| f.required && f.default.as_ref().is_none_or(Value::is_null))
                    .filter(|f| !derived.contains(f.name.as_str()))
                    .map(|f| f.name.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn implementers(&self, host: &EngineGear) -> Vec<&EngineGear> {
        self.gears
            .values()
            .filter(|g| g.id != host.id && host.extension_points.iter().any(|p| fills_point(g, p)))
            .collect()
    }

    /// The gears filling this one point of `host`.
    fn implementers_at<'a>(
        &'a self,
        host: &EngineGear,
        point: &EnginePoint,
    ) -> Vec<&'a EngineGear> {
        self.gears
            .values()
            .filter(|g| g.id != host.id && fills_point(g, point))
            .collect()
    }

    /// Every gear that cannot run in a product from this corpus, and why,
    /// computed to a fixpoint: a gear is dead when its own facts say so, or
    /// when something it must share a binary with is, or — for a host — when
    /// every plugin it could take is.
    fn dead(&self) -> BTreeMap<String, Dead> {
        let mut dead: BTreeMap<String, Dead> = BTreeMap::new();
        for g in self.gears.values() {
            let unset = self.unset_config(g);
            if !unset.is_empty() {
                dead.insert(g.id.clone(), Dead::NeedsConfig(unset));
            } else if g.fills.is_some() && self.host_of(g).is_none() {
                dead.insert(g.id.clone(), Dead::NoHost);
            }
        }
        loop {
            let mut changed = false;
            for g in self.gears.values() {
                if dead.contains_key(&g.id) {
                    continue;
                }
                if let Some(dep) = g.colocated_deps.iter().find(|d| dead.contains_key(*d)) {
                    dead.insert(g.id.clone(), Dead::Dep(dep.clone()));
                    changed = true;
                    continue;
                }
                if let Some(host) = self.host_of(g).filter(|h| dead.contains_key(&h.id)) {
                    dead.insert(g.id.clone(), Dead::Dep(host.id.clone()));
                    changed = true;
                    continue;
                }
                if !g.extension_points.is_empty()
                    && self
                        .implementers(g)
                        .iter()
                        .all(|p| dead.contains_key(&p.id))
                {
                    dead.insert(g.id.clone(), Dead::NoPlugin);
                    changed = true;
                }
            }
            if !changed {
                return dead;
            }
        }
    }

    /// The plugin to put under `host` when nobody chose one: alive, then the
    /// runtime's own priority (lower wins), then a `static` one — it runs with
    /// no external service, which is what a first build needs — then by name.
    fn default_plugin<'a>(
        &'a self,
        host: &EngineGear,
        point: &EnginePoint,
        dead: &BTreeMap<String, Dead>,
    ) -> Option<&'a EngineGear> {
        let mut alive: Vec<&EngineGear> = self
            .implementers_at(host, point)
            .into_iter()
            .filter(|p| !dead.contains_key(&p.id))
            .collect();
        // A plugin registered under the vendor the host selects needs nothing
        // set to be found; prefer it over one that would need its vendor
        // overridden.
        alive.sort_by_key(|p| {
            (
                !vendor_agrees(host, p, None),
                p.fills
                    .as_ref()
                    .and_then(|f| f.default_priority)
                    .unwrap_or(i64::MAX),
                !p.id.contains("static"),
                p.id.clone(),
            )
        });
        alive.into_iter().next()
    }

    /// `ids` and everything they must share a binary with.
    fn closure(&self, ids: &[String]) -> BTreeSet<String> {
        let mut out: BTreeSet<String> = BTreeSet::new();
        let mut todo: Vec<String> = ids.to_vec();
        while let Some(id) = todo.pop() {
            if !out.insert(id.clone()) {
                continue;
            }
            if let Some(g) = self.gears.get(&id) {
                todo.extend(g.colocated_deps.iter().cloned());
            }
        }
        out
    }
}

fn dead_reason(catalogue: &EngineCatalogue, why: &Dead) -> String {
    match why {
        Dead::NeedsConfig(fields) => format!(
            "needs configuration nobody has given yet: {} — add it back and set it in product.gdl",
            fields.join(", ")
        ),
        Dead::NoPlugin => "no plugin in the corpus fills its extension point".to_string(),
        Dead::NoHost => "a plugin for an extension point no gear in the corpus hosts".to_string(),
        Dead::Dep(dep) => {
            let crate_name = catalogue
                .gears
                .get(dep)
                .map_or(dep.as_str(), |g| g.package.crate_name.as_str());
            format!("must run with {crate_name}, which cannot run here")
        }
    }
}

/// Turn picks into a set the engine can resolve, saying what changed and why.
///
/// Only what the catalogue proves: a gear is dropped when its own
/// descriptor, or one it must share a binary with, rules it out; a plugin
/// is added when a host in the product has none; a REST host when REST
/// gears have nothing to serve them. Nothing is guessed about what the
/// product is for. The engine still has the last word — the caller resolves
/// the result.
pub fn complete(catalogue: &EngineCatalogue, picked: &[String], config: &GearConfig) -> Completion {
    let dead = catalogue.dead();
    let mut config = config.clone();
    let crate_of = |id: &str| catalogue.pick_name_of(id);
    let mut changes: Vec<Change> = Vec::new();
    let mut set: Vec<String> = Vec::new();

    for name in picked {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let Some(g) = catalogue.find(name) else {
            if !changes.iter().any(|c| c.gear == name) {
                changes.push(Change {
                    gear: name.to_string(),
                    added: false,
                    reason: "no gear.gdl describes it yet, so it cannot be composed".to_string(),
                });
            }
            continue;
        };
        if let Some(why) = dead.get(&g.id) {
            changes.push(Change {
                gear: catalogue.pick_name(g),
                added: false,
                reason: dead_reason(catalogue, why),
            });
            continue;
        }
        if !set.contains(&g.id) {
            set.push(g.id.clone());
        }
    }

    // Additions settle in a few rounds: a REST host brings its own deps,
    // which may be hosts wanting a plugin. Bounded, because each round only
    // adds from a finite catalogue.
    for _ in 0..catalogue.gears.len().max(1) {
        let mut added = false;
        let effective = catalogue.closure(&set);

        for host_id in &effective {
            let Some(host) = catalogue.gears.get(host_id) else {
                continue;
            };
            // Each point on its own: mini-chat's audit and model-policy
            // points live in one SDK, and a plugin for one fills not the other.
            for point in &host.extension_points {
                let filled = catalogue
                    .implementers_at(host, point)
                    .iter()
                    .any(|p| set.contains(&p.id));
                if filled {
                    continue;
                }
                if let Some(p) = catalogue.default_plugin(host, point, &dead) {
                    set.push(p.id.clone());
                    changes.push(Change {
                        gear: catalogue.pick_name(p),
                        added: true,
                        reason: format!(
                            "{} needs a plugin; this one runs with no configuration",
                            crate_of(host_id)
                        ),
                    });
                    added = true;
                }
            }
        }

        let effective = catalogue.closure(&set);
        let has = |cap: &str| {
            effective
                .iter()
                .filter_map(|id| catalogue.gears.get(id))
                .any(|g| g.runtime_caps.iter().any(|c| c == cap))
        };
        if has("rest") && !has("rest_host") {
            let host = catalogue.gears.values().find(|g| {
                g.runtime_caps.iter().any(|c| c == "rest_host") && !dead.contains_key(&g.id)
            });
            if let Some(h) = host {
                set.push(h.id.clone());
                changes.push(Change {
                    gear: catalogue.pick_name(h),
                    added: true,
                    reason: "the REST gears need a REST host to serve their routes".to_string(),
                });
                added = true;
            }
        }
        if !added {
            break;
        }
    }

    // Every plugin in the product registers under the vendor its host
    // selects, or the engine refuses the pair (GBX0512). A plugin whose own
    // default disagrees gets the host's vendor set -- unless the product
    // already sets a vendor on it, which is somebody's decision to keep.
    let effective = catalogue.closure(&set);
    for host_id in &effective {
        let Some(host) = catalogue.gears.get(host_id) else {
            continue;
        };
        let Some(want) = host.vendor_selector.clone() else {
            continue;
        };
        for p in catalogue.implementers(host) {
            if !set.contains(&p.id) {
                continue;
            }
            let crate_name = catalogue.pick_name(p);
            let set_here = config
                .get(&crate_name)
                .is_some_and(|c| c.contains_key("vendor"));
            if set_here || vendor_agrees(host, p, None) {
                continue;
            }
            config
                .entry(crate_name.clone())
                .or_default()
                .insert("vendor".to_string(), Value::String(want.clone()));
            changes.push(Change {
                gear: crate_name,
                added: true,
                reason: format!(
                    "vendor set to `{want}`: {} selects its plugins by that vendor, and this one \
                     registers under `{}` by default",
                    crate_of(host_id),
                    plugin_vendor(p, None).unwrap_or_default()
                ),
            });
        }
    }

    Completion {
        gears: set.iter().map(|id| crate_of(id)).collect(),
        changes,
        config,
    }
}

// ── What a candidate brings with it ───────────────────────────────────────

/// One gear a candidate would add to the product, and why it comes along.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Brought {
    /// Crate name.
    pub gear: String,
    pub reason: String,
    /// It keeps its own database (`db` among its runtime capabilities).
    pub database: bool,
}

/// A contract the product would get from two gears because of the
/// candidate: one it has and one the candidate brings, or two the candidate
/// brings — the second audit store a certified platform cannot keep
/// (interview problem 4.7). A contract the product already gets twice, with
/// nothing more brought for it, is not the candidate's doing and is not one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overlap {
    pub contract: String,
    /// Crate names already in the product that provide it.
    pub already: Vec<String>,
    /// Crate names the candidate brings that provide it too.
    pub brought: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Brings {
    /// The candidate as asked; `false` when no `gear.gdl` describes it.
    pub described: bool,
    /// What is new to the product, the candidate first.
    pub brought: Vec<Brought>,
    pub overlaps: Vec<Overlap>,
    /// What completing the product with the candidate would drop or change
    /// that completing it without would not.
    pub changes: Vec<Change>,
}

/// What adding `candidate` to a product of `current` would bring with it,
/// from the catalogue alone: the gears completion adds and those they must
/// share a binary with, the host a plugin needs, and the contracts the
/// product would then get twice. Nothing is written; the engine still has
/// the last word when the product is resolved.
pub fn brings(
    catalogue: &EngineCatalogue,
    current: &[String],
    candidate: &str,
    config: &GearConfig,
) -> Brings {
    let Some(cand) = catalogue.find(candidate.trim()) else {
        return Brings::default();
    };
    let crate_of = |id: &str| catalogue.pick_name_of(id);
    let ids_of = |completion: &Completion| -> Vec<String> {
        completion
            .gears
            .iter()
            .filter_map(|n| catalogue.find(n).map(|g| g.id.clone()))
            .collect()
    };
    let before_completion = complete(catalogue, current, config);
    let mut with: Vec<String> = current.to_vec();
    with.push(catalogue.pick_name(cand));
    let after_completion = complete(catalogue, &with, config);
    let mut before = catalogue.closure(&ids_of(&before_completion));
    let mut after = catalogue.closure(&ids_of(&after_completion));
    // A plugin runs under its host: `compose` writes the host in, so count it.
    for set in [&mut before, &mut after] {
        let hosts: Vec<String> = set
            .iter()
            .filter_map(|id| catalogue.gears.get(id))
            .filter_map(|g| catalogue.host_of(g).map(|h| h.id.clone()))
            .collect();
        let hosts: Vec<String> = catalogue.closure(&hosts).into_iter().collect();
        set.extend(hosts);
    }

    let reason_for = |id: &str| -> String {
        if id == cand.id {
            return "the gear you picked".to_string();
        }
        let name = crate_of(id);
        if let Some(c) = after_completion
            .changes
            .iter()
            .find(|c| c.added && c.gear == name)
        {
            return c.reason.clone();
        }
        if let Some(g) = after
            .iter()
            .filter_map(|o| catalogue.gears.get(o))
            .find(|g| g.colocated_deps.iter().any(|d| d == id))
        {
            return format!("{} must run with it", g.package.crate_name);
        }
        if let Some(p) = after
            .iter()
            .filter_map(|o| catalogue.gears.get(o))
            .find(|g| catalogue.host_of(g).is_some_and(|h| h.id == id))
        {
            return format!("hosts the extension point {} fills", p.package.crate_name);
        }
        "completion of the product".to_string()
    };
    let mut new: Vec<&String> = after.difference(&before).collect();
    new.sort_by_key(|id| (**id != cand.id, (*id).clone()));
    let brought: Vec<Brought> = new
        .iter()
        .map(|id| Brought {
            gear: crate_of(id),
            reason: reason_for(id),
            database: catalogue
                .gears
                .get(*id)
                .is_some_and(|g| g.runtime_caps.iter().any(|c| c == "db")),
        })
        .collect();

    let provides = |id: &str| -> Vec<String> {
        catalogue
            .gears
            .get(id)
            .map(|g| g.provides.iter().map(|p| p.contract.clone()).collect())
            .unwrap_or_default()
    };
    let mut by_contract: BTreeMap<String, (BTreeSet<String>, BTreeSet<String>)> = BTreeMap::new();
    for id in &before {
        for c in provides(id) {
            by_contract.entry(c).or_default().0.insert(crate_of(id));
        }
    }
    for id in &new {
        for c in provides(id) {
            by_contract.entry(c).or_default().1.insert(crate_of(id));
        }
    }
    let overlaps = by_contract
        .into_iter()
        .filter(|(_, (a, b))| !b.is_empty() && a.len() + b.len() > 1)
        .map(|(contract, (a, b))| Overlap {
            contract,
            already: a.into_iter().collect(),
            brought: b.into_iter().collect(),
        })
        .collect();

    let changes = after_completion
        .changes
        .into_iter()
        .filter(|c| !before_completion.changes.contains(c))
        .filter(|c| !(c.added && brought.iter().any(|b| b.gear == c.gear)))
        .collect();

    Brings {
        described: true,
        brought,
        overlaps,
        changes,
    }
}

// ── Facts: what the engine knows, as component-profile fields ─────────────

fn fact(v: &str) -> Value {
    serde_json::json!({ "v": v, "b": v })
}

fn lamp(v: &str, s: &str) -> Value {
    serde_json::json!({ "v": v, "b": v, "s": s })
}

/// What the catalogue says of the gear `name` (engine id or crate name), as
/// the facts an explanation is written from: its own words from the engine's
/// raw descriptor (`display_name`, `description`, `category`, `maturity`) and
/// what the parsed catalogue proves (host, choices, plugins, colocated
/// gears). `None` for a gear the corpus does not describe. The README is
/// read separately, from the checkout.
pub fn gear_brief(
    catalogue: &EngineCatalogue,
    raw: &Value,
    name: &str,
) -> Option<super::explanations::GearBrief> {
    let g = catalogue.find(name.trim())?;
    let text_of = |id: &str, field: &str| {
        raw.get("gears")
            .and_then(|gs| gs.get(id))
            .and_then(|d| d.get(field))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    // A gear as a person reads it: its display name, else its crate.
    let label = |other: &EngineGear| {
        text_of(&other.id, "display_name").unwrap_or_else(|| other.package.crate_name.clone())
    };
    let points = g
        .extension_points
        .iter()
        .map(|p| {
            p.trait_ident
                .clone()
                .unwrap_or_else(|| p.sdk.crate_name.clone())
        })
        .collect();
    Some(super::explanations::GearBrief {
        id: g.id.clone(),
        crate_name: g.package.crate_name.clone(),
        display_name: text_of(&g.id, "display_name"),
        description: text_of(&g.id, "description"),
        category: text_of(&g.id, "category"),
        maturity: text_of(&g.id, "maturity"),
        runtime_caps: g.runtime_caps.clone(),
        host: g
            .fills
            .as_ref()
            .and_then(|_| catalogue.host_of(g).map(label)),
        points,
        plugins: catalogue.implementers(g).into_iter().map(label).collect(),
        brings: g
            .colocated_deps
            .iter()
            .map(|d| catalogue.gears.get(d).map_or_else(|| d.clone(), label))
            .collect(),
        path: g.package.path.clone(),
        readme: None,
    })
}

/// The README of the crate at `path` (relative to the corpus at `dir`), at
/// most `max` bytes; `None` when there is none or the path leaves the corpus.
pub fn read_readme(dir: &Path, path: &str, max: usize) -> Option<String> {
    let rel = Path::new(path.trim());
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return None;
    }
    // A package path may name the crate's manifest rather than its directory.
    let crate_dir = if rel.extension().is_some_and(|e| e == "toml") {
        rel.parent().unwrap_or(rel)
    } else {
        rel
    };
    ["README.md", "readme.md", "README"]
        .iter()
        .map(|f| dir.join(crate_dir).join(f))
        .find(|f| f.is_file())
        .and_then(|f| std::fs::File::open(f).ok())
        .and_then(|f| {
            let mut buf = Vec::new();
            f.take(max as u64).read_to_end(&mut buf).ok()?;
            let text = String::from_utf8_lossy(&buf).into_owned();
            (!text.trim().is_empty()).then_some(text)
        })
}

/// Profile fields for every gear the corpus describes, keyed by crate name.
/// The keys are the `gearbox` group of `field_schemas/gear.json`; a gear with
/// no `gear.gdl` gets none, and its page says so through the group's empty
/// cells rather than a false "no".
pub fn gear_facts(catalogue: &EngineCatalogue, corpus: &str) -> BTreeMap<String, Value> {
    let dead = catalogue.dead();
    let crate_of = |id: &str| catalogue.pick_name_of(id);
    let list = |items: Vec<String>| {
        if items.is_empty() {
            "—".to_string()
        } else {
            items.join(", ")
        }
    };
    catalogue
        .gears
        .values()
        .map(|g| {
            let role = if !g.extension_points.is_empty() {
                let plugins = catalogue.implementers_of(g);
                if plugins.is_empty() {
                    "host; no plugin in the corpus fills it".to_string()
                } else {
                    format!("host; plugins: {}", plugins.join(", "))
                }
            } else if g.fills.is_some() {
                match catalogue.host_of(g) {
                    Some(h) => format!("plugin of {}", catalogue.pick_name(h)),
                    None => "plugin; no gear in the corpus hosts it".to_string(),
                }
            } else {
                "—".to_string()
            };
            let runs = match dead.get(&g.id) {
                None => lamp("yes", "good"),
                Some(why) => lamp(&format!("no — {}", dead_reason(catalogue, why)), "bad"),
            };
            let fields = serde_json::json!({
                "gdl": lamp("yes", "good"),
                "gdl_id": fact(&g.id),
                "gdl_caps": fact(&list(g.runtime_caps.clone())),
                "gdl_deps": fact(&list(g.colocated_deps.iter().map(|d| crate_of(d)).collect())),
                "gdl_role": fact(&role),
                "gdl_contracts": fact(&list(g.contracts())),
                "gdl_config": fact(&list(catalogue.unset_config(g))),
                "gdl_runs": runs,
                "gdl_corpus": fact(corpus),
            });
            (g.package.crate_name.clone(), fields)
        })
        .collect()
}

// ── New gears: the engine's own scaffold ──────────────────────────────────

/// The three shapes the engine scaffolds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GearKind {
    Minimal,
    Service,
    Plugin,
}

impl GearKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "minimal" => Some(Self::Minimal),
            "service" | "" => Some(Self::Service),
            "plugin" => Some(Self::Plugin),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Minimal => "minimal",
            Self::Service => "service",
            Self::Plugin => "plugin",
        }
    }
}

/// Where the SDK a plugin implements lives, as its `gear.gdl` writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdkLocator {
    /// The spec's own GTS segment (`cf.core.authn_resolver.plugin.v1~`), which
    /// the engine writes as `fills = "..."`: the declaration that makes a
    /// crate a plugin.
    pub spec: String,
    /// The trait the plugin implements.
    pub trait_ident: String,
    pub crate_name: String,
    pub lib_ident: String,
    /// Relative to the new gear's own directory.
    pub path: String,
}

#[derive(Debug, Clone)]
pub struct GearScaffold {
    /// The crate, which is also the id the engine names the package after.
    pub crate_name: String,
    pub name: String,
    pub kind: GearKind,
    pub plugin: Option<SdkLocator>,
}

/// A host a new plugin can fill, and the SDK its extension point is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPoint {
    pub host_id: String,
    pub host_crate: String,
    /// The point's full GTS spec id; a host may declare several.
    pub spec: String,
    pub trait_ident: String,
    pub sdk_crate: String,
    pub sdk_lib: String,
    /// Relative to the corpus root.
    pub sdk_path: String,
    /// Whether the host can run in a product from this corpus.
    pub runs: bool,
    /// The root (gear repository) the host is in, by source id.
    pub source: String,
}

pub fn host_points(catalogue: &EngineCatalogue) -> Vec<HostPoint> {
    let dead = catalogue.dead();
    let mut out: Vec<HostPoint> = catalogue
        .gears
        .values()
        .flat_map(|g| {
            let runs = !dead.contains_key(&g.id);
            g.extension_points.iter().filter_map(move |p| {
                Some(HostPoint {
                    host_id: g.id.clone(),
                    host_crate: g.package.crate_name.clone(),
                    spec: p.spec.clone()?,
                    trait_ident: p.trait_ident.clone()?,
                    sdk_crate: p.sdk.crate_name.clone(),
                    sdk_lib: p.sdk.lib_ident.clone()?,
                    sdk_path: p.sdk.path.clone()?,
                    runs,
                    source: g
                        .source
                        .clone()
                        .unwrap_or_else(|| CORPUS_SOURCE_ID.to_string()),
                })
            })
        })
        .collect();
    out.sort_by(|a, b| (!a.runs, &a.host_crate, &a.spec).cmp(&(!b.runs, &b.host_crate, &b.spec)));
    out
}

/// The SDK path as a new gear's `gear.gdl` must write it: from the gear's own
/// directory, `<parent_dir>/<slug>`, to the SDK, both in one repository.
///
/// One repository, because the engine resolves a `cargo(path = ...)` inside
/// the source root that declares it and refuses a `..` that climbs out
/// (`RelPath::resolve`, reported as GBX0102). A plugin written into its own
/// repository cannot name a corpus SDK by path at all, so it is never asked to.
pub fn sdk_path_in_repo(parent_dir: &str, sdk_path: &str) -> String {
    let depth = parent_dir
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .count()
        + 1;
    format!(
        "{}{}",
        "../".repeat(depth),
        sdk_path.trim_start_matches('/')
    )
}

/// The SDK path from a gear in a project's own repository to the checkout of
/// the gear repository `source_id` beside it in a Studio workspace:
/// `<checkout>/<parent_dir>/<slug>` up to the workspace, then `<source_id>/`.
pub fn sdk_path_beside(parent_dir: &str, source_id: &str, sdk_path: &str) -> String {
    let depth = parent_dir
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .count()
        + 2;
    format!(
        "{}{source_id}/{}",
        "../".repeat(depth),
        sdk_path.trim_start_matches('/')
    )
}

/// A plugin spec's own GTS segment: `cf.toolkit.plugins.plugin.v1~cf.core.x.plugin.v1~`
/// -> `cf.core.x.plugin.v1~`, the form a plugin's `fills = "..."` is written in.
pub fn spec_segment(spec: &str) -> &str {
    spec.strip_prefix("cf.toolkit.plugins.plugin.v1~")
        .unwrap_or(spec)
}

/// `https://github.com/Owner/Repo.git`, `owner/repo` -> `owner/repo`: the form
/// two spellings of one repository compare equal in.
pub fn repo_key(value: &str) -> String {
    let v = value.trim().trim_end_matches('/').trim_end_matches(".git");
    let v = v.split_once("://").map_or(v, |(_, rest)| rest);
    let parts: Vec<&str> = v.split('/').filter(|s| !s.is_empty()).collect();
    let tail = if parts.len() > 2 {
        &parts[parts.len() - 2..]
    } else {
        &parts[..]
    };
    tail.join("/").to_ascii_lowercase()
}

fn answer_gdl(result: &Value) -> anyhow::Result<String> {
    if let Some(error) = result.get("error") {
        bail!(
            "the engine refused the scaffold: {}",
            error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("no message")
        );
    }
    result
        .pointer("/result/gear_gdl")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("the engine's scaffold answer has no gear_gdl"))
}

/// One request to `gearbox rpc --stdio`: initialize (writes declared, because
/// the scaffold method refuses a read-only session even for a dry run), the
/// request, shut down. Returns the request's whole response. Blocking.
fn rpc_once(
    bin: &Path,
    root: &Path,
    workspace: &Path,
    method: &str,
    params: Value,
) -> anyhow::Result<Value> {
    use std::io::{BufRead, BufReader, Write};

    let mut child = Command::new(bin)
        .args(["rpc", "--stdio", "--root"])
        .arg(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| anyhow!("cannot run the Gearbox engine `{}`: {e}", bin.display()))?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let stdout = child.stdout.take().expect("stdout is piped");

    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut length = None;
            loop {
                let mut line = String::new();
                if reader
                    .read_line(&mut line)
                    .ok()
                    .filter(|n| *n > 0)
                    .is_none()
                {
                    return;
                }
                let line = line.trim_end();
                if line.is_empty() {
                    break;
                }
                if let Some(v) = line.strip_prefix("Content-Length:") {
                    length = v.trim().parse::<usize>().ok();
                }
            }
            let Some(n) = length else { return };
            let mut body = vec![0u8; n];
            if std::io::Read::read_exact(&mut reader, &mut body).is_err() {
                return;
            }
            if let Ok(v) = serde_json::from_slice::<Value>(&body)
                && tx.send(v).is_err()
            {
                return;
            }
        }
    });

    let mut send = |message: Value| -> anyhow::Result<()> {
        let body = serde_json::to_vec(&message)?;
        write!(stdin, "Content-Length: {}\r\n\r\n", body.len())?;
        stdin.write_all(&body)?;
        stdin.flush()?;
        Ok(())
    };
    let deadline = Instant::now() + ENGINE_TIMEOUT;
    let wait_for = |id: i64| -> anyhow::Result<Value> {
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let message = rx.recv_timeout(left).map_err(|_| {
                anyhow!(
                    "the Gearbox engine did not answer within {}s",
                    ENGINE_TIMEOUT.as_secs()
                )
            })?;
            if message.get("id").and_then(Value::as_i64) == Some(id) {
                return Ok(message);
            }
        }
    };

    let outcome = (|| {
        send(
            serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "roots": [root.to_string_lossy()],
                "workspace": workspace.to_string_lossy(),
                "allow_writes": true,
            }}),
        )?;
        let init = wait_for(1)?;
        if let Some(e) = init.get("error") {
            bail!("the engine refused to initialize: {e}");
        }
        send(serde_json::json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} }))?;
        send(serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": method, "params": params }))?;
        let answer = wait_for(2)?;
        let _ = send(
            serde_json::json!({ "jsonrpc": "2.0", "id": 3, "method": "shutdown", "params": null }),
        );
        let _ = send(serde_json::json!({ "jsonrpc": "2.0", "method": "exit" }));
        Ok(answer)
    })();
    let _ = child.kill();
    let _ = child.wait();
    outcome
}

/// A product id is a kebab-case id in GDL: lowercase letters, digits, single
/// interior hyphens, starting with a letter.
pub fn is_kebab_id(s: &str) -> bool {
    let bytes = s.as_bytes();
    !bytes.is_empty()
        && bytes[0].is_ascii_lowercase()
        && bytes.last().is_some_and(|b| *b != b'-')
        && !s.contains("--")
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// A JSON value as a GDL literal: strings quoted, `True`/`False`, lists and
/// maps nested. `null` has no GDL spelling and is left out by the caller.
fn gdl_value(v: &Value) -> String {
    match v {
        Value::String(s) => gdl_string(s),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .filter(|i| !i.is_null())
                .map(gdl_value)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Object(map) => gdl_map(map),
        Value::Null => "None".to_string(),
    }
}

/// `{"key": value, ...}`, keys in order, nulls dropped.
fn gdl_map(map: &serde_json::Map<String, Value>) -> String {
    let body = map
        .iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| format!("{}: {}", gdl_string(k), gdl_value(v)))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{{{body}}}")
}

fn gdl_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Which corpus a description names, and at which commit: one root, as a
/// test spells it ([`render_product_gdl_from`] takes several).
#[cfg(test)]
#[derive(Debug, Clone, Copy)]
pub struct CorpusPin<'a> {
    pub url: &'a str,
    pub rev: &'a str,
}

/// Where a new product's description goes in its project's repository:
/// `products/<id>/product.gdl`. The file keeps the name the engine and the IDE
/// look for, and the product's id names its directory, so a repository shows
/// which product it holds and can hold more than one. `product_id` must be a
/// kebab-case id ([`is_kebab_id`]), which keeps the path inside `products/`.
pub fn product_gdl_path(product_id: &str) -> String {
    format!("products/{product_id}/product.gdl")
}

/// One gear repository a `product.gdl` names: its source id, its clone URL,
/// and the commit it was checked against. Without a commit, the description
/// reaches the checkout beside the repository instead.
pub struct SourcePin<'a> {
    pub id: &'a str,
    pub url: &'a str,
    pub rev: Option<&'a str>,
    /// A source inside the project's own repository, at this path from its
    /// root (`studio-backend`): written as a `path(...)` from the product
    /// file, because it travels with it.
    pub within: Option<&'a str>,
}

/// The `product.gdl` for a composition, to be saved at `product_path` in the
/// project's repository. `default_profile` must be one of [`PROFILES`].
///
/// With a `pin`, the corpus is a git source at the commit the composition was
/// checked against, so the description says by itself what it was built from
/// and needs no checkout beside it; the IDE brings that commit in when it opens
/// the product. Without one (a corpus whose commit is unknown), the sibling
/// checkout, reached from where the description sits.
#[cfg(test)]
pub fn render_product_gdl(
    product_id: &str,
    product_path: &str,
    name: &str,
    composition: &Composition,
    default_profile: &str,
    pin: Option<CorpusPin<'_>>,
    config: &BTreeMap<String, serde_json::Map<String, Value>>,
) -> String {
    let source = SourcePin {
        id: CORPUS_SOURCE_ID,
        url: pin.as_ref().map_or("", |p| p.url),
        rev: pin.as_ref().map(|p| p.rev),
        within: None,
    };
    render_product_gdl_from(
        product_id,
        product_path,
        name,
        composition,
        default_profile,
        &[source],
        &BTreeMap::new(),
        config,
    )
}

/// [`render_product_gdl`] over several gear repositories (ADR-0046): one
/// `source` per repository, and each `use_gear` naming the repository the
/// engine found it in (`gear_source`, by engine id; the first repository when
/// unknown).
#[allow(clippy::too_many_arguments)]
pub fn render_product_gdl_from(
    product_id: &str,
    product_path: &str,
    name: &str,
    composition: &Composition,
    default_profile: &str,
    sources: &[SourcePin<'_>],
    gear_source: &BTreeMap<String, String>,
    config: &BTreeMap<String, serde_json::Map<String, Value>>,
) -> String {
    // `config` is keyed by engine id here; the caller maps crate names.
    let config_arg = |id: &str| {
        config
            .get(id)
            .filter(|c| c.values().any(|v| !v.is_null()))
            .map(|c| format!(", config = {}", gdl_map(c)))
            .unwrap_or_default()
    };
    let first = sources.first().map_or(CORPUS_SOURCE_ID, |s| s.id);
    let source_of = |id: &str| -> String {
        gear_source
            .get(id)
            .filter(|s| sources.iter().any(|p| p.id == s.as_str()))
            .map_or_else(|| first.to_string(), Clone::clone)
    };
    let mut gears = String::new();
    for g in &composition.gears {
        if g.plugins.is_empty() {
            gears.push_str(&format!(
                "        use_gear({}, source = {}{}),\n",
                gdl_string(&g.id),
                gdl_string(&source_of(&g.id)),
                config_arg(&g.id)
            ));
        } else {
            let plugins = g
                .plugins
                .iter()
                .map(|p| format!("plugin({}{})", gdl_string(p), config_arg(p)))
                .collect::<Vec<_>>()
                .join(", ");
            gears.push_str(&format!(
                "        use_gear({}, source = {}{}, plugins = [{plugins}]),\n",
                gdl_string(&g.id),
                gdl_string(&source_of(&g.id)),
                config_arg(&g.id)
            ));
        }
    }
    let id = gdl_string(product_id);
    let depth = product_path.split('/').filter(|s| !s.is_empty()).count();
    let up = "../".repeat(depth.max(1));
    let names = sources
        .iter()
        .map(|s| format!("`{}`", s.id))
        .collect::<Vec<_>>()
        .join(", ");
    let pinned = !sources.is_empty() && sources.iter().all(|s| s.rev.is_some());
    let from = if pinned {
        format!(
            "# gears come from {names} at the commit this was checked against;\n\
             # the Studio IDE brings that commit in when it opens the product. From a\n\
             # checkout of {names} at that commit, resolve it with"
        )
    } else {
        format!(
            "# gears come from the {names} checkout beside this repository in a\n\
             # Studio workspace. Resolve it with"
        )
    };
    let roots = sources
        .iter()
        .map(|s| format!("--root {up}{}", s.id))
        .collect::<Vec<_>>()
        .join(" ");
    let declared = sources
        .iter()
        .map(|s| {
            let at = match (s.within, s.rev) {
                (Some(within), _) => format!(
                    "path({})",
                    gdl_string(&format!(
                        "{}{within}",
                        "../".repeat(depth.saturating_sub(1))
                    ))
                ),
                (None, Some(rev)) => format!(
                    "git(url = {}, rev = {})",
                    gdl_string(s.url),
                    gdl_string(rev)
                ),
                (None, None) => format!("path({})", gdl_string(&format!("{up}{}", s.id))),
            };
            format!("source(id = {}, at = {at})", gdl_string(s.id))
        })
        .collect::<Vec<_>>()
        .join(",\n                   ");
    // A cluster's Postgres password comes out of an existing Secret.
    let cluster_db = format!(
        "postgres(host = \"postgres\", user = \"app\", password = \"${{GEARS_PG_PASSWORD}}\",\n\
         \x20                                      existing_secret = {})",
        gdl_string(&format!("{product_id}-db"))
    );
    format!(
        "# The product this project ships, as Gearbox composes it.\n\
         #\n\
         # Written by Constructor Studio from the gears picked for the project. The\n\
         {from}\n\
         #\n\
         #   gearbox resolve {roots} --product product.gdl --profile dev\n\
         #\n\
         # Reference: https://github.com/constructorfabric/gearbox/blob/main/docs/gdl.md\n\
         \n\
         product(\n\
         \x20   id = {id},\n\
         \x20   name = {name},\n\
         \x20   version = \"0.1.0\",\n\
         \x20   sources = [{declared}],\n\
         \x20   # Where the gears that keep data keep it: one Postgres per profile\n\
         \x20   # (GDL 1.1). The password is only ever a `${{NAME}}` the deployment\n\
         \x20   # sets; change the host and user to the server you run.\n\
         \x20   # `dev` and `local` run on a machine: development profiles, so the\n\
         \x20   # production rules (accept-all sign-in, ...) warn there instead of\n\
         \x20   # failing. `prod` is held to them.\n\
         \x20   profiles = [\n\
         \x20       embedded(id = \"dev\", development = True,\n\
         \x20                database = {local_db}),\n\
         \x20       self_hosted(id = \"local\", development = True, host = {id}, worker_discovery = \"directory\",\n\
         \x20                   target_dir = \"target\",\n\
         \x20                   database = {local_db}),\n\
         \x20       kubernetes(id = \"prod\", discovery = \"static\", namespace = {id},\n\
         \x20                  database = {cluster_db}),\n\
         \x20   ],\n\
         \x20   default_profile = {profile},\n\
         \x20   gears = [\n\
         {gears}\
         \x20   ],\n\
         )\n",
        name = gdl_string(name),
        profile = gdl_string(default_profile),
        local_db = PROFILE_DATABASE,
    )
}

/// The Postgres a profile on a machine names. Without one, a product with any
/// gear that keeps data -- types-registry is in nearly all of them -- does not
/// resolve since GDL 1.1 (GBX0306); a product with none resolves with it too.
const PROFILE_DATABASE: &str =
    "postgres(host = \"127.0.0.1\", user = \"app\", password = \"${GEARS_PG_PASSWORD}\")";

// ── What the engine said ──────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineDiagnostic {
    pub code: String,
    pub severity: String,
    pub message: String,
    pub help: Option<String>,
    /// Where it points: `product.gdl` or a corpus-relative `gear.gdl`.
    pub file: Option<String>,
    /// One-based.
    pub line: Option<u32>,
}

impl EngineDiagnostic {
    pub fn is_error(&self) -> bool {
        self.severity == "error"
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineListen {
    pub name: String,
    pub gear: String,
    pub address: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineApplication {
    pub name: String,
    pub kind: String,
    pub anchor: Option<String>,
    pub gears: Vec<String>,
    pub replicas: u32,
    pub listens: Vec<EngineListen>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineResolvedGear {
    pub id: String,
    pub crate_name: String,
    /// Why it is in the product: `selected`, `colocated with api-gateway`,
    /// `plugin of authn-resolver`.
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Resolution {
    pub applications: Vec<EngineApplication>,
    pub gears: Vec<EngineResolvedGear>,
    pub diagnostics: Vec<EngineDiagnostic>,
}

/// Diagnostics as the engine serializes them, with locations made relative:
/// a URI inside the corpus becomes its corpus path, the product file becomes
/// `product.gdl`, and anything else keeps only its file name.
pub fn parse_diagnostics(v: &Value, corpus: &Path) -> Vec<EngineDiagnostic> {
    let corpus = corpus.to_string_lossy().replace('\\', "/");
    let corpus = corpus.trim_end_matches('/');
    v.as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|d| {
                    let s = |k: &str| d.get(k).and_then(Value::as_str).map(str::to_string);
                    let uri = d.pointer("/location/uri").and_then(Value::as_str);
                    let file = uri.map(|u| {
                        let path = u.strip_prefix("file://").unwrap_or(u);
                        match path.strip_prefix(corpus) {
                            Some(rel) => rel.trim_start_matches('/').to_string(),
                            None => path.rsplit('/').next().unwrap_or(path).to_string(),
                        }
                    });
                    let line = d
                        .pointer("/location/range/start/line")
                        .and_then(Value::as_u64)
                        .and_then(|l| u32::try_from(l + 1).ok());
                    Some(EngineDiagnostic {
                        code: s("code")?,
                        severity: s("severity").unwrap_or_else(|| "error".into()),
                        message: s("message").unwrap_or_default(),
                        help: s("help"),
                        file,
                        line,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_resolution(v: &Value, corpus: &Path) -> Resolution {
    let str_list = |v: Option<&Value>| -> Vec<String> {
        v.and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    let applications = v
        .get("applications")
        .and_then(Value::as_array)
        .map(|apps| {
            apps.iter()
                .map(|a| {
                    let s = |k: &str| a.get(k).and_then(Value::as_str).map(str::to_string);
                    EngineApplication {
                        name: s("name").unwrap_or_default(),
                        kind: s("kind").unwrap_or_default(),
                        anchor: s("anchor"),
                        gears: str_list(a.get("gears")),
                        replicas: a
                            .get("replicas")
                            .and_then(Value::as_u64)
                            .and_then(|n| u32::try_from(n).ok())
                            .unwrap_or(1),
                        listens: a
                            .get("listens")
                            .and_then(Value::as_array)
                            .map(|ls| {
                                ls.iter()
                                    .map(|l| {
                                        let s = |k: &str| {
                                            l.get(k)
                                                .and_then(Value::as_str)
                                                .unwrap_or_default()
                                                .to_string()
                                        };
                                        EngineListen {
                                            name: s("name"),
                                            gear: s("gear"),
                                            address: s("address"),
                                        }
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let gears = v
        .get("gears")
        .and_then(Value::as_object)
        .map(|gears| {
            gears
                .values()
                .map(|g| EngineResolvedGear {
                    id: g
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    crate_name: g
                        .pointer("/package/crate_name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    reasons: g
                        .get("selected_by")
                        .and_then(Value::as_array)
                        .map(|rs| rs.iter().map(reason).collect())
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    Resolution {
        applications,
        gears,
        diagnostics: v
            .get("diagnostics")
            .map(|d| parse_diagnostics(d, corpus))
            .unwrap_or_default(),
    }
}

fn reason(r: &Value) -> String {
    let s = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or_default();
    match s("reason") {
        "colocated_by" => format!("colocated with {}", s("gear")),
        "plugin_of" => format!("plugin of {}", s("host")),
        "" => "selected".to_string(),
        other => other.replace('_', " "),
    }
}

// ── Running it ────────────────────────────────────────────────────────────

pub struct PreviewInput {
    pub product_id: String,
    /// Where the description is saved, relative to the repository root
    /// ([`product_gdl_path`] for a new one). The engine is run on it laid out
    /// the same way, so a sibling corpus resolves as it will in the IDE.
    pub product_path: String,
    pub name: String,
    pub gears: Vec<String>,
    pub profile: String,
    /// The product's configuration of its gears, by crate name or engine id.
    pub config: GearConfig,
    /// `owner/name` of the repository the description is saved to, when
    /// known: a project root in it is a `path(...)` beside the file; one in
    /// another repository is pinned by its git url instead.
    pub repo: Option<String>,
    /// Whether the engine's answer may come from an earlier preview of the
    /// same description against the same commits. A preview that is saved
    /// asks the engine afresh.
    pub reuse: bool,
}

/// Where a pinned root sits for the description: inside the repository the
/// file is saved to (`within` its directory) only when the root's checkout is
/// that repository. Another project's directory of the organization would be
/// a path that does not exist beside this file.
fn within_product_repo<'a>(
    subdir: Option<&'a str>,
    root_url: &str,
    product_repo: Option<&str>,
) -> Option<&'a str> {
    subdir.filter(|_| product_repo.is_some_and(|repo| repo_key(repo) == repo_key(root_url)))
}

pub struct Preview {
    pub product_gdl: String,
    pub composition: Composition,
    pub resolution: Resolution,
    pub corpus_commit: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GearboxStatus {
    pub engine_version: Option<String>,
    pub corpus_url: String,
    pub corpus_ref: String,
    pub corpus_commit: Option<String>,
    pub problem: Option<String>,
    /// Each root the engine reads, in its order.
    pub sources: Vec<SourceStatus>,
    /// The organization's repositories left out because a platform repository
    /// has the same source id, by source id.
    pub shadowed: Vec<String>,
}

/// One gear repository as the engine last read it.
#[derive(Debug, Clone)]
pub struct SourceStatus {
    pub source_id: String,
    /// `owner/repo`, or the deployment's URL for its corpus.
    pub repo: String,
    pub git_ref: String,
    pub commit: Option<String>,
    /// Gears the engine attributes to it.
    pub gears: usize,
    /// The gear repository connection it comes from; `None` for the
    /// deployment's corpus.
    pub connection_id: Option<uuid::Uuid>,
    /// The tier it belongs to: `platform`, or `organization`.
    pub tier: &'static str,
}

/// A root of the corpus as it was read: where it comes from, the commit, and
/// how many gears the engine found in it.
#[derive(Clone)]
pub struct ReadRoot {
    pub root: GearRoot,
    pub commit: Option<String>,
    pub gears: usize,
}

/// Which corpus a call reads (ADR-0046): the platform's gear repositories
/// (`None`), or an organization's (`Some(org)`) -- the platform's, then the
/// organization's own. An organization with none of its own reads the
/// platform's corpus.
pub type Scope = Option<uuid::Uuid>;

/// A root of the corpus: a gear repository and the id the engine knows it by.
#[derive(Clone)]
pub struct GearRoot {
    pub id: String,
    pub source: CorpusSource,
    /// The connection it is read through; `None` for the deployment's corpus.
    pub connection_id: Option<uuid::Uuid>,
    /// An organization's own repository, rather than the platform's.
    pub organization: bool,
    /// The directory inside the checkout the engine reads, when the root is
    /// not the repository itself: a project's `source(id, at = path("..."))`
    /// (studio-web's gears are `studio-backend/`). Its last segment is the
    /// source id, because the engine names a root by its directory.
    pub subdir: Option<String>,
}

impl GearRoot {
    /// What decides whether a checkout is still the one asked for. Not the
    /// token: a rotated token reads the same repository, and is taken into
    /// the list without making it a new generation -- which would have
    /// made every request wait for a fetch and a catalogue it already had.
    fn same(&self, other: &Self) -> bool {
        self.id == other.id
            && self.connection_id == other.connection_id
            && self.source.key == other.source.key
            && self.source.url == other.source.url
            && self.source.git_ref == other.source.git_ref
            && self.subdir == other.subdir
    }
}

/// A root as it is checked out.
#[derive(Clone)]
struct Root {
    id: String,
    dir: PathBuf,
    commit: Option<String>,
}

/// Whether a catalogue the engine read over `before` still describes
/// `after`: the same roots, in the same directories, at the same commits.
/// Within one generation that is the rule it always was; across generations
/// (the list read again and found different) every commit must be known as
/// well, since a root without one could hold anything.
fn same_checkouts(before: &[Root], after: &[Root], same_generation: bool) -> bool {
    before.len() == after.len()
        && before.iter().zip(after).all(|(a, b)| {
            a.id == b.id
                && a.dir == b.dir
                && a.commit == b.commit
                && (same_generation || a.commit.is_some())
        })
}

/// A corpus as a request reads it: its roots, the catalogue and the engine's
/// answer verbatim.
#[derive(Clone)]
struct Loaded {
    roots: Vec<Root>,
    catalogue: Arc<EngineCatalogue>,
    raw: Arc<Value>,
}

impl Loaded {
    /// Each root's id and directory, as the engine is handed them.
    fn named(&self) -> Vec<(String, PathBuf)> {
        self.roots
            .iter()
            .map(|r| (r.id.clone(), r.dir.clone()))
            .collect()
    }

    /// The first root's commit: the one a single-corpus client shows.
    fn commit(&self) -> Option<String> {
        self.roots.first().and_then(|r| r.commit.clone())
    }
}

#[derive(Clone)]
struct Corpus {
    roots: Vec<Root>,
    /// The generations (the platform's list, the organization's) these roots
    /// were checked out for.
    generation: (u64, u64),
    refreshed: Instant,
    catalogue: Option<Arc<EngineCatalogue>>,
    /// The engine's answer verbatim, for a client that reads more of it than
    /// composing does: the IDE's catalogue renders every `GearDescriptor`.
    raw: Option<Arc<Value>>,
}

impl Corpus {
    /// What a request reads, once the catalogue is loaded.
    fn loaded(&self) -> Option<Loaded> {
        Some(Loaded {
            roots: self.roots.clone(),
            catalogue: self.catalogue.clone()?,
            raw: self.raw.clone()?,
        })
    }
}

/// One scope's corpus, and the lock a refresh of it holds.
struct ScopeCell {
    /// What requests read. Held only to look, or to put a refreshed corpus
    /// in: never across a fetch or an engine run.
    corpus: Mutex<Option<Corpus>>,
    /// Held for a whole refresh -- every root fetched, the catalogue loaded
    /// -- so one runs at a time per scope. A request that has a corpus to
    /// serve never waits on it.
    sync: Mutex<()>,
}

impl ScopeCell {
    fn new() -> Self {
        Self {
            corpus: Mutex::new(None),
            sync: Mutex::new(()),
        }
    }
}

/// What a refresh needs, owned, so it can run on a task of its own after the
/// request that noticed the corpus was stale has been answered.
#[derive(Clone)]
struct Syncer {
    bin: PathBuf,
    workdir: PathBuf,
    checkouts: CheckoutLocks,
    refresh: Duration,
}

impl Syncer {
    /// Bring `cell` to `wanted` at `generation`: fetch every root (unless a
    /// corpus of this generation was fetched within the refresh period and
    /// only its catalogue is missing), reuse the catalogue when the commits
    /// are the ones it was read at, else run the engine. With `keep_partial`
    /// the fetched roots are kept even when the catalogue fails, so the next
    /// call only retries the engine; a refresh in the background keeps the
    /// corpus it is replacing instead.
    async fn sync(
        &self,
        cell: &ScopeCell,
        wanted: &[GearRoot],
        generation: (u64, u64),
        keep_partial: bool,
    ) -> anyhow::Result<Loaded> {
        let previous: Option<Corpus> = cell.corpus.lock().await.clone();
        let fetched_recently = previous
            .as_ref()
            .filter(|p| p.generation == generation && p.refreshed.elapsed() < self.refresh);
        let (roots, refreshed) = match fetched_recently {
            Some(p) => (p.roots.clone(), p.refreshed),
            None => {
                let same_generation = previous.as_ref().filter(|p| p.generation == generation);
                (self.fetch(wanted, same_generation).await?, Instant::now())
            }
        };
        let reusable = previous.as_ref().filter(|p| {
            p.catalogue.is_some()
                && p.raw.is_some()
                && same_checkouts(&p.roots, &roots, p.generation == generation)
        });
        let loaded = match reusable {
            Some(p) => Loaded {
                roots,
                catalogue: p.catalogue.clone().expect("checked above"),
                raw: p.raw.clone().expect("checked above"),
            },
            None => {
                let named: Vec<(String, PathBuf)> = roots
                    .iter()
                    .map(|r| (r.id.clone(), r.dir.clone()))
                    .collect();
                match self.load_catalogue(named).await {
                    Ok((catalogue, raw)) => Loaded {
                        roots,
                        catalogue,
                        raw,
                    },
                    Err(e) => {
                        if keep_partial {
                            *cell.corpus.lock().await = Some(Corpus {
                                roots,
                                generation,
                                refreshed,
                                catalogue: None,
                                raw: None,
                            });
                        }
                        return Err(e);
                    }
                }
            }
        };
        *cell.corpus.lock().await = Some(Corpus {
            roots: loaded.roots.clone(),
            generation,
            refreshed,
            catalogue: Some(Arc::clone(&loaded.catalogue)),
            raw: Some(Arc::clone(&loaded.raw)),
        });
        Ok(loaded)
    }

    /// Every root of `wanted` fetched or cloned, a few at once. A root whose
    /// fetch fails keeps its checkout from `previous` (the same generation),
    /// so a flaky fetch does not turn every preview into an error; one with
    /// nothing to keep fails the refresh.
    async fn fetch(
        &self,
        wanted: &[GearRoot],
        previous: Option<&Corpus>,
    ) -> anyhow::Result<Vec<Root>> {
        let results: Vec<anyhow::Result<crate::connectors::sdk::git_checkout::CloneResult>> =
            futures_util::stream::iter(wanted.iter().cloned())
                .map(|r| {
                    let (workdir, locks) = (self.workdir.clone(), Arc::clone(&self.checkouts));
                    async move {
                        tokio::task::spawn_blocking(move || checkout_root(&workdir, &locks, &r))
                            .await
                            .unwrap_or_else(|e| Err(anyhow!("corpus sync task: {e}")))
                    }
                })
                .buffered(PARALLEL_CHECKOUTS)
                .collect()
                .await;
        let mut roots = Vec::with_capacity(wanted.len());
        for (r, result) in wanted.iter().zip(results) {
            match result {
                Ok(c) => {
                    // A project's directory is judged again on the
                    // refreshed checkout: the pull may have made it a
                    // link out of the repository.
                    let dir = match &r.subdir {
                        Some(sub) => match super::project_roots::contained_dir(&c.dir, sub) {
                            Some(dir) => dir,
                            None => {
                                warn!(source = %r.id, subdir = %sub, "gearbox: a project's gear directory is not a directory inside its repository; not read");
                                continue;
                            }
                        },
                        None => c.dir,
                    };
                    roots.push(Root {
                        id: r.id.clone(),
                        dir,
                        commit: c.commit,
                    });
                }
                Err(e) => match previous.and_then(|p| p.roots.iter().find(|x| x.id == r.id)) {
                    Some(kept) => {
                        warn!(source = %r.id, error = %format!("{e:#}"), "gearbox: gear repository refresh failed; using the last checkout");
                        roots.push(kept.clone());
                    }
                    None => {
                        return Err(e.context(format!(
                            "cannot check out the gear repository `{}` ({})",
                            r.id, r.source.label
                        )));
                    }
                },
            }
        }
        Ok(roots)
    }

    /// `gearbox catalogue` over `named`, parsed, and verbatim.
    async fn load_catalogue(
        &self,
        named: Vec<(String, PathBuf)>,
    ) -> anyhow::Result<(Arc<EngineCatalogue>, Arc<Value>)> {
        let bin = self.bin.clone();
        let mut args: Vec<String> = vec!["catalogue".into()];
        // Each root under a directory named by its source id: the engine
        // takes a root's id from its directory's name when there are
        // several (`--source-id` names one root only).
        for (_, dir) in &named {
            args.push("--root".into());
            args.push(dir.to_string_lossy().into_owned());
        }
        args.extend(["--format".into(), "json".into()]);
        let out = tokio::task::spawn_blocking(move || run_engine(&bin, &args, None))
            .await
            .context("catalogue task")??;
        let raw: Value = serde_json::from_str(&out.stdout).with_context(|| {
            format!("the engine's catalogue is not JSON: {}", out.stderr_tail())
        })?;
        let parsed: EngineCatalogue = serde_json::from_value(raw.clone())
            .context("the engine's catalogue does not have the expected shape")?;
        if let Some(why) = parsed.unreadable_root(&named) {
            bail!(why);
        }
        Ok((Arc::new(parsed), Arc::new(raw)))
    }
}

/// Check one root out under `workdir` (see [`checkout_dir`]), holding its
/// directory's lock: a platform root is read by the platform's corpus and by
/// every organization's, and two fetches into one directory at once break it.
/// Blocking.
fn checkout_root(
    workdir: &Path,
    locks: &CheckoutLocks,
    r: &GearRoot,
) -> anyhow::Result<crate::connectors::sdk::git_checkout::CloneResult> {
    let s = &r.source;
    let git_ref = Some(s.git_ref.as_str()).filter(|g| !g.trim().is_empty());
    // `gearbox-roots/<key>/<source id>`: the engine names a root by its
    // directory -- the real one, after links are followed -- so the checkout
    // itself carries the id; the key keeps two repositories apart.
    let dir = checkout_dir(workdir, r);
    let lock = Arc::clone(
        locks
            .lock()
            .expect("gearbox checkout locks")
            .entry(dir.clone())
            .or_default(),
    );
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    crate::connectors::sdk::git_checkout::clone_or_update_into(
        &dir,
        &s.url,
        &s.username,
        &s.token,
        git_ref,
    )
}

/// Keys with a refresh running, so a second one is not started beside it.
pub struct InFlight<K>(std::sync::Mutex<HashSet<K>>);

impl<K: Eq + std::hash::Hash + Clone> InFlight<K> {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new(HashSet::new()))
    }

    /// `key`'s refresh, claimed until the claim is dropped; `None` while
    /// another holds it.
    pub fn claim(&self, key: K) -> Option<Claim<'_, K>> {
        let mut held = self.0.lock().unwrap_or_else(|p| p.into_inner());
        // Built only when claimed: a claim built and dropped on refusal would
        // free the key its holder still has.
        if held.insert(key.clone()) {
            Some(Claim { set: self, key })
        } else {
            None
        }
    }
}

impl<K: Eq + std::hash::Hash + Clone> Default for InFlight<K> {
    fn default() -> Self {
        Self::new()
    }
}

/// A claimed refresh; dropping it, however the refresh ended, frees the key.
pub struct Claim<'a, K: Eq + std::hash::Hash> {
    set: &'a InFlight<K>,
    key: K,
}

impl<K: Eq + std::hash::Hash> Drop for Claim<'_, K> {
    fn drop(&mut self) {
        self.set
            .0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.key);
    }
}

/// The engine's answers to recent previews, by [`evaluation_key`].
#[derive(Default)]
struct Evaluations {
    /// Each answer with when it was kept and its place in the order kept.
    entries: HashMap<[u8; 32], (Instant, u64, Resolution)>,
    kept: u64,
}

impl Evaluations {
    fn get(&mut self, key: &[u8; 32]) -> Option<Resolution> {
        self.entries
            .retain(|_, (at, _, _)| at.elapsed() < EVALUATION_TTL);
        self.entries.get(key).map(|(_, _, r)| r.clone())
    }

    fn put(&mut self, key: [u8; 32], resolution: Resolution) {
        self.entries
            .retain(|_, (at, _, _)| at.elapsed() < EVALUATION_TTL);
        // The first kept goes first: by order, not by clock, which can read
        // the same for two answers kept in quick succession.
        if !self.entries.contains_key(&key)
            && self.entries.len() >= EVALUATIONS_KEPT
            && let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (_, n, _))| *n)
                .map(|(k, _)| *k)
        {
            self.entries.remove(&oldest);
        }
        self.kept += 1;
        self.entries
            .insert(key, (Instant::now(), self.kept, resolution));
    }
}

/// What decides the engine's answer to a preview: the scope asking (so no
/// answer crosses from one organization to another), every root's directory
/// and commit, and the description with where it sits and the profile.
/// `None` when a root's commit is unknown: its content could be anything.
fn evaluation_key(
    scope: Scope,
    roots: &[Root],
    product_id: &str,
    product_path: &str,
    profile: &str,
    gdl: &str,
) -> Option<[u8; 32]> {
    use sha2::Digest as _;
    let mut h = sha2::Sha256::new();
    h.update(format!("{scope:?}\0").as_bytes());
    for r in roots {
        let commit = r.commit.as_deref()?;
        h.update(format!("{}\0{}\0{commit}\0", r.id, r.dir.display()).as_bytes());
    }
    for part in [product_id, product_path, profile, gdl] {
        h.update(part.as_bytes());
        h.update([0u8]);
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&h.finalize());
    Some(key)
}

/// The roots asked for, and when their list was last read.
struct RootSet {
    list: Vec<GearRoot>,
    generation: u64,
    checked: Option<Instant>,
}

impl RootSet {
    fn new(list: Vec<GearRoot>) -> Self {
        Self {
            list,
            generation: 0,
            checked: None,
        }
    }

    fn due(&self) -> bool {
        self.checked.is_none_or(|t| t.elapsed() >= ROOTS_RECHECK)
    }

    /// Take `list`; a list unlike the last one is a new generation. The list
    /// is taken either way, so a rotated token is the one the next fetch
    /// uses.
    fn take(&mut self, list: Vec<GearRoot>) {
        self.checked = Some(Instant::now());
        let unchanged =
            self.list.len() == list.len() && self.list.iter().zip(&list).all(|(a, b)| a.same(b));
        self.list = list;
        if !unchanged {
            self.generation += 1;
        }
    }
}

/// What a scope reads: its roots in the engine's order, the generations they
/// come from, and the organization's roots left out for a clash.
struct ScopeView {
    scope: Scope,
    roots: Vec<GearRoot>,
    generation: (u64, u64),
    shadowed: Vec<String>,
}

/// A repository checked out under the engine's working directory: a root of
/// the corpus, or a catalogue source whose files the component catalogue
/// reads.
#[derive(Clone)]
pub struct CorpusSource {
    /// `owner/repo@ref`, as a person reads it.
    pub label: String,
    /// Namespaces the checkout directory, so two sources never share one.
    pub key: String,
    pub repo: String,
    pub url: String,
    pub username: String,
    /// Held in memory only, for the refresh fetch; never logged or returned.
    pub token: String,
    pub git_ref: String,
}

/// One lock per checkout directory: a platform root is read by the platform's
/// corpus and by every organization's, and two fetches into one directory at
/// once break it.
type CheckoutLocks = Arc<std::sync::Mutex<HashMap<PathBuf, Arc<std::sync::Mutex<()>>>>>;

pub struct Gearbox {
    cfg: GearboxConfig,
    /// One corpus per scope, each behind its own locks, so one organization's
    /// fetch does not hold up another's previews.
    corpora: std::sync::Mutex<HashMap<Scope, Arc<ScopeCell>>>,
    /// The platform's roots.
    roots: std::sync::Mutex<RootSet>,
    /// Held while the platform's list is read, so one read runs at a time.
    roots_reading: Mutex<()>,
    /// Each organization's own roots, by organization.
    org_roots: std::sync::Mutex<HashMap<uuid::Uuid, RootSet>>,
    /// The organizations whose roots are being read.
    org_reads: InFlight<uuid::Uuid>,
    checkouts: CheckoutLocks,
    /// The `product.gdl` each project keeps in its repository, read with its
    /// organization's roots (`project_roots`), by project.
    project_files: std::sync::Mutex<HashMap<uuid::Uuid, ProjectFile>>,
    /// `gearbox --version`, asked once: the binary does not change under a
    /// running process, and the status page asked it on every load.
    version: std::sync::OnceLock<String>,
    /// Recent previews' answers.
    evaluations: std::sync::Mutex<Evaluations>,
}

/// A project's own product description, as its repository holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectFile {
    pub organization: uuid::Uuid,
    /// `owner/repo` and the branch it was read from.
    pub repo: String,
    pub branch: String,
    /// Its path in the repository: `product.gdl`.
    pub path: String,
    pub commit: Option<String>,
    /// Every gear it names, hosts and plugins, by gear id.
    pub gears: Vec<String>,
}

/// Where a root is checked out: `gearbox-roots/<key>/<source id>`, the
/// engine naming a root by its directory; a root inside its repository is the
/// repository's one clone, `gearbox-roots/<key>/repo`, read at its subdir.
pub fn checkout_dir(workdir: &Path, root: &GearRoot) -> PathBuf {
    let base = workdir.join("gearbox-roots").join(&root.source.key);
    match root.subdir {
        Some(_) => base.join("repo"),
        None => base.join(&root.id),
    }
}

/// The deployment's corpus as the one root, when it names one.
fn deployment_roots(cfg: &GearboxConfig) -> Vec<GearRoot> {
    if cfg.corpus_url.trim().is_empty() {
        return Vec::new();
    }
    vec![GearRoot {
        id: CORPUS_SOURCE_ID.to_string(),
        source: CorpusSource {
            label: format!(
                "{}@{}",
                cfg.corpus_url
                    .trim_end_matches(".git")
                    .trim_start_matches("https://github.com/"),
                cfg.corpus_ref
            ),
            key: "gearbox".to_string(),
            repo: CORPUS_SOURCE_ID.to_string(),
            url: cfg.corpus_url.clone(),
            username: "x-access-token".to_string(),
            token: String::new(),
            git_ref: cfg.corpus_ref.clone(),
        },
        connection_id: None,
        organization: false,
        subdir: None,
    }]
}

/// The platform's roots, then the organization's -- less any whose source id
/// a platform root already has: the engine names a root by its directory, so
/// two roots cannot share an id. Returns the roots and the ids left out.
fn merged_roots(platform: &[GearRoot], own: &[GearRoot]) -> (Vec<GearRoot>, Vec<String>) {
    let mut roots = platform.to_vec();
    let mut shadowed = Vec::new();
    for r in own {
        if roots.iter().any(|p| p.id == r.id) {
            shadowed.push(r.id.clone());
        } else {
            roots.push(r.clone());
        }
    }
    (roots, shadowed)
}

impl Gearbox {
    pub fn new(cfg: GearboxConfig) -> Self {
        let list = deployment_roots(&cfg);
        Self {
            cfg,
            corpora: std::sync::Mutex::new(HashMap::new()),
            roots: std::sync::Mutex::new(RootSet::new(list)),
            roots_reading: Mutex::new(()),
            org_roots: std::sync::Mutex::new(HashMap::new()),
            org_reads: InFlight::new(),
            checkouts: Arc::new(std::sync::Mutex::new(HashMap::new())),
            project_files: std::sync::Mutex::new(HashMap::new()),
            version: std::sync::OnceLock::new(),
            evaluations: std::sync::Mutex::new(Evaluations::default()),
        }
    }

    /// The lock a read of the platform's list holds (`gear_roots::refresh`).
    pub fn roots_reading(&self) -> &Mutex<()> {
        &self.roots_reading
    }

    /// Whether the platform's list has been read (or tried) at all: before
    /// that, a request waits for it rather than read the deployment's corpus
    /// it is about to replace.
    pub fn roots_ever_read(&self) -> bool {
        self.roots.lock().expect("gearbox roots").checked.is_some()
    }

    /// Whether organization `org`'s roots have been read (or tried) at all.
    pub fn org_roots_ever_read(&self, org: uuid::Uuid) -> bool {
        self.org_roots
            .lock()
            .expect("gearbox org roots")
            .get(&org)
            .is_some_and(|s| s.checked.is_some())
    }

    /// The roots organization `org`'s projects keep in their own
    /// repositories, as last read.
    pub fn org_project_roots(&self, org: uuid::Uuid) -> Vec<GearRoot> {
        self.org_roots
            .lock()
            .expect("gearbox org roots")
            .get(&org)
            .map(|s| {
                s.list
                    .iter()
                    .filter(|r| r.subdir.is_some())
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Claim the read of `org`'s roots; `None` while one is running.
    pub fn claim_org_read(&self, org: uuid::Uuid) -> Option<Claim<'_, uuid::Uuid>> {
        self.org_reads.claim(org)
    }

    fn syncer(&self) -> Syncer {
        Syncer {
            bin: self.cfg.bin.clone(),
            workdir: self.cfg.workdir.clone(),
            checkouts: Arc::clone(&self.checkouts),
            refresh: self.cfg.refresh,
        }
    }

    /// Check `source` out at `dir` (see [`checkout_dir`]) under the same lock
    /// the corpus takes, so a project's clone read for its product file and
    /// the corpus reading it as a root never fetch into it at once. Blocking.
    pub fn checkout_at(
        &self,
        dir: &Path,
        source: &CorpusSource,
    ) -> anyhow::Result<crate::connectors::sdk::git_checkout::CloneResult> {
        let lock = Arc::clone(
            self.checkouts
                .lock()
                .expect("gearbox checkout locks")
                .entry(dir.to_path_buf())
                .or_default(),
        );
        let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
        let git_ref = Some(source.git_ref.as_str()).filter(|g| !g.trim().is_empty());
        crate::connectors::sdk::git_checkout::clone_or_update_into(
            dir,
            &source.url,
            &source.username,
            &source.token,
            git_ref,
        )
    }

    /// Replace organization `org`'s projects' product files.
    pub fn use_project_files(&self, org: uuid::Uuid, files: Vec<(uuid::Uuid, ProjectFile)>) {
        let mut map = self.project_files.lock().expect("gearbox project files");
        map.retain(|_, f| f.organization != org);
        map.extend(files);
    }

    /// The product file project `project` keeps, when its organization's
    /// roots were read and it has one.
    pub fn project_file(&self, project: uuid::Uuid) -> Option<ProjectFile> {
        self.project_files
            .lock()
            .expect("gearbox project files")
            .get(&project)
            .cloned()
    }

    /// Every product file organization `org`'s projects keep, by project.
    pub fn project_files_of(&self, org: uuid::Uuid) -> Vec<(uuid::Uuid, ProjectFile)> {
        self.project_files
            .lock()
            .expect("gearbox project files")
            .iter()
            .filter(|(_, f)| f.organization == org)
            .map(|(p, f)| (*p, f.clone()))
            .collect()
    }

    /// The platform's roots, in the engine's order.
    #[cfg(test)]
    pub fn roots(&self) -> Vec<GearRoot> {
        self.roots.lock().expect("gearbox roots").list.clone()
    }

    /// What `scope` reads. An organization with no roots of its own reads the
    /// platform's corpus, under the platform's scope.
    fn view(&self, scope: Scope) -> ScopeView {
        let (platform, pg) = {
            let set = self.roots.lock().expect("gearbox roots");
            (set.list.clone(), set.generation)
        };
        let own = scope.and_then(|org| {
            let orgs = self.org_roots.lock().expect("gearbox org roots");
            orgs.get(&org)
                .filter(|s| !s.list.is_empty())
                .map(|s| (org, s.list.clone(), s.generation))
        });
        match own {
            Some((org, list, og)) => {
                let (roots, shadowed) = merged_roots(&platform, &list);
                ScopeView {
                    scope: Some(org),
                    roots,
                    generation: (pg, og),
                    shadowed,
                }
            }
            None => ScopeView {
                scope: None,
                roots: platform,
                generation: (pg, 0),
                shadowed: Vec::new(),
            },
        }
    }

    /// The roots `scope` reads, in the engine's order.
    pub fn roots_in(&self, scope: Scope) -> Vec<GearRoot> {
        self.view(scope).roots
    }

    /// Whether the platform's gear repositories are due to be read again.
    pub fn roots_due(&self) -> bool {
        self.roots.lock().expect("gearbox roots").due()
    }

    /// Read the corpus from `repositories` (the platform's gear repositories,
    /// in order), or from the deployment's corpus while there are none. A
    /// list unlike the last one is checked out afresh on the next use.
    pub fn use_repositories(&self, repositories: Vec<GearRoot>) {
        let list = if repositories.is_empty() {
            deployment_roots(&self.cfg)
        } else {
            repositories
        };
        self.roots.lock().expect("gearbox roots").take(list);
    }

    /// Note a failed read of the platform's list, so it is not retried on
    /// every request.
    pub fn mark_roots_checked(&self) {
        self.roots.lock().expect("gearbox roots").checked = Some(Instant::now());
    }

    /// Whether organization `org`'s own gear repositories are due to be read.
    /// A request claims the read with [`Self::begin_org_refresh`].
    #[cfg(test)]
    pub fn org_roots_due(&self, org: uuid::Uuid) -> bool {
        self.org_roots
            .lock()
            .expect("gearbox org roots")
            .get(&org)
            .is_none_or(RootSet::due)
    }

    /// Organization `org`'s own gear repositories (ADR-0046 phase 3), read
    /// after the platform's in that organization's corpus.
    pub fn use_org_repositories(&self, org: uuid::Uuid, repositories: Vec<GearRoot>) {
        let list = repositories
            .into_iter()
            .map(|mut r| {
                r.organization = true;
                r
            })
            .collect();
        self.org_roots
            .lock()
            .expect("gearbox org roots")
            .entry(org)
            .or_insert_with(|| RootSet::new(Vec::new()))
            .take(list);
    }

    /// Claim the next read of `org`'s roots: true for the one request that
    /// should read them now (they are due, or `now`), which marks them
    /// checked before it starts, so requests arriving during that read serve
    /// the roots there are instead of each starting the same slow read.
    pub fn begin_org_refresh(&self, org: uuid::Uuid, now: bool) -> bool {
        let mut sets = self.org_roots.lock().expect("gearbox org roots");
        let set = sets.entry(org).or_insert_with(|| RootSet::new(Vec::new()));
        if !now && !set.due() {
            return false;
        }
        set.checked = Some(Instant::now());
        true
    }

    /// Note a failed read of `org`'s list.
    pub fn mark_org_roots_checked(&self, org: uuid::Uuid) {
        self.org_roots
            .lock()
            .expect("gearbox org roots")
            .entry(org)
            .or_insert_with(|| RootSet::new(Vec::new()))
            .checked = Some(Instant::now());
    }

    fn cell(&self, scope: Scope) -> Arc<ScopeCell> {
        Arc::clone(
            self.corpora
                .lock()
                .expect("gearbox corpora")
                .entry(scope)
                .or_insert_with(|| Arc::new(ScopeCell::new())),
        )
    }

    fn first_source(&self, scope: Scope) -> Option<CorpusSource> {
        self.roots_in(scope).into_iter().next().map(|r| r.source)
    }

    /// Whether `repo_key` (`owner/repo`) is one of the repositories `scope`
    /// reads.
    #[cfg(test)]
    pub fn is_corpus_repo(&self, scope: Scope, repo_key: &str) -> bool {
        self.roots_in(scope)
            .iter()
            .any(|r| self::repo_key(&r.source.url) == repo_key)
    }

    /// The directory the corpus is checked out under; also where the
    /// components reference keeps its last engine catalogue across restarts.
    pub fn workdir(&self) -> &Path {
        &self.cfg.workdir
    }

    /// The corpus the catalogue, previews and facts are read from, as a label:
    /// each root's `owner/repo@ref`.
    pub fn corpus_label(&self, scope: Scope) -> String {
        let labels: Vec<String> = self
            .roots_in(scope)
            .into_iter()
            .map(|r| r.source.label)
            .collect();
        if labels.is_empty() {
            "no gear repository".to_string()
        } else {
            labels.join(", ")
        }
    }

    /// Where a client can clone the corpus's first root itself: its URL and
    /// ref, and whether reaching it takes the token this backend holds (which
    /// is never handed out, so such a corpus cannot be cloned from a laptop
    /// directly). Every root: [`Self::read_roots`].
    pub fn corpus_origin(&self, scope: Scope) -> (String, String, bool) {
        self.first_source(scope)
            .map(|s| (s.url, s.git_ref, !s.token.is_empty()))
            .unwrap_or_default()
    }

    /// The source id of the root [`Self::corpus_origin`] names.
    pub fn corpus_source_id(&self, scope: Scope) -> String {
        self.roots_in(scope)
            .into_iter()
            .next()
            .map_or_else(|| CORPUS_SOURCE_ID.to_string(), |r| r.id)
    }

    /// What the corpus Git relay sends upstream for root `source_id` of
    /// `scope` -- the first root when none is named: the repository URL and
    /// the token it is read with (empty for a public one). Server-side only.
    /// `None` when `scope` reads no such root.
    pub(crate) fn corpus_fetch(
        &self,
        scope: Scope,
        source_id: Option<&str>,
    ) -> Option<(String, String)> {
        let roots = self.roots_in(scope);
        let root = match source_id {
            Some(id) => roots.into_iter().find(|r| r.id == id),
            None => roots.into_iter().next(),
        }?;
        Some((root.source.url, root.source.token))
    }

    /// Check `source` out (or bring its checkout up to date) under the engine's
    /// working directory, and say where.
    ///
    /// The component catalogue reads its gears' files from here too, so one
    /// clone serves the catalogue, the previews and the IDE: the key namespaces
    /// the directory by source, and a second call for the same source is a
    /// fetch, not a download.
    pub async fn checkout(&self, source: &CorpusSource) -> anyhow::Result<PathBuf> {
        let workdir = self.cfg.workdir.clone();
        let s = source.clone();
        tokio::task::spawn_blocking(move || {
            // An empty ref is the repository's default branch.
            let git_ref = Some(s.git_ref.as_str()).filter(|r| !r.trim().is_empty());
            crate::connectors::sdk::git_checkout::clone_or_update(
                &workdir,
                &s.key,
                &s.repo,
                &s.url,
                &s.username,
                &s.token,
                git_ref,
            )
            .map(|c| c.dir)
        })
        .await
        .context("catalogue source checkout task")?
    }

    /// What the engine knows about every gear the corpus describes, keyed by
    /// crate name and shaped as component-profile fields (`{v, b, s}`), with
    /// the corpus they were read from.
    pub async fn facts(&self, scope: Scope) -> anyhow::Result<(String, BTreeMap<String, Value>)> {
        let (_, commit, catalogue) = self.ensure_corpus(scope).await?;
        let mut label = self.corpus_label(scope);
        if let Some(c) = commit {
            label = format!("{label} ({})", &c[..c.len().min(7)]);
        }
        Ok((label.clone(), gear_facts(&catalogue, &label)))
    }

    /// Every root `scope` reads, with the commit it was last read at and the
    /// gears the engine found in it. Roots not checked out yet have no commit.
    pub async fn read_roots(&self, scope: Scope) -> Vec<ReadRoot> {
        let view = self.view(scope);
        let cell = self.cell(view.scope);
        let guard = cell.corpus.lock().await;
        let commits: BTreeMap<String, Option<String>> = guard
            .as_ref()
            .map(|c| {
                c.roots
                    .iter()
                    .map(|r| (r.id.clone(), r.commit.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        if let Some(raw) = guard.as_ref().and_then(|c| c.raw.clone()) {
            for g in raw
                .get("gears")
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(|m| m.values())
            {
                if let Some(src) = g.get("source").and_then(Value::as_str) {
                    *counts.entry(src.to_string()).or_default() += 1;
                }
            }
        }
        view.roots
            .into_iter()
            .map(|root| ReadRoot {
                commit: commits.get(&root.id).cloned().flatten(),
                gears: counts.get(&root.id).copied().unwrap_or(0),
                root,
            })
            .collect()
    }

    /// `gearbox --version` with the engine's commit, asked once per process.
    /// A failed run is not remembered, so the next status asks again.
    async fn engine_version(&self) -> Option<String> {
        if let Some(v) = self.version.get() {
            return Some(v.clone());
        }
        let bin = self.cfg.bin.clone();
        let version =
            tokio::task::spawn_blocking(move || run_engine(&bin, &["--version".into()], None).ok())
                .await
                .ok()
                .flatten()
                .filter(|o| o.success)
                .map(|o| with_revision(o.stdout.trim(), engine_revision().as_deref()))?;
        Some(self.version.get_or_init(|| version).clone())
    }

    pub async fn status(&self, scope: Scope) -> GearboxStatus {
        let version = self.engine_version().await;
        let (commit, problem) = match self.ensure_corpus(scope).await {
            Ok((_, commit, _)) => (commit, None),
            Err(e) => (None, Some(format!("{e:#}"))),
        };
        let shadowed = self.view(scope).shadowed;
        let read = self.read_roots(scope).await;
        let sources = read
            .iter()
            .map(|r| SourceStatus {
                source_id: r.root.id.clone(),
                repo: repo_key(&r.root.source.url),
                git_ref: r.root.source.git_ref.clone(),
                commit: r.commit.clone(),
                gears: r.gears,
                connection_id: r.root.connection_id,
                tier: if r.root.organization {
                    "organization"
                } else {
                    "platform"
                },
            })
            .collect();
        let first = read.first().map(|r| r.root.source.clone());
        GearboxStatus {
            problem: if version.is_none() {
                Some(format!(
                    "the Gearbox engine `{}` did not run",
                    self.cfg.bin.display()
                ))
            } else {
                problem
            },
            engine_version: version,
            corpus_url: first.as_ref().map(|s| s.url.clone()).unwrap_or_default(),
            corpus_ref: first.map(|s| s.git_ref).unwrap_or_default(),
            corpus_commit: commit,
            sources,
            shadowed,
        }
    }

    /// `scope`'s roots checked out and their catalogue, loaded once per set of
    /// commits. Returns each root's id and directory, the first root's
    /// commit, and the catalogue.
    async fn ensure_corpus(
        &self,
        scope: Scope,
    ) -> anyhow::Result<(Vec<(String, PathBuf)>, Option<String>, Arc<EngineCatalogue>)> {
        let loaded = self.ensure(scope).await?;
        Ok((loaded.named(), loaded.commit(), loaded.catalogue))
    }

    /// `scope`'s corpus as a request reads it.
    ///
    /// A corpus of the roots asked for is served as it is, even past its
    /// refresh period: then it is refreshed on a task of its own (one at a
    /// time per scope) and the next request reads the refreshed one. Only a
    /// scope with nothing to serve yet -- never read, its roots changed, or
    /// its catalogue not loaded -- waits for the fetch and the engine. On
    /// studio-dev a request that found the corpus stale paid for every
    /// root's fetch, one after another, and maybe a catalogue: 6.6 s on
    /// average for the status page.
    async fn ensure(&self, scope: Scope) -> anyhow::Result<Loaded> {
        let view = self.view(scope);
        let (wanted, generation) = (view.roots, view.generation);
        if wanted.is_empty() {
            bail!(
                "no gear repository: the platform has none connected, and the deployment names \
                 no corpus (STUDIO_GEARBOX_CORPUS_URL)"
            );
        }
        let cell = self.cell(view.scope);
        {
            let guard = cell.corpus.lock().await;
            if let Some(corpus) = guard.as_ref().filter(|c| c.generation == generation)
                && let Some(loaded) = corpus.loaded()
            {
                if corpus.refreshed.elapsed() >= self.cfg.refresh {
                    self.refresh_in_background(Arc::clone(&cell), wanted, generation);
                }
                return Ok(loaded);
            }
        }
        let _syncing = cell.sync.lock().await;
        // Another request may have brought it in while this one waited.
        if let Some(loaded) = cell
            .corpus
            .lock()
            .await
            .as_ref()
            .filter(|c| c.generation == generation)
            .and_then(Corpus::loaded)
        {
            return Ok(loaded);
        }
        self.syncer().sync(&cell, &wanted, generation, true).await
    }

    /// Refresh `cell` on a task of its own, unless a refresh of it is running
    /// already. A failed refresh keeps the corpus there is and tries again
    /// after another refresh period, rather than on every request.
    fn refresh_in_background(
        &self,
        cell: Arc<ScopeCell>,
        wanted: Vec<GearRoot>,
        generation: (u64, u64),
    ) {
        let syncer = self.syncer();
        tokio::spawn(async move {
            let Ok(_syncing) = cell.sync.try_lock() else {
                return;
            };
            let due = cell.corpus.lock().await.as_ref().is_none_or(|c| {
                c.generation != generation || c.refreshed.elapsed() >= syncer.refresh
            });
            if !due {
                return;
            }
            let started = Instant::now();
            match syncer.sync(&cell, &wanted, generation, false).await {
                Ok(_) => tracing::info!(
                    elapsed_ms = started.elapsed().as_millis(),
                    "gearbox: corpus refreshed in the background"
                ),
                Err(e) => {
                    warn!(error = %format!("{e:#}"), "gearbox: background corpus refresh failed; serving the last one");
                    if let Some(c) = cell
                        .corpus
                        .lock()
                        .await
                        .as_mut()
                        .filter(|c| c.generation == generation)
                    {
                        c.refreshed = Instant::now();
                    }
                }
            }
        });
    }

    /// The corpus's catalogue as the engine printed it (`gearbox catalogue
    /// --format json`), and the first root's commit. One checkout serves every
    /// project, so an IDE lists the gears without cloning the corpus.
    pub async fn catalogue_json(
        &self,
        scope: Scope,
    ) -> anyhow::Result<(Arc<Value>, Option<String>)> {
        let loaded = self.ensure(scope).await?;
        let commit = loaded.commit();
        Ok((loaded.raw, commit))
    }

    /// The facts an explanation of the gear `name` is written from, with its
    /// crate's README from the checkout. `None` for a gear the corpus does
    /// not describe. The platform's corpus: an explanation is the
    /// platform's, shared by every organization.
    pub async fn gear_brief(
        &self,
        name: &str,
    ) -> anyhow::Result<Option<super::explanations::GearBrief>> {
        let (roots, _, catalogue) = self.ensure_corpus(None).await?;
        let (raw, _) = self.catalogue_json(None).await?;
        let Some(mut brief) = gear_brief(&catalogue, &raw, name) else {
            return Ok(None);
        };
        if let Some(path) = brief.path.clone() {
            // The catalogue does not say which repository a gear came from,
            // so the README is looked for under each root in turn.
            brief.readme = tokio::task::spawn_blocking(move || {
                roots.iter().find_map(|(_, dir)| {
                    read_readme(dir, &path, super::explanations::MAX_README_BYTES)
                })
            })
            .await
            .ok()
            .flatten();
        }
        Ok(Some(brief))
    }

    /// [`complete`] against `scope`'s corpus.
    pub async fn complete(
        &self,
        scope: Scope,
        picked: &[String],
        config: &GearConfig,
    ) -> anyhow::Result<Completion> {
        let (_, _, catalogue) = self.ensure_corpus(scope).await?;
        Ok(complete(&catalogue, picked, config))
    }

    /// [`brings`] against `scope`'s corpus.
    pub async fn brings(
        &self,
        scope: Scope,
        current: &[String],
        candidate: &str,
        config: &GearConfig,
    ) -> anyhow::Result<Brings> {
        let (_, _, catalogue) = self.ensure_corpus(scope).await?;
        Ok(brings(&catalogue, current, candidate, config))
    }

    /// [`config_schemas`] against `scope`'s corpus.
    pub async fn config_schemas(
        &self,
        scope: Scope,
        names: &[String],
    ) -> anyhow::Result<Vec<GearConfigSchema>> {
        let (_, _, catalogue) = self.ensure_corpus(scope).await?;
        Ok(config_schemas(&catalogue, names))
    }

    /// The extension points a new plugin gear can fill, one per host.
    pub async fn extension_points(&self, scope: Scope) -> anyhow::Result<Vec<HostPoint>> {
        let (_, _, catalogue) = self.ensure_corpus(scope).await?;
        Ok(host_points(&catalogue))
    }

    /// The `gear.gdl` the engine writes for a new gear, from its own
    /// scaffold, so a gear Studio creates is described the way Gearbox Studio
    /// describes one. Dry run: nothing is written; the text is returned.
    pub async fn scaffold_gdl(&self, spec: GearScaffold) -> anyhow::Result<String> {
        let bin = self.cfg.bin.clone();
        let scratch =
            std::env::temp_dir().join(format!("studio-gearbox-scaffold-{}", uuid::Uuid::new_v4()));
        let result = tokio::task::spawn_blocking(move || {
            // **An empty root, named for the corpus, not the corpus checkout.**
            // The RPC takes a root's source id from its directory's name, and
            // the checkout lives at `gearbox__gears_rust` (`clone_or_update`'s
            // layout), which is not a valid id -- the engine refused every
            // scaffold with "no source root is open". The CLI calls pass
            // `--source-id`; the RPC has no such parameter. Nor does the
            // scaffold read the corpus: the host's spec, trait and SDK arrive
            // in the params, taken from the catalogue.
            let root = scratch.join(CORPUS_SOURCE_ID);
            std::fs::create_dir_all(&root)?;
            let params = serde_json::json!({
                "id": spec.crate_name,
                "name": spec.name,
                "version": "0.1.0",
                "kind": spec.kind.as_str(),
                "plugin": spec.plugin.as_ref().map(|p| serde_json::json!({
                    "spec": p.spec,
                    "trait_ident": p.trait_ident,
                    "crate_name": p.crate_name,
                    "lib_ident": p.lib_ident,
                    "path": p.path,
                })),
                "destination_dir": scratch.join("gear").to_string_lossy(),
                "dry_run": true,
            });
            let answer = rpc_once(&bin, &root, &scratch, "gearbox/gear/scaffold", params);
            let _ = std::fs::remove_dir_all(&scratch);
            answer
        })
        .await
        .context("scaffold task")??;
        answer_gdl(&result)
    }

    pub async fn preview(&self, scope: Scope, input: PreviewInput) -> anyhow::Result<Preview> {
        if !is_kebab_id(&input.product_id) {
            bail!(
                "product id `{}` is not a kebab-case id (lowercase letters, digits, single hyphens)",
                input.product_id
            );
        }
        if !PROFILES.contains(&input.profile.as_str()) {
            bail!(
                "profile `{}` is not one of {}",
                input.profile,
                PROFILES.join(", ")
            );
        }
        let started = Instant::now();
        let loaded = self.ensure(scope).await?;
        let corpus_ms = started.elapsed().as_millis();
        let (named, commit, catalogue) = (loaded.named(), loaded.commit(), &loaded.catalogue);
        let composition = compose(catalogue, &input.gears);
        // Each root at the commit it was read at, so the description says by
        // itself what it was built from.
        let read = self.read_roots(scope).await;
        let gear_source: BTreeMap<String, String> = catalogue
            .gears
            .values()
            .filter_map(|g| g.source.clone().map(|s| (g.id.clone(), s)))
            .collect();
        // A project's own root (inside its repository) is this product's
        // source only when one of its gears is in it: another project's
        // directory means nothing beside this file.
        let used: BTreeSet<&str> = composition
            .gears
            .iter()
            .flat_map(|g| std::iter::once(&g.id).chain(&g.plugins))
            .filter_map(|id| gear_source.get(id).map(String::as_str))
            .collect();
        let pins: Vec<SourcePin<'_>> = read
            .iter()
            .filter(|r| r.root.subdir.is_none() || used.contains(r.root.id.as_str()))
            .map(|r| SourcePin {
                id: &r.root.id,
                url: &r.root.source.url,
                rev: r.commit.as_deref(),
                within: within_product_repo(
                    r.root.subdir.as_deref(),
                    &r.root.source.url,
                    input.repo.as_deref(),
                ),
            })
            .collect();
        // Config arrives keyed as the picks are (crate names); the description
        // names gears by engine id.
        let by_id: BTreeMap<String, serde_json::Map<String, Value>> = input
            .config
            .iter()
            .filter_map(|(k, v)| catalogue.find(k).map(|g| (g.id.clone(), v.clone())))
            .collect();
        if !is_product_path(&input.product_path) {
            bail!(
                "`{}` is not a place for a product description: a relative path to a `product.gdl`",
                input.product_path
            );
        }
        let product_gdl = render_product_gdl_from(
            &input.product_id,
            &input.product_path,
            &input.name,
            &composition,
            &input.profile,
            &pins,
            &gear_source,
            &by_id,
        );
        // A product at its project's birth names no gears yet. There is nothing
        // for the engine to resolve, and the description is still the file the
        // project starts from: picking gears later rewrites it.
        if input.gears.is_empty() {
            return Ok(Preview {
                product_gdl,
                composition,
                resolution: Resolution::default(),
                corpus_commit: commit,
            });
        }

        let key = input
            .reuse
            .then(|| {
                evaluation_key(
                    scope,
                    &loaded.roots,
                    &input.product_id,
                    &input.product_path,
                    &input.profile,
                    &product_gdl,
                )
            })
            .flatten();
        let started = Instant::now();
        let kept = key.as_ref().and_then(|k| {
            self.evaluations
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(k)
        });
        let reused = kept.is_some();
        let resolution = match kept {
            Some(r) => r,
            None => {
                let bin = self.cfg.bin.clone();
                let gdl = product_gdl.clone();
                let product_id = input.product_id.clone();
                let product_path = input.product_path.clone();
                let profile = input.profile.clone();
                let r = tokio::task::spawn_blocking(move || {
                    evaluate(&bin, &named, &product_id, &product_path, &gdl, &profile)
                })
                .await
                .context("engine task")??;
                if let Some(k) = key {
                    self.evaluations
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .put(k, r.clone());
                }
                r
            }
        };
        tracing::info!(
            corpus_ms,
            evaluate_ms = started.elapsed().as_millis(),
            reused,
            gears = input.gears.len(),
            "gearbox: preview evaluated"
        );
        Ok(Preview {
            product_gdl,
            composition,
            resolution,
            corpus_commit: commit,
        })
    }
}

/// Where the image records the engine's commit: the `gearbox` stage writes it
/// beside the binary it downloads (the release's commit), because
/// `gearbox --version` says only the crate's version, which has stayed `0.1.0`
/// across every commit.
const ENGINE_REVISION_FILE: &str = "/usr/local/share/gearbox/REVISION";

/// The engine's commit: `STUDIO_GEARBOX_REV`, else the image's record.
fn engine_revision() -> Option<String> {
    std::env::var("STUDIO_GEARBOX_REV")
        .ok()
        .or_else(|| std::fs::read_to_string(ENGINE_REVISION_FILE).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The engine's repository and commit, for a pipeline that builds a product
/// with the engine this Studio runs (ADR-0048 §5): `STUDIO_GEARBOX_REPO`
/// (the images' build argument) and [`engine_revision`].
pub fn engine_pin() -> (String, Option<String>) {
    let repo = std::env::var("STUDIO_GEARBOX_REPO")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://github.com/constructorfabric/gearbox".to_owned());
    (repo, engine_revision())
}

/// `gearbox 0.1.0` with its commit: `gearbox 0.1.0-ea964f9`, so two images
/// with the same crate version say which engine each runs.
fn with_revision(version: &str, revision: Option<&str>) -> String {
    match revision {
        Some(rev) if !version.contains(&rev[..rev.len().min(7)]) => {
            format!("{version}-{}", &rev[..rev.len().min(7)])
        }
        _ => version.to_string(),
    }
}

/// A relative path to a `product.gdl` that stays inside the repository: no
/// leading `/`, no `.` or `..` segment, no backslash.
pub(crate) fn is_product_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    segments.last() == Some(&"product.gdl")
        && !path.contains('\\')
        && segments
            .iter()
            .all(|s| !s.is_empty() && *s != "." && *s != "..")
}

/// Lay the description out the way a session workspace does — the project's
/// repository, with the description at `product_path` in it, beside a
/// directory per gear repository, named by its source id — then validate and,
/// if that is clean, resolve. A diagnostic's file is `<source id>/<path>`.
/// The two runs go side by side, each reading the corpus on its own: the
/// answer is the one the sequence gave -- validation's errors alone when it
/// has any, the resolve's output discarded unread -- in about half the time.
/// Blocking.
fn evaluate(
    bin: &Path,
    roots: &[(String, PathBuf)],
    product_id: &str,
    product_path: &str,
    gdl: &str,
    profile: &str,
) -> anyhow::Result<Resolution> {
    let scratch = std::env::temp_dir().join(format!("studio-gearbox-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let product_file = scratch.join(product_id).join(product_path);
        if let Some(dir) = product_file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut root_args: Vec<String> = Vec::new();
        for (id, dir) in roots {
            let link = scratch.join(id);
            link_dir(dir, &link)?;
            root_args.push("--root".into());
            root_args.push(link.to_string_lossy().into_owned());
        }
        std::fs::write(&product_file, gdl)?;
        let product = product_file.to_string_lossy().into_owned();

        let mut args: Vec<String> = vec!["validate".into()];
        args.extend(root_args.iter().cloned());
        args.extend([
            "--product".into(),
            product.clone(),
            "--format".into(),
            "json".into(),
        ]);
        let mut resolve_args: Vec<String> = vec!["resolve".into()];
        resolve_args.extend(root_args);
        resolve_args.extend([
            "--product".into(),
            product,
            "--profile".into(),
            profile.into(),
            "--format".into(),
            "json".into(),
        ]);
        // One engine run at a time: both work in `scratch`, and two at once
        // double the engine's peak memory inside the backend's own limit.
        let validate = run_engine(bin, &args, Some(&scratch))?;
        let parsed: Value = serde_json::from_str(&validate.stdout).with_context(|| {
            format!(
                "the engine's validation is not JSON: {}",
                validate.stderr_tail()
            )
        })?;
        let diagnostics = parse_diagnostics(&parsed, &scratch);
        let diagnostics = relabel(diagnostics);
        if diagnostics.iter().any(EngineDiagnostic::is_error) {
            return Ok(Resolution {
                diagnostics,
                ..Resolution::default()
            });
        }

        let resolve = run_engine(bin, &resolve_args, Some(&scratch))?;
        let parsed: Value = serde_json::from_str(&resolve.stdout).with_context(|| {
            format!(
                "the engine's resolution is not JSON: {}",
                resolve.stderr_tail()
            )
        })?;
        let mut resolution = parse_resolution(&parsed, &scratch);
        let mut all = diagnostics;
        all.extend(relabel(resolution.diagnostics));
        resolution.diagnostics = all;
        Ok(resolution)
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

/// The scratch product file is `<id>/product.gdl`; the person knows it as the
/// `product.gdl` at the root of their repository.
fn relabel(diagnostics: Vec<EngineDiagnostic>) -> Vec<EngineDiagnostic> {
    diagnostics
        .into_iter()
        .map(|mut d| {
            if d.file
                .as_deref()
                .is_some_and(|f| f.ends_with("product.gdl"))
            {
                d.file = Some("product.gdl".into());
            }
            d
        })
        .collect()
}

#[cfg(unix)]
fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

struct EngineOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

impl EngineOutput {
    fn stderr_tail(&self) -> String {
        let t = self.stderr.trim();
        let skip = t.chars().count().saturating_sub(400);
        t.chars().skip(skip).collect()
    }
}

/// Run the engine with a deadline. Blocking. A non-zero exit is not an error
/// here: `validate` exits 1 exactly when it has something to say.
fn run_engine(bin: &Path, args: &[String], cwd: Option<&Path>) -> anyhow::Result<EngineOutput> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| anyhow!("cannot run the Gearbox engine `{}`: {e}", bin.display()))?;
    // Drain both pipes on their own threads so a large catalogue cannot fill
    // one while this waits on the other.
    let mut out_pipe = child.stdout.take().expect("stdout is piped");
    let mut err_pipe = child.stderr.take().expect("stderr is piped");
    let out_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out_pipe.read_to_string(&mut s);
        s
    });
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err_pipe.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + ENGINE_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "the Gearbox engine did not answer within {}s",
                ENGINE_TIMEOUT.as_secs()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Ok(EngineOutput {
        success: status.success(),
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}

/// Whether `plugin` fills `point`: by the point's GTS spec when both sides
/// state one -- two points can share an SDK crate, and only their specs tell
/// them apart -- else by the SDK crate the point lives in.
fn fills_point(plugin: &EngineGear, point: &EnginePoint) -> bool {
    let Some(f) = plugin.fills.as_ref() else {
        return false;
    };
    match (f.spec(), point.spec.as_deref()) {
        (Some(a), Some(b)) => a == b,
        _ => f
            .point
            .as_ref()
            .is_some_and(|p| p.sdk.crate_name == point.sdk.crate_name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_plugin_is_read_under_the_engines_new_name_too() {
        let gear: EngineGear = serde_json::from_value(json!({
            "id": "static-authn-plugin",
            "package": {"crate_name": "cf-gears-static-authn-plugin"},
            "implements": {
                "spec": "cf.core.authn_resolver.plugin.v1~",
                "point": {"sdk": {"crate_name": "cf-gears-authn-resolver-sdk"}},
                "default_vendor": "constructorfabric"
            }
        }))
        .expect("an engine gear with `implements` deserializes");
        let point = gear
            .fills
            .expect("`implements` is the plugin's point")
            .point
            .expect("the host's declaration is carried");
        assert_eq!(point.sdk.crate_name, "cf-gears-authn-resolver-sdk");
    }

    #[test]
    fn a_plugin_no_host_declares_does_not_fail_the_catalogue() {
        // The engine omits `point` when no gear declares the spec (GBX0519).
        let catalogue: EngineCatalogue = serde_json::from_value(json!({
            "gears": {
                "orphan-plugin": {
                    "id": "orphan-plugin",
                    "package": {"crate_name": "cf-gears-orphan-plugin"},
                    "implements": {"spec": "gts.x.core.orphan.plugin.v1~"}
                }
            }
        }))
        .expect("a plugin without the host's declaration deserializes");
        let gear = &catalogue.gears["orphan-plugin"];
        assert_eq!(
            gear.contracts(),
            vec!["gts.x.core.orphan.plugin.v1~".to_string()]
        );
        assert!(catalogue.host_of(gear).is_none());
    }

    #[test]
    fn a_root_the_engine_cannot_read_is_named_not_dropped() {
        // The pinned engine over a corpus moved to a newer GDL: every
        // gear.gdl refused, no gear from it, the project's own gears still read.
        let diag = |file: &str| {
            json!({
                "code": "GBX0102",
                "severity": "error",
                "message": "Variable `git` not found, did you mean `dict`?",
                "location": {"uri": format!("file:///var/lib/studio/gearbox/gears-rust/{file}/gear.gdl")}
            })
        };
        let catalogue: EngineCatalogue = serde_json::from_value(json!({
            "gears": {
                "studio-authz-plugin": {
                    "id": "studio-authz-plugin",
                    "package": {"crate_name": "studio-authz-plugin"},
                    "source": "studio-web"
                }
            },
            "diagnostics": [diag("gears/a"), diag("gears/b")]
        }))
        .expect("a catalogue with diagnostics deserializes");
        let roots = vec![
            (
                "gears-rust".to_string(),
                PathBuf::from("/var/lib/studio/gearbox/gears-rust"),
            ),
            (
                "studio-web".to_string(),
                PathBuf::from("/var/lib/studio/gearbox/studio-web"),
            ),
        ];
        let why = catalogue
            .unreadable_root(&roots)
            .expect("the corpus root is reported");
        assert!(why.contains("`gears-rust`"), "{why}");
        assert!(why.contains("GBX0102 \u{d7}2"), "{why}");

        // A root with no gears and no errors (a project without gear.gdl) is fine.
        let quiet: EngineCatalogue = serde_json::from_value(json!({"gears": {}})).unwrap();
        assert!(quiet.unreadable_root(&roots).is_none());
    }

    /// What the pinned engine (6d60603f) prints over gears-rust in GDL 1.0
    /// and this repository's own gear.gdl files, trimmed to a host and a
    /// plugin from each root and one design: the shape grew (`sdks`,
    /// `origin`, `implementation`, `scenarios`), and none of it may stop the
    /// catalogue from reading or a plugin from finding its host.
    #[test]
    fn a_gdl_1_0_catalogue_reads_and_its_plugins_find_their_hosts() {
        let raw: Value = serde_json::from_str(include_str!("testdata/catalogue-gdl-1.0.json"))
            .expect("the fixture is JSON");
        let catalogue: EngineCatalogue =
            serde_json::from_value(raw).expect("the GDL 1.0 catalogue deserializes");
        for (plugin, host) in [
            ("static-tr-plugin", "tenant-resolver"),
            ("github-connector-plugin", "studio-connector"),
        ] {
            let found = catalogue
                .host_of(&catalogue.gears[plugin])
                .map(|g| g.id.as_str());
            assert_eq!(found, Some(host), "{plugin}");
        }
        assert_eq!(
            catalogue.implementers_of(&catalogue.gears["tenant-resolver"]),
            ["cf-gears-static-tr-plugin"]
        );
        let roots = vec![
            (
                "gears-rust".to_string(),
                PathBuf::from("/corpus/gears-rust"),
            ),
            (
                "studio-backend".to_string(),
                PathBuf::from("/corpus/studio-backend"),
            ),
        ];
        assert!(catalogue.unreadable_root(&roots).is_none());

        // The same output with one root's gears gone and the engine's own
        // diagnostic for it, as 6d60603f prints one (`location.uri` under the
        // root): that root is named, the other is not.
        let mut raw: Value = serde_json::from_str(include_str!("testdata/catalogue-gdl-1.0.json"))
            .expect("the fixture is JSON");
        let gears = raw["gears"].as_object_mut().expect("gears is a map");
        gears.retain(|_, g| g["source"] == "gears-rust");
        raw["diagnostics"] = json!([{
            "code": "GBX0519",
            "severity": "error",
            "message": "`postgres-usage-collector-plugin` implements `cf.core.uc.plugin.v1~`, which no described gear declares as an extension point",
            "location": {
                "uri": "file:///corpus/studio-backend/plugins/postgres-usage-collector-plugin/gear.gdl",
                "range": {"start": {"line": 7, "character": 0}, "end": {"line": 19, "character": 1}}
            }
        }]);
        let half: EngineCatalogue = serde_json::from_value(raw).expect("still the shape");
        let why = half
            .unreadable_root(&roots)
            .expect("the root with no gears and an error is named");
        assert!(why.contains("`studio-backend`"), "{why}");
        assert!(why.contains("GBX0519 \u{d7}1"), "{why}");
    }

    /// The corpus shape that matters: a host with an extension point, two
    /// plugins filling it, and a gear that is neither.
    fn catalogue() -> EngineCatalogue {
        serde_json::from_value(json!({
            "gears": {
                "api-gateway": {"id": "api-gateway", "package": {"crate_name": "cf-gears-api-gateway"}},
                "authn-resolver": {
                    "id": "authn-resolver",
                    "package": {"crate_name": "cf-gears-authn-resolver"},
                    "extension_points": [{"sdk": {"crate_name": "cf-gears-authn-resolver-sdk"}}]
                },
                "static-authn-plugin": {
                    "id": "static-authn-plugin",
                    "package": {"crate_name": "cf-gears-static-authn-plugin"},
                    "fills": {"point": {"sdk": {"crate_name": "cf-gears-authn-resolver-sdk"}}}
                },
                "oidc-authn-plugin": {
                    "id": "oidc-authn-plugin",
                    "package": {"crate_name": "cf-gears-oidc-authn-plugin"},
                    "fills": {"point": {"sdk": {"crate_name": "cf-gears-authn-resolver-sdk"}}}
                },
                "credstore": {
                    "id": "credstore",
                    "package": {"crate_name": "cf-gears-credstore"},
                    "fills": {"point": {"sdk": {"crate_name": "cf-gears-credstore-sdk"}}}
                }
            }
        }))
        .expect("catalogue fixture parses")
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn a_brief_says_what_the_catalogue_proves_in_a_person_s_names() {
        let raw = json!({"gears": {
            "authn-resolver": {"display_name": "Sign-in", "description": " ", "category": "security"},
            "static-authn-plugin": {"display_name": "Static sign-in", "maturity": "beta"}
        }});
        let c = catalogue();
        let host = gear_brief(&c, &raw, "cf-gears-authn-resolver").expect("found by crate");
        assert_eq!(host.id, "authn-resolver");
        assert_eq!(host.display_name.as_deref(), Some("Sign-in"));
        // A blank description is none.
        assert_eq!(host.description, None);
        assert_eq!(host.category.as_deref(), Some("security"));
        assert_eq!(host.points, names(&["cf-gears-authn-resolver-sdk"]));
        let mut plugins = host.plugins.clone();
        plugins.sort();
        assert_eq!(
            plugins,
            names(&["Static sign-in", "cf-gears-oidc-authn-plugin"])
        );
        assert_eq!(host.host, None);

        let plugin = gear_brief(&c, &raw, "static-authn-plugin").expect("found by id");
        assert_eq!(plugin.host.as_deref(), Some("Sign-in"));
        assert_eq!(plugin.maturity.as_deref(), Some("beta"));
        assert!(gear_brief(&c, &raw, "nothing").is_none());
    }

    #[test]
    fn a_readme_is_never_read_from_outside_the_corpus() {
        let dir = Path::new("/no-such-corpus");
        assert_eq!(read_readme(dir, "../etc", 100), None);
        assert_eq!(read_readme(dir, "/etc", 100), None);
        assert_eq!(read_readme(dir, "gears/x/Cargo.toml", 100), None);
    }

    /// A product with an audit store, and a candidate that brings its own.
    fn audited() -> EngineCatalogue {
        serde_json::from_value(json!({"gears": {
            "audit": {"id": "audit", "package": {"crate_name": "cf-gears-audit"},
                      "provides": [{"contract": "audit/AuditLog@v1"}], "runtime_caps": ["db"]},
            "billing": {"id": "billing", "package": {"crate_name": "cf-gears-billing"},
                        "colocated_deps": ["billing-audit"]},
            "billing-audit": {"id": "billing-audit", "package": {"crate_name": "cf-gears-billing-audit"},
                              "provides": [{"contract": "audit/AuditLog@v1"}], "runtime_caps": ["db"]},
            "authn-resolver": {"id": "authn-resolver", "package": {"crate_name": "cf-gears-authn-resolver"},
                               "extension_points": [{"sdk": {"crate_name": "authn-sdk"}}]},
            "static-authn-plugin": {"id": "static-authn-plugin",
                                    "package": {"crate_name": "cf-gears-static-authn-plugin"},
                                    "fills": {"point": {"sdk": {"crate_name": "authn-sdk"}}}}
        }}))
        .expect("audited fixture parses")
    }

    #[test]
    fn a_candidate_shows_what_comes_with_it_and_the_contract_it_doubles() {
        let b = brings(
            &audited(),
            &names(&["cf-gears-audit"]),
            "cf-gears-billing",
            &GearConfig::new(),
        );
        assert!(b.described);
        let gears: Vec<&str> = b.brought.iter().map(|g| g.gear.as_str()).collect();
        assert_eq!(gears, ["cf-gears-billing", "cf-gears-billing-audit"]);
        assert_eq!(b.brought[0].reason, "the gear you picked");
        assert_eq!(b.brought[1].reason, "cf-gears-billing must run with it");
        assert!(b.brought[1].database);
        assert_eq!(
            b.overlaps,
            vec![Overlap {
                contract: "audit/AuditLog@v1".into(),
                already: vec!["cf-gears-audit".into()],
                brought: vec!["cf-gears-billing-audit".into()],
            }]
        );
    }

    /// #744: two gears the candidate brings that provide one contract are an
    /// overlap too, with nothing of it in the product yet.
    #[test]
    fn two_gears_a_candidate_brings_for_one_contract_overlap() {
        let catalogue: EngineCatalogue = serde_json::from_value(json!({"gears": {
            "ledger": {"id": "ledger", "package": {"crate_name": "cf-gears-ledger"},
                       "provides": [{"contract": "audit/AuditLog@v1"}],
                       "colocated_deps": ["ledger-audit"]},
            "ledger-audit": {"id": "ledger-audit", "package": {"crate_name": "cf-gears-ledger-audit"},
                             "provides": [{"contract": "audit/AuditLog@v1"}]}
        }}))
        .expect("fixture parses");
        let b = brings(&catalogue, &[], "cf-gears-ledger", &GearConfig::new());
        assert_eq!(
            b.overlaps,
            vec![Overlap {
                contract: "audit/AuditLog@v1".into(),
                already: vec![],
                brought: vec!["cf-gears-ledger".into(), "cf-gears-ledger-audit".into()],
            }]
        );
    }

    #[test]
    fn a_plugin_brings_its_host_and_nothing_already_there_is_new() {
        let b = brings(&audited(), &[], "static-authn-plugin", &GearConfig::new());
        let gears: Vec<&str> = b.brought.iter().map(|g| g.gear.as_str()).collect();
        assert_eq!(
            gears,
            ["cf-gears-static-authn-plugin", "cf-gears-authn-resolver"]
        );
        assert_eq!(
            b.brought[1].reason,
            "hosts the extension point cf-gears-static-authn-plugin fills"
        );
        let again = brings(
            &audited(),
            &names(&["cf-gears-billing"]),
            "cf-gears-billing-audit",
            &GearConfig::new(),
        );
        assert!(again.brought.is_empty());
        assert!(again.overlaps.is_empty());
    }

    #[test]
    fn an_undescribed_candidate_brings_nothing() {
        let b = brings(&audited(), &[], "cf-gears-nowhere", &GearConfig::new());
        assert!(!b.described);
        assert!(b.brought.is_empty());
    }

    #[test]
    fn crate_names_and_engine_ids_both_select_a_gear() {
        let c = compose(
            &catalogue(),
            &names(&["cf-gears-api-gateway", "authn-resolver"]),
        );
        let ids: Vec<&str> = c.gears.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["api-gateway", "authn-resolver"]);
        assert!(c.not_described.is_empty());
    }

    /// mini-chat as the corpus has it: its two static plugins live in its
    /// own crate, and both of its points in one SDK.
    fn mini_chat() -> EngineCatalogue {
        let point =
            |spec: &str| json!({"spec": spec, "sdk": {"crate_name": "cf-gears-mini-chat-sdk"}});
        let plugin = |id: &str, spec: &str| json!({"id": id, "package": {"crate_name": "cf-gears-mini-chat"}, "fills": {"point": point(spec)}});
        serde_json::from_value(json!({"gears": {
            "mini-chat": {"id": "mini-chat", "package": {"crate_name": "cf-gears-mini-chat"},
                          "extension_points": [point("audit~"), point("model_policy~")]},
            "static-mini-chat-audit-plugin": plugin("static-mini-chat-audit-plugin", "audit~"),
            "static-mini-chat-model-policy-plugin": plugin("static-mini-chat-model-policy-plugin", "model_policy~"),
        }}))
        .unwrap()
    }

    #[test]
    fn a_crate_shared_by_a_host_and_its_plugins_names_the_host_and_each_point_gets_its_plugin() {
        let cat = mini_chat();
        assert_eq!(cat.find("cf-gears-mini-chat").unwrap().id, "mini-chat");
        let done = complete(
            &cat,
            &names(&["cf-gears-mini-chat"]),
            &GearConfig::default(),
        );
        assert_eq!(
            done.gears,
            [
                "cf-gears-mini-chat",
                "static-mini-chat-audit-plugin",
                "static-mini-chat-model-policy-plugin"
            ]
        );
        let c = compose(&cat, &done.gears);
        assert_eq!(c.gears.len(), 1);
        assert_eq!(
            c.gears[0].plugins,
            [
                "static-mini-chat-audit-plugin",
                "static-mini-chat-model-policy-plugin"
            ]
        );
        assert!(c.plugin_options.is_empty());
    }

    #[test]
    fn a_plugin_goes_under_its_host_and_brings_the_host_when_missing() {
        let c = compose(&catalogue(), &names(&["cf-gears-static-authn-plugin"]));
        assert_eq!(
            c.gears,
            vec![GearUse {
                id: "authn-resolver".into(),
                plugins: vec!["static-authn-plugin".into()],
            }]
        );
        assert_eq!(
            c.added_hosts,
            vec![(
                "authn-resolver".to_string(),
                "static-authn-plugin".to_string()
            )]
        );
    }

    #[test]
    fn a_picked_host_is_not_reported_as_added() {
        let c = compose(
            &catalogue(),
            &names(&[
                "cf-gears-oidc-authn-plugin",
                "cf-gears-authn-resolver",
                "static-authn-plugin",
            ]),
        );
        assert_eq!(c.gears.len(), 1);
        assert_eq!(
            c.gears[0].plugins,
            ["oidc-authn-plugin", "static-authn-plugin"]
        );
        assert!(c.added_hosts.is_empty());
    }

    /// The shape of the real corpus on feature/gearbox, cut down to what
    /// completion reasons about.
    fn corpus() -> EngineCatalogue {
        let point = |sdk: &str| json!({"sdk": {"crate_name": sdk}});
        let plugin = |id: &str, sdk: &str, prio: i64, deps: &[&str]| {
            json!({"id": id, "package": {"crate_name": format!("cf-gears-{id}")},
                   "fills": {"point": point(sdk), "default_priority": prio}, "colocated_deps": deps})
        };
        serde_json::from_value(json!({"gears": {
            "types-registry": {"id": "types-registry", "package": {"crate_name": "cf-gears-types-registry"},
                               "runtime_caps": ["db", "rest", "system"]},
            "authn-resolver": {"id": "authn-resolver", "package": {"crate_name": "cf-gears-authn-resolver"},
                               "extension_points": [point("authn-sdk")], "colocated_deps": ["types-registry"]},
            "oidc-authn-plugin": plugin("oidc-authn-plugin", "authn-sdk", 100, &["authn-resolver"]),
            "static-authn-plugin": plugin("static-authn-plugin", "authn-sdk", 100, &["types-registry"]),
            "authz-resolver": {"id": "authz-resolver", "package": {"crate_name": "cf-gears-authz-resolver"},
                               "extension_points": [point("authz-sdk")], "runtime_caps": ["rest"]},
            "resource-group": {"id": "resource-group", "package": {"crate_name": "cf-gears-resource-group"},
                               "colocated_deps": ["authz-resolver"], "runtime_caps": ["rest"]},
            "tenant-resolver": {"id": "tenant-resolver", "package": {"crate_name": "cf-gears-tenant-resolver"},
                                "extension_points": [point("tr-sdk")]},
            "static-tr-plugin": plugin("static-tr-plugin", "tr-sdk", 100, &[]),
            "single-tenant-tr-plugin": plugin("single-tenant-tr-plugin", "tr-sdk", 1000, &[]),
            "rg-tr-plugin": plugin("rg-tr-plugin", "tr-sdk", 50, &["resource-group"]),
            "account-management": plugin("account-management", "idp-sdk", 100, &[]),
            "api-gateway": {"id": "api-gateway", "package": {"crate_name": "cf-gears-api-gateway"},
                            "runtime_caps": ["rest", "rest_host"], "colocated_deps": ["authn-resolver"],
                            "serves": [{"config_key": "bind_addr"}],
                            "config_schema": {"fields": [{"name": "bind_addr", "required": true}]}},
            "event-broker": {"id": "event-broker", "package": {"crate_name": "cf-gears-event-broker"},
                             "config_schema": {"fields": [
                                 {"name": "mode", "required": true, "default": null},
                                 {"name": "retention", "required": true, "default": "7d"},
                                 {"name": "tuning", "required": false}]}}
        }}))
        .expect("corpus fixture parses")
    }

    #[test]
    fn completion_drops_what_cannot_run_and_adds_what_is_missing() {
        let c = complete(
            &corpus(),
            &names(&[
                "cf-gears-types-registry",
                "cf-gears-resource-group",
                "cf-gears-event-broker",
                "cf-gears-account-management",
                "cf-gears-tenant-resolver",
                "cf-gears-ledger",
            ]),
            &GearConfig::new(),
        );
        assert_eq!(
            c.gears,
            [
                "cf-gears-types-registry",
                "cf-gears-tenant-resolver",
                // the host's plugin: rg-tr has the best priority but must run
                // with resource-group, which needs authz-resolver, which
                // nothing in the corpus can plug
                "cf-gears-static-tr-plugin",
                // the REST host, bound through `serves` so `bind_addr` is not
                // a missing field, and it brings authn-resolver along
                "cf-gears-api-gateway",
                // …whose plugin comes a round later; static beats oidc on the tie
                "cf-gears-static-authn-plugin",
            ]
        );
        let why: BTreeMap<&str, (bool, &str)> = c
            .changes
            .iter()
            .map(|ch| (ch.gear.as_str(), (ch.added, ch.reason.as_str())))
            .collect();
        assert!(!why["cf-gears-ledger"].0);
        assert!(
            why["cf-gears-resource-group"]
                .1
                .contains("cf-gears-authz-resolver")
        );
        assert!(why["cf-gears-event-broker"].1.contains("mode"));
        assert!(
            !why["cf-gears-event-broker"].1.contains("retention"),
            "a default is not a missing field"
        );
        assert!(
            why["cf-gears-account-management"]
                .1
                .contains("no gear in the corpus hosts")
        );
        assert!(why["cf-gears-static-tr-plugin"].0);
        assert!(why["cf-gears-api-gateway"].1.contains("REST host"));
    }

    #[test]
    fn facts_say_what_a_gear_is_in_a_composition_and_whether_it_can_run() {
        let f = gear_facts(&corpus(), "acme/gears@main (abc1234)");
        let get = |crate_name: &str, key: &str| {
            f[crate_name][key]["v"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        };
        assert_eq!(get("cf-gears-api-gateway", "gdl"), "yes");
        assert_eq!(get("cf-gears-api-gateway", "gdl_id"), "api-gateway");
        assert_eq!(get("cf-gears-api-gateway", "gdl_caps"), "rest, rest_host");
        assert_eq!(
            get("cf-gears-api-gateway", "gdl_deps"),
            "cf-gears-authn-resolver"
        );
        // Written by generation, so not asked of a person.
        assert_eq!(get("cf-gears-api-gateway", "gdl_config"), "—");
        assert_eq!(get("cf-gears-api-gateway", "gdl_runs"), "yes");
        assert_eq!(
            get("cf-gears-api-gateway", "gdl_corpus"),
            "acme/gears@main (abc1234)"
        );
        assert!(get("cf-gears-tenant-resolver", "gdl_role").starts_with("host; plugins: "));
        assert_eq!(
            get("cf-gears-static-tr-plugin", "gdl_role"),
            "plugin of cf-gears-tenant-resolver"
        );
        assert!(get("cf-gears-authz-resolver", "gdl_role").contains("no plugin"));
        assert_eq!(get("cf-gears-event-broker", "gdl_config"), "mode");
        assert!(get("cf-gears-resource-group", "gdl_runs").contains("cf-gears-authz-resolver"));
        assert_eq!(f["cf-gears-resource-group"]["gdl_runs"]["s"], "bad");
        assert!(
            !f.contains_key("cf-gears-ledger"),
            "no descriptor, no facts"
        );
        // The fixture's points carry no spec and nothing provides a contract.
        assert_eq!(get("cf-gears-tenant-resolver", "gdl_contracts"), "—");
    }

    /// What the composer matches a capability's contracts against, in the
    /// shape `gearbox catalogue --format json` writes at ea964f9.
    #[test]
    fn a_gears_contracts_are_what_it_provides_hosts_and_implements() {
        let catalogue: EngineCatalogue = serde_json::from_value(json!({"gears": {
            "authz-resolver": {
                "id": "authz-resolver",
                "package": {"crate_name": "cf-authz-resolver"},
                "provides": [{"contract": "authz-resolver/AuthZResolverApi@v1",
                              "provider_gear": "authz-resolver", "transports": ["local", "rest"]}],
                "extension_points": [{"sdk": {"crate_name": "cf-authz-resolver-sdk"},
                                      "spec": "cf.toolkit.plugins.plugin.v1~cf.core.authz_resolver.plugin.v1~"}]
            },
            "static-authz-plugin": {
                "id": "static-authz-plugin",
                "package": {"crate_name": "cf-static-authz-plugin"},
                "implements": {"point": {"sdk": {"crate_name": "cf-authz-resolver-sdk"},
                                         "spec": "cf.toolkit.plugins.plugin.v1~cf.core.authz_resolver.plugin.v1~"}}
            }
        }}))
        .expect("the engine's shape deserializes");
        assert_eq!(
            catalogue.gears["authz-resolver"].contracts(),
            [
                "authz-resolver/AuthZResolverApi@v1",
                "cf.toolkit.plugins.plugin.v1~cf.core.authz_resolver.plugin.v1~",
            ]
        );
        assert_eq!(
            catalogue.gears["static-authz-plugin"].contracts(),
            ["cf.toolkit.plugins.plugin.v1~cf.core.authz_resolver.plugin.v1~"]
        );
        let f = gear_facts(&catalogue, "corpus");
        assert_eq!(
            f["cf-authz-resolver"]["gdl_contracts"]["v"],
            "authz-resolver/AuthZResolverApi@v1, cf.toolkit.plugins.plugin.v1~cf.core.authz_resolver.plugin.v1~"
        );
    }

    #[test]
    fn a_config_schema_says_what_is_required_defaulted_and_written_by_generation() {
        let schemas = config_schemas(
            &corpus(),
            &names(&[
                "cf-gears-event-broker",
                "api-gateway",
                "cf-gears-types-registry",
                "cf-gears-nowhere",
                "cf-gears-event-broker",
            ]),
        );
        let asked: Vec<&str> = schemas.iter().map(|s| s.gear.as_str()).collect();
        assert_eq!(
            asked,
            [
                "cf-gears-event-broker",
                "api-gateway",
                "cf-gears-types-registry",
                "cf-gears-nowhere"
            ],
            "in the order asked, each once, by the name it was asked by"
        );

        let broker = &schemas[0];
        assert_eq!(broker.id.as_deref(), Some("event-broker"));
        let field = |name: &str| ConfigFieldInfo {
            name: name.to_string(),
            required: false,
            default: None,
            derived: false,
        };
        assert_eq!(
            broker.fields,
            [
                ConfigFieldInfo {
                    required: true,
                    ..field("mode")
                },
                ConfigFieldInfo {
                    required: true,
                    default: Some(json!("7d")),
                    ..field("retention")
                },
                field("tuning"),
            ],
            "a null default is no default; declaration order is kept"
        );

        let gateway = &schemas[1];
        assert_eq!(
            gateway.fields,
            [ConfigFieldInfo {
                required: true,
                derived: true,
                ..field("bind_addr")
            }],
            "an endpoint's config_key is generation's to write"
        );

        assert_eq!(schemas[2].id.as_deref(), Some("types-registry"));
        assert!(schemas[2].fields.is_empty(), "no schema, no fields");
        assert_eq!(schemas[3].id, None, "not in the corpus");
        assert!(schemas[3].fields.is_empty());
    }

    #[test]
    fn a_complete_set_is_left_as_it_is() {
        let picks = names(&[
            "cf-gears-api-gateway",
            "cf-gears-authn-resolver",
            "cf-gears-oidc-authn-plugin",
        ]);
        let c = complete(&corpus(), &picks, &GearConfig::new());
        assert_eq!(c.gears, picks);
        assert!(c.changes.is_empty());
    }

    #[test]
    fn a_host_picked_without_a_plugin_is_offered_the_ones_that_fill_it() {
        let c = compose(
            &catalogue(),
            &names(&["cf-gears-authn-resolver", "api-gateway"]),
        );
        assert_eq!(
            c.plugin_options,
            vec![(
                "authn-resolver".to_string(),
                vec![
                    "cf-gears-oidc-authn-plugin".to_string(),
                    "cf-gears-static-authn-plugin".to_string()
                ]
            )]
        );
        let filled = compose(
            &catalogue(),
            &names(&["authn-resolver", "static-authn-plugin"]),
        );
        assert!(filled.plugin_options.is_empty());
    }

    #[test]
    fn a_plugin_with_no_host_in_the_corpus_is_left_for_the_engine_to_judge() {
        let c = compose(&catalogue(), &names(&["cf-gears-credstore"]));
        assert_eq!(c.gears[0].id, "credstore");
        assert!(c.gears[0].plugins.is_empty());
    }

    #[test]
    fn a_gear_without_a_descriptor_is_reported_once_and_not_written() {
        let c = compose(
            &catalogue(),
            &names(&["cf-gears-ledger", "cf-gears-ledger", " "]),
        );
        assert!(c.gears.is_empty());
        assert_eq!(c.not_described, ["cf-gears-ledger"]);
    }

    #[test]
    fn a_pinned_description_names_its_corpus_commit_and_no_sibling_path() {
        let c = compose(&catalogue(), &names(&["api-gateway"]));
        let gdl = render_product_gdl(
            "my-shop",
            "products/my-shop/product.gdl",
            "My Shop",
            &c,
            "dev",
            Some(CorpusPin {
                url: "https://github.com/MikeFalcon77/gears-rust.git",
                rev: "a0a42cec5e68b313c31e3ceb00254b0df89cd8b8",
            }),
            &BTreeMap::new(),
        );
        assert!(
            gdl.contains(
                r#"source(id = "gears-rust", at = git(url = "https://github.com/MikeFalcon77/gears-rust.git", rev = "a0a42cec5e68b313c31e3ceb00254b0df89cd8b8"))"#
            ),
            "{gdl}"
        );
        assert!(!gdl.contains(r#"path("../gears-rust")"#));
    }

    #[test]
    fn a_new_product_lives_under_products_and_reaches_the_corpus_from_there() {
        assert_eq!(product_gdl_path("my-shop"), "products/my-shop/product.gdl");
        let c = compose(&catalogue(), &names(&["api-gateway"]));
        let gdl = render_product_gdl(
            "my-shop",
            &product_gdl_path("my-shop"),
            "My Shop",
            &c,
            "dev",
            None,
            &BTreeMap::new(),
        );
        assert!(
            gdl.contains(r#"source(id = "gears-rust", at = path("../../../gears-rust"))"#),
            "{gdl}"
        );
        assert!(gdl.contains("gearbox resolve --root ../../../gears-rust --product product.gdl"));
    }

    #[test]
    fn a_product_path_stays_inside_the_repository() {
        assert!(is_product_path("product.gdl"));
        assert!(is_product_path("products/my-shop/product.gdl"));
        for bad in [
            "",
            "/product.gdl",
            "../product.gdl",
            "products/../../product.gdl",
            "products/./product.gdl",
            "products//product.gdl",
            r"products\my-shop\product.gdl",
            "products/my-shop/shop.gdl",
        ] {
            assert!(!is_product_path(bad), "{bad}");
        }
    }

    #[test]
    fn the_description_names_every_profile_and_nests_plugins() {
        let c = compose(
            &catalogue(),
            &names(&["api-gateway", "static-authn-plugin"]),
        );
        let gdl = render_product_gdl(
            "my-shop",
            "product.gdl",
            "My \"Shop\"",
            &c,
            "local",
            None,
            &BTreeMap::new(),
        );
        assert!(gdl.contains("id = \"my-shop\""));
        assert!(gdl.contains("name = \"My \\\"Shop\\\"\""));
        assert!(gdl.contains("source(id = \"gears-rust\", at = path(\"../gears-rust\"))"));
        assert!(gdl.contains("embedded(id = \"dev\", development = True,"));
        assert!(gdl.contains("self_hosted(id = \"local\", development = True, host = \"my-shop\""));
        assert!(
            gdl.contains("kubernetes(id = \"prod\", discovery"),
            "prod stays a production profile"
        );
        assert!(gdl.contains("kubernetes(id = \"prod\""));
        // Every profile names its Postgres (GBX0306 otherwise), with the
        // password as a reference only.
        assert_eq!(gdl.matches("database = postgres(").count(), 3, "{gdl}");
        assert!(gdl.contains("password = \"${GEARS_PG_PASSWORD}\""));
        assert!(gdl.contains("existing_secret = \"my-shop-db\""));
        assert!(gdl.contains("default_profile = \"local\""));
        assert!(gdl.contains("use_gear(\"api-gateway\", source = \"gears-rust\"),"));
        assert!(gdl.contains(
            "use_gear(\"authn-resolver\", source = \"gears-rust\", plugins = [plugin(\"static-authn-plugin\")]),"
        ));
    }

    #[test]
    fn kebab_ids() {
        for ok in ["a", "my-shop", "shop2", "a-b-c"] {
            assert!(is_kebab_id(ok), "{ok}");
        }
        for bad in ["", "My-shop", "2shop", "shop-", "a--b", "a_b", "-a"] {
            assert!(!is_kebab_id(bad), "{bad}");
        }
    }

    #[test]
    fn diagnostics_point_at_repository_paths_one_based() {
        let v = json!([
            {"code": "GBX0513", "severity": "error", "message": "no host",
             "location": {"uri": "file:///tmp/x/my-shop/product.gdl",
                          "range": {"start": {"line": 9, "character": 0}}},
             "help": "select the host"},
            {"code": "GBX0108", "severity": "warning", "message": "category",
             "location": {"uri": "file:///tmp/x/gears-rust/gears/a/gear.gdl",
                          "range": {"start": {"line": 0, "character": 0}}}},
            {"severity": "error", "message": "no code, dropped"}
        ]);
        let d = relabel(parse_diagnostics(&v, Path::new("/tmp/x/gears-rust")));
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].file.as_deref(), Some("product.gdl"));
        assert_eq!(d[0].line, Some(10));
        assert!(d[0].is_error());
        assert_eq!(d[0].help.as_deref(), Some("select the host"));
        assert_eq!(d[1].file.as_deref(), Some("gears/a/gear.gdl"));
        assert!(!d[1].is_error());
    }

    #[test]
    fn a_resolution_reads_as_applications_and_reasons() {
        let v = json!({
            "gears": {
                "api-gateway": {"id": "api-gateway", "package": {"crate_name": "cf-gears-api-gateway"},
                                "selected_by": [{"reason": "selected"}]},
                "static-authn-plugin": {"id": "static-authn-plugin",
                                        "package": {"crate_name": "cf-gears-static-authn-plugin"},
                                        "selected_by": [{"reason": "plugin_of", "host": "authn-resolver", "profile": "dev"}]},
                "types-registry": {"id": "types-registry", "package": {"crate_name": "cf-gears-types-registry"},
                                   "selected_by": [{"reason": "colocated_by", "gear": "authn-resolver"}]}
            },
            "applications": [{
                "name": "my-shop", "kind": "host", "anchor": "api-gateway",
                "gears": ["types-registry", "api-gateway"], "replicas": 2,
                "listens": [{"name": "rest", "gear": "api-gateway", "address": "127.0.0.1:8087"}]
            }],
            "diagnostics": [{"code": "GBX0315", "severity": "warning", "message": "grpc"}]
        });
        let r = parse_resolution(&v, Path::new("/c"));
        assert_eq!(r.applications.len(), 1);
        let app = &r.applications[0];
        assert_eq!(
            (app.name.as_str(), app.anchor.as_deref(), app.replicas),
            ("my-shop", Some("api-gateway"), 2)
        );
        assert_eq!(app.listens[0].address, "127.0.0.1:8087");
        let reasons: BTreeMap<_, _> = r
            .gears
            .iter()
            .map(|g| (g.id.as_str(), g.reasons.clone()))
            .collect();
        assert_eq!(reasons["api-gateway"], ["selected"]);
        assert_eq!(reasons["static-authn-plugin"], ["plugin of authn-resolver"]);
        assert_eq!(reasons["types-registry"], ["colocated with authn-resolver"]);
        assert_eq!(r.diagnostics[0].code, "GBX0315");
    }

    #[test]
    fn a_host_is_offered_only_when_its_sdk_can_be_located() {
        let c: EngineCatalogue = serde_json::from_value(json!({
            "gears": {
                "authn-resolver": {
                    "id": "authn-resolver",
                    "package": {"crate_name": "cf-gears-authn-resolver"},
                    "extension_points": [{
                        "spec": "cf.toolkit.plugins.plugin.v1~cf.core.authn_resolver.plugin.v1~",
                        "trait_ident": "AuthNResolverPluginClient",
                        "sdk": {
                            "crate_name": "cf-gears-authn-resolver-sdk",
                            "lib_ident": "authn_resolver_sdk",
                            "path": "gears/system/authn-resolver/authn-resolver-sdk"
                        }
                    }]
                },
                // Without a path a plugin's `gear.gdl` could not point at it.
                "credstore": {
                    "id": "credstore",
                    "package": {"crate_name": "cf-gears-credstore"},
                    "extension_points": [{"sdk": {"crate_name": "cf-gears-credstore-sdk"}}]
                }
            }
        }))
        .expect("fixture parses");
        let points = host_points(&c);
        assert_eq!(points.len(), 1, "{points:?}");
        assert_eq!(points[0].host_crate, "cf-gears-authn-resolver");
        assert_eq!(points[0].sdk_lib, "authn_resolver_sdk");
        assert_eq!(
            spec_segment(&points[0].spec),
            "cf.core.authn_resolver.plugin.v1~"
        );
        assert_eq!(points[0].trait_ident, "AuthNResolverPluginClient");
    }

    #[test]
    fn the_sdk_path_climbs_to_the_repository_root_and_no_further() {
        // gears/<slug>/ -> up two to the root, then down to the SDK. Never
        // above the root: the engine refuses that (GBX0102).
        assert_eq!(
            sdk_path_in_repo("gears", "gears/system/x-sdk"),
            "../../gears/system/x-sdk"
        );
        assert_eq!(
            sdk_path_in_repo("/gears/bss/", "/gears/x-sdk"),
            "../../../gears/x-sdk"
        );
        assert_eq!(sdk_path_in_repo("", "x-sdk"), "../x-sdk");
    }

    #[test]
    fn from_a_projects_own_repository_the_sdk_is_in_the_checkout_beside_it() {
        assert_eq!(
            sdk_path_beside("gears", "gears-rust", "gears/system/x-sdk"),
            "../../../gears-rust/gears/system/x-sdk"
        );
        assert_eq!(
            sdk_path_beside("", "gears-rust", "x-sdk"),
            "../../gears-rust/x-sdk"
        );
        assert_eq!(
            sdk_path_beside("", "gears-bss", "x-sdk"),
            "../../gears-bss/x-sdk"
        );
    }

    #[test]
    fn two_spellings_of_one_repository_compare_equal() {
        assert_eq!(
            repo_key("https://github.com/MikeFalcon77/gears-rust.git"),
            "mikefalcon77/gears-rust"
        );
        assert_eq!(
            repo_key("MikeFalcon77/gears-rust"),
            "mikefalcon77/gears-rust"
        );
        assert_ne!(
            repo_key("acme/gears-rust"),
            repo_key("MikeFalcon77/gears-rust")
        );
    }

    #[test]
    fn a_scaffold_answer_yields_its_gdl_or_the_engines_refusal() {
        let ok = json!({"id": 2, "result": {"gear_gdl": "gear x {}\n", "plans": []}});
        assert_eq!(answer_gdl(&ok).expect("gdl"), "gear x {}\n");
        let refused =
            json!({"id": 2, "error": {"code": -32602, "message": "id is not kebab-case"}});
        let e = answer_gdl(&refused).expect_err("refused");
        assert!(format!("{e}").contains("id is not kebab-case"), "{e}");
        assert!(answer_gdl(&json!({"id": 2, "result": {}})).is_err());
    }

    #[test]
    fn an_unknown_gear_kind_is_refused_and_blank_means_service() {
        assert_eq!(GearKind::parse(""), Some(GearKind::Service));
        assert_eq!(GearKind::parse(" plugin "), Some(GearKind::Plugin));
        assert_eq!(GearKind::parse("library"), None);
    }

    fn vendor_corpus(plugins: &[(&str, &str)]) -> EngineCatalogue {
        let mut gears = serde_json::Map::new();
        gears.insert(
            "account-management".into(),
            json!({
                "id": "account-management",
                "package": {"crate_name": "cf-gears-account-management"},
                "vendor_selector": "constructorfabric",
                "extension_points": [{"spec": "cf.toolkit.plugins.plugin.v1~cf.core.idp.plugin.v1~",
                                      "sdk": {"crate_name": "cf-gears-account-management-sdk"}}]
            }),
        );
        for (id, vendor) in plugins {
            gears.insert(
                (*id).into(),
                json!({
                    "id": id,
                    "package": {"crate_name": format!("cf-gears-{id}")},
                    "fills": {"point": {"sdk": {"crate_name": "cf-gears-account-management-sdk"}}},
                    "config_schema": {"fields": [{"name": "vendor", "default": vendor}]}
                }),
            );
        }
        serde_json::from_value(json!({ "gears": gears })).expect("fixture parses")
    }

    #[test]
    fn a_plugin_under_the_hosts_vendor_is_preferred() {
        let c = vendor_corpus(&[
            ("keycloak-idp-plugin", "keycloak"),
            ("cf-idp-plugin", "constructorfabric"),
        ]);
        let done = complete(
            &c,
            &names(&["cf-gears-account-management"]),
            &GearConfig::new(),
        );
        assert!(
            done.gears.contains(&"cf-gears-cf-idp-plugin".to_string()),
            "{:?}",
            done.gears
        );
        assert!(
            done.config.is_empty(),
            "nothing needed setting: {:?}",
            done.config
        );
    }

    #[test]
    fn a_plugin_under_another_vendor_gets_the_hosts() {
        // The corpus as it is today: the host selects `constructorfabric`,
        // its plugin registers under `cf` (GBX0512).
        let c = vendor_corpus(&[("static-idp-plugin", "cf")]);
        let done = complete(
            &c,
            &names(&["cf-gears-account-management"]),
            &GearConfig::new(),
        );
        assert!(
            done.gears
                .contains(&"cf-gears-static-idp-plugin".to_string())
        );
        assert_eq!(
            done.config["cf-gears-static-idp-plugin"]["vendor"],
            "constructorfabric"
        );
        assert!(
            done.changes
                .iter()
                .any(|ch| ch.reason.contains("vendor set to `constructorfabric`"))
        );
    }

    #[test]
    fn a_vendor_somebody_set_is_kept() {
        let c = vendor_corpus(&[("static-idp-plugin", "cf")]);
        let mut mine = GearConfig::new();
        mine.entry("cf-gears-static-idp-plugin".into())
            .or_default()
            .insert("vendor".into(), json!("mine"));
        let done = complete(
            &c,
            &names(&["cf-gears-account-management", "cf-gears-static-idp-plugin"]),
            &mine,
        );
        assert_eq!(done.config["cf-gears-static-idp-plugin"]["vendor"], "mine");
    }

    #[test]
    fn configuration_is_written_on_the_gear_and_on_its_plugin() {
        let composition = Composition {
            gears: vec![GearUse {
                id: "account-management".into(),
                plugins: vec!["static-idp-plugin".into()],
            }],
            ..Composition::default()
        };
        let mut config = BTreeMap::new();
        config.insert(
            "static-idp-plugin".to_string(),
            json!({"vendor": "constructorfabric", "priority": 100})
                .as_object()
                .expect("object")
                .clone(),
        );
        config.insert(
            "account-management".to_string(),
            json!({"strict": true}).as_object().expect("object").clone(),
        );
        let gdl = render_product_gdl("p", "product.gdl", "P", &composition, "dev", None, &config);
        assert!(
            gdl.contains(r#"use_gear("account-management", source = "gears-rust", config = {"strict": True}, plugins = [plugin("static-idp-plugin", config = {"priority": 100, "vendor": "constructorfabric"})])"#),
            "{gdl}"
        );
    }

    fn config(corpus_url: &str) -> GearboxConfig {
        GearboxConfig {
            bin: PathBuf::from("gearbox"),
            workdir: std::env::temp_dir(),
            corpus_url: corpus_url.into(),
            corpus_ref: "main".into(),
            refresh: DEFAULT_REFRESH,
        }
    }

    fn repo_root(id: &str, url: &str) -> GearRoot {
        GearRoot {
            id: id.into(),
            source: CorpusSource {
                label: id.into(),
                key: format!("gearbox-{id}"),
                repo: id.into(),
                url: url.into(),
                username: "x-access-token".into(),
                token: String::new(),
                git_ref: String::new(),
            },
            connection_id: Some(uuid::Uuid::new_v4()),
            organization: false,
            subdir: None,
        }
    }

    fn ids(g: &Gearbox) -> Vec<String> {
        g.roots().into_iter().map(|r| r.id).collect()
    }

    #[test]
    fn the_platforms_gear_repositories_replace_the_deployments_corpus_until_there_are_none() {
        let g = Gearbox::new(config("https://github.com/MikeFalcon77/gears-rust.git"));
        assert_eq!(ids(&g), ["gears-rust"]);
        assert!(g.roots_due());

        let core = repo_root(
            "gears-core",
            "https://github.com/constructorfabric/gears-core.git",
        );
        let bss = repo_root(
            "gears-bss",
            "https://github.com/constructorfabric/gears-bss.git",
        );
        g.use_repositories(vec![core.clone(), bss.clone()]);
        assert_eq!(ids(&g), ["gears-core", "gears-bss"]);
        assert!(!g.roots_due());
        assert!(g.is_corpus_repo(None, "constructorfabric/gears-bss"));
        assert!(!g.is_corpus_repo(None, "MikeFalcon77/gears-rust"));
        let generation = g.roots.lock().expect("roots").generation;

        // The same list again is not a change: nothing is checked out afresh.
        g.use_repositories(vec![core.clone(), bss.clone()]);
        assert_eq!(g.roots.lock().expect("roots").generation, generation);
        // Another order is: the engine's order decides which declaration wins.
        g.use_repositories(vec![bss.clone(), core]);
        assert_eq!(g.roots.lock().expect("roots").generation, generation + 1);
        // Removed and added again as it was: another connection, so another
        // root -- its status must name the connection that exists.
        let again = repo_root(
            "gears-core",
            "https://github.com/constructorfabric/gears-core.git",
        );
        g.use_repositories(vec![bss, again.clone()]);
        assert_eq!(g.roots.lock().expect("roots").generation, generation + 2);
        assert_eq!(g.roots()[1].connection_id, again.connection_id);

        g.use_repositories(Vec::new());
        assert_eq!(ids(&g), ["gears-rust"]);
    }

    #[test]
    fn a_project_root_is_a_path_only_inside_the_repository_the_file_is_saved_to() {
        let url = "https://github.com/Acme/Shop.git";
        assert_eq!(
            within_product_repo(Some("shop-backend"), url, Some("acme/shop")),
            Some("shop-backend")
        );
        assert_eq!(
            within_product_repo(Some("shop-backend"), url, Some("acme/crm")),
            None,
            "another project's directory is pinned by its git url, not a path here"
        );
        assert_eq!(within_product_repo(Some("shop-backend"), url, None), None);
        assert_eq!(within_product_repo(None, url, Some("acme/shop")), None);
    }

    #[test]
    fn one_request_claims_an_organizations_refresh_the_others_serve_what_there_is() {
        let g = Gearbox::new(config("https://github.com/MikeFalcon77/gears-rust.git"));
        let acme = uuid::Uuid::new_v4();
        assert!(g.begin_org_refresh(acme, false), "due: the first claims it");
        assert!(
            !g.begin_org_refresh(acme, false),
            "while it reads, the next request does not start the same read"
        );
        assert!(!g.org_roots_due(acme));
        assert!(g.begin_org_refresh(acme, true), "asked for now, it reads");
    }

    #[test]
    fn an_organization_reads_the_platforms_repositories_then_its_own() {
        let g = Gearbox::new(config("https://github.com/MikeFalcon77/gears-rust.git"));
        let core = repo_root(
            "gears-core",
            "https://github.com/constructorfabric/gears-core.git",
        );
        g.use_repositories(vec![core.clone()]);
        let acme = uuid::Uuid::new_v4();
        let other = uuid::Uuid::new_v4();
        assert!(g.org_roots_due(acme));

        // With none of its own, an organization reads the platform's corpus,
        // under the platform's scope: one checkout, one catalogue.
        g.use_org_repositories(acme, Vec::new());
        assert!(!g.org_roots_due(acme));
        assert_eq!(g.view(Some(acme)).scope, None);

        let own = repo_root("acme-gears", "https://github.com/acme/gears.git");
        let clash = repo_root("gears-core", "https://github.com/acme/core.git");
        g.use_org_repositories(acme, vec![own.clone(), clash]);
        let view = g.view(Some(acme));
        assert_eq!(view.scope, Some(acme));
        let ids: Vec<&str> = view.roots.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["gears-core", "acme-gears"]);
        // A root whose id the platform already has is left out, and said so.
        assert_eq!(view.shadowed, ["gears-core"]);
        assert!(view.roots[1].organization && !view.roots[0].organization);
        // Another organization still reads only the platform's.
        assert_eq!(g.roots_in(Some(other)).len(), 1);
        assert!(g.is_corpus_repo(Some(acme), "acme/gears"));
        assert!(!g.is_corpus_repo(None, "acme/gears"));

        // The relay finds a root by id, in the scope that reads it only.
        let (url, _) = g
            .corpus_fetch(Some(acme), Some("acme-gears"))
            .expect("acme's");
        assert_eq!(url, "https://github.com/acme/gears.git");
        assert!(g.corpus_fetch(Some(other), Some("acme-gears")).is_none());
        assert_eq!(
            g.corpus_fetch(None, None).map(|(u, _)| u),
            Some("https://github.com/constructorfabric/gears-core.git".to_string())
        );

        // A change on either side is a new generation of the merged view.
        let before = g.view(Some(acme)).generation;
        g.use_repositories(vec![core]);
        assert_eq!(g.view(Some(acme)).generation, before);
        g.use_org_repositories(acme, vec![own]);
        assert_ne!(g.view(Some(acme)).generation, before);
    }

    #[test]
    fn without_a_corpus_or_a_gear_repository_there_is_nothing_to_read() {
        let g = Gearbox::new(config(""));
        assert!(g.roots().is_empty());
        assert_eq!(g.corpus_label(None), "no gear repository");
        assert_eq!(g.corpus_origin(None), (String::new(), String::new(), false));
        assert_eq!(g.corpus_fetch(None, None), None);
    }

    #[test]
    fn a_source_inside_the_projects_repository_is_a_path_from_the_product_file() {
        let c = compose(&catalogue(), &names(&["api-gateway"]));
        let pins = [SourcePin {
            id: "studio-backend",
            url: "https://github.com/constructorfabric/studio-web.git",
            rev: Some("cccc"),
            within: Some("studio-backend"),
        }];
        let at_root = render_product_gdl_from(
            "studio-web",
            "product.gdl",
            "Studio",
            &c,
            "dev",
            &pins,
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert!(
            at_root.contains(r#"source(id = "studio-backend", at = path("studio-backend"))"#),
            "{at_root}"
        );
        let below = render_product_gdl_from(
            "studio-web",
            "products/studio-web/product.gdl",
            "Studio",
            &c,
            "dev",
            &pins,
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert!(
            below.contains(r#"source(id = "studio-backend", at = path("../../studio-backend"))"#),
            "{below}"
        );
    }

    #[test]
    fn each_gear_names_the_repository_it_came_from_and_each_repository_is_pinned() {
        let c = compose(&catalogue(), &names(&["api-gateway", "credstore"]));
        let gear_source: BTreeMap<String, String> =
            [("credstore".to_string(), "gears-security".to_string())].into();
        let gdl = render_product_gdl_from(
            "my-shop",
            "products/my-shop/product.gdl",
            "My Shop",
            &c,
            "dev",
            &[
                SourcePin {
                    id: "gears-core",
                    url: "https://github.com/constructorfabric/gears-core.git",
                    rev: Some("aaaa"),
                    within: None,
                },
                SourcePin {
                    id: "gears-security",
                    url: "https://github.com/constructorfabric/gears-security.git",
                    rev: Some("bbbb"),
                    within: None,
                },
            ],
            &gear_source,
            &BTreeMap::new(),
        );
        assert!(gdl.contains(r#"source(id = "gears-core", at = git(url = "https://github.com/constructorfabric/gears-core.git", rev = "aaaa"))"#), "{gdl}");
        assert!(gdl.contains(r#"source(id = "gears-security", at = git(url = "https://github.com/constructorfabric/gears-security.git", rev = "bbbb"))"#), "{gdl}");
        assert!(
            gdl.contains(r#"use_gear("credstore", source = "gears-security""#),
            "{gdl}"
        );
        // A gear the engine attributes to no listed repository takes the first.
        assert!(
            gdl.contains(r#"use_gear("api-gateway", source = "gears-core""#),
            "{gdl}"
        );
        assert!(gdl.contains("gearbox resolve --root ../../../gears-core --root ../../../gears-security --product"), "{gdl}");
    }

    #[test]
    fn the_engines_version_says_which_commit_it_was_built_from() {
        assert_eq!(
            with_revision(
                "gearbox 0.1.0",
                Some("ea964f94a59627ab818f4215d8251cbd64db098d")
            ),
            "gearbox 0.1.0-ea964f9"
        );
        assert_eq!(with_revision("gearbox 0.1.0", None), "gearbox 0.1.0");
        // An engine that names its commit itself is left as it says.
        assert_eq!(
            with_revision("gearbox 0.2.0 (ea964f9)", Some("ea964f94a5")),
            "gearbox 0.2.0 (ea964f9)"
        );
    }

    #[test]
    fn a_rotated_token_is_taken_without_a_new_generation() {
        let g = Gearbox::new(config(""));
        let core = repo_root(
            "gears-core",
            "https://github.com/constructorfabric/gears-core.git",
        );
        g.use_repositories(vec![core.clone()]);
        let generation = g.roots.lock().expect("roots").generation;
        let mut rotated = core;
        rotated.source.token = "new-token".into();
        g.use_repositories(vec![rotated]);
        assert_eq!(
            g.roots.lock().expect("roots").generation,
            generation,
            "the same repository with another token is the same checkout"
        );
        assert_eq!(
            g.roots()[0].source.token,
            "new-token",
            "the next fetch uses the token read last"
        );
    }

    fn checked_out(id: &str, commit: Option<&str>) -> Root {
        Root {
            id: id.into(),
            dir: PathBuf::from(format!("/work/gearbox-roots/k/{id}")),
            commit: commit.map(str::to_owned),
        }
    }

    #[test]
    fn a_catalogue_is_reused_while_every_root_is_at_the_commit_it_was_read_at() {
        let before = [checked_out("a", Some("1")), checked_out("b", Some("2"))];
        assert!(same_checkouts(&before, &before, true));
        assert!(
            same_checkouts(&before, &before, false),
            "a new generation at the same commits is the same corpus"
        );
        let moved = [checked_out("a", Some("1")), checked_out("b", Some("3"))];
        assert!(!same_checkouts(&before, &moved, true));
        let reordered = [checked_out("b", Some("2")), checked_out("a", Some("1"))];
        assert!(
            !same_checkouts(&before, &reordered, false),
            "the order decides which declaration wins"
        );
        let unknown = [checked_out("a", None)];
        assert!(same_checkouts(&unknown, &unknown, true));
        assert!(
            !same_checkouts(&unknown, &unknown, false),
            "across generations a root with no commit could hold anything"
        );
        let elsewhere = [Root {
            dir: PathBuf::from("/work/gearbox-roots/other/a"),
            ..checked_out("a", Some("1"))
        }];
        assert!(!same_checkouts(&before[..1], &elsewhere, false));
    }

    #[test]
    fn one_refresh_per_key_runs_at_a_time() {
        let flights: InFlight<u32> = InFlight::new();
        let first = flights.claim(1).expect("nothing runs yet");
        assert!(flights.claim(1).is_none(), "a second refresh is refused");
        assert!(
            flights.claim(1).is_none(),
            "a refused claim does not free the key it was refused"
        );
        assert!(flights.claim(2).is_some(), "another key is its own");
        drop(first);
        assert!(
            flights.claim(1).is_some(),
            "a finished refresh frees its key"
        );
    }

    #[test]
    fn a_preview_is_answered_again_only_for_the_same_scope_commits_and_text() {
        let roots = [checked_out("a", Some("1"))];
        let key = |scope: Scope, roots: &[Root], gdl: &str| {
            evaluation_key(scope, roots, "p", "product.gdl", "dev", gdl)
        };
        let org = Some(uuid::Uuid::from_u128(7));
        let k = key(org, &roots, "x").expect("every commit is known");
        assert_eq!(key(org, &roots, "x"), Some(k));
        assert_ne!(key(None, &roots, "x"), Some(k), "no answer crosses scopes");
        assert_ne!(key(org, &roots, "y"), Some(k));
        assert_ne!(key(org, &[checked_out("a", Some("2"))], "x"), Some(k));
        assert_eq!(key(org, &[checked_out("a", None)], "x"), None);

        let mut kept = Evaluations::default();
        assert!(kept.get(&k).is_none());
        kept.put(k, Resolution::default());
        assert!(kept.get(&k).is_some());
        for i in 0..EVALUATIONS_KEPT {
            let other = key(org, &roots, &i.to_string()).expect("key");
            kept.put(other, Resolution::default());
        }
        assert_eq!(kept.entries.len(), EVALUATIONS_KEPT, "bounded");
        assert!(kept.get(&k).is_none(), "the oldest answer went first");
    }

    /// The engine the images pin, run for real over a gear corpus and read
    /// the way the portal reads it: the catalogue, a description Studio
    /// writes, its validation and resolution in every profile, and a
    /// scaffold. The parsers above take what they find and default the rest,
    /// so an engine whose output changed shape shows up as empty fields, not
    /// as an error; this asserts the fields are there.
    ///
    /// Ignored: it needs the engine and a checkout of the corpus. Run it when
    /// the pin moves, with `GEARBOX_E2E_BIN` the release's `gearbox` and
    /// `GEARBOX_E2E_CORPUS` a gears-rust checkout in a directory named
    /// `gears-rust`: `cargo test pinned_engine -- --ignored`.
    #[test]
    #[ignore = "needs GEARBOX_E2E_BIN and GEARBOX_E2E_CORPUS"]
    fn the_pinned_engine_reads_the_corpus_and_resolves_what_studio_writes() {
        let var = |k: &str| PathBuf::from(std::env::var(k).unwrap_or_else(|_| panic!("{k}")));
        let bin = var("GEARBOX_E2E_BIN");
        let corpus = var("GEARBOX_E2E_CORPUS");
        let roots = vec![(CORPUS_SOURCE_ID.to_string(), corpus.clone())];

        let args: Vec<String> = vec![
            "catalogue".into(),
            "--root".into(),
            corpus.to_string_lossy().into_owned(),
            "--format".into(),
            "json".into(),
        ];
        let out = run_engine(&bin, &args, None).expect("the engine runs");
        let raw: Value = serde_json::from_str(&out.stdout)
            .unwrap_or_else(|e| panic!("the catalogue is not JSON ({e}): {}", out.stderr_tail()));
        let catalogue: EngineCatalogue =
            serde_json::from_value(raw).expect("the catalogue has the expected shape");
        assert!(
            catalogue.unreadable_root(&roots).is_none(),
            "{:?}",
            catalogue.unreadable_root(&roots)
        );
        assert!(
            catalogue.gears.len() > 20,
            "{} gears",
            catalogue.gears.len()
        );
        let gateway = &catalogue.gears["api-gateway"];
        assert!(!gateway.package.crate_name.is_empty());
        assert_eq!(gateway.source.as_deref(), Some(CORPUS_SOURCE_ID));
        let plugin = &catalogue.gears["static-tr-plugin"];
        assert_eq!(
            catalogue.host_of(plugin).map(|g| g.id.as_str()),
            Some("tenant-resolver")
        );

        // A sign-in a production profile accepts: static-authn-plugin in
        // `accept_all` mode is refused there (GBX0325), as it should be.
        let picked = names(&["api-gateway", "simple-user-settings", "oidc-authn-plugin"]);
        let composition = compose(&catalogue, &picked);
        for profile in PROFILES {
            let gdl = render_product_gdl(
                "my-shop",
                "product.gdl",
                "My Shop",
                &composition,
                profile,
                None,
                &BTreeMap::new(),
            );
            let resolution = evaluate(&bin, &roots, "my-shop", "product.gdl", &gdl, profile)
                .expect("the engine evaluates the description");
            assert!(
                !resolution
                    .diagnostics
                    .iter()
                    .any(EngineDiagnostic::is_error),
                "{profile}: {:#?}\n{gdl}",
                resolution.diagnostics
            );
            assert!(
                !resolution.applications.is_empty(),
                "{profile}: no applications"
            );
            assert!(
                resolution
                    .applications
                    .iter()
                    .all(|a| !a.name.is_empty() && !a.kind.is_empty() && !a.gears.is_empty()),
                "{profile}: {:#?}",
                resolution.applications
            );
            let resolved = resolution
                .gears
                .iter()
                .find(|g| g.id == "api-gateway")
                .unwrap_or_else(|| panic!("{profile}: api-gateway is not resolved"));
            assert!(!resolved.crate_name.is_empty(), "{profile}");
            assert!(!resolved.reasons.is_empty(), "{profile}");
        }

        let scratch = std::env::temp_dir().join(format!("gearbox-e2e-{}", uuid::Uuid::new_v4()));
        let root = scratch.join(CORPUS_SOURCE_ID);
        std::fs::create_dir_all(&root).expect("scratch");
        let params = json!({
            "id": "my-gear",
            "name": "My gear",
            "version": "0.1.0",
            "kind": "service",
            "plugin": null,
            "destination_dir": scratch.join("gear").to_string_lossy(),
            "dry_run": true,
        });
        let answer = rpc_once(&bin, &root, &scratch, "gearbox/gear/scaffold", params);
        let _ = std::fs::remove_dir_all(&scratch);
        let gdl = answer_gdl(&answer.expect("the engine answers")).expect("a scaffold");
        assert!(gdl.contains("my-gear"), "{gdl}");
    }
}
