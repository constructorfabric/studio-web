//! The components reference: the portal's catalogue and the Gearbox engine's
//! catalogue, joined into one list.
//!
//! The same gear was shown twice. The portal's Components page lists what
//! crates.io published and what the repository scans read (a crate, its
//! version, downloads, a profile); the IDE's Gearbox catalogue lists what the
//! corpus's `gear.gdl` descriptors declare (an engine id, a role, extension
//! points). `account-management` in the engine and `cf-gears-account-management`
//! in the portal are one thing, and a person building a product needs both
//! halves in one place: what it is and how alive it is, and what it takes to
//! put it in.
//!
//! ── The join ─────────────────────────────────────────────────────────────────
//!
//! **The crate name.** The engine reads each gear's `package.crate_name` from
//! the `Cargo.toml` next to its descriptor; crates.io lists the same crate
//! under the same name, and the repository scan now keys a gear by the
//! `[package] name` it reads (see `repo_enrich::primary_crate`). So
//! `engine.gears[id].package.crate_name == component.name` is exact, not a
//! heuristic. Several engine gears can share one crate — `mini-chat` ships its
//! two static plugins inside `cf-gears-mini-chat` — so a component carries a
//! LIST of engine gears.
//!
//! **The directory, as a fallback.** A component catalogued before the scan
//! read crate names is still keyed by the `cf-gears-<directory>` guess
//! (`cf-gears-ledger` for the crate `cf-gears-bss-ledger`). Such a component
//! carries the directory it was read from, and when no component has the
//! engine gear's crate name, the one whose directory contains the engine
//! gear's package path — the deepest — is it. Only a component no engine gear
//! claimed by name is eligible, so a host cannot swallow its own plugin.
//!
//! An engine gear no component matches is listed on its own, with every
//! portal field null: it can still be put into a product.
//!
//! ── Kinds, categories, and what is left out ─────────────────────────────────
//!
//! Every entry gets a kind and a category from one vocabulary each, decided
//! from evidence in [`super::taxonomy`], with the evidence as `kind_reason` /
//! `category_reason`. Entries that are not components (configs, test support,
//! docs, templates, examples) and nodes that are older copies of another
//! (`superseded`) carry `component: false` and an `excluded_reason`; the
//! handler leaves them out unless asked (`?include=all`). The read is clean
//! before any re-sync: superseded nodes are recognised from what is stored,
//! and the next sync deletes them.
//!
//! ── Nulls ────────────────────────────────────────────────────────────────────
//!
//! Unknown is null, never zero. A crate with no downloads figure has
//! `downloads: null`; a component Insight was not asked about has
//! `activity: null`; a component with no field schema has no profile ratio.
//! Every number is read from a store (the graph for crates.io and the scans,
//! the engine's catalogue, the warehouse) and none is computed per client.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::Deserialize;
use serde_json::Value;

use super::field_schema::TypeFieldSchema;
use super::gts;
use super::service::CatalogNodeView;
use super::taxonomy;

// ── wire shapes ──────────────────────────────────────────────────────────────

/// One extension point a gear declares: the place a plugin goes.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ReferenceExtensionPointDto {
    /// The GTS spec plugins register under — the point's identity.
    pub spec: String,
    /// `sdk_lib::Trait`, as a person reads it. Null when the descriptor
    /// names no trait.
    pub interface: Option<String>,
    /// The SDK crate that declares the trait.
    pub sdk_crate: Option<String>,
}

/// What the Gearbox engine says about one gear, read from its `gear.gdl`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ReferenceEngineGearDto {
    /// The engine id — what `product.gdl` names and what "Add to product"
    /// takes (`account-management`).
    pub id: String,
    pub display_name: Option<String>,
    /// `service` or `plugin` (a plugin fills another gear's extension point).
    pub role: String,
    pub category: Option<String>,
    /// Where the descriptor is, relative to the corpus root.
    pub gdl_path: Option<String>,
    /// `db`, `rest`, `stateful`, … as the engine projects them.
    pub runtime_caps: Vec<String>,
    /// Engine ids that must share a binary with this gear.
    pub colocated_deps: Vec<String>,
    pub extension_points: Vec<ReferenceExtensionPointDto>,
    /// For a plugin: the spec of the point it fills.
    pub fills: Option<String>,
    /// For a plugin: the engine ids of the gears that declare that point.
    pub hosts: Vec<String>,
    /// For a host: the engine ids of the plugins that fill its points.
    pub plugins: Vec<String>,
}

/// A crate that belongs with a component: its SDK, a plugin for it, the SDK a
/// plugin implements.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ReferenceRelatedCrateDto {
    pub name: String,
    /// `sdk`, `plugin`, `implements` (the SDK whose point a plugin fills) or
    /// `crate` (another crate of the same gear directory).
    pub role: String,
    /// Whether the catalogue lists it as a component of its own.
    pub in_catalogue: bool,
    /// The engine id, when the engine describes it as a gear.
    pub gear_id: Option<String>,
}

/// Delivery activity over the requested window.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ReferenceActivityDto {
    pub commits: u64,
    pub files_changed: u64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub authors: u64,
}

/// One consumer waiting for a component, and how badly.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ReferenceDemandDto {
    /// The consumer, as the roadmap source names its priority letter.
    pub consumer: String,
    /// 1 is the most urgent.
    pub priority: u32,
}

/// One progress axis on the roadmap board (`Design`, `SDK`, …).
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ReferenceAxisDto {
    pub label: String,
    /// What the board says: `80%`, `Done`, `N/A`.
    pub value: String,
    /// The same as a number, null for `N/A`.
    pub pct: Option<u32>,
}

/// Where a component is and whether its plan meets the demand for it: the
/// roadmap board's answer beside the repository's.
///
/// Every part is optional and a component with none of them has no readiness
/// at all (null), rather than a block of empty fields.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ReferenceReadinessDto {
    /// The board's stage (`In Dev`), and where it sits in the pipeline.
    pub stage: Option<String>,
    pub stage_at: Option<u32>,
    pub stage_of: Option<u32>,
    /// The repository's answer: `in development` … `mature`.
    pub lifecycle: Option<String>,
    /// The milestone and its due date, `YYYY-MM-DD`.
    pub milestone: Option<String>,
    pub due: Option<String>,
    /// Whether the date is a commitment.
    pub committed: Option<bool>,
    /// Plan meets demand: `on track`, `check`, `at risk`, `delivered`,
    /// `unplanned`; the lamp (`good`, `watch`, `bad`, `none`) and why.
    pub plan: Option<String>,
    pub plan_lamp: Option<String>,
    pub plan_reasons: Vec<String>,
    pub demand: Vec<ReferenceDemandDto>,
    pub progress: Vec<ReferenceAxisDto>,
    /// The newest release tag and when it was cut.
    pub last_release: Option<String>,
    pub released_on: Option<String>,
    /// How many catalogued components depend on this one.
    pub used_by: Option<u32>,
    /// The board item, a link.
    pub roadmap_item: Option<String>,
    /// The quality grade (`A`…`E`) and what would raise it: the fixes of
    /// every criterion it fails.
    pub grade: Option<String>,
    pub grade_fixes: Vec<String>,
}

/// One component of the reference.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentReferenceDto {
    /// The catalogue name: the crate, the npm package, the kit slug — or, for
    /// a gear only the engine knows, its crate name. A node stored under a
    /// guessed name is listed under the real one, and the stored name is in
    /// `aka`.
    pub name: String,
    /// Names the same component is stored under.
    pub aka: Vec<String>,
    /// The graph node, so a client can match an entry to `/components`. Null
    /// for a gear only the engine knows.
    pub instance_id: Option<String>,
    /// A human name when one exists (the engine's `display_name`, a kit's
    /// title); null rather than the name repeated.
    pub title: Option<String>,
    /// The node type in the graph. Null for a gear only the engine knows.
    pub type_id: Option<String>,
    /// What it IS, from one vocabulary (`taxonomy::Kind`): `gear`, `plugin`,
    /// `sdk`, `library`, `micro-frontend`, `frontend-library`, `tool`, `kit`;
    /// or, for what is not a component, `config`, `test-support`, `docs`,
    /// `template`, `example`; or `superseded`.
    pub kind: String,
    /// The evidence that decided `kind`.
    pub kind_reason: String,
    /// False for a non-component class or a superseded node.
    pub component: bool,
    /// Why it is left out of the default list. Null for a component.
    pub excluded_reason: Option<String>,
    /// For a superseded node: the entry listed instead.
    pub superseded_by: Option<String>,
    /// One of `taxonomy::CATEGORIES`, or null.
    pub category: Option<String>,
    /// Where `category` came from (`gear.gdl`, `gear.toml`, `the category of
    /// …`, a crates.io category).
    pub category_reason: Option<String>,
    /// The registry categories and scan tags as the sources spelled them,
    /// kept apart because they are not this platform's categories.
    pub source_categories: Vec<String>,
    pub description: Option<String>,
    /// `published` (a crate exists) or `draft` (documents only), from the
    /// repository scan. Null when no scan counted the crates.
    pub status: Option<String>,
    /// The released version when a registry has one, else the version the
    /// source declares.
    pub version: Option<String>,
    /// `crates.io` or `declared` (a `package.json` or manifest nobody
    /// published). Null with `version`.
    pub version_source: Option<String>,
    pub num_versions: Option<u64>,
    pub downloads: Option<u64>,
    pub recent_downloads: Option<u64>,
    /// When it last changed: the newest crates.io release or the last commit
    /// to its directory, `YYYY-MM-DD…`.
    pub updated_at: Option<String>,
    /// The repository URL.
    pub repository: Option<String>,
    /// The directory inside it, when a scan read one.
    pub repo_path: Option<String>,
    /// `owner/name` of the repository a scan read it from.
    pub synced_from: Option<String>,
    /// Where the entry's facts came from: `crates.io`, `repository`,
    /// `gearbox`, `kit manifest`.
    pub sources: Vec<String>,
    /// Profile completeness: schema fields with an answer, out of how many
    /// the component's type describes. Both null without a schema.
    pub profile_filled: Option<u32>,
    pub profile_fields: Option<u32>,
    /// Null when the warehouse was not asked about it or had no row for it.
    pub activity: Option<ReferenceActivityDto>,
    /// Stage, due date, demand and whether they meet. Null when neither the
    /// roadmap board nor the repository says anything about it.
    pub readiness: Option<ReferenceReadinessDto>,
    /// Every engine gear this component is, usually one.
    pub engine: Vec<ReferenceEngineGearDto>,
    pub related: Vec<ReferenceRelatedCrateDto>,
    /// Whose catalogue it is in (ADR-0042): `platform` or `organization`.
    /// Null for a gear only the engine knows.
    pub tier: Option<String>,
}

/// What the entries were built from, and what could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
#[toolkit_macros::api_dto(response)]
pub struct ReferenceSourcesDto {
    /// `owner/repo@ref (commit)` of the engine's corpus. Null when Gearbox is
    /// off or its catalogue could not be read.
    pub gearbox_corpus: Option<String>,
    /// Why there are no engine facts, when there are none.
    pub gearbox_problem: Option<String>,
    /// The activity window in days; null when activity was not measured.
    pub activity_days: Option<u32>,
    pub activity_from: Option<String>,
    pub activity_to: Option<String>,
    /// Why there is no activity, when there is none.
    pub activity_problem: Option<String>,
    /// How many entries the default list leaves out: not components, and
    /// older copies of another. `?include=all` lists them with the reason.
    pub excluded: u32,
    /// Whether this answer came from the cache (built for the same catalogue
    /// generation and corpus commit).
    pub cached: bool,
}

/// The reference, whole: one answer for the whole list, so a client never
/// asks per row.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct ComponentReferenceListDto {
    pub items: Vec<ComponentReferenceDto>,
    pub total: u32,
    /// The component listing hit its cap: this is a prefix of the catalogue.
    pub truncated: bool,
    pub sources: ReferenceSourcesDto,
}

// ── the engine's catalogue, as much of it as the reference reads ───────────

#[derive(Debug, Clone, Default, Deserialize)]
struct RawPackage {
    #[serde(default)]
    crate_name: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawPoint {
    #[serde(default)]
    sdk: Option<RawPackage>,
    #[serde(default)]
    spec: Option<String>,
    #[serde(default)]
    sdk_lib: Option<String>,
    #[serde(default)]
    trait_ident: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawFills {
    #[serde(default)]
    spec: Option<String>,
    #[serde(default)]
    point: Option<RawPoint>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawGear {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    gdl_path: Option<String>,
    #[serde(default)]
    package: RawPackage,
    /// `implements` since gearbox#2; see `EngineGear::fills`.
    #[serde(default, alias = "implements")]
    fills: Option<RawFills>,
    #[serde(default)]
    extension_points: Vec<RawPoint>,
    #[serde(default)]
    runtime_caps: Vec<String>,
    #[serde(default)]
    colocated_deps: Vec<String>,
}

impl RawGear {
    fn crate_name(&self) -> Option<&str> {
        self.package.crate_name.as_deref().filter(|s| !s.is_empty())
    }

    /// The spec of the point this plugin fills: `fills.spec`, which is what
    /// the engine writes, or the joined point's own spec.
    fn fills_spec(&self) -> Option<&str> {
        let fills = self.fills.as_ref()?;
        fills
            .spec
            .as_deref()
            .or_else(|| fills.point.as_ref().and_then(|p| p.spec.as_deref()))
    }
}

/// The engine's gears, each parsed on its own: a descriptor this build cannot
/// read is skipped, not a reason to lose the other forty-three.
#[derive(Debug, Default)]
pub struct EngineIndex {
    gears: Vec<RawGear>,
}

impl EngineIndex {
    /// From `gearbox catalogue --format json`, as `/gearbox/catalogue` serves
    /// it under `catalogue`.
    pub fn from_catalogue(catalogue: &Value) -> Self {
        let mut gears: Vec<RawGear> = catalogue
            .get("gears")
            .and_then(Value::as_object)
            .map(|m| {
                m.values()
                    .filter_map(|v| serde_json::from_value::<RawGear>(v.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        gears.sort_by(|a, b| a.id.cmp(&b.id));
        Self { gears }
    }

    fn facts(&self, gear: &RawGear) -> ReferenceEngineGearDto {
        let fills = gear.fills_spec().map(str::to_string);
        let hosts: Vec<String> = match &fills {
            Some(spec) => self
                .gears
                .iter()
                .filter(|h| h.id != gear.id)
                .filter(|h| {
                    h.extension_points
                        .iter()
                        .any(|p| p.spec.as_deref() == Some(spec))
                })
                .map(|h| h.id.clone())
                .collect(),
            None => Vec::new(),
        };
        let specs: BTreeSet<&str> = gear
            .extension_points
            .iter()
            .filter_map(|p| p.spec.as_deref())
            .collect();
        let plugins: Vec<String> = self
            .gears
            .iter()
            .filter(|p| p.id != gear.id)
            .filter(|p| p.fills_spec().is_some_and(|s| specs.contains(s)))
            .map(|p| p.id.clone())
            .collect();
        ReferenceEngineGearDto {
            id: gear.id.clone(),
            display_name: gear.display_name.clone(),
            role: if gear.fills.is_some() {
                "plugin".to_string()
            } else {
                "service".to_string()
            },
            category: gear.category.clone(),
            gdl_path: gear.gdl_path.clone(),
            runtime_caps: gear.runtime_caps.clone(),
            colocated_deps: gear.colocated_deps.clone(),
            extension_points: gear
                .extension_points
                .iter()
                .filter_map(|p| {
                    Some(ReferenceExtensionPointDto {
                        spec: p.spec.clone()?,
                        interface: match (&p.sdk_lib, &p.trait_ident) {
                            (Some(lib), Some(t)) => Some(format!("{lib}::{t}")),
                            (None, Some(t)) => Some(t.clone()),
                            _ => None,
                        },
                        sdk_crate: p.sdk.as_ref().and_then(|s| s.crate_name.clone()),
                    })
                })
                .collect(),
            fills,
            hosts,
            plugins,
        }
    }

    fn by_id(&self, id: &str) -> Option<&RawGear> {
        self.gears.iter().find(|g| g.id == id)
    }
}

// ── building the reference ──────────────────────────────────────────────────

/// Everything the builder reads, gathered by the handler from the stores.
pub struct ReferenceInputs<'a> {
    pub nodes: &'a [CatalogNodeView],
    /// Profiles by the component name they describe (`gear_name`).
    pub profiles: &'a HashMap<String, Value>,
    pub schemas: &'a [TypeFieldSchema],
    pub engine: Option<&'a EngineIndex>,
    /// Activity rows by component name.
    pub activity: Option<&'a HashMap<String, ReferenceActivityDto>>,
}

fn text<'v>(value: &'v Value, key: &str) -> Option<&'v str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn number(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(Value::as_u64)
}

/// The directory a component was read from: the node's `repo_path`, or — for
/// a node synced before that field existed — the scan's `path` field in its
/// profile, which held the same directory.
fn directory_of(node: &Value, profile: Option<&Value>) -> Option<String> {
    if let Some(p) = text(node, "repo_path") {
        return Some(p.trim_matches('/').to_string());
    }
    let scanned = profile?
        .get("auto")?
        .get("path")?
        .get("v")?
        .as_str()?
        .trim();
    // An old flat `repository` URL copied into `path` is not a directory.
    (!scanned.is_empty() && !scanned.contains("://")).then(|| scanned.trim_matches('/').to_string())
}

/// The brief (`b`, else `v`) of one resolved field, as text.
fn brief<'v>(values: &'v serde_json::Map<String, Value>, key: &str) -> Option<&'v str> {
    values
        .get(key)
        .and_then(|f| f.get("b").or_else(|| f.get("v")))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn yes_no(values: &serde_json::Map<String, Value>, key: &str) -> Option<bool> {
    match brief(values, key) {
        Some("yes") => Some(true),
        Some("no") => Some(false),
        _ => None,
    }
}

/// The schema a component's profile is counted against: its type's, or the
/// gear schema for a type nobody described (the rule the portal renders by).
pub(crate) fn schema_for<'s>(
    schemas: &'s [TypeFieldSchema],
    type_id: &str,
) -> Option<&'s TypeFieldSchema> {
    schemas
        .iter()
        .find(|s| s.describes == type_id)
        .or_else(|| schemas.iter().find(|s| s.describes == gts::GEAR_TYPE))
        .filter(|s| s.fields().next().is_some())
}

/// `gts.cf.studio.catalog.frontx.v1~` → `frontx node`.
fn type_label(type_id: &str) -> String {
    let leaf = type_id
        .trim_end_matches('~')
        .rsplit("catalog.")
        .next()
        .unwrap_or(type_id);
    let leaf = leaf.strip_suffix(".v1").unwrap_or(leaf);
    format!("{leaf} node")
}

/// Why one node is not listed as a component of its own.
#[derive(Debug, Clone)]
struct Superseded {
    /// The node that is listed instead.
    by: usize,
    reason: String,
}

/// Which nodes are older copies of another, decided from what is stored — so
/// the read is clean before any re-sync, and a sync then deletes them for good
/// (`service::stale`, `service::misfiled_frontx`).
///
/// Two cases:
///
/// * **Two nodes, one name.** A FrontX package written as a gear node by an
///   old scan, and again as a micro-frontend node by the current one. The node
///   a scan recorded its source on wins; between two such, the one not filed
///   as a gear.
/// * **A guessed name.** A scan node keyed `cf-gears-<directory>` whose
///   directory holds a crate the engine names differently, when that crate is
///   catalogued under its own name too (`cf-gears-chat-engine` →
///   `cf-chat-engine`). When the real name is not catalogued, the node is kept
///   and takes the real name instead (`cf-gears-ledger` → `cf-gears-bss-ledger`).
fn superseded(
    nodes: &[CatalogNodeView],
    names: &[String],
    dirs: &[Option<String>],
    engine: Option<&EngineIndex>,
) -> Vec<Option<Superseded>> {
    let mut out: Vec<Option<Superseded>> = vec![None; nodes.len()];

    let mut by_name: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (i, n) in names.iter().enumerate() {
        by_name.entry(n.as_str()).or_default().push(i);
    }
    let score = |i: usize| {
        let recorded = text(&nodes[i].value, "synced_from").is_some();
        let not_gear = nodes[i].type_id != gts::GEAR_TYPE;
        (u8::from(recorded) << 1) | u8::from(not_gear)
    };
    for (name, group) in &by_name {
        if group.len() < 2 {
            continue;
        }
        let best = *group
            .iter()
            .max_by_key(|i| (score(**i), std::cmp::Reverse(**i)))
            .expect("a group has members");
        for &i in group.iter().filter(|i| **i != best) {
            out[i] = Some(Superseded {
                by: best,
                reason: format!(
                    "a second node for {name} ({}, {}); the {} one is kept",
                    type_label(&nodes[i].type_id),
                    if text(&nodes[i].value, "synced_from").is_some() {
                        "source recorded"
                    } else {
                        "written by an older scan, no source recorded"
                    },
                    if nodes[best].type_id == gts::FRONTX_TYPE {
                        "FrontX-typed"
                    } else {
                        "newer"
                    },
                ),
            });
        }
    }

    let Some(engine) = engine else {
        return out;
    };
    for (i, node) in nodes.iter().enumerate() {
        if out[i].is_some() || node.type_id != gts::GEAR_TYPE {
            continue;
        }
        let Some(dir) = dirs[i].as_deref() else {
            continue;
        };
        if engine
            .gears
            .iter()
            .any(|g| g.crate_name() == Some(names[i].as_str()))
        {
            continue; // its own name is a real crate
        }
        let slug = dir.rsplit('/').next().unwrap_or(dir);
        let own_package = |g: &&RawGear| {
            g.package
                .path
                .as_deref()
                .is_some_and(|p| p == dir || p == format!("{dir}/{slug}"))
        };
        let Some(real) = engine
            .gears
            .iter()
            .find(own_package)
            .and_then(RawGear::crate_name)
        else {
            continue;
        };
        if let Some(winner) = names.iter().position(|n| n == real)
            && winner != i
            && out[winner].is_none()
        {
            out[i] = Some(Superseded {
                by: winner,
                reason: format!(
                    "catalogued under the guessed name {}; the crate in {dir} is {real}, catalogued under its own name",
                    names[i]
                ),
            });
        }
    }
    out
}

/// Build the reference: every entry, components and not, each with its kind,
/// category and — for what is not a component of its own — the reason. The
/// handler decides what to show. Pure: it reads nothing but its inputs.
pub fn build(inputs: &ReferenceInputs<'_>) -> Vec<ComponentReferenceDto> {
    let nodes = inputs.nodes;
    let names: Vec<String> = nodes
        .iter()
        .map(|n| {
            text(&n.value, "name")
                .map(str::to_string)
                .unwrap_or_else(|| n.instance_id.clone())
        })
        .collect();
    let dirs: Vec<Option<String>> = nodes
        .iter()
        .zip(&names)
        .map(|(n, name)| directory_of(&n.value, inputs.profiles.get(name)))
        .collect();
    let gone = superseded(nodes, &names, &dirs, inputs.engine);
    let live = |i: usize| gone[i].is_none();

    // What a superseded node knew and its survivor did not (its profile, its
    // directory, its source) is lent to the survivor.
    let mut donors: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, g) in gone.iter().enumerate() {
        if let Some(s) = g {
            donors.entry(s.by).or_default().push(i);
        }
    }
    let profile_of = |i: usize| -> Option<&Value> {
        inputs.profiles.get(&names[i]).or_else(|| {
            donors
                .get(&i)?
                .iter()
                .find_map(|d| inputs.profiles.get(&names[*d]))
        })
    };
    let dir_of = |i: usize| -> Option<String> {
        dirs[i]
            .clone()
            .or_else(|| donors.get(&i)?.iter().find_map(|d| dirs[*d].clone()))
    };
    let lent = |i: usize, key: &str| -> Option<String> {
        text(&nodes[i].value, key).map(str::to_string).or_else(|| {
            donors
                .get(&i)?
                .iter()
                .find_map(|d| text(&nodes[*d].value, key).map(str::to_string))
        })
    };

    // Engine gears per live component: by crate name, then by directory.
    let mut claimed: Vec<Vec<String>> = vec![Vec::new(); nodes.len()];
    let mut orphans: Vec<&RawGear> = Vec::new();
    let mut canonical: Vec<Option<String>> = vec![None; nodes.len()];
    if let Some(engine) = inputs.engine {
        let mut by_path: Vec<&RawGear> = Vec::new();
        for gear in &engine.gears {
            match gear
                .crate_name()
                .and_then(|c| (0..nodes.len()).find(|i| live(*i) && names[*i] == c))
            {
                Some(i) => claimed[i].push(gear.id.clone()),
                None => by_path.push(gear),
            }
        }
        for gear in by_path {
            let Some(pkg) = gear.package.path.as_deref() else {
                orphans.push(gear);
                continue;
            };
            let hit = (0..nodes.len())
                .filter(|i| live(*i) && nodes[*i].type_id == gts::GEAR_TYPE)
                .filter(|i| {
                    claimed[*i].iter().all(|id| {
                        engine
                            .by_id(id)
                            .is_some_and(|g| g.crate_name() != Some(names[*i].as_str()))
                    })
                })
                .filter_map(|i| dirs[i].as_deref().map(|d| (i, d)))
                .filter(|(_, d)| pkg == *d || pkg.starts_with(&format!("{d}/")))
                .max_by_key(|(_, d)| d.len());
            match hit {
                Some((i, d)) => {
                    let slug = d.rsplit('/').next().unwrap_or(d);
                    if canonical[i].is_none() && (pkg == d || pkg == format!("{d}/{slug}")) {
                        canonical[i] = gear.crate_name().map(str::to_string);
                    }
                    claimed[i].push(gear.id.clone());
                }
                None => orphans.push(gear),
            }
        }
    }

    let display: Vec<String> = (0..nodes.len())
        .map(|i| canonical[i].clone().unwrap_or_else(|| names[i].clone()))
        .collect();
    let in_catalogue: BTreeSet<&str> = (0..nodes.len())
        .filter(|i| live(*i))
        .flat_map(|i| [names[i].as_str(), display[i].as_str()])
        .collect();
    let gear_of_crate: HashMap<&str, &str> = inputs
        .engine
        .map(|e| {
            e.gears
                .iter()
                .filter_map(|g| g.crate_name().map(|c| (c, g.id.as_str())))
                .collect()
        })
        .unwrap_or_default();

    let mut out: Vec<ComponentReferenceDto> = Vec::with_capacity(nodes.len() + orphans.len());
    for (i, node) in nodes.iter().enumerate() {
        let v = &node.value;
        if let Some(s) = &gone[i] {
            out.push(ComponentReferenceDto {
                name: names[i].clone(),
                instance_id: Some(node.instance_id.clone()),
                type_id: Some(node.type_id.clone()),
                kind: "superseded".to_string(),
                kind_reason: s.reason.clone(),
                component: false,
                excluded_reason: Some(format!("superseded by {}: {}", display[s.by], s.reason)),
                superseded_by: Some(display[s.by].clone()),
                ..ComponentReferenceDto::default()
            });
            continue;
        }
        let profile = profile_of(i);
        let mut values = super::values::resolve(v, profile);
        super::quality::attach(&mut values, schema_for(inputs.schemas, &node.type_id));
        let engine: Vec<ReferenceEngineGearDto> = inputs
            .engine
            .map(|e| {
                claimed[i]
                    .iter()
                    .filter_map(|id| e.by_id(id))
                    .map(|g| e.facts(g))
                    .collect()
            })
            .unwrap_or_default();
        let dir = dir_of(i);

        let released = text(v, "max_stable_version")
            .or_else(|| text(v, "newest_version"))
            .or_else(|| text(v, "max_version"));
        let declared = brief(&values, "version");
        let (version, version_source) = match (released, declared) {
            (Some(r), _) => (Some(r.to_string()), Some("crates.io".to_string())),
            (None, Some(d)) => (Some(d.to_string()), Some("declared".to_string())),
            (None, None) => (None, None),
        };

        let scanned_as = profile.and_then(|p| text(p, "source"));
        let mut sources: Vec<String> = Vec::new();
        if released.is_some() || v.get("downloads").is_some() {
            sources.push("crates.io".to_string());
        }
        if node.type_id == gts::KIT_TYPE {
            sources.push("kit manifest".to_string());
        } else if lent(i, "synced_from").is_some()
            || profile.is_some_and(|p| p.get("auto").is_some())
        {
            sources.push("repository".to_string());
        }
        if !engine.is_empty() {
            sources.push("gearbox".to_string());
        }

        // ── kind ─────────────────────────────────────────────────────────
        let is_npm = node.type_id == gts::FRONTX_TYPE
            || names[i].starts_with('@')
            || scanned_as == Some("frontx")
            || text(v, "kind") == Some("frontx");
        let roles: Vec<&str> = engine.iter().map(|g| g.role.as_str()).collect();
        let engine_category = engine
            .iter()
            .find(|g| g.role == "service")
            .or_else(|| engine.first())
            .and_then(|g| g.category.as_deref());
        let classified = taxonomy::classify(&taxonomy::Evidence {
            name: &display[i],
            is_kit: node.type_id == gts::KIT_TYPE,
            is_npm,
            path: dir.as_deref(),
            gear_toml: scanned_as == Some("gears"),
            gear_toml_plugin: yes_no(&values, "is_plugin"),
            manifest: brief(&values, "manifest"),
            engine_roles: roles,
            engine_category,
            stored_kind: text(v, "kind"),
            npm_bin: yes_no(&values, "npm_bin"),
            npm_mfe: yes_no(&values, "npm_mfe"),
            npm_private: yes_no(&values, "npm_private"),
        });

        // ── category ─────────────────────────────────────────────────────
        let registry: Vec<&str> = v
            .get("categories")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let scan_category = profile
            .and_then(|p| p.get("auto"))
            .and_then(|a| a.get("category"))
            .and_then(|c| c.get("b").or_else(|| c.get("v")))
            .and_then(Value::as_str)
            .or_else(|| text(v, "category"));
        let host = inputs.engine.and_then(|e| {
            engine.iter().flat_map(|g| g.hosts.iter()).find_map(|h| {
                let host = e.by_id(h)?;
                Some((
                    host.category.as_deref()?,
                    host.crate_name().unwrap_or(h.as_str()),
                ))
            })
        });
        let categorised = if is_npm {
            // npm keywords (`hai3`, `eslint`) are tags, not platform categories.
            taxonomy::Categorised {
                category: None,
                reason: None,
            }
        } else {
            let scanned =
                scan_category.map(|c| (c, brief(&values, "manifest").unwrap_or("gear.toml")));
            taxonomy::categorise(engine_category, scanned, host, &registry)
        };
        let mut source_categories: Vec<String> = registry.iter().map(|s| s.to_string()).collect();
        if let Some(c) = scan_category
            && !taxonomy::is_category(c)
            && !source_categories.iter().any(|s| s == c)
        {
            source_categories.push(c.to_string());
        }

        let (profile_filled, profile_fields) = match schema_for(inputs.schemas, &node.type_id) {
            Some(schema) => {
                let fields: Vec<&str> = schema.fields().map(|f| f.key.as_str()).collect();
                let filled = fields
                    .iter()
                    .filter(|k| values.get(**k).is_some_and(|x| !x.is_null()))
                    .count();
                (u32::try_from(filled).ok(), u32::try_from(fields.len()).ok())
            }
            None => (None, None),
        };
        let description = text(v, "description").map(str::to_string).or_else(|| {
            values
                .get("description")
                .and_then(|f| f.get("v"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        let updated_at = text(v, "updated_at").map(str::to_string).or_else(|| {
            values
                .get("lastchange")
                .and_then(|f| f.get("u").or_else(|| f.get("v")))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        let title = engine
            .first()
            .and_then(|g| g.display_name.clone())
            .or_else(|| {
                text(v, "title")
                    .filter(|t| *t != names[i] && *t != display[i])
                    .map(str::to_string)
            });
        let related = related_crates(
            &display[i],
            v,
            &engine,
            inputs.engine,
            &in_catalogue,
            &gear_of_crate,
            nodes,
            &names,
        );
        let kind = classified.kind;
        out.push(ComponentReferenceDto {
            name: display[i].clone(),
            aka: if display[i] == names[i] {
                Vec::new()
            } else {
                vec![names[i].clone()]
            },
            instance_id: Some(node.instance_id.clone()),
            title,
            type_id: Some(node.type_id.clone()),
            kind: kind.as_str().to_string(),
            kind_reason: classified.reason.clone(),
            component: kind.is_component(),
            excluded_reason: (!kind.is_component())
                .then(|| format!("not a component ({kind}): {}", classified.reason)),
            superseded_by: None,
            category: categorised.category,
            category_reason: categorised.reason,
            source_categories,
            description,
            status: lent(i, "status"),
            version,
            version_source,
            num_versions: number(v, "num_versions"),
            downloads: number(v, "downloads"),
            recent_downloads: number(v, "recent_downloads"),
            updated_at,
            repository: text(v, "repository").map(str::to_string),
            repo_path: dir,
            synced_from: lent(i, "synced_from"),
            sources,
            profile_filled,
            profile_fields,
            activity: inputs
                .activity
                .and_then(|a| a.get(&names[i]).or_else(|| a.get(&display[i])).cloned()),
            // Read off the same resolved values, so a superseded node's
            // profile, lent to its survivor, carries its readiness along.
            readiness: readiness_of(&values),
            engine,
            related,
            tier: text(v, "tier").map(str::to_string),
        });
    }

    // Gears only the engine describes: listed, so they can still be put into
    // a product, with every portal fact null rather than invented.
    if let Some(engine) = inputs.engine {
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for gear in orphans {
            let name = gear
                .crate_name()
                .map(str::to_string)
                .unwrap_or_else(|| gear.id.clone());
            // Two engine gears in one unlisted crate: one entry, both gears.
            if !seen.insert(name.clone()) {
                if let Some(entry) = out.iter_mut().find(|e| e.name == name) {
                    entry.engine.push(engine.facts(gear));
                }
                continue;
            }
            let facts = engine.facts(gear);
            let related = related_crates(
                &name,
                &Value::Null,
                std::slice::from_ref(&facts),
                Some(engine),
                &in_catalogue,
                &gear_of_crate,
                nodes,
                &names,
            );
            let classified = taxonomy::classify(&taxonomy::Evidence {
                name: &name,
                path: gear.package.path.as_deref(),
                engine_roles: vec![facts.role.as_str()],
                engine_category: gear.category.as_deref(),
                ..taxonomy::Evidence::default()
            });
            let categorised = taxonomy::categorise(gear.category.as_deref(), None, None, &[]);
            let kind = classified.kind;
            out.push(ComponentReferenceDto {
                name,
                title: gear.display_name.clone(),
                kind: kind.as_str().to_string(),
                kind_reason: classified.reason.clone(),
                component: kind.is_component(),
                excluded_reason: (!kind.is_component())
                    .then(|| format!("not a component ({kind}): {}", classified.reason)),
                category: categorised.category,
                category_reason: categorised.reason,
                source_categories: gear
                    .category
                    .iter()
                    .filter(|c| !taxonomy::is_category(c))
                    .cloned()
                    .collect(),
                description: gear.description.clone(),
                repo_path: gear.package.path.clone(),
                sources: vec!["gearbox".to_string()],
                engine: vec![facts],
                related,
                ..ComponentReferenceDto::default()
            });
        }
    }

    // An SDK is filed where its gear is: the gear that names it as its SDK.
    let owners: HashMap<String, (String, String)> = out
        .iter()
        .filter(|e| e.component && e.kind != "sdk")
        .filter_map(|e| Some((e.category.clone()?, e)))
        .flat_map(|(c, e)| {
            e.related
                .iter()
                .filter(|r| r.role == "sdk")
                .map(move |r| (r.name.clone(), (c.clone(), e.name.clone())))
        })
        .collect();
    for e in out
        .iter_mut()
        .filter(|e| e.kind == "sdk" && e.category.is_none())
    {
        if let Some((c, of)) = owners.get(&e.name) {
            e.category = Some(c.clone());
            e.category_reason = Some(format!("the category of {of}"));
        }
    }

    out.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then(a.component.cmp(&b.component).reverse())
    });
    out
}

/// A component's readiness, read off its resolved profile values: the
/// roadmap board's fields and the repository scan's lifecycle, release and
/// dependents. Null when none of them has an answer.
pub(crate) fn readiness_of(
    values: &serde_json::Map<String, Value>,
) -> Option<ReferenceReadinessDto> {
    let field = |k: &str| values.get(k).filter(|v| !v.is_null());
    let brief = |k: &str| {
        field(k)
            .and_then(|v| v.get("b").or_else(|| v.get("v")))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let part = |k: &str, p: &str| {
        field(k)
            .and_then(|v| v.get(p))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    // `In Dev (3 of 6)`: where in the pipeline.
    let (stage_at, stage_of) = part("stage", "v")
        .and_then(|v| {
            let tail = v.rsplit_once('(')?.1.trim_end_matches(')').to_string();
            let (at, of) = tail.split_once(" of ")?;
            Some((at.trim().parse().ok()?, of.trim().parse().ok()?))
        })
        .map_or((None, None), |(a, o)| (Some(a), Some(o)));
    let array = |k: &str| {
        field(k)
            .and_then(|v| v.get("parts"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let demand: Vec<ReferenceDemandDto> = array("demand")
        .iter()
        .filter_map(|p| {
            Some(ReferenceDemandDto {
                consumer: p.get("consumer")?.as_str()?.to_string(),
                priority: u32::try_from(p.get("priority")?.as_u64()?).ok()?,
            })
        })
        .collect();
    let progress: Vec<ReferenceAxisDto> = array("roadmap_progress")
        .iter()
        .filter_map(|p| {
            Some(ReferenceAxisDto {
                label: p.get("label")?.as_str()?.to_string(),
                value: p.get("value")?.as_str()?.to_string(),
                pct: p
                    .get("pct")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok()),
            })
        })
        .collect();
    let plan = brief("convergence");
    // The reasons are only reasons when the lamp is not green: a green plan's
    // `v` is its brief repeated.
    let plan_lamp = part("convergence", "s");
    let plan_reasons: Vec<String> = match plan_lamp.as_deref() {
        Some("bad" | "watch") => part("convergence", "v")
            .map(|v| v.split("; ").map(str::to_string).collect())
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    let out = ReferenceReadinessDto {
        stage: brief("stage"),
        stage_at,
        stage_of,
        lifecycle: brief("lifecycle"),
        milestone: brief("milestone"),
        due: part("milestone", "u"),
        committed: brief("commitment").map(|c| c == "committed"),
        plan,
        plan_lamp,
        plan_reasons,
        demand,
        progress,
        last_release: brief("lastrelease"),
        released_on: part("lastrelease", "u"),
        used_by: field("consumers")
            .and_then(|v| v.get("n"))
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok()),
        roadmap_item: part("roadmap_item", "l"),
        grade: brief("grade"),
        grade_fixes: field("grade")
            .and_then(|g| g.get("parts"))
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter(|p| p.get("pass") == Some(&Value::Bool(false)))
                    .filter_map(|p| p.get("fix").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    };
    let empty = out.stage.is_none()
        && out.lifecycle.is_none()
        && out.milestone.is_none()
        && out.plan.is_none()
        && out.demand.is_empty()
        && out.progress.is_empty()
        && out.last_release.is_none()
        && out.grade.is_none();
    (!empty).then_some(out)
}

/// The crates that belong with one component, each named from a source that
/// states it — never from a naming convention alone:
///
/// * the other crates its directory declares (`crate_names`, read from the
///   manifests by the scan);
/// * the SDKs its engine gears declare extension points in, and the SDK a
///   plugin's point lives in;
/// * the plugins that fill its points, by their crates;
/// * `<name>-sdk`, only when the catalogue lists such a crate from the same
///   repository — an existing crate, not a guessed one.
#[allow(clippy::too_many_arguments)]
fn related_crates(
    name: &str,
    node: &Value,
    engine_facts: &[ReferenceEngineGearDto],
    engine: Option<&EngineIndex>,
    in_catalogue: &BTreeSet<&str>,
    gear_of_crate: &HashMap<&str, &str>,
    nodes: &[CatalogNodeView],
    names: &[String],
) -> Vec<ReferenceRelatedCrateDto> {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    let mut add = |crate_name: &str, role: &str| {
        if crate_name != name && !crate_name.is_empty() {
            out.entry(crate_name.to_string())
                .or_insert_with(|| role.to_string());
        }
    };

    if let Some(list) = node.get("crate_names").and_then(Value::as_array) {
        for c in list.iter().filter_map(Value::as_str) {
            add(c, if c.ends_with("-sdk") { "sdk" } else { "crate" });
        }
    }
    for facts in engine_facts {
        for point in &facts.extension_points {
            if let Some(sdk) = &point.sdk_crate {
                add(sdk, "sdk");
            }
        }
        if let Some(engine) = engine {
            if let Some(gear) = engine.by_id(&facts.id)
                && let Some(sdk) = gear
                    .fills
                    .as_ref()
                    .and_then(|f| f.point.as_ref())
                    .and_then(|p| p.sdk.as_ref())
                    .and_then(|s| s.crate_name.as_deref())
            {
                add(sdk, "implements");
            }
            for plugin in &facts.plugins {
                if let Some(c) = engine.by_id(plugin).and_then(RawGear::crate_name) {
                    add(c, "plugin");
                }
            }
        }
    }
    let sdk = format!("{name}-sdk");
    if !name.ends_with("-sdk")
        && let Some(i) = names.iter().position(|n| *n == sdk)
    {
        let repo = |v: &Value| text(v, "repository").map(|r| r.trim_end_matches('/').to_string());
        let own = repo(node).or_else(|| {
            names
                .iter()
                .position(|n| n == name)
                .and_then(|j| repo(&nodes[j].value))
        });
        if own.is_some() && own == repo(&nodes[i].value) {
            add(&sdk, "sdk");
        }
    }

    out.into_iter()
        .map(|(crate_name, role)| ReferenceRelatedCrateDto {
            in_catalogue: in_catalogue.contains(crate_name.as_str()),
            gear_id: gear_of_crate
                .get(crate_name.as_str())
                .map(|s| (*s).to_string()),
            name: crate_name,
            role,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_engine_plugin_is_read_under_implements_too() {
        let gear: RawGear = serde_json::from_value(json!({
            "id": "static-authn-plugin",
            "package": {"crate_name": "cf-gears-static-authn-plugin"},
            "implements": {"spec": "cf.core.authn_resolver.plugin.v1~"}
        }))
        .expect("an engine gear with `implements` deserializes");
        assert_eq!(gear.fills_spec(), Some("cf.core.authn_resolver.plugin.v1~"));
    }

    fn node(type_id: &'static str, value: Value) -> CatalogNodeView {
        CatalogNodeView {
            type_id: type_id.to_string(),
            instance_id: value["name"].as_str().unwrap_or("x").to_string(),
            value,
        }
    }

    /// A slice of the real engine catalogue (`MikeFalcon77/gears-rust@feature/gearbox`,
    /// read from `/gearbox/catalogue` on the local stack, 2026-09-29).
    fn engine() -> EngineIndex {
        let idp_spec = "cf.toolkit.plugins.plugin.v1~cf.core.idp.plugin.v1~";
        let am_sdk = json!({ "crate_name": "cf-gears-account-management-sdk", "path": "gears/system/account-management/account-management-sdk" });
        EngineIndex::from_catalogue(&json!({
            "gears": {
                "account-management": {
                    "id": "account-management",
                    "display_name": "Account Management",
                    "category": "oss",
                    "gdl_path": "gears/system/account-management/account-management/gear.gdl",
                    "package": { "crate_name": "cf-gears-account-management", "path": "gears/system/account-management/account-management" },
                    "extension_points": [{ "sdk": am_sdk, "sdk_lib": "account_management_sdk", "spec": idp_spec, "trait_ident": "IdpPluginClient" }],
                    "runtime_caps": ["db", "rest", "stateful"],
                    "colocated_deps": ["types-registry"]
                },
                "keycloak-idp-plugin": {
                    "id": "keycloak-idp-plugin",
                    "display_name": "Keycloak IdP Plugin",
                    "package": { "crate_name": "cf-gears-keycloak-idp-plugin", "path": "gears/system/account-management/plugins/keycloak-idp-plugin" },
                    "fills": { "spec": idp_spec, "point": { "sdk": am_sdk, "spec": idp_spec, "trait_ident": "IdpPluginClient" } }
                },
                "bss-ledger": {
                    "id": "bss-ledger",
                    "display_name": "Ledger",
                    "package": { "crate_name": "cf-gears-bss-ledger", "path": "gears/bss/ledger/ledger" }
                },
                "mini-chat": {
                    "id": "mini-chat",
                    "package": { "crate_name": "cf-gears-mini-chat", "path": "gears/mini-chat/mini-chat" }
                },
                "static-mini-chat-audit-plugin": {
                    "id": "static-mini-chat-audit-plugin",
                    "package": { "crate_name": "cf-gears-mini-chat", "path": "gears/mini-chat/mini-chat" },
                    "fills": { "spec": "cf.toolkit.plugins.plugin.v1~cf.core.mini_chat_audit.plugin.v1~" }
                },
                "chat-engine": {
                    "id": "chat-engine",
                    "category": "gen-ai",
                    "package": { "crate_name": "cf-chat-engine", "path": "gears/chat-engine/chat-engine" }
                },
                "api-contracts": {
                    "id": "api-contracts",
                    "description": "An example",
                    "category": "example",
                    "package": { "crate_name": "cf-api-contracts", "path": "examples/toolkit/api-contracts/api-contracts" }
                },
                "broken": { "no_id": true }
            }
        }))
    }

    fn catalogue() -> Vec<CatalogNodeView> {
        vec![
            node(
                gts::GEAR_TYPE,
                json!({
                    "name": "cf-gears-account-management", "kind": "gear", "category": "oss",
                    "max_stable_version": "0.10.0", "num_versions": 12, "downloads": 792,
                    "repository": "https://github.com/constructorfabric/gears-rust",
                    "synced_from": "constructorfabric/gears-rust",
                    "repo_path": "gears/system/account-management",
                    "crate_names": ["cf-gears-account-management", "cf-gears-account-management-sdk"]
                }),
            ),
            node(
                gts::GEAR_TYPE,
                json!({
                    "name": "cf-gears-account-management-sdk", "kind": "sdk", "max_version": "0.7.5",
                    "downloads": 1048, "repository": "https://github.com/constructorfabric/gears-rust"
                }),
            ),
            node(
                gts::GEAR_TYPE,
                json!({ "name": "cf-gears-keycloak-idp-plugin", "kind": "plugin", "newest_version": "0.1.7", "downloads": 210 }),
            ),
            // Catalogued before the scan read crate names: the directory guess.
            node(
                gts::GEAR_TYPE,
                json!({ "name": "cf-gears-ledger", "kind": "gear", "status": "published", "synced_from": "constructorfabric/gears-rust" }),
            ),
            node(
                gts::GEAR_TYPE,
                json!({ "name": "cf-gears-mini-chat", "kind": "gear", "max_stable_version": "0.4.5" }),
            ),
            node(
                gts::FRONTX_TYPE,
                json!({ "name": "@gears-frontx/ui-kit", "kind": "frontx", "category": "hai3", "synced_from": "constructorfabric/gears-frontx" }),
            ),
            // The same package, written as a gear node by an older scan.
            node(
                gts::GEAR_TYPE,
                json!({ "name": "@gears-frontx/ui-kit", "kind": "frontx", "category": "frontx" }),
            ),
            node(
                gts::FRONTX_TYPE,
                json!({ "name": "@gears-frontx/eslint-config", "kind": "frontx", "category": "eslint", "synced_from": "constructorfabric/gears-frontx", "repo_path": "internal/eslint-config" }),
            ),
            // One gear, twice: crates.io under its real name, the scan under
            // the directory guess.
            node(
                gts::GEAR_TYPE,
                json!({ "name": "cf-chat-engine", "kind": "gear", "categories": ["Artificial intelligence"], "max_stable_version": "0.3.8", "downloads": 583 }),
            ),
            node(
                gts::GEAR_TYPE,
                json!({ "name": "cf-gears-chat-engine", "kind": "gear", "status": "published", "synced_from": "constructorfabric/gears-rust" }),
            ),
            node(
                gts::GEAR_TYPE,
                json!({ "name": "cf-gears-rustls-fips-shim", "kind": "gear", "max_stable_version": "0.1.2" }),
            ),
            node(
                gts::GEAR_TYPE,
                json!({ "name": "cf-gears-cluster-conformance", "kind": "gear", "categories": ["Development tools"], "max_stable_version": "0.3.8" }),
            ),
        ]
    }

    fn profiles() -> HashMap<String, Value> {
        HashMap::from([
            (
                "cf-gears-ledger".to_string(),
                json!({ "gear_name": "cf-gears-ledger", "auto": { "path": { "v": "gears/bss/ledger", "b": "gears/bss/ledger" } } }),
            ),
            (
                "cf-gears-chat-engine".to_string(),
                json!({ "gear_name": "cf-gears-chat-engine", "source": "gears", "auto": {
                    "path": { "v": "gears/chat-engine", "b": "gears/chat-engine" },
                    "adr": { "v": "28", "b": "28", "n": 28 },
                    "stage": { "b": "In Dev", "v": "In Dev (3 of 6)" }
                } }),
            ),
            (
                "@gears-frontx/ui-kit".to_string(),
                json!({ "gear_name": "@gears-frontx/ui-kit", "auto": {
                    "path": { "v": "packages/ui-kit", "b": "packages/ui-kit" },
                    "version": { "v": "0.4.0-alpha.1", "b": "0.4.0-alpha.1" }
                } }),
            ),
        ])
    }

    fn built(engine: Option<&EngineIndex>) -> Vec<ComponentReferenceDto> {
        let nodes = catalogue();
        let profiles = profiles();
        let activity = HashMap::from([(
            "cf-gears-account-management".to_string(),
            ReferenceActivityDto {
                commits: 7,
                files_changed: 20,
                lines_added: 300,
                lines_removed: 40,
                authors: 3,
            },
        )]);
        build(&ReferenceInputs {
            nodes: &nodes,
            profiles: &profiles,
            schemas: &super::super::field_schema::builtin_schemas(),
            engine,
            activity: Some(&activity),
        })
    }

    #[test]
    fn readiness_is_read_off_the_profile_and_absent_when_nothing_answers() {
        let values: serde_json::Map<String, Value> = serde_json::from_value(serde_json::json!({
            "stage": { "b": "In Dev", "v": "In Dev (3 of 6)" },
            "milestone": { "b": "26.10", "v": "26.10 — due 2026-10-31", "u": "2026-10-31", "s": "good" },
            "commitment": { "b": "not committed" },
            "convergence": { "b": "check", "s": "watch", "v": "P1 for Acronis, but the date is not a commitment; the issue is closed but the board still says In Dev" },
            "demand": { "b": "Acronis P1", "parts": [{ "letter": "A", "consumer": "Acronis", "priority": 1 }] },
            "roadmap_progress": { "b": "Design Done", "parts": [{ "label": "Design", "value": "Done", "pct": 100 }, { "label": "SDK", "value": "N/A", "pct": null }] },
            "lifecycle": { "b": "in qa" },
            "lastrelease": { "b": "v0.2.8", "u": "2026-09-23" },
            "consumers": { "b": "3", "n": 3 },
            "roadmap_item": { "b": "#2890 CORE - Events Broker", "l": "https://github.com/o/r/issues/2890" }
        }))
        .unwrap();
        let r = readiness_of(&values).unwrap();
        assert_eq!(r.stage.as_deref(), Some("In Dev"));
        assert_eq!((r.stage_at, r.stage_of), (Some(3), Some(6)));
        assert_eq!(r.due.as_deref(), Some("2026-10-31"));
        assert_eq!(r.committed, Some(false));
        assert_eq!(r.plan_lamp.as_deref(), Some("watch"));
        assert_eq!(r.plan_reasons.len(), 2);
        assert_eq!(
            r.demand,
            vec![ReferenceDemandDto {
                consumer: "Acronis".into(),
                priority: 1
            }]
        );
        assert_eq!(r.progress[1].pct, None);
        assert_eq!(r.released_on.as_deref(), Some("2026-09-23"));
        assert_eq!(r.used_by, Some(3));
        assert_eq!(
            r.roadmap_item.as_deref(),
            Some("https://github.com/o/r/issues/2890")
        );

        // A green plan carries no reasons.
        let mut green = values.clone();
        green.insert(
            "convergence".into(),
            serde_json::json!({ "b": "on track", "s": "good", "v": "on track" }),
        );
        assert!(readiness_of(&green).unwrap().plan_reasons.is_empty());

        // Nothing about readiness: no block at all.
        let bare: serde_json::Map<String, Value> = serde_json::from_value(
            serde_json::json!({ "description": { "b": "x" }, "consumers": { "n": 0 } }),
        )
        .unwrap();
        assert!(readiness_of(&bare).is_none());
    }

    fn entry<'a>(all: &'a [ComponentReferenceDto], name: &str) -> &'a ComponentReferenceDto {
        all.iter()
            .find(|e| e.name == name)
            .unwrap_or_else(|| panic!("no entry {name}"))
    }

    #[test]
    fn an_engine_gear_joins_its_component_by_crate_name() {
        let e = engine();
        let all = built(Some(&e));
        let am = entry(&all, "cf-gears-account-management");
        assert_eq!(am.engine.len(), 1);
        let facts = &am.engine[0];
        assert_eq!(facts.id, "account-management");
        assert_eq!(facts.role, "service");
        assert_eq!(facts.plugins, ["keycloak-idp-plugin"]);
        assert_eq!(
            facts.extension_points[0].interface.as_deref(),
            Some("account_management_sdk::IdpPluginClient")
        );
        assert_eq!(am.title.as_deref(), Some("Account Management"));
        assert_eq!(am.sources, ["crates.io", "repository", "gearbox"]);
        assert_eq!(am.activity.as_ref().map(|a| a.commits), Some(7));

        let kc = entry(&all, "cf-gears-keycloak-idp-plugin");
        assert_eq!(kc.engine[0].role, "plugin");
        assert_eq!(kc.engine[0].hosts, ["account-management"]);
    }

    #[test]
    fn a_gear_s_related_crates_are_its_sdk_and_its_plugins() {
        let e = engine();
        let all = built(Some(&e));
        let am = entry(&all, "cf-gears-account-management");
        let related: Vec<(&str, &str, bool)> = am
            .related
            .iter()
            .map(|r| (r.name.as_str(), r.role.as_str(), r.in_catalogue))
            .collect();
        assert_eq!(
            related,
            [
                ("cf-gears-account-management-sdk", "sdk", true),
                ("cf-gears-keycloak-idp-plugin", "plugin", true),
            ]
        );
        let kc = entry(&all, "cf-gears-keycloak-idp-plugin");
        assert_eq!(kc.related[0].name, "cf-gears-account-management-sdk");
        assert_eq!(kc.related[0].role, "implements");
    }

    #[test]
    fn a_component_keyed_by_the_old_directory_guess_joins_by_directory() {
        let e = engine();
        let all = built(Some(&e));
        let ledger = entry(&all, "cf-gears-bss-ledger");
        assert_eq!(ledger.engine.len(), 1);
        assert_eq!(ledger.engine[0].id, "bss-ledger");
        assert_eq!(
            ledger.aka,
            ["cf-gears-ledger"],
            "listed under the real crate name"
        );
        assert!(
            all.iter().all(|x| x.name != "cf-gears-ledger"),
            "joined, so not listed a second time"
        );
    }

    #[test]
    fn one_crate_can_be_several_engine_gears() {
        let e = engine();
        let all = built(Some(&e));
        let chat = entry(&all, "cf-gears-mini-chat");
        let ids: Vec<&str> = chat.engine.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["mini-chat", "static-mini-chat-audit-plugin"]);
    }

    #[test]
    fn a_gear_only_the_engine_knows_is_listed_with_null_portal_facts() {
        let e = engine();
        let all = built(Some(&e));
        let only = entry(&all, "cf-api-contracts");
        assert_eq!(only.type_id, None);
        assert_eq!(
            only.kind, "example",
            "its gear.gdl files it under `example`"
        );
        assert!(!only.component);
        assert_eq!(only.downloads, None);
        assert_eq!(only.version, None);
        assert_eq!(only.activity, None);
        assert_eq!(only.profile_fields, None);
        assert_eq!(only.sources, ["gearbox"]);
        assert_eq!(only.engine[0].id, "api-contracts");
        assert_eq!(
            e.gears.len(),
            7,
            "the unparseable descriptor is skipped, not fatal"
        );
    }

    #[test]
    fn a_second_node_for_the_same_package_is_superseded() {
        let all = built(None);
        let copies: Vec<&ComponentReferenceDto> = all
            .iter()
            .filter(|e| e.name == "@gears-frontx/ui-kit")
            .collect();
        assert_eq!(copies.len(), 2);
        let old = copies.iter().find(|e| !e.component).unwrap();
        assert_eq!(old.kind, "superseded");
        assert_eq!(old.type_id.as_deref(), Some(gts::GEAR_TYPE));
        assert_eq!(old.superseded_by.as_deref(), Some("@gears-frontx/ui-kit"));
        assert!(
            old.excluded_reason
                .as_deref()
                .unwrap()
                .contains("older scan")
        );
    }

    #[test]
    fn a_guessed_name_is_superseded_by_the_real_crate_which_inherits_its_scan() {
        let e = engine();
        let all = built(Some(&e));
        let guessed = entry(&all, "cf-gears-chat-engine");
        assert_eq!(guessed.superseded_by.as_deref(), Some("cf-chat-engine"));
        assert!(guessed.kind_reason.contains("guessed name"));
        let real = entry(&all, "cf-chat-engine");
        assert!(real.component);
        assert_eq!(real.kind, "gear");
        assert_eq!(real.category.as_deref(), Some("gen-ai"));
        assert_eq!(real.category_reason.as_deref(), Some("gear.gdl"));
        assert_eq!(
            real.repo_path.as_deref(),
            Some("gears/chat-engine"),
            "the scan's directory"
        );
        assert_eq!(
            real.synced_from.as_deref(),
            Some("constructorfabric/gears-rust")
        );
        assert_eq!(real.status.as_deref(), Some("published"));
        assert!(real.sources.contains(&"repository".to_string()));
        // Readiness is read off the lent profile too: the survivor says where
        // the gear is, not only the node that was superseded.
        assert_eq!(
            real.readiness.as_ref().and_then(|r| r.stage.as_deref()),
            Some("In Dev")
        );
    }

    #[test]
    fn crates_that_are_not_gears_are_classified_by_evidence() {
        let all = built(None);
        let shim = entry(&all, "cf-gears-rustls-fips-shim");
        assert_eq!(shim.kind, "library");
        assert!(shim.component);
        let conf = entry(&all, "cf-gears-cluster-conformance");
        assert_eq!(conf.kind, "test-support");
        assert!(!conf.component);
        assert!(
            conf.excluded_reason
                .as_deref()
                .unwrap()
                .starts_with("not a component (test-support)")
        );
        assert_eq!(entry(&all, "@gears-frontx/eslint-config").kind, "config");
    }

    #[test]
    fn plugins_and_sdks_are_filed_under_their_gear_s_category() {
        let e = engine();
        let all = built(Some(&e));
        let kc = entry(&all, "cf-gears-keycloak-idp-plugin");
        assert_eq!(kc.category.as_deref(), Some("oss"));
        assert_eq!(
            kc.category_reason.as_deref(),
            Some("the category of cf-gears-account-management")
        );
        let sdk = entry(&all, "cf-gears-account-management-sdk");
        assert_eq!(sdk.kind, "sdk");
        assert_eq!(sdk.category.as_deref(), Some("oss"));
    }

    #[test]
    fn unknown_numbers_are_null_not_zero() {
        let all = built(None);
        let ledger = entry(&all, "cf-gears-ledger");
        assert_eq!(ledger.downloads, None);
        assert_eq!(ledger.num_versions, None);
        assert_eq!(ledger.version, None);
        assert_eq!(ledger.activity, None);
        assert!(ledger.engine.is_empty());
        assert_eq!(ledger.status.as_deref(), Some("published"));
    }

    #[test]
    fn a_frontx_package_shows_its_declared_version_and_its_kind_not_its_keyword() {
        let all = built(None);
        let ui = all
            .iter()
            .find(|e| e.name == "@gears-frontx/ui-kit" && e.component)
            .expect("the live ui-kit entry");
        assert_eq!(ui.kind, "frontend-library");
        assert_eq!(ui.category, None, "an npm keyword is not a category");
        assert_eq!(ui.source_categories, ["hai3"]);
        assert_eq!(ui.version.as_deref(), Some("0.4.0-alpha.1"));
        assert_eq!(ui.version_source.as_deref(), Some("declared"));
        assert_eq!(ui.repo_path.as_deref(), Some("packages/ui-kit"));
    }

    #[test]
    fn the_profile_ratio_counts_the_type_s_schema_fields() {
        let all = built(None);
        let am = entry(&all, "cf-gears-account-management");
        let (filled, fields) = (am.profile_filled.unwrap(), am.profile_fields.unwrap());
        assert!(
            fields > 10,
            "the gear schema has dozens of fields, got {fields}"
        );
        assert!(filled > 0 && filled < fields, "{filled}/{fields}");
    }

    #[test]
    fn without_gearbox_there_are_no_engine_facts_and_no_engine_only_entries() {
        let all = built(None);
        assert_eq!(all.len(), catalogue().len());
        assert!(all.iter().all(|e| e.engine.is_empty()));
        // The SDK is still named: the scan read it from the manifests.
        let am = entry(&all, "cf-gears-account-management");
        assert_eq!(am.related.len(), 1);
        assert_eq!(am.related[0].role, "sdk");
    }
}
