//! The studio-events vocabulary, read out of `docs/events-catalog.md`.
//!
//! The catalogue is the contract a portal codes against (rule E3), so it is
//! the half of the channel that has to be machine-readable: the frame itself
//! (`StudioEventDto`) is already in the REST contract, but a `kind` and the
//! fields of its payload live only in this page. Reading them from the page,
//! rather than from a second list in the code, keeps one source of truth:
//!
//! * each producer's tests compare the kinds it can publish with the ones the
//!   page lists for its prefix ([`documented_kinds`]), so a kind cannot ship
//!   undocumented, and a documented kind cannot quietly stop being sent;
//! * the compatibility ratchet ([`super::compat`]) records every documented
//!   kind and payload field as accepted, so removing or renaming one is a
//!   break that has to be recorded with a reason.
//!
//! The page's shape is therefore part of it: a `## ` section names its subject
//! type in backticks, and every table whose first column is `kind` has a
//! `Payload fields` column listing the fields in backticks. A section's line
//! that starts `Published by` names the gear that publishes its kinds, in
//! backticks: what the portal shows on that gear (`GET /studio-events/v1/catalog`).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

/// Where the catalogue lives, relative to the crate root.
pub(crate) const CATALOGUE: &str = "../docs/events-catalog.md";

/// One documented `kind`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DocumentedKind {
    /// The `subject_type` its section is about.
    pub subject_type: String,
    /// The payload fields the page promises it may carry.
    pub fields: BTreeSet<String>,
    /// The gear its section says publishes it, when it says.
    pub publisher: Option<String>,
    /// The `When` column, as written.
    pub when: String,
}

/// The whole catalogue.
#[derive(Debug, Default)]
pub(crate) struct Catalogue {
    /// Every registered `subject_type`.
    pub subjects: BTreeSet<String>,
    /// Every documented `kind`.
    pub kinds: BTreeMap<String, DocumentedKind>,
}

/// The first `` `…` `` token in `text`.
fn first_code(text: &str) -> Option<String> {
    codes(text).into_iter().next()
}

/// Every `` `…` `` token in `text`, in order.
fn codes(text: &str) -> Vec<String> {
    text.split('`')
        .enumerate()
        .filter(|(i, _)| i % 2 == 1)
        .map(|(_, code)| code.trim().to_string())
        .filter(|code| !code.is_empty())
        .collect()
}

/// The cells of a `| a | b |` row, trimmed.
fn cells(row: &str) -> Vec<&str> {
    let row = row.trim();
    let row = row.strip_prefix('|').unwrap_or(row);
    let row = row.strip_suffix('|').unwrap_or(row);
    row.split('|').map(str::trim).collect()
}

fn is_field_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Parse the page. An error names what is wrong with its shape.
pub(crate) fn parse(text: &str) -> Result<Catalogue, String> {
    let mut out = Catalogue::default();
    let mut section: Option<String> = None;
    let mut publisher: Option<String> = None;
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        if let Some(heading) = line.strip_prefix("## ") {
            section = first_code(heading);
            publisher = None;
            continue;
        }
        if let Some(rest) = line.trim_start().strip_prefix("Published by ") {
            publisher = first_code(rest);
            continue;
        }
        if !line.trim_start().starts_with('|') {
            continue;
        }
        // A table: this line is its header, the next its `| --- |` rule.
        let header: Vec<String> = cells(line)
            .iter()
            .map(|cell| cell.trim_matches('`').to_string())
            .collect();
        lines.next();
        let mut rows = Vec::new();
        while let Some(row) = lines.peek() {
            if !row.trim_start().starts_with('|') {
                break;
            }
            rows.push(*row);
            lines.next();
        }
        match header.first().map(String::as_str) {
            Some("subject_type") => {
                for row in rows {
                    if let Some(subject) = cells(row).first().copied().and_then(first_code) {
                        out.subjects.insert(subject);
                    }
                }
            }
            Some("kind") => {
                let Some(subject_type) = section.clone() else {
                    return Err(format!(
                        "a `kind` table outside a `## `subject_type`` section: {line}"
                    ));
                };
                let Some(payload) = header
                    .iter()
                    .position(|cell| cell.to_ascii_lowercase().starts_with("payload"))
                else {
                    return Err(format!(
                        "the `{subject_type}` kind table has no `Payload fields` column"
                    ));
                };
                let when_at = header
                    .iter()
                    .position(|cell| cell.eq_ignore_ascii_case("when"));
                for row in rows {
                    let row_cells = cells(row);
                    let Some(kind) = row_cells.first().copied().and_then(first_code) else {
                        return Err(format!("a `{subject_type}` row names no kind: {row}"));
                    };
                    let fields: BTreeSet<String> = row_cells
                        .get(payload)
                        .copied()
                        .map(codes)
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|name| is_field_name(name))
                        .collect();
                    let documented = DocumentedKind {
                        subject_type: subject_type.clone(),
                        fields,
                        publisher: publisher.clone(),
                        when: when_at
                            .and_then(|i| row_cells.get(i))
                            .map(|w| (*w).to_string())
                            .unwrap_or_default(),
                    };
                    if out.kinds.insert(kind.clone(), documented).is_some() {
                        return Err(format!("`{kind}` is documented twice"));
                    }
                }
            }
            _ => {}
        }
    }
    for (kind, documented) in &out.kinds {
        if !out.subjects.contains(&documented.subject_type) {
            return Err(format!(
                "`{kind}` is about `{}`, which is not in the subject-type table",
                documented.subject_type
            ));
        }
    }
    Ok(out)
}

/// The catalogue as committed next to the crate.
pub(crate) fn read(crate_root: &Path) -> Result<Catalogue, String> {
    let path = crate_root.join(CATALOGUE);
    let text =
        fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    parse(&text).map_err(|e| format!("docs/events-catalog.md: {e}"))
}

/// The documented kinds that start with `prefix` (`"task."`): what a producer's
/// test compares its own kinds with.
#[cfg(test)]
pub(crate) fn documented_kinds(prefix: &str) -> BTreeSet<String> {
    let catalogue = read(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap_or_else(|e| panic!("{e}"));
    catalogue
        .kinds
        .into_keys()
        .filter(|kind| kind.starts_with(prefix))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_committed_catalogue_parses() {
        let catalogue =
            read(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap_or_else(|e| panic!("{e}"));
        assert!(catalogue.subjects.contains("task_run"));
        let succeeded = catalogue
            .kinds
            .get("task.succeeded")
            .expect("task.succeeded is documented");
        assert_eq!(succeeded.subject_type, "task_run");
        assert!(succeeded.fields.contains("run_id"), "{succeeded:?}");
        assert_eq!(succeeded.publisher.as_deref(), Some("studio-tasks"));
        assert!(!succeeded.when.is_empty());
        let decided = &catalogue.kinds["review_request.decided"];
        assert_eq!(decided.publisher.as_deref(), Some("studio-documents"));
    }

    #[test]
    fn the_publisher_is_its_sections_and_no_further() {
        let page = "| `subject_type` | is |\n| --- | --- |\n| `a` | x |\n| `b` | y |\n\n\
                    ## `a` — as\n\nPublished by `gear-a` when it likes.\n\n\
                    | `kind` | When | Payload fields |\n| --- | --- | --- |\n| `a.made` | made | `id` |\n\n\
                    ## `b` — bs\n\n| `kind` | When | Payload fields |\n| --- | --- | --- |\n| `b.made` | later | `id` |\n";
        let catalogue = parse(page).expect("parses");
        assert_eq!(
            catalogue.kinds["a.made"].publisher.as_deref(),
            Some("gear-a")
        );
        assert_eq!(catalogue.kinds["a.made"].when, "made");
        assert_eq!(catalogue.kinds["b.made"].publisher, None);
    }

    #[test]
    fn a_kind_table_without_payload_fields_is_refused() {
        let page = "| `subject_type` | is |\n| --- | --- |\n| `thing` | x |\n\n\
                    ## `thing` — things\n\n| `kind` | When |\n| --- | --- |\n| `thing.made` | made |\n";
        assert!(parse(page).unwrap_err().contains("Payload fields"));
    }

    #[test]
    fn a_kind_about_an_unregistered_subject_is_refused() {
        let page = "## `ghost` — ghosts\n\n| `kind` | Payload fields |\n| --- | --- |\n\
                    | `ghost.seen` | `id` |\n";
        assert!(parse(page).unwrap_err().contains("subject-type table"));
    }
}
