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
