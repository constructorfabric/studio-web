//! Code that looks like a gear and is not declared one: the registry's
//! candidates (ADR-0041, phase P3).
//!
//! A module with its own REST surface, its own tables and two consumers is a
//! gear in all but its declaration. The detectors here say so from what the
//! registry walk already has -- the repository's tree listing (paths and blob
//! shas) and the few files discovery reads anyway (`mod.rs`, `lib.rs`) --
//! plus at most [`MAX_MANIFEST_READS`] `Cargo.toml` files. No model, and no
//! request per source file.
//!
//! - **The unit** is a Rust module directory (`src/documents/` with a
//!   `mod.rs`, or a directory beside its `documents.rs`) or a crate (a
//!   `Cargo.toml` with a `src/lib.rs`) that no declared gear covers: not a
//!   gear's own directory, nothing inside one. Tests, `target/` and the other
//!   trees discovery skips are skipped here too.
//! - **The signals**, each a weight and a line a person can read, are in
//!   [`detect`]. A unit needs at least one structural signal (REST,
//!   persistence, types, a boundary); docs and consumers only add to one.
//! - **Copied** is the one signal across projects: the same name found in
//!   another project of the organization ([`apply_copies`], over the walk's
//!   reads and what the registry already holds).
//! - **Score** is the sum; a unit at [`CANDIDATE_THRESHOLD`] or more is a
//!   candidate, at most [`MAX_CANDIDATES`] per repository, highest first.
//!
//! Every candidate carries the fingerprint of its own files ([`unit_fingerprint`]):
//! a rejected candidate is proposed again only when that moves.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::project_gears::{self, LocalGear};
use super::registry::{OccurrenceRecord, RepoRead};

/// What an occurrence of a candidate says declares it: nothing does, a
/// detector found it.
pub const DETECTED: &str = "detected";

/// The score a unit needs to be proposed.
pub const CANDIDATE_THRESHOLD: u32 = 5;
/// Candidates kept per repository, highest score first.
pub const MAX_CANDIDATES: usize = 30;
/// `Cargo.toml` files read per repository for crate names and consumers, at
/// most, shallowest first.
pub const MAX_MANIFEST_READS: usize = 40;

/// It has its own REST surface.
pub const W_REST: u32 = 3;
/// It owns persistence: migrations, entities, a repository.
pub const W_PERSISTENCE: u32 = 3;
/// It owns GTS types or schemas.
pub const W_TYPES: u32 = 2;
/// It exposes a boundary: a `port` or an `sdk`.
pub const W_BOUNDARY_ONE: u32 = 2;
/// Both a `port` and an `sdk`.
pub const W_BOUNDARY_BOTH: u32 = 3;
/// It has its own README or DESIGN.
pub const W_DOCS: u32 = 1;
/// Per module or crate of the repository using it, up to [`MAX_CONSUMER_WEIGHT`].
pub const W_CONSUMER: u32 = 1;
pub const MAX_CONSUMER_WEIGHT: u32 = 3;
/// The same name in another project of the organization.
pub const W_COPIED: u32 = 2;

pub const SIGNAL_REST: &str = "rest";
pub const SIGNAL_PERSISTENCE: &str = "persistence";
pub const SIGNAL_TYPES: &str = "types";
pub const SIGNAL_BOUNDARY: &str = "boundary";
pub const SIGNAL_DOCS: &str = "docs";
pub const SIGNAL_CONSUMERS: &str = "consumers";
pub const SIGNAL_COPIED: &str = "copied";

/// What a structural signal must reach before docs, consumers and copies
/// count: a unit with only those is not proposed.
const STRUCTURAL: [&str; 4] = [
    SIGNAL_REST,
    SIGNAL_PERSISTENCE,
    SIGNAL_TYPES,
    SIGNAL_BOUNDARY,
];

/// The version of the per-unit fingerprint: moved when what it covers changes.
const UNIT_FINGERPRINT_VERSION: &str = "candidate/1";

/// One signal that fired on a unit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    /// `rest`, `persistence`, `types`, `boundary`, `docs`, `consumers` or
    /// `copied`.
    pub signal: String,
    /// What it fired on, in words: "own REST surface: rest.rs".
    pub detail: String,
    pub weight: u32,
}

impl Evidence {
    fn new(signal: &str, detail: String, weight: u32) -> Self {
        Self {
            signal: signal.to_owned(),
            detail,
            weight,
        }
    }
}

/// A unit that looks like a gear.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    /// The module's or crate's name, kebab-case.
    pub name: String,
    /// Its directory, relative to the repository root.
    pub path: String,
    /// The file that opens it: `mod.rs`, `documents.rs` or `Cargo.toml`.
    pub main_file: String,
    /// A crate rather than a module.
    pub crate_unit: bool,
    /// Its module doc's opening, when the file was read.
    pub description: Option<String>,
    pub evidence: Vec<Evidence>,
    pub score: u32,
    /// Of the unit's own files ([`unit_fingerprint`]).
    pub fingerprint: String,
}

/// `Spec_Mapping` / `spec mapping` -> `spec-mapping`: how a candidate is named,
/// and the key a name is compared by across spellings.
pub fn kebab(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut dash = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '.' {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c.to_ascii_lowercase());
        } else {
            dash = true;
        }
    }
    out
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn parent(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

fn joined(dir: &str, rel: &str) -> String {
    if dir.is_empty() {
        rel.to_owned()
    } else {
        format!("{dir}/{rel}")
    }
}

/// A file whose presence a signal reads. Only its path counts, so the
/// repository's fingerprint covers it by path: adding or removing a
/// `rest.rs` moves the fingerprint, editing one does not.
pub fn signal_file(path: &str) -> bool {
    if project_gears::skipped(path) {
        return false;
    }
    let name = file_name(path);
    if matches!(
        name,
        "rest.rs"
            | "routes.rs"
            | "api.rs"
            | "migrations.rs"
            | "entity.rs"
            | "repo.rs"
            | "repository.rs"
            | "gts.rs"
            | "port.rs"
            | "sdk.rs"
            | "DESIGN.md"
    ) || name.ends_with(".schema.json")
    {
        return true;
    }
    let segments: Vec<&str> = path.split('/').collect();
    let dirs = &segments[..segments.len().saturating_sub(1)];
    dirs.contains(&"migrations")
        || (name.ends_with(".rs")
            && dirs.iter().any(|s| {
                matches!(
                    *s,
                    "entity" | "types" | "rest" | "api" | "routes" | "port" | "sdk"
                )
            }))
}

/// The fingerprint of one unit's files: the ones discovery reads, by path and
/// sha, and the ones a signal reads, by path. Equal while nothing a detector
/// looks at changed in it.
pub fn unit_fingerprint(path: &str, main_file: &str, files: &[(String, String)]) -> String {
    let prefix = format!("{path}/");
    let mut text = String::from(UNIT_FINGERPRINT_VERSION);
    for (p, sha) in files {
        if !(p.starts_with(&prefix) || p == main_file) {
            continue;
        }
        if project_gears::relevant(p) {
            text.push('\n');
            text.push_str(p);
            text.push('\0');
            text.push_str(sha);
        } else if signal_file(p) {
            text.push('\n');
            text.push_str(p);
        }
    }
    Uuid::new_v5(&Uuid::NAMESPACE_OID, text.as_bytes()).to_string()
}

/// One module or crate to look at.
#[derive(Clone, Debug, PartialEq)]
struct Unit {
    name: String,
    path: String,
    main_file: String,
    crate_unit: bool,
    /// `crate::a::b` without `crate::`, for a module.
    module_path: Option<String>,
    /// The crate's `[package] name`, when its manifest was read.
    package: Option<String>,
}

/// `studio-backend/src/a/b` -> `a::b`: a module's path in its crate, when the
/// directory is under a `src/`.
fn module_path(dir: &str) -> Option<String> {
    let segments: Vec<&str> = dir.split('/').collect();
    let at = segments.iter().rposition(|s| *s == "src")?;
    let rest = &segments[at + 1..];
    (!rest.is_empty()).then(|| rest.join("::"))
}

/// The crate root (`studio-backend/src/`) a module directory is in.
fn crate_src(dir: &str) -> Option<String> {
    let segments: Vec<&str> = dir.split('/').collect();
    let at = segments.iter().rposition(|s| *s == "src")?;
    Some(format!("{}/", segments[..=at].join("/")))
}

/// The `Cargo.toml` files to read, at most [`MAX_MANIFEST_READS`], shallowest
/// first: a crate's name and who depends on it.
pub fn manifests_to_read<'a>(paths: &[&'a str]) -> Vec<&'a str> {
    let mut out: Vec<&'a str> = paths
        .iter()
        .copied()
        .filter(|p| file_name(p) == "Cargo.toml" && !project_gears::skipped(p))
        .collect();
    out.sort_by_key(|p| (p.matches('/').count(), *p));
    out.truncate(MAX_MANIFEST_READS);
    out
}

/// Whether a declared gear covers a unit: the gear's own directory, or one
/// inside it. A gear declared in a file (`src/foo.rs`) covers the module
/// directory beside it (`src/foo/`).
fn covered(path: &str, gears: &[LocalGear]) -> bool {
    gears.iter().any(|g| {
        let home = g.path.strip_suffix(".rs").unwrap_or(&g.path);
        home.is_empty() || path == home || path.starts_with(&format!("{home}/"))
    })
}

fn units(paths: &[&str], texts: &HashMap<String, String>, gears: &[LocalGear]) -> Vec<Unit> {
    let set: BTreeSet<&str> = paths.iter().copied().collect();
    let mut out: Vec<Unit> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut push = |unit: Unit, out: &mut Vec<Unit>| {
        if !unit.name.is_empty() && !covered(&unit.path, gears) && seen.insert(unit.path.clone()) {
            out.push(unit);
        }
    };
    let rust: Vec<&str> = paths
        .iter()
        .copied()
        .filter(|p| p.ends_with(".rs") && !project_gears::skipped(p))
        .collect();
    // Modules: a directory with a `mod.rs`.
    for p in &rust {
        if file_name(p) != "mod.rs" {
            continue;
        }
        let dir = parent(p);
        if let Some(mp) = module_path(dir) {
            push(
                Unit {
                    name: kebab(file_name(dir)),
                    path: dir.to_owned(),
                    main_file: (*p).to_owned(),
                    crate_unit: false,
                    module_path: Some(mp),
                    package: None,
                },
                &mut out,
            );
        }
    }
    // Modules: a directory beside its own `name.rs`.
    let dirs: BTreeSet<&str> = rust.iter().map(|p| parent(p)).collect();
    for dir in dirs {
        let main = format!("{dir}.rs");
        if dir.is_empty()
            || set.contains(format!("{dir}/mod.rs").as_str())
            || !set.contains(main.as_str())
        {
            continue;
        }
        if let Some(mp) = module_path(dir) {
            push(
                Unit {
                    name: kebab(file_name(dir)),
                    path: dir.to_owned(),
                    main_file: main,
                    crate_unit: false,
                    module_path: Some(mp),
                    package: None,
                },
                &mut out,
            );
        }
    }
    // Crates: a manifest with a library, below the repository root (the root
    // crate is the repository itself).
    for p in paths {
        if file_name(p) != "Cargo.toml" || project_gears::skipped(p) {
            continue;
        }
        let dir = parent(p);
        if dir.is_empty() || !set.contains(joined(dir, "src/lib.rs").as_str()) {
            continue;
        }
        let package = texts
            .get(*p)
            .and_then(|b| super::repo_enrich::cargo_package_name(b));
        push(
            Unit {
                name: kebab(package.as_deref().unwrap_or_else(|| file_name(dir))),
                path: dir.to_owned(),
                main_file: (*p).to_owned(),
                crate_unit: true,
                module_path: None,
                package,
            },
            &mut out,
        );
    }
    out
}

/// The text after `needle` in `body` at a word boundary: `crate::documents`
/// is in `use crate::documents::port;`, not in `crate::documents_tests`.
fn mentions(body: &str, needle: &str) -> bool {
    body.match_indices(needle).any(|(i, _)| {
        body[i + needle.len()..]
            .chars()
            .next()
            .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'))
    })
}

/// How many other modules of the same crate use a module, counted only in
/// the files discovery read (`mod.rs`, `lib.rs`, gear files): bounded, so it
/// can only undercount.
fn module_consumers(unit: &Unit, texts: &HashMap<String, String>) -> usize {
    let (Some(mp), Some(root)) = (&unit.module_path, crate_src(&unit.path)) else {
        return 0;
    };
    let needle = format!("crate::{mp}");
    let inside = format!("{}/", unit.path);
    let users: BTreeSet<&str> = texts
        .iter()
        .filter(|(p, _)| p.ends_with(".rs") && p.starts_with(&root))
        .filter(|(p, _)| !p.starts_with(&inside) && **p != unit.main_file)
        .filter(|(_, body)| mentions(body, &needle))
        .map(|(p, _)| parent(p))
        .collect();
    users.len()
}

/// How many other crates of the repository depend on a crate, in the
/// manifests read.
fn crate_consumers(unit: &Unit, texts: &HashMap<String, String>) -> usize {
    let Some(package) = &unit.package else {
        return 0;
    };
    texts
        .iter()
        .filter(|(p, _)| file_name(p) == "Cargo.toml" && **p != unit.main_file)
        // A virtual workspace's `[workspace.dependencies]` lists crates; it
        // does not use them.
        .filter(|(_, body)| super::repo_enrich::cargo_package_name(body).is_some())
        .filter(|(_, body)| {
            super::repo_enrich::cargo_dependency_names(body)
                .iter()
                .any(|d| d == package)
        })
        .count()
}

/// The signals that fire on one unit.
fn signals(unit: &Unit, paths: &[&str], texts: &HashMap<String, String>) -> Vec<Evidence> {
    let scopes: Vec<String> = if unit.crate_unit {
        vec![unit.path.clone(), joined(&unit.path, "src")]
    } else {
        vec![unit.path.clone()]
    };
    let direct = |name: &str| -> bool {
        scopes
            .iter()
            .any(|s| paths.contains(&joined(s, name).as_str()))
    };
    let subdir = |sub: &str, rust_only: bool| -> bool {
        scopes.iter().any(|s| {
            let prefix = format!("{}/", joined(s, sub));
            paths
                .iter()
                .any(|p| p.starts_with(&prefix) && (!rust_only || p.ends_with(".rs")))
        })
    };
    let main_body = if unit.crate_unit {
        texts.get(&joined(&unit.path, "src/lib.rs"))
    } else {
        texts.get(&unit.main_file)
    };
    let main_name = if unit.crate_unit {
        "lib.rs"
    } else {
        file_name(&unit.main_file)
    };
    let mut out = Vec::new();

    let mut rest: Vec<String> = ["rest.rs", "routes.rs", "api.rs"]
        .into_iter()
        .filter(|f| direct(f))
        .map(str::to_owned)
        .collect();
    rest.extend(
        ["rest", "routes", "api"]
            .into_iter()
            .filter(|d| subdir(d, true))
            .map(|d| format!("{d}/")),
    );
    if rest.is_empty()
        && let Some(body) = main_body
    {
        for marker in ["OperationBuilder::", "Router::new"] {
            if body.contains(marker) {
                rest.push(format!("{} in {main_name}", marker.trim_end_matches(':')));
                break;
            }
        }
    }
    if !rest.is_empty() {
        out.push(Evidence::new(
            SIGNAL_REST,
            format!("own REST surface: {}", rest.join(", ")),
            W_REST,
        ));
    }

    let mut store: Vec<String> = Vec::new();
    if subdir("migrations", false) {
        store.push("migrations/".to_owned());
    }
    for f in ["migrations.rs", "entity.rs", "repo.rs", "repository.rs"] {
        if direct(f) {
            store.push(f.to_owned());
        }
    }
    if subdir("entity", true) {
        store.push("entity/".to_owned());
    }
    if !store.is_empty() {
        out.push(Evidence::new(
            SIGNAL_PERSISTENCE,
            format!("owns persistence: {}", store.join(", ")),
            W_PERSISTENCE,
        ));
    }

    let mut types: Vec<String> = Vec::new();
    if direct("gts.rs") {
        types.push("gts.rs".to_owned());
    }
    if subdir("types", true) {
        types.push("types/".to_owned());
    }
    let inside = format!("{}/", unit.path);
    let schemas = paths
        .iter()
        .filter(|p| p.starts_with(&inside) && p.ends_with(".schema.json"))
        .count();
    if schemas > 0 {
        types.push(format!(
            "{schemas} schema file{}",
            if schemas == 1 { "" } else { "s" }
        ));
    }
    if !types.is_empty() {
        out.push(Evidence::new(
            SIGNAL_TYPES,
            format!("owns its types: {}", types.join(", ")),
            W_TYPES,
        ));
    }

    let port = direct("port.rs") || subdir("port", true);
    let sdk = direct("sdk.rs") || subdir("sdk", true);
    if port || sdk {
        let named: Vec<&str> = [("port", port), ("sdk", sdk)]
            .into_iter()
            .filter(|(_, on)| *on)
            .map(|(n, _)| n)
            .collect();
        out.push(Evidence::new(
            SIGNAL_BOUNDARY,
            format!("exposes a boundary: {}", named.join(" and ")),
            if port && sdk {
                W_BOUNDARY_BOTH
            } else {
                W_BOUNDARY_ONE
            },
        ));
    }

    let doc = paths.iter().copied().find(|p| {
        let dir = parent(p);
        (dir == unit.path || dir == joined(&unit.path, "docs"))
            && matches!(
                file_name(p).to_ascii_uppercase().as_str(),
                "README.MD" | "DESIGN.MD"
            )
    });
    if let Some(doc) = doc {
        out.push(Evidence::new(
            SIGNAL_DOCS,
            format!("has its own {}", file_name(doc)),
            W_DOCS,
        ));
    }

    let (users, what) = if unit.crate_unit {
        (crate_consumers(unit, texts), "crate")
    } else {
        (module_consumers(unit, texts), "module")
    };
    if users > 0 {
        let weight =
            (u32::try_from(users).unwrap_or(u32::MAX) * W_CONSUMER).min(MAX_CONSUMER_WEIGHT);
        out.push(Evidence::new(
            SIGNAL_CONSUMERS,
            format!(
                "used by {users} {what}{}",
                if users == 1 { "" } else { "s" }
            ),
            weight,
        ));
    }
    out
}

/// The units of one repository that look like gears, before the copy signal:
/// every one with a structural signal and a score that copying could lift to
/// [`CANDIDATE_THRESHOLD`], highest first, at most [`MAX_CANDIDATES`].
///
/// `files` is the tree listing (path, blob sha); `texts` the files read
/// (discovery's Rust files and the manifests of [`manifests_to_read`]);
/// `gears` what discovery found declared, which no candidate overlaps.
pub fn detect(
    files: &[(String, String)],
    texts: &HashMap<String, String>,
    gears: &[LocalGear],
) -> Vec<Candidate> {
    let paths: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
    let floor = CANDIDATE_THRESHOLD.saturating_sub(W_COPIED);
    let mut out: Vec<Candidate> = units(&paths, texts, gears)
        .into_iter()
        .filter_map(|unit| {
            let evidence = signals(&unit, &paths, texts);
            if !evidence
                .iter()
                .any(|e| STRUCTURAL.contains(&e.signal.as_str()))
            {
                return None;
            }
            let score: u32 = evidence.iter().map(|e| e.weight).sum();
            if score < floor {
                return None;
            }
            let body = if unit.crate_unit {
                texts.get(&joined(&unit.path, "src/lib.rs"))
            } else {
                texts.get(&unit.main_file)
            };
            Some(Candidate {
                fingerprint: unit_fingerprint(&unit.path, &unit.main_file, files),
                description: body.and_then(|b| project_gears::module_doc(b)),
                name: unit.name,
                path: unit.path,
                main_file: unit.main_file,
                crate_unit: unit.crate_unit,
                evidence,
                score,
            })
        })
        .collect();
    rank(&mut out);
    out
}

/// Highest score first, then by path; at most [`MAX_CANDIDATES`].
fn rank(candidates: &mut Vec<Candidate>) {
    candidates.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    candidates.truncate(MAX_CANDIDATES);
}

/// Where a name was found: by project, the project's name and the
/// repositories (reader keys) it was found in there.
type Places = BTreeMap<Uuid, (String, BTreeSet<String>)>;

/// The names of the projects in `places` that make a finding in project
/// `project`, repository `repo_key` a copy: another project, in another
/// repository. Two projects reading one repository are one copy of the code,
/// not two. Sorted, once each.
fn copied_in(places: Option<&Places>, project: Uuid, repo_key: &str) -> Vec<String> {
    let mut others: Vec<String> = places
        .into_iter()
        .flat_map(|by| by.iter())
        .filter(|(p, (_, repos))| **p != project && repos.iter().any(|k| k != repo_key))
        .map(|(_, (name, _))| name.clone())
        .collect();
    others.sort_unstable();
    others.dedup();
    others
}

/// `evidence` with its copy signal for `others` in place of whatever it
/// said before, and the score that sums to.
pub fn with_copies(evidence: &[Evidence], others: &[String]) -> (Vec<Evidence>, u32) {
    let mut out: Vec<Evidence> = evidence
        .iter()
        .filter(|e| e.signal != SIGNAL_COPIED)
        .cloned()
        .collect();
    if !others.is_empty() {
        out.push(Evidence::new(
            SIGNAL_COPIED,
            format!("copied in {}", others.join(", ")),
            W_COPIED,
        ));
    }
    let score = out.iter().map(|e| e.weight).sum();
    (out, score)
}

/// The copy signal, then the threshold, over every repository a walk read.
///
/// A candidate is copied when the same name (compared [`kebab`]-folded) is
/// found in another project of the organization, in another repository:
/// among this walk's reads (declared or candidate), or among the occurrences
/// the registry holds for repositories this walk did not read again. Two
/// projects reading the same repository (the same reader key) are not a
/// copy. What is left under [`CANDIDATE_THRESHOLD`] after it is dropped.
pub fn apply_copies(reads: &mut [RepoRead], stored: &[(String, OccurrenceRecord)]) {
    let reread: BTreeSet<(Uuid, String)> = reads
        .iter()
        .map(|r| (r.project_id, r.repo_key.clone()))
        .collect();
    let mut found: BTreeMap<String, Places> = BTreeMap::new();
    for r in reads.iter() {
        let names = r
            .gears
            .iter()
            .map(|g| g.name.as_str())
            .chain(r.candidates.iter().map(|c| c.name.as_str()));
        for name in names {
            found
                .entry(kebab(name))
                .or_default()
                .entry(r.project_id)
                .or_insert_with(|| (r.project_name.clone(), BTreeSet::new()))
                .1
                .insert(r.repo_key.clone());
        }
    }
    for (_, o) in stored {
        let Some(project) = o.project_id else {
            continue;
        };
        if reread.contains(&(project, o.repo_key.clone())) {
            continue;
        }
        found
            .entry(kebab(&o.entry))
            .or_default()
            .entry(project)
            .or_insert_with(|| {
                (
                    o.project_name
                        .clone()
                        .unwrap_or_else(|| project.to_string()),
                    BTreeSet::new(),
                )
            })
            .1
            .insert(o.repo_key.clone());
    }
    for r in reads.iter_mut() {
        for c in &mut r.candidates {
            let others = copied_in(found.get(&kebab(&c.name)), r.project_id, &r.repo_key);
            (c.evidence, c.score) = with_copies(&c.evidence, &others);
        }
        r.candidates.retain(|c| c.score >= CANDIDATE_THRESHOLD);
        rank(&mut r.candidates);
    }
}

/// The copy signal of every detected occurrence settled again from the
/// occurrences the registry keeps after a walk (`live`: what the walk
/// found and what it kept), so evidence does not outlive what it was about:
/// an occurrence retired -- its project excluded, its repository no longer
/// named, the organization's gear repository changed -- is no copy any
/// more. Projects are as in [`apply_copies`]: another project, another
/// repository. `owner` says whose read an occurrence is (its project, or the
/// organization for its gear repository). Answers each detected occurrence's
/// index in `live` with its evidence and score, where they changed.
pub fn refreshed_copies(
    live: &[&OccurrenceRecord],
    owner: impl Fn(&OccurrenceRecord) -> Option<Uuid>,
) -> Vec<(usize, Vec<Evidence>, u32)> {
    let mut found: BTreeMap<&str, Places> = BTreeMap::new();
    for o in live {
        let Some(project) = owner(o) else {
            continue;
        };
        found
            .entry(o.entry_id.as_str())
            .or_default()
            .entry(project)
            .or_insert_with(|| {
                (
                    o.project_name
                        .clone()
                        .unwrap_or_else(|| project.to_string()),
                    BTreeSet::new(),
                )
            })
            .1
            .insert(o.repo_key.clone());
    }
    let mut out = Vec::new();
    for (i, o) in live.iter().enumerate() {
        if !o.detected() {
            continue;
        }
        let Some(project) = owner(o) else {
            continue;
        };
        let others = copied_in(found.get(o.entry_id.as_str()), project, &o.repo_key);
        let (evidence, _) = with_copies(&o.evidence, &others);
        if evidence == o.evidence {
            continue;
        }
        // The score moves by the copy signal's weight only: what the other
        // signals scored stays as the detector said.
        let copied = |ev: &[Evidence]| -> u32 {
            ev.iter()
                .filter(|e| e.signal == SIGNAL_COPIED)
                .map(|e| e.weight)
                .sum()
        };
        let before: u32 = o
            .score
            .unwrap_or_else(|| o.evidence.iter().map(|e| e.weight).sum());
        let score = before.saturating_sub(copied(&o.evidence)) + copied(&evidence);
        out.push((i, evidence, score));
    }
    out
}

#[cfg(test)]
#[path = "candidates_tests.rs"]
mod tests;
