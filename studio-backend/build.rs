//! Facts the binary carries about its own build, for `studio-assembly`.
//!
//! Two of them, and both are fixed here rather than read at run time, so the
//! answer a deployment gives cannot drift from the binary that gives it:
//!
//! * `STUDIO_BUILD_COMMIT` — the commit CI built from. CI sets it from
//!   `git rev-parse HEAD` of its checkout; a local build leaves it unset and
//!   the manifest says so (`commit: null`) rather than guessing. Not read from
//!   `.git` here: an incremental build would keep the commit of whichever
//!   build last ran this script, which is a wrong answer that looks right.
//! * the purpose of each Studio gear — the first paragraph of section 1.1 of
//!   its design, `docs/design/<gear>.md`, compiled into a table. A checkout
//!   without `docs/` (a build context that copied only this crate) builds
//!   with an empty table and a warning: the gears are still listed, without
//!   their purpose.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

fn main() {
    println!("cargo::rerun-if-env-changed=STUDIO_BUILD_COMMIT");
    let commit = env::var("STUDIO_BUILD_COMMIT")
        .map(|c| c.trim().to_owned())
        .unwrap_or_default();
    println!("cargo::rustc-env=STUDIO_BUILD_COMMIT={commit}");

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let designs = Path::new(&manifest_dir).join("../docs/design");
    println!("cargo::rerun-if-changed={}", designs.display());

    let mut docs: Vec<(String, String)> = Vec::new();
    match fs::read_dir(&designs) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let Ok(text) = fs::read_to_string(&path) else {
                    continue;
                };
                if let Some(purpose) = vision(&text) {
                    docs.push((name.to_owned(), purpose));
                }
            }
        }
        Err(_) => println!(
            "cargo::warning=docs/design is not in this build context: \
             studio-assembly will list the gears without their purpose"
        ),
    }
    docs.sort();

    let mut out =
        String::from("/// `(design doc stem, its section 1.1 first paragraph)`, by stem.\n");
    out.push_str("pub const DESIGN_DOCS: &[(&str, &str)] = &[\n");
    for (name, purpose) in &docs {
        // `{:?}` of a str is a valid Rust string literal, escapes included.
        let _ = writeln!(out, "    ({name:?}, {purpose:?}),");
    }
    out.push_str("];\n");
    let out_dir = env::var("OUT_DIR").expect("cargo sets OUT_DIR");
    fs::write(Path::new(&out_dir).join("design_docs.rs"), out).expect("write design_docs.rs");

    let src = Path::new(&manifest_dir).join("src");
    println!("cargo::rerun-if-changed={}", src.display());
    fs::write(Path::new(&out_dir).join("gear_uses.rs"), gear_uses(&src))
        .expect("write gear_uses.rs");
}

// ── Which Studio gear uses which, and how ─────────────────────────────────
//
// The toolkit's `deps` name crates, and every Studio gear lives in this one
// crate, so no Studio gear can declare that it needs another: the registry
// sees them all as independent. What one gear uses of another is read here
// from the code instead, as `crate::<gear module>::<item>` paths, and each is
// classified:
//
// * `port`     — the other gear's `port` or `sdk` module;
// * `surface`  — an item its `mod.rs` exports at the top (`crate::tasks::TaskQueue`);
// * `internal` — one of its other modules (`crate::spec_quality::record`).
//
// Test code is left out: files named `*tests.rs`/`*_test.rs`, and a file from
// its first `#[cfg(test)]` on.

/// A directory under `src/` whose `mod.rs` declares a gear, with that gear's name.
fn gear_modules(src: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(src) else {
        return out;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        // `mod.rs` first, else `gear.rs`: where a module keeps its gear.
        let Some((text, at)) = ["mod.rs", "gear.rs"].iter().find_map(|f| {
            let text = fs::read_to_string(dir.join(f)).ok()?;
            let at = text.find("#[toolkit::gear(")?;
            Some((text, at))
        }) else {
            continue;
        };
        let decl = &text[at..];
        let name = decl
            .find("name = \"")
            .map(|i| &decl[i + 8..])
            .and_then(|rest| rest.find('"').map(|end| rest[..end].to_owned()));
        if let (Some(module), Some(name)) = (dir.file_name().and_then(|n| n.to_str()), name) {
            out.push((module.to_owned(), name));
        }
    }
    out.sort();
    out
}

fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The first segment of every path `crate::<module>::…` names in `code`, as
/// `(module, segment)`; a `{a, b::c}` group gives each of its members.
fn crate_paths(code: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = code;
    while let Some(at) = rest.find("crate::") {
        let before_ok = rest[..at].chars().next_back().is_none_or(|c| !is_ident(c));
        rest = &rest[at + 7..];
        if !before_ok {
            continue;
        }
        let module: String = rest.chars().take_while(|c| is_ident(*c)).collect();
        let after = &rest[module.len()..];
        let Some(after) = after.strip_prefix("::") else {
            continue;
        };
        if let Some(group) = after.strip_prefix('{') {
            let Some(end) = group.find('}') else { continue };
            for member in group[..end].split(',') {
                let seg: String = member.trim().chars().take_while(|c| is_ident(*c)).collect();
                if !seg.is_empty() && seg != "self" {
                    out.push((module.clone(), seg));
                }
            }
        } else {
            let seg: String = after.chars().take_while(|c| is_ident(*c)).collect();
            if !seg.is_empty() {
                out.push((module.clone(), seg));
            }
        }
    }
    out
}

fn gear_uses(src: &Path) -> String {
    use std::collections::BTreeMap;
    let modules = gear_modules(src);
    let is_gear = |m: &str| modules.iter().any(|(module, _)| module == m);
    // (from, to, via, segment) → occurrences
    let mut uses: BTreeMap<(String, String, &str, String), u32> = BTreeMap::new();
    for (from, _) in &modules {
        let mut files = Vec::new();
        rust_files(&src.join(from), &mut files);
        for file in files {
            let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.ends_with("tests.rs") || name.ends_with("_test.rs") {
                continue;
            }
            let Ok(text) = fs::read_to_string(&file) else {
                continue;
            };
            let code: String = text
                .lines()
                .take_while(|l| !l.trim_start().starts_with("#[cfg(test)]"))
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            for (to, seg) in crate_paths(&code) {
                if to == *from || !is_gear(&to) {
                    continue;
                }
                let submodule = src.join(&to).join(format!("{seg}.rs")).is_file()
                    || src.join(&to).join(&seg).is_dir();
                let via = if seg == "port" || seg == "sdk" {
                    "port"
                } else if submodule {
                    "internal"
                } else {
                    "surface"
                };
                *uses.entry((from.clone(), to, via, seg)).or_default() += 1;
            }
        }
    }
    let mut out = String::from(
        "/// `(module, gear name)` of every directory under `src/` that declares a gear.\n\
         pub const GEAR_MODULES: &[(&str, &str)] = &[\n",
    );
    for (module, name) in &modules {
        let _ = writeln!(out, "    ({module:?}, {name:?}),");
    }
    out.push_str(
        "];\n\n/// `(from module, to module, via, first segment, occurrences)`: what one\n\
         /// Studio gear names of another, outside test code. `via` is `port`,\n\
         /// `surface` or `internal` (see `build.rs`).\n\
         pub const GEAR_USES: &[(&str, &str, &str, &str, u32)] = &[\n",
    );
    for ((from, to, via, seg), n) in &uses {
        let _ = writeln!(out, "    ({from:?}, {to:?}, {via:?}, {seg:?}, {n}),");
    }
    out.push_str("];\n");
    out
}

/// The first paragraph under `### 1.1 …` (every gear design calls it
/// "Architectural Vision"), as plain text: links keep their words, emphasis
/// and code marks go.
fn vision(text: &str) -> Option<String> {
    let mut lines = text.lines().skip_while(|l| !l.starts_with("### 1.1"));
    lines.next()?;
    let paragraph: Vec<&str> = lines
        .skip_while(|l| l.trim().is_empty())
        .take_while(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .map(str::trim)
        .collect();
    if paragraph.is_empty() {
        return None;
    }
    Some(plain(&paragraph.join(" ")))
}

/// `[words](target)` → `words`; `**`, `*` and backticks dropped.
fn plain(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let link = after.find("](").and_then(|close| {
            after[close + 2..]
                .find(')')
                .map(|end| (close, close + 2 + end))
        });
        match link {
            Some((close, end)) => {
                out.push_str(&rest[..open]);
                out.push_str(&after[..close]);
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out.replace("**", "").replace('`', "")
}
