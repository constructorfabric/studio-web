//! A project's domain model, read from its documents, and the places they
//! disagree about it (`docs/spec-domain-model.md`).
//!
//! Built in stages: the reference index and its rules (`index.rs`), which
//! need no model; the facts of each document revision, read by a model on the
//! caller's key (`extract.rs`, run by `build.rs`); and the finding every rule
//! answers with (`finding.rs`); the merged model's candidates (`rules.rs`)
//! and the model call that confirms or drops each (`judge.rs`).

use std::collections::{BTreeMap, BTreeSet};

pub(crate) mod build;
pub(crate) mod check_methods;
pub(crate) mod domain_doc;
pub(crate) mod extract;
pub(crate) mod finding;
pub(crate) mod glossary;
pub(crate) mod glossary_doc;
pub(crate) mod index;
pub(crate) mod judge;
pub(crate) mod questions;
pub(crate) mod record;
pub(crate) mod related;
pub(crate) mod rename;
pub(crate) mod requirements;
pub(crate) mod rules;
pub(crate) mod trace;
pub(crate) mod work;

/// One document of the project, with its text.
#[derive(Clone, Debug)]
pub struct SourceText {
    pub path: String,
    pub text: String,
    pub doc_type: Option<String>,
    /// The file's node in the artifact graph, which its `spec_finding`
    /// verdict is recorded on.
    pub node: String,
    /// The document binding it was read for.
    pub binding: Option<uuid::Uuid>,
}

/// What the model is read from: the project's documents, and every path of
/// its checkouts for resolving references.
#[derive(Clone, Debug, Default)]
pub struct Sources {
    pub documents: Vec<SourceText>,
    pub tree: BTreeSet<String>,
    /// The checkouts' other text files, `(path, text)`: the code and tests a
    /// requirement can be traced to.
    pub files: Vec<(String, String)>,
    /// Typed documents whose text no checkout on this server holds: the
    /// repository was never synced here, its clone could not be written, or
    /// the copy went with a restarted pod. A sync brings them back; until
    /// then [`last_read`] shows what was read of them.
    pub unread: Vec<String>,
    /// Why the clone a sync keeps is missing, when the reader knows: the
    /// last clone of the repository failed, or the clone volume cannot be
    /// written. `None` when nothing failed (the repository was not synced).
    pub unread_because: Option<String>,
}

impl Sources {
    pub fn reference_findings(&self) -> Vec<finding::Finding> {
        index::reference_findings(&source_docs(&self.documents), &self.tree).1
    }

    /// The identifiers the documents define with a label, and where.
    pub fn labelled_ids(&self) -> BTreeMap<String, Vec<finding::Side>> {
        index::labelled_ids(&source_docs(&self.documents))
    }

    /// Every requirement the documents define, with the basis it states.
    pub fn requirements(&self) -> Vec<requirements::Requirement> {
        requirements::requirements(&source_docs(&self.documents))
    }

    /// Where each requirement is cited: documents, code, tests.
    pub fn trace(&self) -> Vec<trace::Trace> {
        trace::trace(
            &self.requirements(),
            &source_docs(&self.documents),
            &self.files,
        )
    }
}

fn source_docs(documents: &[SourceText]) -> Vec<index::SourceDoc<'_>> {
    documents
        .iter()
        .map(|d| index::SourceDoc {
            path: &d.path,
            text: &d.text,
            doc_type: d.doc_type.as_deref(),
        })
        .collect()
}

/// Every candidate for the judge: the rules' over the merged facts, and the
/// citations of a decision record worth asking about, which need no facts.
pub fn candidates(documents: &[SourceText], facts: &[extract::Fact]) -> Vec<rules::Candidate> {
    let mut out = rules::candidates(facts, CANDIDATE_CAP);
    out.extend(index::misattribution_candidates(
        &source_docs(documents),
        index::CITATION_CAP,
    ));
    out
}

/// Where one document stands in the model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Coverage {
    pub path: String,
    pub revision: String,
    /// `extracted` at its current revision, `failed` part-way (asked again on
    /// the next build), `stale` (extracted at an older revision only) or
    /// `pending` (never).
    pub state: &'static str,
    pub facts: usize,
    pub dropped: usize,
    pub error: Option<String>,
}

/// Whether a path is a template or an example rather than documentation — a
/// `templates` or `examples` directory, a `template.md`, or anything under a
/// tool's `.cf-studio` directory wherever it sits: never read into the model,
/// nor into what the product needs.
pub fn is_template_path(path: &str) -> bool {
    path.split('/')
        .any(|seg| seg == "templates" || seg == "examples" || seg == ".cf-studio")
        || path.ends_with("/template.md")
        || path == "template.md"
}

/// One kept extraction, as the model view reads it.
pub struct Kept<'a> {
    pub path: &'a str,
    pub revision: &'a str,
    pub extractor_version: &'a str,
    pub facts: &'a str,
    pub dropped: i32,
    pub error: Option<&'a str>,
    /// When it was kept, in Unix seconds: the latest reading of a document
    /// whose text is not here is the one [`last_read`] shows.
    pub created_at: i64,
}

/// The facts of every document at its current revision, and where each
/// document stands. An extraction by an older extractor version counts as
/// stale: it answered a different question.
pub fn current(documents: &[SourceText], kept: &[Kept<'_>]) -> (Vec<extract::Fact>, Vec<Coverage>) {
    let mut by_path: BTreeMap<&str, Vec<&Kept<'_>>> = BTreeMap::new();
    for k in kept {
        by_path.entry(k.path).or_default().push(k);
    }
    let mut facts = Vec::new();
    let mut coverage = Vec::new();
    for doc in documents {
        let revision = extract::revision(&doc.text);
        let rows = by_path
            .get(doc.path.as_str())
            .map(Vec::as_slice)
            .unwrap_or_default();
        let now = rows
            .iter()
            .find(|k| k.revision == revision && k.extractor_version == extract::EXTRACTOR_VERSION);
        let (state, n, dropped, error) = match now {
            Some(k) => {
                let got: Vec<extract::Fact> = serde_json::from_str(k.facts).unwrap_or_default();
                let n = got.len();
                facts.extend(got);
                let state = if k.error.is_some() {
                    "failed"
                } else {
                    "extracted"
                };
                (
                    state,
                    n,
                    usize::try_from(k.dropped).unwrap_or(0),
                    k.error.map(str::to_string),
                )
            }
            None if rows.is_empty() => ("pending", 0, 0, None),
            // The same text read by an earlier extractor: its facts stand
            // until a build reads it again, so a new extractor does not empty
            // every model at once. Another revision's facts never do — their
            // lines are not this text's.
            None => match rows
                .iter()
                .find(|k| k.revision == revision && k.error.is_none())
            {
                Some(k) => {
                    let got: Vec<extract::Fact> = serde_json::from_str(k.facts).unwrap_or_default();
                    let n = got.len();
                    facts.extend(got);
                    ("stale", n, usize::try_from(k.dropped).unwrap_or(0), None)
                }
                None => ("stale", 0, 0, None),
            },
        };
        coverage.push(Coverage {
            path: doc.path.clone(),
            revision,
            state,
            facts: n,
            dropped,
            error,
        });
    }
    (facts, coverage)
}

/// The facts last read of documents whose text this server does not hold
/// (`unread`), so a missing clone does not empty the model: the newest
/// complete reading of each, by the current extractor when there is one.
/// Their state is `kept`; a build cannot read them again until the text is
/// back, and the rules that check passages against the text do not see them.
pub fn last_read(unread: &[String], kept: &[Kept<'_>]) -> (Vec<extract::Fact>, Vec<Coverage>) {
    let mut facts = Vec::new();
    let mut coverage = Vec::new();
    for path in unread {
        let best = kept
            .iter()
            .filter(|k| k.path == path && k.error.is_none())
            .max_by_key(|k| {
                (
                    k.extractor_version == extract::EXTRACTOR_VERSION,
                    k.created_at,
                )
            });
        let Some(k) = best else {
            continue;
        };
        let got: Vec<extract::Fact> = serde_json::from_str(k.facts).unwrap_or_default();
        coverage.push(Coverage {
            path: path.clone(),
            revision: k.revision.to_owned(),
            state: "kept",
            facts: got.len(),
            dropped: usize::try_from(k.dropped).unwrap_or(0),
            error: None,
        });
        facts.extend(got);
    }
    (facts, coverage)
}

/// The documents a build has to read: never extracted at their revision, or
/// extracted part-way.
pub fn to_read(coverage: &[Coverage]) -> Vec<&str> {
    coverage
        .iter()
        .filter(|c| c.state != "extracted" && c.state != "kept")
        .map(|c| c.path.as_str())
        .collect()
}

/// Most candidates the rules over the facts send to the judge in one build:
/// each is a model call. Citations have their own cap
/// ([`index::CITATION_CAP`]).
pub const CANDIDATE_CAP: usize = 150;

/// A candidate's key for its judgement: its fingerprint (its sides' paths
/// and passages) and the revisions of the documents its sides are in. A
/// judgement holds while neither document changes.
pub fn judgement_key(
    candidate: &rules::Candidate,
    revision_of: &BTreeMap<String, String>,
) -> (String, String) {
    let fingerprint = finding::Finding::new("", "", String::new(), candidate.side_refs())
        .keyed_by_sides()
        .fingerprint;
    let mut revisions: Vec<&str> = candidate
        .sides
        .iter()
        .map(|f| revision_of.get(&f.path).map_or("", String::as_str))
        .collect();
    revisions.sort_unstable();
    (fingerprint, revisions.join(","))
}

/// One kept judgement, as the findings read it.
pub struct Judged<'a> {
    pub fingerprint: &'a str,
    pub revisions: &'a str,
    pub judge_version: &'a str,
    pub finding: Option<&'a str>,
}

/// The confirmed findings among today's candidates, and the candidates not
/// judged yet at their revisions. A judgement of a revision that is gone, or
/// by an older judge, answers nothing.
pub fn judged(
    candidates: &[rules::Candidate],
    revision_of: &BTreeMap<String, String>,
    kept: &[Judged<'_>],
) -> (Vec<finding::Finding>, Vec<usize>) {
    let mut findings = Vec::new();
    let mut unjudged = Vec::new();
    for (i, candidate) in candidates.iter().enumerate() {
        let (fingerprint, revisions) = judgement_key(candidate, revision_of);
        let hit = kept.iter().find(|k| {
            k.fingerprint == fingerprint
                && k.revisions == revisions
                && k.judge_version == judge::JUDGE_VERSION
        });
        match hit {
            Some(k) => {
                if let Some(found) = k.finding.and_then(|f| serde_json::from_str(f).ok()) {
                    findings.push(found);
                }
            }
            None => unjudged.push(i),
        }
    }
    (findings, unjudged)
}

/// Each document's current revision, by path.
pub fn revisions(documents: &[SourceText]) -> BTreeMap<String, String> {
    documents
        .iter()
        .map(|d| (d.path.clone(), extract::revision(&d.text)))
        .collect()
}

#[cfg(test)]
mod current_tests {
    use super::*;

    fn doc(path: &str, text: &str) -> SourceText {
        SourceText {
            path: path.to_owned(),
            text: text.to_owned(),
            doc_type: Some("prd".to_owned()),
            node: String::new(),
            binding: None,
        }
    }

    const FACTS: &str = r#"[{"kind":"entity","subject":"Invoice","text":"An invoice.","status":"active","path":"docs/a.md","line_start":1,"line_end":1,"quote":"An invoice"}]"#;

    #[test]
    fn an_earlier_extractor_keeps_its_facts_until_the_text_is_read_again() {
        let d = doc("docs/a.md", "An invoice.\n");
        let revision = extract::revision(&d.text);
        let kept = [Kept {
            path: "docs/a.md",
            revision: &revision,
            extractor_version: "0",
            facts: FACTS,
            dropped: 0,
            error: None,
            created_at: 0,
        }];
        let (facts, coverage) = current(std::slice::from_ref(&d), &kept);
        assert_eq!(facts.len(), 1, "the earlier reading still shows");
        assert_eq!(
            coverage[0].state, "stale",
            "and the next build reads it again"
        );
        assert_eq!(to_read(&coverage), vec!["docs/a.md"]);
    }

    #[test]
    fn a_template_is_not_documentation() {
        assert!(is_template_path(
            "studio-backend/src/documents/templates/prd.md"
        ));
        assert!(is_template_path("kits/sdlc/template.md"));
        assert!(!is_template_path("docs/prd/constructor-studio.md"));
        assert!(!is_template_path("docs/templates-guide.md"));
        assert!(is_template_path(
            "studio-frontend/.cf-studio/config/kits/sdlc/artifacts/PRD/examples/example.md"
        ));
        assert!(is_template_path("docs/examples/flow.md"));
        assert!(!is_template_path("docs/example-driven-design.md"));
    }

    fn kept<'a>(revision: &'a str, version: &'a str, error: Option<&'a str>, at: i64) -> Kept<'a> {
        Kept {
            path: "docs/a.md",
            revision,
            extractor_version: version,
            facts: FACTS,
            dropped: 0,
            error,
            created_at: at,
        }
    }

    #[test]
    fn a_document_whose_clone_is_gone_keeps_its_last_reading() {
        let unread = vec!["docs/a.md".to_owned()];
        let rows = [
            kept("old", extract::EXTRACTOR_VERSION, None, 10),
            kept("new", extract::EXTRACTOR_VERSION, None, 20),
            kept("newer", extract::EXTRACTOR_VERSION, Some("cut off"), 30),
        ];
        let (facts, coverage) = last_read(&unread, &rows);
        assert_eq!(facts.len(), 1, "the model does not empty with the clone");
        assert_eq!(coverage[0].state, "kept");
        assert_eq!(coverage[0].revision, "new", "the newest complete reading");
        assert!(
            to_read(&coverage).is_empty(),
            "no text to read it again from"
        );
    }

    #[test]
    fn the_current_extractor_s_reading_wins_over_a_later_older_one() {
        let unread = vec!["docs/a.md".to_owned()];
        let rows = [
            kept("a", extract::EXTRACTOR_VERSION, None, 10),
            kept("b", "0", None, 20),
        ];
        let (_, coverage) = last_read(&unread, &rows);
        assert_eq!(coverage[0].revision, "a");
    }

    #[test]
    fn a_document_never_read_shows_nothing_while_its_text_is_away() {
        let unread = vec!["docs/b.md".to_owned()];
        let (facts, coverage) =
            last_read(&unread, &[kept("a", extract::EXTRACTOR_VERSION, None, 1)]);
        assert!(facts.is_empty() && coverage.is_empty());
    }

    #[test]
    fn another_revision_gives_no_facts() {
        let d = doc("docs/a.md", "An invoice, changed.\n");
        let kept = [Kept {
            path: "docs/a.md",
            revision: "older",
            extractor_version: extract::EXTRACTOR_VERSION,
            facts: FACTS,
            dropped: 0,
            error: None,
            created_at: 0,
        }];
        let (facts, coverage) = current(std::slice::from_ref(&d), &kept);
        assert!(facts.is_empty(), "its lines are not this text's");
        assert_eq!(coverage[0].state, "stale");
    }
}
