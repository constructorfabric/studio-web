//! The platform's components and the organization's, read together
//! (ADR-0042 §1, §3).
//!
//! The platform's catalogue is synced once, in the platform's (root) tenant,
//! from sources only a platform administrator names. Every organization reads
//! it beside its own catalogue, and never writes it: what an organization
//! keeps of its own about a platform component is its annotations -- the
//! profile's `values` layer -- stored in the organization's tenant under the
//! same gear name.
//!
//! The rules, all here and nowhere else:
//!
//! - **One component, one tier.** The platform wins a name it has: an
//!   organization's node of the same name (case-insensitive) is left out of
//!   the organization's reads and counted as `shadowed`, so a screen can say
//!   so. A node with no name is never shadowed.
//! - **Annotations over facts.** A platform component's profile is the
//!   platform's (`auto`, `uml`, ...) with the organization's profile laid over
//!   it: its `values` key by key, and every other key it sets except the ones
//!   a sync owns ([`SYNC_OWNED`]). An organization writing a profile for a
//!   platform component stores only that layer ([`annotation_of`]).
//! - **Schemas and marks stay the organization's.** Its own field schema (or
//!   component mark) for a type wins; a type it has none for falls back to
//!   the platform's, then to the built-in.
//! - **Sources.** An organization source naming a repository the platform
//!   already reads in the same mode is `shadowed_by_platform`: the
//!   organization can remove it, and its sync does not read it
//!   ([`leave_to_platform`]) -- nor the default crates.io keyword when the
//!   platform syncs crates.io. The run's result says what it left.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::field_schema::{TypeFieldSchema, overlay};
use super::gts::GtsNode;
use super::service::{CatalogNodeView, RepoSource};

/// The platform's (root) tenant, where the platform tier lives. The same
/// constant studio-user and the organizations gear name the root by.
pub const PLATFORM_TENANT: Uuid = Uuid::from_u128(1);

/// From the shared set, synced in the platform's tenant.
pub const PLATFORM: &str = "platform";
/// The organization's own: its catalogue sources and its registry.
pub const ORGANIZATION: &str = "organization";
/// Declared in this project's own repositories.
pub const PROJECT: &str = "project";

/// Profile keys a sync writes: never an organization's to set on a platform
/// component, and never stored as its annotation.
pub const SYNC_OWNED: [&str; 2] = ["auto", "uml"];

/// Keys a read lays onto a value, which a write must not store back.
const READ_MARKS: [&str; 2] = ["tier", "annotated"];

/// Whether `ctx` acts in the platform's own tenant.
pub fn is_platform(ctx: &SecurityContext) -> bool {
    ctx.subject_tenant_id() == PLATFORM_TENANT
}

/// The tier of what `ctx`'s own tenant holds.
pub fn own_tier(ctx: &SecurityContext) -> &'static str {
    if is_platform(ctx) {
        PLATFORM
    } else {
        ORGANIZATION
    }
}

fn mark(value: &mut Value, tier: &str) {
    if let Some(obj) = value.as_object_mut() {
        obj.insert("tier".to_owned(), Value::String(tier.to_owned()));
    }
}

fn name_key(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(|n| n.trim().to_ascii_lowercase())
        .filter(|n| !n.is_empty())
}

/// What one joined read answers.
#[derive(Debug, Default)]
pub struct Joined {
    pub nodes: Vec<CatalogNodeView>,
    /// The organization's components the platform's shadow, by name.
    pub shadowed: Vec<String>,
}

/// The platform's nodes and the organization's, each marked with its tier;
/// an organization node whose name the platform has is left out and named
/// in `shadowed`.
pub fn join_nodes(platform: Vec<CatalogNodeView>, own: Vec<CatalogNodeView>) -> Joined {
    let platform_names: BTreeSet<String> = platform
        .iter()
        .filter_map(|n| name_key(&n.value, "name"))
        .collect();
    let mut nodes = Vec::with_capacity(platform.len() + own.len());
    for mut n in platform {
        mark(&mut n.value, PLATFORM);
        nodes.push(n);
    }
    let mut shadowed = BTreeSet::new();
    for mut n in own {
        if let Some(key) = name_key(&n.value, "name")
            && platform_names.contains(&key)
        {
            let shown = n
                .value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            shadowed.insert(shown);
            continue;
        }
        mark(&mut n.value, ORGANIZATION);
        nodes.push(n);
    }
    Joined {
        nodes,
        shadowed: shadowed.into_iter().collect(),
    }
}

/// Every node of `own` marked with `tier`: a read that has nothing to join.
pub fn mark_all(own: Vec<CatalogNodeView>, tier: &str) -> Vec<CatalogNodeView> {
    own.into_iter()
        .map(|mut n| {
            mark(&mut n.value, tier);
            n
        })
        .collect()
}

/// What an organization keeps of a profile it writes for a platform
/// component: everything it set except what a sync owns and what a read
/// marked.
pub fn annotation_of(profile: Value) -> Value {
    let Value::Object(mut obj) = profile else {
        return profile;
    };
    for key in SYNC_OWNED.iter().chain(READ_MARKS.iter()) {
        obj.remove(*key);
    }
    Value::Object(obj)
}

/// `platform` with the organization's annotation laid over it.
pub fn annotate(platform: &Value, own: &Value) -> Value {
    let mut out = platform.as_object().cloned().unwrap_or_default();
    let Some(own) = own.as_object() else {
        return Value::Object(out);
    };
    for (key, value) in own {
        if SYNC_OWNED.contains(&key.as_str()) || READ_MARKS.contains(&key.as_str()) {
            continue;
        }
        if key == "values" {
            let mut values: Map<String, Value> = out
                .get("values")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(mine) = value.as_object() {
                for (k, v) in mine {
                    values.insert(k.clone(), v.clone());
                }
            }
            out.insert("values".to_owned(), Value::Object(values));
            continue;
        }
        out.insert(key.clone(), value.clone());
    }
    Value::Object(out)
}

/// The platform's profiles with the organization's annotations over them,
/// then the organization's own profiles; each marked with its tier, and a
/// platform profile an organization annotated marked `annotated`.
pub fn join_profiles(platform: Vec<GtsNode>, own: Vec<GtsNode>) -> Vec<GtsNode> {
    let mut own_by_name: BTreeMap<String, GtsNode> = BTreeMap::new();
    let mut unnamed = Vec::new();
    for n in own {
        match name_key(&n.value, "gear_name") {
            Some(key) => {
                own_by_name.insert(key, n);
            }
            None => unnamed.push(n),
        }
    }
    let mut out = Vec::with_capacity(platform.len() + own_by_name.len());
    for mut p in platform {
        if let Some(key) = name_key(&p.value, "gear_name")
            && let Some(mine) = own_by_name.remove(&key)
        {
            p.value = annotate(&p.value, &mine.value);
            if let Some(obj) = p.value.as_object_mut() {
                obj.insert("annotated".to_owned(), Value::Bool(true));
            }
        }
        mark(&mut p.value, PLATFORM);
        out.push(p);
    }
    for mut n in own_by_name.into_values().chain(unnamed) {
        mark(&mut n.value, ORGANIZATION);
        out.push(n);
    }
    out
}

/// The field schemas an organization renders against: the built-ins, the
/// platform's stored records over them, the organization's over those. A
/// layout the platform authored reads `owner: "platform"`, so a screen does
/// not offer the organization to revert what is not its own.
pub fn layered_schemas(
    builtins: Vec<TypeFieldSchema>,
    platform: Vec<TypeFieldSchema>,
    own: Vec<TypeFieldSchema>,
) -> Vec<TypeFieldSchema> {
    let mut under = overlay(builtins, platform);
    for s in &mut under {
        if s.owner == "tenant" {
            PLATFORM.clone_into(&mut s.owner);
        }
    }
    overlay(under, own)
}

/// Whether the platform already reads `source`: the same repository
/// (case-insensitive) in the same mode.
pub fn shadowed_by_platform(source: &RepoSource, platform: &[RepoSource]) -> bool {
    let mode = |m: &str| {
        if m.trim().is_empty() {
            "gears".to_owned()
        } else {
            m.trim().to_ascii_lowercase()
        }
    };
    platform.iter().any(|p| {
        p.repo.trim().eq_ignore_ascii_case(source.repo.trim())
            && mode(&p.mode) == mode(&source.mode)
    })
}

/// Take out of an organization's sync what the platform's catalogue already
/// reads, and answer what was taken, in words:
///
/// - every repository source [`shadowed_by_platform`] -- its components are
///   the platform's tier, and reading them into the organization's tenant
///   only writes nodes the organization's reads then hide;
/// - the crates.io keyword, when the platform syncs crates.io
///   (`platform_keyword`) and the organization's is the default one
///   (`default_keyword`) or the platform's own. An organization that names a
///   keyword of its own still syncs it.
pub fn leave_to_platform(
    sources: &mut super::service::SyncSources,
    platform: &[RepoSource],
    platform_keyword: Option<&str>,
    default_keyword: &str,
) -> Vec<String> {
    let mut left = Vec::new();
    sources.repos.retain(|s| {
        if shadowed_by_platform(s, platform) {
            let mode = if s.mode.trim().is_empty() {
                "gears"
            } else {
                s.mode.trim()
            };
            left.push(format!("{} ({mode})", s.repo.trim()));
            false
        } else {
            true
        }
    });
    let platform_keyword = platform_keyword.map(str::trim).filter(|k| !k.is_empty());
    if let (Some(platform_keyword), Some(keyword)) =
        (platform_keyword, sources.crates_io.as_deref())
    {
        let keyword = keyword.trim();
        if keyword.eq_ignore_ascii_case(default_keyword.trim())
            || keyword.eq_ignore_ascii_case(platform_keyword)
        {
            left.push(format!("crates.io keyword `{keyword}`"));
            sources.crates_io = None;
        }
    }
    left
}

#[cfg(test)]
#[path = "tiers_tests.rs"]
mod tests;
