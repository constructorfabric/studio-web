//! OpenAPI schema names are one namespace for the whole assembly: every
//! gear's DTOs, Studio's and the platform's (`cf-*` crates), go into one
//! registry, and two types of the same name panic the server when it boots.
//! No unit test boots the assembly, so this reads the sources instead: every
//! type a schema is derived for (`api_dto`, `ToSchema`) in this crate and in
//! the `cf-*` crates `Cargo.lock` pins, as Cargo unpacked them.
//!
//! The scan is by name, the way the registry keys them. A crate Cargo has
//! not unpacked (an offline checkout) is skipped and said so.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// The types in `src` a schema is derived for: the name of each `struct` or
/// `enum` that follows an `api_dto` attribute or a `ToSchema` derive. A
/// `#[schema(as = …)]` rename is rare enough here that it is not followed.
pub(crate) fn schema_types(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut pending = false;
    for line in src.lines() {
        let t = line.trim_start();
        if t.starts_with("//") {
            continue;
        }
        if t.starts_with("#[") && (t.contains("api_dto") || t.contains("ToSchema")) {
            pending = true;
            continue;
        }
        if !pending {
            continue;
        }
        let words: Vec<&str> = t
            .split(|c: char| c.is_whitespace() || c == '<' || c == '{' || c == '(' || c == ';')
            .filter(|w| !w.is_empty())
            .collect();
        if let Some(at) = words.iter().position(|w| *w == "struct" || *w == "enum") {
            if let Some(name) = words.get(at + 1) {
                out.push((*name).to_owned());
            }
            pending = false;
        } else if !t.starts_with("#[") && !t.starts_with("///") && !t.is_empty() {
            // Something else came between: the attribute was not on a type.
            pending = false;
        }
    }
    out
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if p.file_name().is_some_and(|n| n == "tests" || n == "target") {
                continue;
            }
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs")
            && !p
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with("_tests.rs") || n == "tests.rs")
        {
            out.push(p);
        }
    }
}

/// The `cf-*` packages `Cargo.lock` pins, as `name-version`.
fn locked_platform_crates(lock: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut name: Option<&str> = None;
    for line in lock.lines() {
        if let Some(n) = line.strip_prefix("name = \"") {
            name = n.strip_suffix('"');
        } else if let (Some(v), Some(n)) = (line.strip_prefix("version = \""), name) {
            if n.starts_with("cf-") {
                out.insert(format!("{n}-{}", v.trim_end_matches('"')));
            }
            name = None;
        }
    }
    out
}

/// Where Cargo unpacks registry crates.
fn registry_src() -> Option<PathBuf> {
    let home = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cargo")))?;
    Some(home.join("registry").join("src"))
}

/// Names declared twice that never meet in the registry, each with why. A
/// type a handler returns but no operation registers a schema for is not in
/// the registry; it would clash the day one does.
const KNOWN: &[(&str, &str)] = &[];

/// Each schema type name to the places that declare it.
fn declarations(crate_root: &Path) -> (BTreeMap<String, BTreeSet<String>>, usize, usize) {
    let mut by_name: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut add = |origin: String, files: Vec<PathBuf>| {
        for f in files {
            let Ok(src) = fs::read_to_string(&f) else {
                continue;
            };
            for name in schema_types(&src) {
                by_name
                    .entry(name)
                    .or_default()
                    .insert(format!("{origin}:{}", f.display()));
            }
        }
    };
    let mut own = Vec::new();
    rust_files(&crate_root.join("src"), &mut own);
    add("studio-backend".into(), own);
    let lock = fs::read_to_string(crate_root.join("Cargo.lock")).unwrap_or_default();
    let wanted = locked_platform_crates(&lock);
    let mut found = 0;
    if let Some(src) = registry_src()
        && let Ok(indexes) = fs::read_dir(src)
    {
        for index in indexes.flatten() {
            let Ok(crates) = fs::read_dir(index.path()) else {
                continue;
            };
            for c in crates.flatten() {
                let dir = c.file_name().to_string_lossy().into_owned();
                if !wanted.contains(&dir) {
                    continue;
                }
                found += 1;
                let mut files = Vec::new();
                rust_files(&c.path().join("src"), &mut files);
                add(dir, files);
            }
        }
    }
    (by_name, wanted.len(), found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_types_are_read_after_their_derive() {
        let src = "#[derive(Debug)]\n#[toolkit_macros::api_dto(response)]\npub struct A {\n}\n\
                   #[derive(ToSchema, Serialize)]\n#[serde(rename_all = \"snake_case\")]\n\
                   pub enum B { X }\n#[derive(Debug)]\npub struct NotOne;\n\
                   #[derive(utoipa::ToSchema)]\nfn f() {}\nstruct Later;\n";
        assert_eq!(schema_types(src), ["A", "B"]);
    }

    /// Two schema types of one name anywhere in the assembly would panic it
    /// at start; every name is declared in one place only.
    #[test]
    fn no_two_schema_types_share_a_name() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let (by_name, wanted, found) = declarations(root);
        if found < wanted {
            eprintln!(
                "schema names: {found} of {wanted} locked cf-* crates are unpacked; the rest are \
                 not checked"
            );
        }
        let clashes: Vec<String> = by_name
            .iter()
            .filter(|(name, _)| !KNOWN.iter().any(|(k, _)| k == name))
            .filter(|(_, at)| {
                // One crate at two versions is the same type twice, not a clash.
                let crates: BTreeSet<&str> = at
                    .iter()
                    .map(|a| {
                        let origin = a.split(':').next().unwrap_or_default();
                        origin.rsplit_once('-').map_or(origin, |(n, _)| n)
                    })
                    .collect();
                at.len() > 1 && (crates.len() > 1 || crates.contains("studio"))
            })
            .map(|(name, at)| {
                format!(
                    "{name}: {}",
                    at.iter().cloned().collect::<Vec<_>>().join(", ")
                )
            })
            .collect();
        assert!(
            clashes.is_empty(),
            "OpenAPI schema names declared more than once (the assembly panics at boot):\n{}",
            clashes.join("\n")
        );
    }
}
