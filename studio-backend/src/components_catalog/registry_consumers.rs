//! Who uses a registry entry, and whether the platform has it (ADR-0041 P4,
//! ADR-0042 §4). Pure: [`super::registry::plan`] asks these.
//!
//! - **Consumers.** A project uses an entry when a crate its code depends on
//!   (`[dependencies]` of any `Cargo.toml` in its repositories, as
//!   `project_dependencies` reads them) or a gear its product picks
//!   (studio-product's record) is the entry: its name or one of its aliases,
//!   folded as candidate names are, bare or as `cf-gears-<name>`. A project
//!   that declares the entry is not its consumer. The facts are kept per
//!   repository on its `registry_read` node and per project on the last
//!   walk's status, so a repository skipped as unchanged keeps them; a
//!   repository read again replaces them.
//! - **Published.** The platform's catalogue (tier `platform`) is read as a
//!   set of folded names: each gear's name, its crates and its directory's
//!   last segment, with and without `cf-gears-`.

use std::collections::{BTreeMap, BTreeSet};

use uuid::Uuid;

use super::candidates::kebab;
use super::gts::GtsNode;
use super::registry::{Consumer, EntryRecord, OccurrenceRecord, ReadRecord, Walk};

/// How a project uses entries: the crates its code depends on, and the gears
/// its product picks.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProjectUses {
    pub cargo: BTreeSet<String>,
    pub product: BTreeSet<String>,
}

/// The crate prefix the platform's gears are published under.
const GEAR_CRATE_PREFIX: &str = "cf-gears-";

/// Whether `used` (a crate or a pick) names the component `name`: the same
/// folded name, or `cf-gears-<name>`.
pub fn names_component(used: &str, name: &str) -> bool {
    let used = kebab(used);
    let name = kebab(name);
    if used.is_empty() || name.is_empty() {
        return false;
    }
    used == name
        || used.strip_prefix(GEAR_CRATE_PREFIX) == Some(name.as_str())
        || name.strip_prefix(GEAR_CRATE_PREFIX) == Some(used.as_str())
}

/// Every name an entry goes by: its own and its aliases.
fn names_of(entry: &EntryRecord) -> impl Iterator<Item = &str> {
    std::iter::once(entry.name.as_str()).chain(entry.aliases.iter().map(String::as_str))
}

/// What each project uses, by what the walk holds: the Cargo dependencies of
/// the repositories read now, and of the stored reads not read again and not
/// gone; and each project's product picks. The organization's gear
/// repository is no project and uses nothing.
pub fn project_uses(
    walk: &Walk,
    stored: &[(String, ReadRecord)],
    read_now: &BTreeSet<(Uuid, &str)>,
) -> BTreeMap<Uuid, ProjectUses> {
    let mut out: BTreeMap<Uuid, ProjectUses> = BTreeMap::new();
    for read in walk.reads.iter().filter(|r| !r.organization) {
        out.entry(read.project_id)
            .or_default()
            .cargo
            .extend(read.cargo_deps.iter().cloned());
    }
    for (_, read) in stored {
        if read.project_id == walk.org
            || read_now.contains(&(read.project_id, read.repo_key.as_str()))
            || super::registry::pair_gone(walk, Some(read.project_id), &read.repo_key)
        {
            continue;
        }
        out.entry(read.project_id)
            .or_default()
            .cargo
            .extend(read.cargo_deps.iter().cloned());
    }
    for (project, picks) in &walk.product_picks {
        if let Some(scope) = &walk.in_scope
            && !scope.contains(project)
        {
            continue;
        }
        out.entry(*project)
            .or_default()
            .product
            .extend(picks.iter().cloned());
    }
    out
}

/// The project names the registry already holds: from occurrences, and from
/// entries' consumers, for a project the walk did not name.
pub fn names_from(
    occurrences: &[(String, OccurrenceRecord)],
    entries: &BTreeMap<String, EntryRecord>,
) -> BTreeMap<Uuid, String> {
    let mut out = BTreeMap::new();
    for e in entries.values() {
        for c in &e.consumers {
            out.insert(c.project_id, c.project_name.clone());
        }
    }
    for (_, o) in occurrences {
        if let (Some(p), Some(n)) = (o.project_id, o.project_name.as_ref()) {
            out.insert(p, n.clone());
        }
    }
    out
}

/// The projects that use `entry` without declaring it, by name.
pub fn consumers_of(
    entry: &EntryRecord,
    uses: &BTreeMap<Uuid, ProjectUses>,
    declared_in: Option<&BTreeSet<Uuid>>,
    walk: &Walk,
    names_seen: &BTreeMap<Uuid, String>,
) -> Vec<Consumer> {
    let mut out: Vec<Consumer> = uses
        .iter()
        .filter(|(project, _)| declared_in.is_none_or(|d| !d.contains(project)))
        .filter_map(|(project, used)| {
            let hits = |set: &BTreeSet<String>| {
                set.iter()
                    .any(|u| names_of(entry).any(|n| names_component(u, n)))
            };
            let mut via = Vec::new();
            if hits(&used.cargo) {
                via.push("cargo".to_owned());
            }
            if hits(&used.product) {
                via.push("product".to_owned());
            }
            (!via.is_empty()).then(|| Consumer {
                project_id: *project,
                project_name: walk
                    .project_names
                    .get(project)
                    .or_else(|| names_seen.get(project))
                    .cloned()
                    .unwrap_or_else(|| project.to_string()),
                via,
            })
        })
        .collect();
    out.sort_by(|a, b| {
        a.project_name
            .to_lowercase()
            .cmp(&b.project_name.to_lowercase())
            .then(a.project_id.cmp(&b.project_id))
    });
    out
}

/// The platform's components as folded names, each with its newest version
/// when the catalogue knows one: a gear node's `name`, its `crate_names`, and
/// the last segment of its `repo_path`, each also without `cf-gears-`.
pub fn platform_components(nodes: &[GtsNode]) -> BTreeMap<String, Option<String>> {
    let mut out: BTreeMap<String, Option<String>> = BTreeMap::new();
    for node in nodes {
        let v = &node.value;
        let text = |k: &str| {
            v.get(k)
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let version = text("newest_version").or_else(|| text("max_version"));
        let mut names: Vec<String> = Vec::new();
        names.extend(text("name"));
        if let Some(crates) = v.get("crate_names").and_then(serde_json::Value::as_array) {
            names.extend(
                crates
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned),
            );
        }
        if let Some(path) = text("repo_path")
            && let Some(last) = path.rsplit('/').next()
        {
            names.push(last.to_owned());
        }
        for name in names {
            let folded = kebab(&name);
            if folded.is_empty() {
                continue;
            }
            let bare = folded
                .strip_prefix(GEAR_CRATE_PREFIX)
                .map(str::to_owned)
                .unwrap_or_else(|| folded.clone());
            for key in [folded, bare] {
                let slot = out.entry(key).or_insert(None);
                if slot.is_none() {
                    slot.clone_from(&version);
                }
            }
        }
    }
    out
}

/// Whether the platform has `entry` (by any of its names), and its version
/// there when known. `None`: the platform does not have it.
pub fn platform_version(
    platform: &BTreeMap<String, Option<String>>,
    entry: &EntryRecord,
) -> Option<Option<String>> {
    names_of(entry).find_map(|n| {
        let folded = kebab(n);
        let bare = folded
            .strip_prefix(GEAR_CRATE_PREFIX)
            .unwrap_or(&folded)
            .to_owned();
        platform
            .get(&folded)
            .or_else(|| platform.get(&bare))
            .cloned()
    })
}

#[cfg(test)]
#[path = "registry_consumers_tests.rs"]
mod tests;
