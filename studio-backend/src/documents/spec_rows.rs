//! What a project has of each document, however it got there.
//!
//! A project's documents arrive two ways. Somebody writes one in Studio — an
//! authored document, whose content is a Postgres column — or the repository
//! already had one and a sync bound the file to a type, in which case the
//! content lives in the artifact graph's file node. Neither is object storage:
//! that holds uploaded binaries, and even then the graph node carries a
//! reference rather than the bytes.
//!
//! Where the bytes live is an implementation detail of ours. The question a
//! reader actually has is "what specs do we have, and are they any good", and
//! for a long time answering it meant reading two lists and merging them by
//! eye. So they are merged here, once, and the difference is kept as a column
//! rather than as a tab.
//!
//! ── Why this is not in the browser any more ──────────────────────────────────
//!
//! It was. `spec-rows.ts` and `spec-pipeline.ts` did this fold in the portal,
//! which meant the page had to hold every input first: the bindings, the
//! authored documents, AND every ingested file — the last of those by paging
//! `GET /studio-artifact-ingest/v1/nodes?type=file` to exhaustion, because the
//! projection cannot narrow by a payload field. On a project of a few thousand
//! files that is a great many round trips to build a list nobody asked to see
//! in full.
//!
//! With a second portal arriving, each of those rules would have been written
//! twice and disagreed quietly — and the rules below are exactly the kind that
//! disagree quietly: which queue a row belongs in, and what counts as coverage.

use serde::Serialize;

/// Where a row's bytes live. An implementation detail of ours, kept visible
/// because the two behave differently — an authored document reaches the
/// repository only when somebody presses Commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Repository,
    Authored,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Origin::Repository => "repository",
            Origin::Authored => "authored",
        }
    }
}

/// A binding's state, as the fold needs to read it.
///
/// `NotADocument` is a decision that this file is not one; `Unknown` is the
/// absence of any decision. Neither names a type worth counting, whatever
/// `type_key` happens to be left on the record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingState {
    Detected,
    Confirmed,
    Manual,
    Unknown,
    NotADocument,
}

impl BindingState {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "detected" => BindingState::Detected,
            "confirmed" => BindingState::Confirmed,
            "manual" => BindingState::Manual,
            "unknown" => BindingState::Unknown,
            "not_a_document" => BindingState::NotADocument,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            BindingState::Detected => "detected",
            BindingState::Confirmed => "confirmed",
            BindingState::Manual => "manual",
            BindingState::Unknown => "unknown",
            BindingState::NotADocument => "not_a_document",
        }
    }

    /// Does this state name a type somebody actually decided on?
    fn settled(self) -> bool {
        matches!(self, BindingState::Confirmed | BindingState::Manual)
    }
}

/// A repository file bound to a type, as the fold reads it.
#[derive(Debug, Clone)]
pub struct Binding {
    pub id: String,
    pub node_id: String,
    pub path: String,
    pub type_key: Option<String>,
    pub state: BindingState,
    pub conforms: Option<bool>,
    pub updated_at: String,
}

/// A document written in Studio, as the fold reads it.
#[derive(Debug, Clone)]
pub struct Authored {
    pub id: String,
    pub title: String,
    pub type_key: Option<String>,
    /// `draft` | `review` | `approved`.
    pub status: String,
    pub conforms: Option<bool>,
    pub updated_at: String,
}

/// A file the sync ingested that nothing has classified yet.
///
/// These exist the moment a repository is synced, long before anyone presses
/// Scan. Showing them is the difference between "this project has 5785 files,
/// none analysed" and an empty screen that reads as "there is nothing here".
#[derive(Debug, Clone)]
pub struct Candidate {
    pub node_id: String,
    pub path: String,
}

/// One row of the list, whatever it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpecRow {
    /// Unique across all three kinds: the binding id, the document id, or the
    /// candidate's node prefixed so it cannot collide with either.
    pub id: String,
    pub origin: Origin,
    /// What to show in the Name column.
    pub name: String,
    /// Repo-relative path for a repository file; empty for an authored one,
    /// which has no path until it is committed.
    pub path: String,
    /// `None` when nothing has decided a type yet.
    pub type_key: Option<String>,
    /// Graph node id for a repository row — what findings are keyed on.
    pub node_id: Option<String>,
    /// The binding's state. An authored document has none: nobody has to
    /// decide what it is, because somebody chose its type to write it.
    pub state: Option<BindingState>,
    /// Editorial status for an authored row; `None` otherwise — a repository
    /// file has no editorial status, only a type decision.
    pub status: Option<String>,
    /// The last validation verdict, from whichever record holds it.
    pub conforms: Option<bool>,
    pub updated_at: String,
    /// The repository the file came from, for the provenance column. Empty for
    /// an authored row and for a file whose sync recorded none.
    pub repo: String,
}

/// The queues the filter chips offer.
///
/// `NeedsReview` is the one that has to be right: it is a queue, and a queue
/// that lists things nobody can act on stops being read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    NotScanned,
    NeedsReview,
    Bound,
    NotDocuments,
    All,
}

impl Filter {
    // No `parse` counterpart: the endpoint does not narrow by queue and should
    // not. Every row carries the queues it is in, so the chips switch without
    // a request each — and narrowing on the server would make the counts a
    // second question rather than a part of the same answer.

    /// Every queue except `All`, which is the total rather than a queue.
    const QUEUES: [Filter; 4] = [
        Filter::NotScanned,
        Filter::NeedsReview,
        Filter::Bound,
        Filter::NotDocuments,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Filter::NotScanned => "not-scanned",
            Filter::NeedsReview => "needs-review",
            Filter::Bound => "bound",
            Filter::NotDocuments => "not-documents",
            Filter::All => "all",
        }
    }
}

/// Does this row belong in that queue?
#[must_use]
pub fn in_filter(row: &SpecRow, filter: Filter) -> bool {
    match filter {
        // Ingested and never analysed. Distinct from `NeedsReview` on purpose:
        // that queue is for a decision a detector already proposed, this one
        // is for files nothing has looked at yet.
        Filter::NotScanned => row.origin == Origin::Repository && row.state.is_none(),
        Filter::NeedsReview => {
            row.origin == Origin::Repository
                && matches!(
                    row.state,
                    Some(BindingState::Detected) | Some(BindingState::Unknown)
                )
        }
        // An authored document is bound by construction: somebody picked the
        // type before writing a word.
        Filter::Bound => {
            row.origin == Origin::Authored
                || matches!(
                    row.state,
                    Some(BindingState::Confirmed) | Some(BindingState::Manual)
                )
        }
        Filter::NotDocuments => row.state == Some(BindingState::NotADocument),
        Filter::All => true,
    }
}

/// Which queues a row is in.
///
/// `All` is not among them: it is the total rather than a queue, and a row
/// claiming membership of it would make every count wrong.
#[must_use]
pub fn queues_of(row: &SpecRow) -> Vec<Filter> {
    Filter::QUEUES
        .into_iter()
        .filter(|f| in_filter(row, *f))
        .collect()
}

/// Count each queue once, so the chips and the list cannot disagree.
#[must_use]
pub fn counts(rows: &[SpecRow]) -> Vec<(Filter, u32)> {
    let mut out: Vec<(Filter, u32)> = Filter::QUEUES.iter().map(|f| (*f, 0)).collect();
    for row in rows {
        for entry in out.iter_mut() {
            if in_filter(row, entry.0) {
                entry.1 += 1;
            }
        }
    }
    out.push((Filter::All, u32::try_from(rows.len()).unwrap_or(u32::MAX)));
    out
}

/// How a project's specs stand, for its one cell in the projects table.
///
/// A spec is what the Bound queue lists: a repository file somebody confirmed
/// or chose a type for, or a document written in Studio. A file a detector only
/// proposed is not one yet — it is waiting in Needs review.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SpecSummary {
    pub specs: u32,
    /// Of those, written in Studio rather than found in a repository.
    pub authored: u32,
    /// Of those, with a validation verdict of either kind.
    pub checked: u32,
    /// Of the checked, the ones that do not conform.
    pub failing: u32,
}

/// Fold `(state, verdict)` per binding and the verdict per authored document.
///
/// An authored document always carries a verdict (its column is a `bool`), so
/// it always counts as checked — the same reading [`rows`] gives it.
#[must_use]
pub fn summary(
    bindings: impl IntoIterator<Item = (BindingState, Option<bool>)>,
    authored: impl IntoIterator<Item = bool>,
) -> SpecSummary {
    let mut out = SpecSummary::default();
    let mut count = |conforms: Option<bool>| {
        out.specs += 1;
        if let Some(ok) = conforms {
            out.checked += 1;
            if !ok {
                out.failing += 1;
            }
        }
    };
    for (state, conforms) in bindings {
        if matches!(state, BindingState::Confirmed | BindingState::Manual) {
            count(conforms);
        }
    }
    let mut written = 0;
    for conforms in authored {
        count(Some(conforms));
        written += 1;
    }
    out.authored = written;
    out
}

/// The last path segment — what a reader recognises.
fn leaf(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(path)
        .to_owned()
}

/// Merge every source into one list.
///
/// Authored documents come first within the same instant, because they are the
/// ones this project decided to write; beyond that it is newest first, which
/// is the order somebody scanning for "what moved" wants.
///
/// A candidate is dropped as soon as a binding exists for the same node: the
/// binding is the same file, one step further along, and listing both would
/// count one file twice.
#[must_use]
pub fn rows(
    bindings: &[Binding],
    authored: &[Authored],
    candidates: &[Candidate],
    repo_of: &dyn Fn(&str) -> String,
) -> Vec<SpecRow> {
    let mut out: Vec<SpecRow> = Vec::new();

    for b in bindings {
        out.push(SpecRow {
            id: b.id.clone(),
            origin: Origin::Repository,
            name: leaf(&b.path),
            path: b.path.clone(),
            type_key: b.type_key.clone(),
            node_id: Some(b.node_id.clone()),
            state: Some(b.state),
            status: None,
            conforms: b.conforms,
            updated_at: b.updated_at.clone(),
            repo: repo_of(&b.node_id),
        });
    }

    for d in authored {
        out.push(SpecRow {
            id: d.id.clone(),
            origin: Origin::Authored,
            name: d.title.clone(),
            path: String::new(),
            type_key: d.type_key.clone(),
            node_id: None,
            state: None,
            status: Some(d.status.clone()),
            conforms: d.conforms,
            updated_at: d.updated_at.clone(),
            repo: String::new(),
        });
    }

    for c in candidates {
        if bindings.iter().any(|b| b.node_id == c.node_id) {
            continue;
        }
        out.push(SpecRow {
            id: format!("candidate:{}", c.node_id),
            // It IS a repository file — the only thing it lacks is a decision.
            // A third origin would say the bytes live somewhere else, which is
            // the question Origin answers.
            origin: Origin::Repository,
            name: leaf(&c.path),
            path: c.path.clone(),
            type_key: None,
            node_id: Some(c.node_id.clone()),
            // No binding, so no state: nothing has judged this file yet. That
            // is what puts it in "not scanned" and keeps it out of "needs
            // review", which is for files a detector already had an opinion
            // about.
            state: None,
            status: None,
            conforms: None,
            updated_at: String::new(),
            repo: repo_of(&c.node_id),
        });
    }

    out.sort_by(|a, b| {
        // An unreadable date sorts LAST rather than first: the least
        // informative rows must not take the place where the most recent ones
        // belong.
        let at = instant(&a.updated_at);
        let bt = instant(&b.updated_at);
        bt.cmp(&at)
            .then_with(|| match (a.origin, b.origin) {
                (Origin::Authored, Origin::Repository) => std::cmp::Ordering::Less,
                (Origin::Repository, Origin::Authored) => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            })
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

/// An RFC 3339 timestamp as something orderable, with the unreadable ones
/// ordering below every readable one.
///
/// Compared as a string rather than parsed: these come out of Postgres in one
/// format, and lexicographic order is chronological order for it. What matters
/// is that a value which is not one sorts below all of them.
fn instant(value: &str) -> Option<&str> {
    (!value.trim().is_empty()).then_some(value)
}

// ── the pipeline ─────────────────────────────────────────────────────────────

/// A document type as the workspace defines it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineType {
    pub key: String,
    pub name: String,
    /// What the type is for, as the workspace describes it. Shown beside a
    /// type nothing has started yet, where it is the only thing to say.
    pub description: String,
}

/// One document under a type, named the way a reader recognises it.
///
/// `conforms` travels with it because a screen may hold a FRESHER verdict than
/// the record does — a "Validate all" run supersedes what was written at the
/// document's last save. That override is screen state and stays in the
/// browser; what does not is the rule about which documents are eligible to be
/// counted at all, which is here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineEntry {
    pub id: String,
    /// An authored document's title, or a bound file's last path segment.
    pub name: String,
    pub conforms: Option<bool>,
    /// `draft` | `review` | `approved` for an authored document; `None` for a
    /// repository file, which has no editorial status — only a type decision.
    /// The same distinction the list makes, for the same reason.
    pub status: Option<String>,
}

/// One type, and what the project has of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineRow {
    pub type_key: String,
    pub type_name: String,
    pub type_description: String,
    /// Documents written in Studio.
    pub authored: Vec<PipelineEntry>,
    /// Repository files bound to this type by a DECISION — confirmed or
    /// manual. These are documents of this type as much as authored ones.
    pub bound: Vec<PipelineEntry>,
    /// Repository files the scanner THINKS are this type, still unconfirmed.
    /// Counted apart: a guess is not coverage.
    pub proposed: Vec<PipelineEntry>,
    /// Nothing of this type exists and nothing has been proposed — the only
    /// state that honestly reads "not started".
    pub untouched: bool,
    /// Of `authored` + `bound`, how many passed their type's checks. A
    /// document nobody has checked has not passed anything, so an absent
    /// verdict counts as not-valid rather than as valid.
    pub valid: u32,
    /// `authored` + `bound`. The proposals are deliberately NOT in it: folding
    /// a guess in would report coverage the project has not agreed to.
    pub total: u32,
}

/// Group every document a project has under the type it belongs to.
///
/// One row per declared type, in the order the types were given — the
/// workspace decides that order and this must not reshuffle it. A binding
/// naming a type the workspace no longer declares is DROPPED rather than
/// invented into a row: the type list is the authority on what types exist.
#[must_use]
pub fn pipeline(
    types: &[PipelineType],
    authored: &[Authored],
    bindings: &[Binding],
) -> Vec<PipelineRow> {
    types
        .iter()
        .map(|ty| {
            let mut valid = 0u32;

            let authored_entries: Vec<PipelineEntry> = authored
                .iter()
                .filter(|d| d.type_key.as_deref() == Some(ty.key.as_str()))
                .inspect(|d| {
                    if d.conforms == Some(true) {
                        valid += 1;
                    }
                })
                .map(|d| PipelineEntry {
                    id: d.id.clone(),
                    name: d.title.clone(),
                    conforms: d.conforms,
                    status: Some(d.status.clone()),
                })
                .collect();

            let mut bound = Vec::new();
            let mut proposed = Vec::new();
            for b in bindings {
                if b.type_key.as_deref() != Some(ty.key.as_str()) {
                    continue;
                }
                // Neither of these names a type worth counting, whatever
                // `type_key` happens to be left on the record.
                if matches!(b.state, BindingState::NotADocument | BindingState::Unknown) {
                    continue;
                }
                let entry = PipelineEntry {
                    id: b.id.clone(),
                    name: leaf(&b.path),
                    conforms: b.conforms,
                    status: None,
                };
                if b.state.settled() {
                    if b.conforms == Some(true) {
                        valid += 1;
                    }
                    bound.push(entry);
                } else {
                    proposed.push(entry);
                }
            }

            let total = u32::try_from(authored_entries.len() + bound.len()).unwrap_or(u32::MAX);
            PipelineRow {
                type_key: ty.key.clone(),
                type_name: ty.name.clone(),
                type_description: ty.description.clone(),
                untouched: authored_entries.is_empty() && bound.is_empty() && proposed.is_empty(),
                authored: authored_entries,
                bound,
                proposed,
                valid,
                total,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_repo(_: &str) -> String {
        String::new()
    }

    fn ids(entries: &[PipelineEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.id.as_str()).collect()
    }

    fn binding(id: &str, path: &str, state: BindingState) -> Binding {
        Binding {
            id: id.to_owned(),
            node_id: format!("node-{id}"),
            path: path.to_owned(),
            type_key: Some("prd".to_owned()),
            state,
            conforms: None,
            updated_at: "2026-09-01T00:00:00Z".to_owned(),
        }
    }

    fn doc(id: &str, title: &str) -> Authored {
        Authored {
            id: id.to_owned(),
            title: title.to_owned(),
            type_key: Some("prd".to_owned()),
            status: "draft".to_owned(),
            conforms: None,
            updated_at: "2026-09-01T00:00:00Z".to_owned(),
        }
    }

    // ---- one list out of two kinds ---------------------------------------

    #[test]
    fn both_origins_go_in_one_list_and_say_which_is_which() {
        let out = rows(
            &[binding("b1", "docs/prd.md", BindingState::Confirmed)],
            &[doc("d1", "Written here")],
            &[],
            &no_repo,
        );
        assert_eq!(out.len(), 2);
        let origins: Vec<Origin> = out.iter().map(|r| r.origin).collect();
        assert!(origins.contains(&Origin::Repository));
        assert!(origins.contains(&Origin::Authored));
    }

    #[test]
    fn a_repository_row_is_named_by_its_file_and_an_authored_one_by_its_title() {
        let out = rows(
            &[binding(
                "b1",
                "docs/adr/0007-shell.md",
                BindingState::Manual,
            )],
            &[doc("d1", "Product requirements")],
            &[],
            &no_repo,
        );
        let repo = out.iter().find(|r| r.origin == Origin::Repository).unwrap();
        let authored = out.iter().find(|r| r.origin == Origin::Authored).unwrap();
        assert_eq!(repo.name, "0007-shell.md");
        assert_eq!(authored.name, "Product requirements");
    }

    #[test]
    fn an_authored_row_has_no_path_until_it_is_committed() {
        let out = rows(&[], &[doc("d1", "Spec")], &[], &no_repo);
        assert_eq!(out[0].path, "");
    }

    #[test]
    fn the_newest_row_comes_first() {
        let mut older = binding("b1", "a.md", BindingState::Confirmed);
        older.updated_at = "2026-08-01T00:00:00Z".to_owned();
        let mut newer = binding("b2", "b.md", BindingState::Confirmed);
        newer.updated_at = "2026-09-20T00:00:00Z".to_owned();
        let out = rows(&[older, newer], &[], &[], &no_repo);
        assert_eq!(out[0].id, "b2");
    }

    #[test]
    fn an_unreadable_date_sorts_last_not_first() {
        // The least informative row must not take the place where the most
        // recent one belongs.
        let mut undated = binding("b1", "a.md", BindingState::Confirmed);
        undated.updated_at = String::new();
        let dated = binding("b2", "b.md", BindingState::Confirmed);
        let out = rows(&[undated, dated], &[], &[], &no_repo);
        assert_eq!(out[0].id, "b2");
        assert_eq!(out[1].id, "b1");
    }

    #[test]
    fn an_authored_document_comes_first_within_the_same_instant() {
        let out = rows(
            &[binding("b1", "a.md", BindingState::Confirmed)],
            &[doc("d1", "Zzz")],
            &[],
            &no_repo,
        );
        assert_eq!(out[0].origin, Origin::Authored);
    }

    // ---- the queues -------------------------------------------------------

    #[test]
    fn an_authored_document_stays_out_of_the_review_queue() {
        // It was written AS a type, so there is nothing to review about what
        // it is.
        let out = rows(&[], &[doc("d1", "Spec")], &[], &no_repo);
        assert!(!in_filter(&out[0], Filter::NeedsReview));
        assert!(in_filter(&out[0], Filter::Bound));
    }

    #[test]
    fn an_undecided_repository_file_is_in_the_review_queue() {
        for state in [BindingState::Detected, BindingState::Unknown] {
            let out = rows(&[binding("b1", "a.md", state)], &[], &[], &no_repo);
            assert!(in_filter(&out[0], Filter::NeedsReview), "{state:?}");
        }
    }

    #[test]
    fn a_decided_file_counts_as_bound_whichever_way_it_was_decided() {
        for state in [BindingState::Confirmed, BindingState::Manual] {
            let out = rows(&[binding("b1", "a.md", state)], &[], &[], &no_repo);
            assert!(in_filter(&out[0], Filter::Bound), "{state:?}");
            assert!(!in_filter(&out[0], Filter::NeedsReview), "{state:?}");
        }
    }

    #[test]
    fn a_rejected_file_stays_in_its_own_queue_and_out_of_the_others() {
        let out = rows(
            &[binding("b1", "a.md", BindingState::NotADocument)],
            &[],
            &[],
            &no_repo,
        );
        assert!(in_filter(&out[0], Filter::NotDocuments));
        assert!(!in_filter(&out[0], Filter::Bound));
        assert!(!in_filter(&out[0], Filter::NeedsReview));
        assert!(!in_filter(&out[0], Filter::NotScanned));
    }

    #[test]
    fn a_rows_queues_are_the_ones_it_is_counted_in() {
        // The wire carries these per row so no caller re-derives them; they
        // must be the same answer the counts are made of.
        let out = rows(
            &[
                binding("b1", "a.md", BindingState::Detected),
                binding("b2", "b.md", BindingState::Confirmed),
                binding("b3", "c.md", BindingState::NotADocument),
            ],
            &[doc("d1", "Spec")],
            &[Candidate {
                node_id: "n9".to_owned(),
                path: "d.md".to_owned(),
            }],
            &no_repo,
        );
        for row in &out {
            let claimed = queues_of(row);
            for queue in Filter::QUEUES {
                assert_eq!(
                    claimed.contains(&queue),
                    in_filter(row, queue),
                    "{} in {}",
                    row.id,
                    queue.as_str()
                );
            }
            // `All` is the total, not a queue: a row claiming it would make
            // every count wrong.
            assert!(!claimed.contains(&Filter::All));
        }
    }

    #[test]
    fn the_counts_agree_with_the_list_they_label() {
        let out = rows(
            &[
                binding("b1", "a.md", BindingState::Detected),
                binding("b2", "b.md", BindingState::Confirmed),
                binding("b3", "c.md", BindingState::NotADocument),
            ],
            &[doc("d1", "Spec")],
            &[Candidate {
                node_id: "n9".to_owned(),
                path: "d.md".to_owned(),
            }],
            &no_repo,
        );
        let counted = counts(&out);
        for (filter, n) in &counted {
            let by_hand = out.iter().filter(|r| in_filter(r, *filter)).count();
            assert_eq!(*n as usize, by_hand, "{}", filter.as_str());
        }
        assert_eq!(
            counted
                .iter()
                .find(|(f, _)| *f == Filter::All)
                .map(|(_, n)| *n),
            Some(5)
        );
    }

    // ---- candidates -------------------------------------------------------

    #[test]
    fn an_ingested_file_nothing_has_classified_is_listed() {
        let out = rows(
            &[],
            &[],
            &[Candidate {
                node_id: "n1".to_owned(),
                path: "docs/readme.md".to_owned(),
            }],
            &no_repo,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].origin, Origin::Repository);
        assert_eq!(out[0].name, "readme.md");
        assert_eq!(out[0].node_id.as_deref(), Some("n1"));
        assert_eq!(out[0].type_key, None);
    }

    #[test]
    fn a_candidate_is_dropped_the_moment_its_file_has_a_binding() {
        // The binding is the same file one step further along; listing both
        // would count one file twice.
        let b = binding("b1", "docs/prd.md", BindingState::Confirmed);
        let out = rows(
            std::slice::from_ref(&b),
            &[],
            &[Candidate {
                node_id: b.node_id.clone(),
                path: b.path.clone(),
            }],
            &no_repo,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "b1");
    }

    #[test]
    fn a_candidate_belongs_to_not_scanned_never_to_needs_review() {
        let out = rows(
            &[],
            &[],
            &[Candidate {
                node_id: "n1".to_owned(),
                path: "a.md".to_owned(),
            }],
            &no_repo,
        );
        assert!(in_filter(&out[0], Filter::NotScanned));
        assert!(!in_filter(&out[0], Filter::NeedsReview));
        assert!(!in_filter(&out[0], Filter::Bound));
    }

    #[test]
    fn a_rows_repository_comes_from_the_node_it_was_ingested_from() {
        let repo_of = |node: &str| {
            if node == "n1" {
                "constructorfabric/studio-web".to_owned()
            } else {
                String::new()
            }
        };
        let out = rows(
            &[],
            &[doc("d1", "Authored")],
            &[Candidate {
                node_id: "n1".to_owned(),
                path: "a.md".to_owned(),
            }],
            &repo_of,
        );
        let file = out.iter().find(|r| r.origin == Origin::Repository).unwrap();
        let written = out.iter().find(|r| r.origin == Origin::Authored).unwrap();
        assert_eq!(file.repo, "constructorfabric/studio-web");
        // An authored document is not in a repository until somebody commits it.
        assert_eq!(written.repo, "");
    }

    // ---- the pipeline -----------------------------------------------------

    fn types() -> Vec<PipelineType> {
        vec![
            PipelineType {
                key: "prd".to_owned(),
                name: "PRD".to_owned(),
                description: String::new(),
            },
            PipelineType {
                key: "adr".to_owned(),
                name: "ADR".to_owned(),
                description: String::new(),
            },
        ]
    }

    #[test]
    fn a_repository_file_bound_to_a_type_is_a_document_of_that_type() {
        let out = pipeline(
            &types(),
            &[],
            &[binding("b1", "a.md", BindingState::Confirmed)],
        );
        assert_eq!(ids(&out[0].bound), vec!["b1"]);
        assert_eq!(out[0].total, 1);
        assert!(!out[0].untouched);
    }

    #[test]
    fn a_scanners_guess_is_kept_out_of_the_bound_set() {
        let out = pipeline(
            &types(),
            &[],
            &[binding("b1", "a.md", BindingState::Detected)],
        );
        assert!(out[0].bound.is_empty());
        assert_eq!(ids(&out[0].proposed), vec!["b1"]);
        // Shown, but not coverage the project agreed to.
        assert_eq!(out[0].total, 0);
        assert!(!out[0].untouched);
    }

    #[test]
    fn a_file_somebody_decided_is_not_a_document_is_ignored() {
        for state in [BindingState::NotADocument, BindingState::Unknown] {
            let out = pipeline(&types(), &[], &[binding("b1", "a.md", state)]);
            assert!(out[0].bound.is_empty(), "{state:?}");
            assert!(out[0].proposed.is_empty(), "{state:?}");
            assert!(out[0].untouched, "{state:?}");
        }
    }

    #[test]
    fn there_is_one_row_per_declared_type_in_the_order_declared() {
        let out = pipeline(&types(), &[], &[]);
        let keys: Vec<&str> = out.iter().map(|r| r.type_key.as_str()).collect();
        assert_eq!(keys, vec!["prd", "adr"]);
    }

    #[test]
    fn a_binding_naming_a_type_the_workspace_no_longer_declares_is_dropped() {
        // The type list is the authority on what types exist.
        let mut b = binding("b1", "a.md", BindingState::Confirmed);
        b.type_key = Some("retired".to_owned());
        let out = pipeline(&types(), &[], &[b]);
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|r| r.bound.is_empty()));
    }

    #[test]
    fn authored_and_bound_documents_share_one_total() {
        let out = pipeline(
            &types(),
            &[doc("d1", "Spec")],
            &[binding("b1", "a.md", BindingState::Manual)],
        );
        assert_eq!(out[0].total, 2);
    }

    #[test]
    fn an_unchecked_document_is_not_valid_rather_than_valid() {
        // Nobody has checked it, so it has not passed anything.
        let out = pipeline(&types(), &[doc("d1", "Spec")], &[]);
        assert_eq!(out[0].total, 1);
        assert_eq!(out[0].valid, 0);
    }

    #[test]
    fn a_passing_document_counts_towards_valid_from_either_side() {
        let mut d = doc("d1", "Spec");
        d.conforms = Some(true);
        let mut b = binding("b1", "a.md", BindingState::Confirmed);
        b.conforms = Some(true);
        let mut failing = binding("b2", "b.md", BindingState::Confirmed);
        failing.conforms = Some(false);
        let out = pipeline(&types(), &[d], &[b, failing]);
        assert_eq!(out[0].valid, 2);
        assert_eq!(out[0].total, 3);
    }

    #[test]
    fn an_unconfirmed_guess_stays_out_of_the_total_even_when_it_passes() {
        let mut guess = binding("b1", "a.md", BindingState::Detected);
        guess.conforms = Some(true);
        let out = pipeline(&types(), &[], &[guess]);
        assert_eq!(out[0].total, 0);
        assert_eq!(out[0].valid, 0);
    }

    #[test]
    fn a_type_with_nothing_at_all_reads_as_not_started() {
        let out = pipeline(&types(), &[], &[]);
        assert!(out[1].untouched);
        assert_eq!(out[1].total, 0);
    }

    #[test]
    fn a_summary_counts_only_decided_specs() {
        let s = summary(
            [
                (BindingState::Confirmed, Some(true)),
                (BindingState::Manual, Some(false)),
                (BindingState::Confirmed, None),
                // Proposed, not decided: waiting in Needs review, not a spec.
                (BindingState::Detected, Some(true)),
                (BindingState::NotADocument, None),
            ],
            [true, false],
        );
        assert_eq!(
            s,
            SpecSummary {
                specs: 5,
                authored: 2,
                checked: 4,
                failing: 2,
            }
        );
    }
}
