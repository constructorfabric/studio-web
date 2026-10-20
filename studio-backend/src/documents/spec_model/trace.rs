//! Where each requirement is cited: the documents that refer to it, the code
//! that names it, the tests that name it (`docs/spec-domain-model.md`,
//! "From requirement to code and test"; issue #738).
//!
//! Mechanical, as the work links are: a file cites a requirement when it
//! names the identifier as a whole token. No model guesses which code
//! implements what. A test is told from code by its path, the conventions of
//! the common languages; nothing about a project is assumed beyond them.

use std::collections::{HashMap, HashSet};

use super::index::SourceDoc;
use super::requirements::Requirement;
use super::work::names;

/// One place an identifier is named.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cited {
    pub path: String,
    /// The first line that names it, from 1.
    pub line: usize,
}

/// One requirement and every place that names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Trace {
    pub requirement: Requirement,
    /// Other documents (and other places in its own) that refer to it.
    pub documents: Vec<Cited>,
    /// Code that names it, tests left out.
    pub code: Vec<Cited>,
    pub tests: Vec<Cited>,
}

/// The most places of one kind kept per requirement.
const PER_KIND: usize = 20;

/// Whether a path is a test by the conventions of the common languages.
pub fn is_test_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let in_test_dir = lower.split('/').any(|d| {
        matches!(
            d,
            "test" | "tests" | "__tests__" | "spec" | "e2e" | "testdata"
        )
    });
    in_test_dir
        || name.ends_with("_test.rs")
        || name.ends_with("_tests.rs")
        || name.ends_with("_test.go")
        || name.ends_with("_test.py")
        || name.starts_with("test_")
        || [".test.", ".spec."].iter().any(|m| name.contains(m))
        || name.ends_with("test.java")
        || name.ends_with("tests.cs")
}

/// Whether a path is something a requirement can be implemented in: source
/// code and configuration, not prose or data dumps.
fn is_code_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    const CODE: [&str; 22] = [
        ".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".go", ".py", ".java", ".kt", ".cs", ".rb",
        ".php", ".swift", ".scala", ".c", ".cc", ".cpp", ".h", ".sql", ".proto", ".gdl",
    ];
    CODE.iter().any(|ext| lower.ends_with(ext))
}

fn first_line_naming(text: &str, id: &str) -> Option<usize> {
    let lower_id = id.to_ascii_lowercase();
    text.lines()
        .enumerate()
        .find(|(_, line)| {
            let l = line.to_ascii_lowercase();
            l.contains(&lower_id) && names(&l, &lower_id)
        })
        .map(|(i, _)| i + 1)
}

/// What a token is made of, as [`names`] reads a whole token.
fn is_part(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// An id [`names`] can only find as one whole token -- every id a document
/// labels. Anything else is looked for the slow way, line by line.
fn is_token(id: &str) -> bool {
    !id.is_empty() && id.chars().all(is_part)
}

/// The lines of `text` (from 1) naming each of `wanted` (lower-cased ids),
/// at most `keep` per id, read in one pass over the text.
fn lines_naming(text: &str, wanted: &HashSet<String>, keep: usize) -> HashMap<String, Vec<usize>> {
    let mut out: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, line) in text.lines().enumerate() {
        for token in line.split(|c: char| !is_part(c)) {
            if token.is_empty() {
                continue;
            }
            let token = token.to_ascii_lowercase();
            if !wanted.contains(&token) {
                continue;
            }
            let at = out.entry(token).or_default();
            if at.len() < keep && at.last() != Some(&(i + 1)) {
                at.push(i + 1);
            }
        }
    }
    out
}

/// Every requirement with the places that name it, in the requirements' order.
///
/// Each file is read once, whatever the number of requirements: a project
/// with hundreds of requirements over a checkout of thousands of files asked
/// one scan per pair before, which held a request for a minute and the
/// backend's health check with it.
pub fn trace(
    requirements: &[Requirement],
    docs: &[SourceDoc<'_>],
    files: &[(String, String)],
) -> Vec<Trace> {
    let wanted: HashSet<String> = requirements
        .iter()
        .filter(|r| is_token(&r.id))
        .map(|r| r.id.to_ascii_lowercase())
        .collect();
    // Two lines per document: a definition is not a reference to itself, so
    // the line after it may be the one that counts.
    let in_docs: Vec<HashMap<String, Vec<usize>>> = docs
        .iter()
        .map(|d| lines_naming(d.text, &wanted, 2))
        .collect();
    let sources: Vec<&(String, String)> = files
        .iter()
        .filter(|(path, _)| is_code_path(path) || is_test_path(path))
        .collect();
    let in_files: Vec<HashMap<String, Vec<usize>>> = sources
        .iter()
        .map(|(_, text)| lines_naming(text, &wanted, 1))
        .collect();

    requirements
        .iter()
        .map(|r| {
            let key = r.id.to_ascii_lowercase();
            let indexed = wanted.contains(&key);
            let mut documents: Vec<Cited> = docs
                .iter()
                .zip(&in_docs)
                .filter_map(|(d, found)| {
                    let own = d.path == r.path;
                    let line = if indexed {
                        found
                            .get(&key)?
                            .iter()
                            .copied()
                            .find(|&l| !own || l != r.line)?
                    } else {
                        // Its own definition is not a reference to it: look past it.
                        let text: String = if own {
                            d.text
                                .lines()
                                .enumerate()
                                .filter(|(i, _)| i + 1 != r.line)
                                .map(|(_, l)| l)
                                .collect::<Vec<_>>()
                                .join("\n")
                        } else {
                            d.text.to_string()
                        };
                        let line = first_line_naming(&text, &r.id)?;
                        if own && line >= r.line {
                            line + 1
                        } else {
                            line
                        }
                    };
                    Some(Cited {
                        path: d.path.to_string(),
                        line,
                    })
                })
                .collect();
            documents.truncate(PER_KIND);
            let (mut tests, mut code): (Vec<Cited>, Vec<Cited>) = sources
                .iter()
                .zip(&in_files)
                .filter_map(|((path, text), found)| {
                    let line = if indexed {
                        found.get(&key)?.first().copied()?
                    } else {
                        first_line_naming(text, &r.id)?
                    };
                    Some(Cited {
                        path: path.clone(),
                        line,
                    })
                })
                .partition(|c| is_test_path(&c.path));
            code.truncate(PER_KIND);
            tests.truncate(PER_KIND);
            Trace {
                requirement: r.clone(),
                documents,
                code,
                tests,
            }
        })
        .collect()
}

#[cfg(test)]
#[path = "trace_tests.rs"]
mod tests;
