//! The gears a project's own repository declares.
//!
//! The catalogue lists the gears an organization publishes. A project that
//! writes gears of its own has more than that: Studio's own backend declares
//! two dozen in `studio-backend/src` (`spec_mapping` is
//! `#[toolkit::gear(name = "studio-spec-mapping")]`), and none of them is a
//! crate on crates.io or a directory in the gears repository, so a capability
//! one of them already fills read as a gap on the project's own Components tab.
//!
//! A gear is found in the repository the way it is declared there:
//! - a directory with a `gear.toml` or a `gear.gdl` (the catalogue's own rule,
//!   `repo_enrich::gear_dirs`), named by its crate;
//! - a `#[toolkit::gear(name = "…")]` attribute in Rust source, named by the
//!   attribute. A gear whose attribute sits inside a directory already found
//!   by its manifest is that gear, not a second one.
//!
//! What is read stays bounded: only the Rust files a gear is declared in by
//! convention ([`rust_candidates`]), at most [`MAX_RUST_FILES`] of them, none
//! over [`MAX_FILE_BYTES`], and at most [`MAX_PROJECT_GEARS`] gears. The answer
//! is cached per repository and kept while the files it was read from are
//! unchanged ([`fingerprint`]), so a second look at the Components tab costs
//! one tree listing.
//!
//! The rules here are pure; `RepoEnricher::project_gears` does the reading.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};

/// Rust files read per repository, at most.
pub const MAX_RUST_FILES: usize = 150;
/// Gears reported per repository, at most.
pub const MAX_PROJECT_GEARS: usize = 80;
/// A file larger than this is not read: a gear's entry point is not one.
pub const MAX_FILE_BYTES: i64 = 256 * 1024;
/// How much of a gear's description is kept.
const MAX_DESCRIPTION_CHARS: usize = 300;

/// Trees that never hold a gear's declaration.
const SKIP: [&str; 13] = [
    "target",
    "tests",
    "examples",
    "benches",
    "fuzz",
    "vendor",
    "fixtures",
    "__fixtures__",
    "node_modules",
    "dist",
    "build",
    ".git",
    "src-app",
];

/// The attributes that declare a gear in Rust source. `modkit::module` is
/// what the toolkit's macro was called before it was `toolkit::gear`.
const ATTRIBUTES: [&str; 2] = ["#[toolkit::gear", "#[modkit::module"];

/// One gear the project's repository declares.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalGear {
    /// The crate a manifest-described gear is, or the name its attribute gives.
    pub name: String,
    /// `gear` or `plugin`.
    pub kind: String,
    pub description: Option<String>,
    pub category: Option<String>,
    /// Where it lives, relative to the repository root: its directory, or the
    /// file when several gears share one (`src/connectors/plugin.rs`).
    pub path: String,
    /// The file that declares it: `gear.toml`, `gear.gdl` or a Rust source.
    pub declared_in: String,
    /// `owner/name` of the repository it was read from.
    pub repo: String,
    /// The capability keys it declares (`gear.toml` `capabilities`).
    pub capabilities: Vec<String>,
    /// The toolkit's runtime labels (`rest`, `db`): what it needs from the
    /// runtime, never what it does for a product, so never matched on.
    pub runtime: Vec<String>,
    /// It has code: an attribute in source, or a `.rs` file in its directory.
    pub built: bool,
    /// Its README's opening, and the README's path.
    pub doc: Option<(String, String)>,
}

impl LocalGear {
    /// The gear as a catalogue component node, marked as the project's own.
    pub fn component(&self) -> Value {
        json!({
            "name": self.name,
            "kind": self.kind,
            "description": self.description,
            "category": self.category,
            "origin": "project",
            "path": self.path,
            "declared_in": self.declared_in,
            "source_repo": self.repo,
            "runtime_capabilities": self.runtime,
        })
    }

    /// The gear as a catalogue profile: whether it is built, what it declares,
    /// and its README as a document the matching may quote.
    pub fn profile(&self) -> Value {
        let mut auto = Map::new();
        auto.insert(
            "gear_status".into(),
            json!(if self.built { "built" } else { "docs-only" }),
        );
        if !self.capabilities.is_empty() {
            auto.insert("capabilities".into(), json!(self.capabilities.join(", ")));
        }
        if let Some((path, text)) = &self.doc {
            auto.insert("doc_text".into(), json!([{ "t": text, "l": path }]));
        }
        json!({ "gear_name": self.name, "origin": "project", "auto": auto })
    }
}

/// Gears in the catalogue's shape: component nodes, and profiles by gear.
pub fn catalogue_shape(gears: &[LocalGear]) -> (Vec<Value>, Map<String, Value>) {
    let nodes = gears.iter().map(LocalGear::component).collect();
    let profiles = gears
        .iter()
        .map(|g| (g.name.clone(), g.profile()))
        .collect();
    (nodes, profiles)
}

/// One gear an attribute in Rust source declares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeGear {
    pub name: String,
    pub runtime: Vec<String>,
}

/// The gears a Rust file declares with `#[toolkit::gear(name = "…", …)]`.
///
/// Only an attribute that begins a line counts, so one quoted in a comment or
/// generated into a string (`product::skeleton`) does not. Reading stops at
/// the file's `#[cfg(test)]`: a gear a test declares is not the project's.
/// An attribute without a `name` names no gear and is skipped.
/// Whether the item after a `#[cfg(test)]` ends on its own line (`mod x;`,
/// `use y;`), rather than opening a body.
fn cfg_test_item_is_one_line(rest: &str) -> bool {
    rest.lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("//") && !l.starts_with("#["))
        .is_some_and(|l| l.ends_with(';'))
}

pub fn code_declarations(body: &str) -> Vec<CodeGear> {
    let mut out = Vec::new();
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        let start = offset;
        offset += line.len();
        let trimmed = line.trim_start();
        if trimmed.starts_with("#[cfg(test)]") {
            // `#[cfg(test)] mod repo_tests;` only names a test file, and a
            // gear's own `mod.rs` usually has a few of them above its
            // attribute (studio-documents does). Only an item with a body --
            // the inline `mod tests { … }` -- is where the tests begin.
            if cfg_test_item_is_one_line(&body[offset..]) {
                continue;
            }
            break;
        }
        if !ATTRIBUTES.iter().any(|a| {
            trimmed.strip_prefix(a).is_some_and(|rest| {
                rest.starts_with(['(', ']']) || rest.starts_with(char::is_whitespace)
            })
        }) {
            continue;
        }
        let at = start + (line.len() - trimmed.len());
        let Some(attr) = bracketed(&body[at..]) else {
            continue;
        };
        let Some(args) = attr.find('(').map(|i| &attr[i + 1..]) else {
            continue;
        };
        let args = args.trim_end().strip_suffix(')').unwrap_or(args);
        let mut name = None;
        let mut runtime = Vec::new();
        for arg in top_level_split(args) {
            let Some((key, value)) = arg.split_once('=') else {
                continue;
            };
            let value = value.trim();
            match key.trim() {
                "name" => name = quoted(value),
                "capabilities" => {
                    runtime = value
                        .trim_start_matches('[')
                        .trim_end_matches(']')
                        .split(',')
                        .map(|c| c.trim().to_string())
                        .filter(|c| !c.is_empty())
                        .collect();
                }
                _ => {}
            }
        }
        if let Some(name) = name.filter(|n| is_gear_name(n))
            && !out.iter().any(|g: &CodeGear| g.name == name)
        {
            out.push(CodeGear { name, runtime });
        }
    }
    out
}

/// The attribute opening at `text[0]` (`#[`), up to its closing `]`, with
/// brackets inside string literals ignored. `None` when it never closes.
fn bracketed(text: &str) -> Option<&str> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (i, c) in text.char_indices() {
        if in_string {
            match c {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '[' => depth += 1,
            ']' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(&text[2..i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// `a = 1, b = [x, y]` split on the commas outside brackets and strings.
fn top_level_split(args: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut from = 0;
    for (i, c) in args.char_indices() {
        match c {
            '"' => in_string = !in_string,
            '[' | '(' | '{' if !in_string => depth += 1,
            ']' | ')' | '}' if !in_string => depth -= 1,
            ',' if !in_string && depth == 0 => {
                out.push(&args[from..i]);
                from = i + 1;
            }
            _ => {}
        }
    }
    out.push(&args[from..]);
    out
}

fn quoted(value: &str) -> Option<String> {
    let inner = value.strip_prefix('"')?;
    let end = inner.find('"')?;
    Some(inner[..end].to_string())
}

/// A name as a gear is named: no placeholder, no spaces.
fn is_gear_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// The first paragraph of a Rust file's inner doc comment (`//!`), on one
/// line, without the gear's own name in front of it: `//! studio-documents —
/// document management gear.` is `document management gear.`
pub fn module_doc(body: &str) -> Option<String> {
    let mut lines: Vec<&str> = Vec::new();
    for raw in body.lines() {
        let line = raw.trim();
        let Some(text) = line.strip_prefix("//!") else {
            if line.is_empty() && lines.is_empty() {
                continue;
            }
            break;
        };
        let text = text.trim();
        if text.is_empty() {
            if lines.is_empty() {
                continue;
            }
            break;
        }
        lines.push(text);
    }
    let joined = lines.join(" ");
    let text = strip_name_prefix(&joined).trim();
    (!text.is_empty()).then(|| text.chars().take(MAX_DESCRIPTION_CHARS).collect())
}

/// `name: rest`, `name — rest`, `name -- rest`, `name - rest` as `rest`, when
/// `name` is one word: how the module docs here open.
fn strip_name_prefix(text: &str) -> &str {
    let Some((head, rest)) = text.split_once(' ') else {
        return text;
    };
    if head.len() > 1 && head.ends_with(':') {
        return rest;
    }
    for dash in ["— ", "-- ", "- ", "– "] {
        if let Some(after) = rest.strip_prefix(dash) {
            return after;
        }
    }
    text
}

pub(super) fn skipped(path: &str) -> bool {
    path.split('/').any(|seg| SKIP.contains(&seg))
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn parent(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

/// A Rust file that holds tests rather than a gear: `tests.rs`, `*_tests.rs`,
/// `*_test.rs`.
fn is_test_file(name: &str) -> bool {
    name == "tests.rs" || name.ends_with("_tests.rs") || name.ends_with("_test.rs")
}

/// The Rust files a gear is declared in by convention, shallowest first and
/// at most [`MAX_RUST_FILES`]: a crate's `lib.rs`, a module's `mod.rs`, and
/// any file whose name says gear, module or plugin (`gear.rs`,
/// `studio_authz_plugin.rs`). Reading every `.rs` file would cost a request
/// each over the API.
pub fn rust_candidates<'a>(paths: &[&'a str]) -> Vec<&'a str> {
    let mut out: Vec<&'a str> = paths
        .iter()
        .copied()
        .filter(|p| p.ends_with(".rs") && !skipped(p))
        // A test module's fixtures write gear attributes into string
        // literals, at the start of a line: read, they declare the gears
        // under test, and the first finding wins over the real `mod.rs`
        // (seen on studio-web's own `project_gears_tests.rs`).
        .filter(|p| !is_test_file(file_name(p)))
        .filter(|p| {
            let name = file_name(p);
            matches!(name, "lib.rs" | "mod.rs" | "module.rs")
                || name.contains("gear")
                || name.contains("plugin")
        })
        .collect();
    out.sort_by_key(|p| (p.matches('/').count(), *p));
    out.truncate(MAX_RUST_FILES);
    out
}

/// Where a gear declared in `file` lives: a module's directory for `mod.rs`,
/// `gear.rs` and `module.rs`; a crate's directory for `src/lib.rs`; the file
/// itself otherwise.
pub fn rust_home(file: &str) -> String {
    let dir = parent(file);
    match file_name(file) {
        "mod.rs" | "gear.rs" | "module.rs" => dir.to_string(),
        "lib.rs" if dir == "src" => String::new(),
        "lib.rs" if dir.ends_with("/src") => parent(dir).to_string(),
        "lib.rs" => dir.to_string(),
        _ => file.to_string(),
    }
}

/// The file whose doc comment describes the module `file` is part of: the
/// directory's `mod.rs` for a gear declared in a sibling (`git_proxy/gear.rs`).
pub fn doc_file<'a>(file: &'a str, paths: &[&'a str]) -> &'a str {
    if matches!(file_name(file), "gear.rs" | "module.rs") {
        let module = format!("{}/mod.rs", parent(file));
        if let Some(found) = paths.iter().find(|p| **p == module) {
            return found;
        }
    }
    file
}

/// The README of a gear's directory, when it has one.
pub fn readme<'a>(dir: &str, paths: &[&'a str]) -> Option<&'a str> {
    if dir.ends_with(".rs") {
        return None;
    }
    paths
        .iter()
        .copied()
        .find(|p| parent(p) == dir && file_name(p).eq_ignore_ascii_case("README.md"))
}

/// Add a gear found in source to those found by manifest. A name already
/// there, or an attribute inside a manifest gear's directory, is that gear:
/// it gives its runtime labels and its code, not a second entry.
pub fn absorb(gears: &mut Vec<LocalGear>, found: LocalGear) {
    let home =
        |g: &LocalGear| g.declared_in.ends_with("gear.toml") || g.declared_in.ends_with("gear.gdl");
    let inside = |g: &LocalGear| {
        home(g)
            && (g.path.is_empty()
                || found.path == g.path
                || found.path.starts_with(&format!("{}/", g.path)))
    };
    if let Some(g) = gears
        .iter_mut()
        .find(|g| g.name.eq_ignore_ascii_case(&found.name) || inside(g))
    {
        g.built = true;
        for r in found.runtime {
            if !g.runtime.contains(&r) {
                g.runtime.push(r);
            }
        }
        if g.description.is_none() {
            g.description = found.description;
        }
        return;
    }
    gears.push(found);
}

/// The files the answer is read from: what a cached answer is checked against.
pub(super) fn relevant(path: &str) -> bool {
    matches!(
        file_name(path),
        "gear.toml" | "gear.gdl" | "Cargo.toml" | "README.md"
    ) || (path.ends_with(".rs") && !rust_candidates(&[path]).is_empty())
}

/// What discovery is: moved whenever the rules here change what a repository
/// is read as, so a stored fingerprint from the old rules no longer matches
/// and every repository is read again once.
///
/// `/4`: the candidate detectors (`candidates.rs`) read the presence of
/// signal files too, so every repository is read once more to find them.
///
/// `/5`: the registry keeps each repository's Cargo dependencies on its
/// read (the consumer graph, ADR-0041 P4), so every repository is read once
/// more to record them.
pub const DISCOVERY_VERSION: &str = "project-gears/5";

/// A fingerprint of the files the answer depends on, from the tree listing's
/// `(path, blob sha)` pairs: equal while none of them changed. The files the
/// candidate detectors only look for ([`super::candidates::signal_file`])
/// count by path: adding a `rest.rs` moves it, editing one does not.
///
/// Stable across builds and restarts (a uuid5 of the pairs and
/// [`DISCOVERY_VERSION`]), because the registry stores it: the standard
/// library's hasher promises no such thing.
pub fn fingerprint(files: &[(String, String)]) -> String {
    let mut text = String::from(DISCOVERY_VERSION);
    for (path, sha) in files {
        if relevant(path) {
            text.push('\n');
            text.push_str(path);
            text.push('\0');
            text.push_str(sha);
        } else if super::candidates::signal_file(path) {
            text.push('\n');
            text.push_str(path);
        }
    }
    uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, text.as_bytes()).to_string()
}

/// Whether a repository need not be read again: a fingerprint was stored and
/// the files have it still.
pub fn unchanged(known: Option<&str>, print: &str) -> bool {
    known == Some(print)
}

/// What was read per repository, kept while its fingerprint holds.
#[derive(Default)]
pub struct Cache(Mutex<HashMap<String, Cached>>);

/// One repository's answer, the candidates when they were looked for, and
/// the fingerprint it was read under.
type Cached = (
    String,
    Arc<Vec<LocalGear>>,
    Option<Arc<Vec<super::candidates::Candidate>>>,
);

/// What a cached read found: the gears, and the candidates.
pub type Found = (Arc<Vec<LocalGear>>, Arc<Vec<super::candidates::Candidate>>);

impl Cache {
    /// Repositories remembered at most; past it, the cache starts over.
    const CAPACITY: usize = 64;

    /// The gears and the candidates, when both were read under `print`. A
    /// read that did not look for candidates answers `None` when they are
    /// asked for.
    pub fn get_found(&self, key: &str, print: &str, candidates: bool) -> Option<Found> {
        let map = self.0.lock().ok()?;
        let (_, gears, found) = map.get(key).filter(|(p, _, _)| p == print)?;
        match found {
            Some(c) => Some((Arc::clone(gears), Arc::clone(c))),
            None if !candidates => Some((Arc::clone(gears), Arc::new(Vec::new()))),
            None => None,
        }
    }

    pub fn put_found(
        &self,
        key: String,
        print: String,
        gears: Arc<Vec<LocalGear>>,
        candidates: Option<Arc<Vec<super::candidates::Candidate>>>,
    ) {
        if let Ok(mut map) = self.0.lock() {
            if map.len() >= Self::CAPACITY && !map.contains_key(&key) {
                map.clear();
            }
            map.insert(key, (print, gears, candidates));
        }
    }
}

#[cfg(test)]
#[path = "project_gears_tests.rs"]
mod tests;
