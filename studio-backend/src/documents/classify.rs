//! Document-type detection for files that arrived from somewhere else.
//!
//! A document created in Studio knows its type — you picked it from the
//! catalogue. A file pulled out of an existing repository does not, so before
//! it can be validated against a template something has to decide *which*
//! template. That decision is made here, cheaply and offline, in two steps:
//!
//! 1. **Declared** — the file's front matter names its type (`type: prd`).
//!    Whoever wrote it already answered the question; take the answer.
//! 2. **Inferred** — score every candidate type on four independent signals
//!    (which required sections the file actually contains, what its path is
//!    called, what its title says, which front-matter keys it fills) and take
//!    the winner if it is both good enough and clearly ahead of the runner-up.
//!
//! Anything that does not clear those bars comes back as *undetermined* with
//! its candidates attached, which is the honest answer: a person picks. The
//! third step — asking the external Spec Quality `purpose` detector — is driven
//! by the caller on exactly that leftover set, and its verdict is recorded
//! through [`super::model::DetectionSource::SpecQuality`].
//!
//! Scoring is deliberately derived from the type's own definition (its key,
//! name, sections and rules) rather than a hard-coded table of filenames, so a
//! workspace-defined type is detected on the same terms as a built-in one.

use std::collections::BTreeSet;

use super::model::{DetectionSource, DocumentType, TypeCandidate};
use super::validate::{headings, split_front_matter};

/// Extensions that can hold a specification document. Everything else (source,
/// images, lockfiles, build output) is not prose and is never classified.
const DOC_EXT: &[&str] = &["md", "markdown", "txt", "rst", "adoc", "asciidoc"];

/// Front-matter keys that may declare a document's type outright.
const TYPE_KEYS: &[&str] = &["type", "doc_type", "document_type", "kind"];

/// Words that carry no signal about which type a document is.
const STOPWORDS: &[&str] = &["the", "a", "an", "of", "and", "or", "for", "to", "v1"];

/// A score below this is never proposed — the file simply does not look enough
/// like any known type.
const ACCEPT: f32 = 0.45;

/// How far ahead of the runner-up the winner must be. Two types that score the
/// same are ambiguous, and guessing between them is worse than asking.
const MARGIN: f32 = 0.08;

/// What the classifier concluded about one file.
#[derive(Clone, Debug, PartialEq)]
pub struct Classification {
    /// The proposed type, or `None` when nothing cleared [`ACCEPT`]/[`MARGIN`].
    pub type_key: Option<String>,
    /// Confidence in the proposal, 0.0–1.0.
    pub confidence: f32,
    /// How the proposal was reached (meaningless when `type_key` is `None`).
    pub source: DetectionSource,
    /// Every type that scored at all, best first — what a person chooses from
    /// when the proposal is absent or wrong.
    pub candidates: Vec<TypeCandidate>,
    /// False when the path is not prose at all (a `.png`, a `.rs`).
    pub is_prose: bool,
}

/// True when a path looks like it could hold a specification document.
pub fn is_prose_path(path: &str) -> bool {
    let ext = path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    // A path with no dot after the last separator has no extension at all.
    let has_ext = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .contains('.');
    has_ext && DOC_EXT.contains(&ext.as_str())
}

/// Lowercase alphanumeric words, with the noise words dropped.
fn tokens(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| t.len() > 1)
        .map(|t| t.to_ascii_lowercase())
        .filter(|t| !STOPWORDS.contains(&t.as_str()))
        .collect()
}

/// Normalize a declared type value (`"Product Requirements"`, `"PRD"`) the same
/// way a type key is written, so the two can be compared.
fn normalize_declared(value: &str) -> String {
    value
        .trim()
        .trim_matches(['"', '\''])
        .to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

/// The type a file declares in its front matter, when it names a known one.
fn declared_type(content: &str, types: &[DocumentType]) -> Option<String> {
    let (fm, _) = split_front_matter(content);
    for key in TYPE_KEYS {
        let Some(raw) = fm.get(*key) else { continue };
        let declared = normalize_declared(raw);
        if declared.is_empty() {
            continue;
        }
        // A declaration may name the key (`prd`) or the display name
        // (`Product Requirements (PRD)`); accept either.
        if let Some(t) = types
            .iter()
            .find(|t| t.key == declared || normalize_declared(&t.name) == declared)
        {
            return Some(t.key.clone());
        }
    }
    None
}

/// Fraction of `ty`'s required section headings the document actually has.
fn section_score(ty: &DocumentType, body: &str) -> Option<(f32, usize, usize)> {
    let required: Vec<&str> = ty
        .template
        .sections
        .iter()
        .filter(|s| s.required)
        .map(|s| s.title.as_str())
        .collect();
    if required.is_empty() {
        return None;
    }
    let present: BTreeSet<String> = headings(body).into_iter().map(|h| h.title_norm).collect();
    let hits = required
        .iter()
        .filter(|t| present.contains(&t.trim().to_lowercase()))
        .count();
    Some((hits as f32 / required.len() as f32, hits, required.len()))
}

/// How much the path looks like this type: a full key match is decisive, a
/// partial name match is a hint.
fn path_score(ty: &DocumentType, path: &str) -> f32 {
    let path_toks: BTreeSet<String> = tokens(path).into_iter().collect();
    if path_toks.is_empty() {
        return 0.0;
    }
    let key_toks = tokens(&ty.key);
    if !key_toks.is_empty() && key_toks.iter().all(|t| path_toks.contains(t)) {
        return 1.0;
    }
    let name_toks = tokens(&ty.name);
    if name_toks.is_empty() {
        return 0.0;
    }
    let hits = name_toks.iter().filter(|t| path_toks.contains(*t)).count();
    hits as f32 / name_toks.len() as f32
}

/// Whether the document's own title names the type ("# ADR — …").
fn title_score(ty: &DocumentType, body: &str) -> f32 {
    let Some(title) = headings(body).into_iter().find(|h| h.level == 1) else {
        return 0.0;
    };
    let title_toks: BTreeSet<String> = tokens(&title.title_norm).into_iter().collect();
    if title_toks.is_empty() {
        return 0.0;
    }
    let key_toks = tokens(&ty.key);
    if !key_toks.is_empty() && key_toks.iter().all(|t| title_toks.contains(t)) {
        return 1.0;
    }
    let name_toks = tokens(&ty.name);
    if name_toks.is_empty() {
        return 0.0;
    }
    let hits = name_toks.iter().filter(|t| title_toks.contains(*t)).count();
    hits as f32 / name_toks.len() as f32
}

/// Fraction of the type's required front-matter keys the document fills.
/// `None` when the type requires none — that signal then carries no weight.
fn front_matter_score(ty: &DocumentType, content: &str) -> Option<f32> {
    let want = &ty.template.rules.front_matter;
    if want.is_empty() {
        return None;
    }
    let (fm, _) = split_front_matter(content);
    let hits = want
        .iter()
        .filter(|k| {
            fm.get(&k.trim().to_lowercase())
                .is_some_and(|v| !v.trim().is_empty())
        })
        .count();
    Some(hits as f32 / want.len() as f32)
}

/// Score one type against one document, and say in words why.
fn score(ty: &DocumentType, path: &str, content: &str) -> (f32, String) {
    let (_, body) = split_front_matter(content);

    // Sections are the strongest signal — they are what the template actually
    // asks for. Front matter is the weakest, and types that require none give
    // their weight back to the sections rather than letting it vanish.
    let (sections, why_sections) = match section_score(ty, body) {
        Some((s, hits, total)) => (s, format!("{hits}/{total} required sections")),
        None => (0.0, "no required sections".to_string()),
    };
    let path_s = path_score(ty, path);
    let title_s = title_score(ty, body);
    let fm = front_matter_score(ty, content);

    let (w_sections, w_fm) = match fm {
        Some(_) => (0.55, 0.10),
        None => (0.65, 0.0),
    };
    let total =
        w_sections * sections + 0.20 * path_s + 0.15 * title_s + w_fm * fm.unwrap_or_default();

    let mut why = vec![why_sections];
    if path_s > 0.0 {
        why.push("path matches".to_string());
    }
    if title_s > 0.0 {
        why.push("title matches".to_string());
    }
    if fm.is_some_and(|f| f > 0.0) {
        why.push("front matter matches".to_string());
    }
    (total, why.join(", "))
}

/// Decide which type a file is, given the effective type catalogue.
pub fn classify(path: &str, content: &str, types: &[DocumentType]) -> Classification {
    if !is_prose_path(path) {
        return Classification {
            type_key: None,
            confidence: 0.0,
            source: DetectionSource::Heuristic,
            candidates: Vec::new(),
            is_prose: false,
        };
    }

    // A declared type is an answer, not a guess — no scoring needed.
    if let Some(key) = declared_type(content, types) {
        return Classification {
            type_key: Some(key.clone()),
            confidence: 1.0,
            source: DetectionSource::FrontMatter,
            candidates: vec![TypeCandidate {
                type_key: key,
                confidence: 1.0,
                why: "declared in front matter".to_string(),
            }],
            is_prose: true,
        };
    }

    let mut candidates: Vec<TypeCandidate> = types
        .iter()
        .map(|ty| {
            let (confidence, why) = score(ty, path, content);
            TypeCandidate {
                type_key: ty.key.clone(),
                confidence,
                why,
            }
        })
        .filter(|c| c.confidence > 0.0)
        .collect();
    // Best first; ties broken by key so the order is stable across runs.
    candidates.sort_by(|a, b| {
        b.confidence
            .total_cmp(&a.confidence)
            .then_with(|| a.type_key.cmp(&b.type_key))
    });
    candidates.truncate(3);

    let best = candidates.first();
    let runner_up = candidates.get(1).map(|c| c.confidence).unwrap_or(0.0);
    let winner = best.filter(|b| b.confidence >= ACCEPT && b.confidence - runner_up >= MARGIN);

    Classification {
        type_key: winner.map(|c| c.type_key.clone()),
        confidence: winner.map(|c| c.confidence).unwrap_or(0.0),
        source: DetectionSource::Heuristic,
        candidates,
        is_prose: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::model::builtin_types;

    /// A document that fills every required section of a built-in type.
    fn filled(headings: &[&str]) -> String {
        let mut out = String::from("---\nstatus: draft\nowner: alice\n---\n\n# Some Title\n\n");
        for h in headings {
            out.push_str(&format!("## {h}\n\nSome real prose here.\n\n"));
        }
        out
    }

    #[test]
    fn non_prose_paths_are_not_classified() {
        let types = builtin_types();
        for path in ["src/main.rs", "logo.png", "Cargo.lock", "Makefile"] {
            let c = classify(path, "# whatever", &types);
            assert!(!c.is_prose, "{path} should not be prose");
            assert_eq!(c.type_key, None);
        }
    }

    #[test]
    fn front_matter_declaration_wins_outright() {
        let types = builtin_types();
        // The path and every section say "adr"; the declaration says otherwise
        // and is taken at its word.
        let content = "---\ntype: design\nstatus: draft\n---\n\n# ADR — something\n\n## Context\n\n## Decision\n";
        let c = classify("docs/adr/0001-thing.md", content, &types);
        assert_eq!(c.type_key.as_deref(), Some("design"));
        assert_eq!(c.source, DetectionSource::FrontMatter);
        assert_eq!(c.confidence, 1.0);
    }

    #[test]
    fn declaration_may_name_the_display_name() {
        let types = builtin_types();
        let content = "---\ndoc_type: Architecture Decision Record\n---\n\n# Whatever\n";
        let c = classify("notes.md", content, &types);
        assert_eq!(c.type_key.as_deref(), Some("adr"));
    }

    #[test]
    fn an_unknown_declaration_falls_through_to_scoring() {
        let types = builtin_types();
        let content = format!(
            "---\ntype: not_a_real_type\nstatus: draft\n---\n\n# ADR — x\n\n{}",
            filled(&["Status", "Context", "Decision", "Consequences"])
        );
        let c = classify("docs/adr/0001-x.md", &content, &types);
        assert_eq!(c.source, DetectionSource::Heuristic);
        assert_eq!(c.type_key.as_deref(), Some("adr"));
    }

    #[test]
    fn a_real_adr_is_detected_by_its_sections_and_path() {
        let types = builtin_types();
        let content = filled(&["Status", "Context", "Decision", "Consequences"]);
        let c = classify("docs/adr/0007-shell-tokens.md", &content, &types);
        assert_eq!(c.type_key.as_deref(), Some("adr"));
        assert!(c.confidence >= ACCEPT, "confidence {}", c.confidence);
    }

    #[test]
    fn a_real_prd_is_detected_from_its_sections_alone() {
        let types = builtin_types();
        // Deliberately an unhelpful filename: only the sections identify it.
        let content = filled(&[
            "Problem",
            "Goals",
            "Non-Goals",
            "Users & Use Cases",
            "Requirements",
            "Success Metrics",
        ]);
        let c = classify("docs/notes-2026.md", &content, &types);
        assert_eq!(c.type_key.as_deref(), Some("prd"));
    }

    #[test]
    fn prose_that_matches_nothing_is_left_undetermined() {
        let types = builtin_types();
        let content = "# Release notes\n\nWe shipped some things this week.\n";
        let c = classify("CHANGELOG.md", content, &types);
        assert!(c.is_prose);
        assert_eq!(c.type_key, None, "candidates: {:?}", c.candidates);
    }

    #[test]
    fn candidates_are_returned_even_when_nothing_is_proposed() {
        let types = builtin_types();
        // Two sections shared between several types, nothing decisive.
        let content = filled(&["Overview", "Context"]);
        let c = classify("docs/thing.md", &content, &types);
        assert_eq!(c.type_key, None);
        assert!(!c.candidates.is_empty());
        assert!(c.candidates.len() <= 3);
        // Sorted best first.
        for w in c.candidates.windows(2) {
            assert!(w[0].confidence >= w[1].confidence);
        }
    }

    #[test]
    fn a_workspace_defined_type_is_detected_on_the_same_terms() {
        use crate::documents::model::{Owner, Rules, Section, TemplateSpec};

        let custom = DocumentType {
            key: "runbook".to_string(),
            name: "Operational Runbook".to_string(),
            description: String::new(),
            gts_type_id: "gts.cf.studio.doc.runbook.v1~".to_string(),
            owner: Owner::Workspace {
                tenant_id: uuid::Uuid::nil(),
            },
            template: TemplateSpec {
                body: String::new(),
                sections: vec![
                    Section {
                        key: "symptoms".into(),
                        title: "Symptoms".into(),
                        required: true,
                        min_words: None,
                        description: None,
                    },
                    Section {
                        key: "diagnosis".into(),
                        title: "Diagnosis".into(),
                        required: true,
                        min_words: None,
                        description: None,
                    },
                    Section {
                        key: "recovery".into(),
                        title: "Recovery".into(),
                        required: true,
                        min_words: None,
                        description: None,
                    },
                ],
                rules: Rules::default(),
                questionnaire: Vec::new(),
            },
            hidden: false,
        };
        let mut types = builtin_types();
        types.push(custom);

        let content = filled(&["Symptoms", "Diagnosis", "Recovery"]);
        let c = classify("ops/runbook-postgres.md", &content, &types);
        assert_eq!(c.type_key.as_deref(), Some("runbook"));
    }
}
