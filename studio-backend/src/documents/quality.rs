//! Handing a project's specs to Spec Quality, without sending them through a
//! browser first.
//!
//! ## What this replaces
//!
//! The detectors were called from the portal, and the portal could only call
//! them by holding the documents: it walked every ingested file node, read each
//! file's text out of a checkout through `GET /repo-files`, kept the lot in
//! memory, and posted it back in the request body. A full round trip of bytes
//! the backend had just read off its own disk — and for `bloat` and
//! `traceability`, which take the whole document set in ONE body, the reason
//! the fetch layer still apologises for HTTP 413.
//!
//! Nothing but the browser could do it, because nothing else could join the two
//! halves: this gear knows which files are specs and what type each is, and the
//! text lives with whoever holds the checkout. `artifact_ingest::port` is that
//! seam now, so the join happens here.
//!
//! ## What deliberately did NOT move
//!
//! Which documents to analyse. `spec_quality::batch_task` says it plainly —
//! moving the fan-out is not a reason to quietly move the policy with it — and
//! the same applies twice over to moving the text. The caller names the
//! bindings; this decides nothing about which ones deserve a detector, only how
//! to get their contents to one.
//!
//! ## Why every detector goes through the batch run
//!
//! `spec_quality.analyze` watches an upstream task somebody has already
//! submitted, and only that gear can submit — it holds the key. The batch run
//! submits each item itself, posting the item's payload verbatim. A whole-set
//! detector is therefore one item whose payload is the whole set, and all four
//! detectors take one path instead of two.

use std::collections::BTreeMap;

use serde_json::{Value, json};

/// A document as the analysis needs it.
pub struct SpecDoc {
    /// Repo-relative path — the id the detectors echo back.
    pub path: String,
    pub text: String,
    /// The type a binding settled on, for the detector that judges against it.
    pub doc_type: Option<String>,
}

/// The name a document written in Studio goes by in a detector run. It has no
/// path in any repository, and the run echoes this back as the item's id.
pub fn studio_doc_path(id: uuid::Uuid) -> String {
    format!("studio-doc/{id}.md")
}

/// How many texts one request may carry inline.
///
/// Inline texts exist for the one document somebody is looking at — an
/// editor's unsaved buffer, a desktop checkout ahead of the server's — and a
/// set detector needs a few more beside it at most. A caller with a whole
/// project to send has a checkout for the server to read instead.
pub const MAX_INLINE_DOCUMENTS: usize = 20;
/// The largest single inline text, in bytes. Well past any specification a
/// person writes by hand; a file this size is generated, and the checkout has
/// it.
pub const MAX_INLINE_TEXT_BYTES: usize = 256 * 1024;
/// All inline texts together, in bytes. Kept under axum's 2 MiB body default
/// with room for JSON escaping, so an oversized request is refused by this
/// rule, with a reason, rather than by the extractor with a bare 413.
pub const MAX_INLINE_TOTAL_BYTES: usize = 1024 * 1024;
/// A path is an id the run echoes back, not content.
pub const MAX_INLINE_PATH_CHARS: usize = 1024;

/// A text the caller sent with the request rather than one the server read.
pub struct InlineDoc {
    pub path: String,
    pub text: String,
    pub doc_type: Option<String>,
}

/// Check inline texts against the caps and turn them into documents.
///
/// A whitespace-only text is dropped, as an empty file or document is: a
/// detector asked about nothing answers about nothing. Everything else that
/// is wrong — too many, too large, a path missing or given twice — is the
/// caller's to fix, so it is refused with the reason rather than trimmed.
pub fn inline_docs(inline: Vec<InlineDoc>) -> Result<Vec<SpecDoc>, String> {
    if inline.len() > MAX_INLINE_DOCUMENTS {
        return Err(format!(
            "at most {MAX_INLINE_DOCUMENTS} documents may be sent inline; this request has {}",
            inline.len()
        ));
    }
    let mut total = 0usize;
    let mut out: Vec<SpecDoc> = Vec::with_capacity(inline.len());
    for doc in inline {
        let path = doc.path.trim().to_string();
        if path.is_empty() {
            return Err("every inline document needs a path".to_string());
        }
        if path.chars().count() > MAX_INLINE_PATH_CHARS {
            return Err(format!(
                "an inline document's path is at most {MAX_INLINE_PATH_CHARS} characters"
            ));
        }
        if out.iter().any(|d| d.path == path) {
            return Err(format!("`{path}` is sent inline twice"));
        }
        if doc.text.len() > MAX_INLINE_TEXT_BYTES {
            return Err(format!(
                "`{path}` is {} bytes; an inline document is at most {MAX_INLINE_TEXT_BYTES}",
                doc.text.len()
            ));
        }
        total += doc.text.len();
        if total > MAX_INLINE_TOTAL_BYTES {
            return Err(format!(
                "the inline documents come to more than {MAX_INLINE_TOTAL_BYTES} bytes together"
            ));
        }
        if doc.text.trim().is_empty() {
            continue;
        }
        out.push(SpecDoc {
            path,
            text: doc.text,
            doc_type: doc
                .doc_type
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty()),
        });
    }
    Ok(out)
}

/// Add the inline texts to what the server read.
///
/// An inline text at a path the server also read REPLACES that copy: it is the
/// newer text of the same document, and judging both would have `bloat` find
/// the document duplicating itself. What the server knew about it that the
/// caller did not say — its bound type — is kept.
pub fn with_inline(mut read: Vec<SpecDoc>, inline: Vec<SpecDoc>) -> Vec<SpecDoc> {
    let mut brought: Vec<SpecDoc> = Vec::with_capacity(inline.len());
    for mut doc in inline {
        if let Some(at) = read.iter().position(|r| r.path == doc.path) {
            let server = read.remove(at);
            if doc.doc_type.is_none() {
                doc.doc_type = server.doc_type;
            }
        }
        brought.push(doc);
    }
    // The server's documents first, as they were asked for, then the ones
    // the caller brought.
    read.extend(brought);
    read
}

/// The four the upstream serves. Rejected by name rather than forwarded, so an
/// unknown one fails here instead of as an upstream 404 inside a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detector {
    Purpose,
    Leak,
    Bloat,
    Traceability,
}

impl Detector {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "purpose" => Some(Self::Purpose),
            "leak" => Some(Self::Leak),
            "bloat" => Some(Self::Bloat),
            "traceability" => Some(Self::Traceability),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Purpose => "purpose",
            Self::Leak => "leak",
            Self::Bloat => "bloat",
            Self::Traceability => "traceability",
        }
    }

    /// Whether the detector judges one document or a set of them.
    ///
    /// `bloat` looks for text shared BETWEEN documents and `traceability` for
    /// references between them; neither has an answer for a document on its
    /// own. The other two do, and get one item each so a slow document does
    /// not hold up the rest.
    fn whole_set(self) -> bool {
        matches!(self, Self::Bloat | Self::Traceability)
    }
}

/// One item of the batch run: an id the result is joined on, and the body the
/// detector expects.
pub struct AnalysisItem {
    pub id: String,
    pub payload: Value,
}

/// Build what the batch run submits.
///
/// The bodies are the upstream's, mirrored from what the portal used to send —
/// including `verify: false`, which asks the detectors not to spend a second
/// LLM round trip confirming themselves.
pub fn build_items(detector: Detector, docs: &[SpecDoc], set_id: &str) -> Vec<AnalysisItem> {
    if docs.is_empty() {
        return Vec::new();
    }
    if detector.whole_set() {
        let mut map = serde_json::Map::new();
        for doc in docs {
            map.insert(doc.path.clone(), Value::String(doc.text.clone()));
        }
        let docs_value = Value::Object(map);
        let payload = match detector {
            Detector::Bloat => json!({ "docs": docs_value }),
            _ => json!({ "docs": docs_value, "mode": "extract", "verify": false }),
        };
        return vec![AnalysisItem {
            id: set_id.to_string(),
            payload,
        }];
    }
    docs.iter()
        .map(|doc| AnalysisItem {
            id: doc.path.clone(),
            payload: match detector {
                Detector::Purpose => json!({
                    "text": doc.text,
                    "path": doc.path,
                    "classify_doc_type": true,
                }),
                // A leak verdict is "how much of this document belongs to some
                // other type", so it needs the type this one claims. A document
                // with none is not asked: the question has no subject.
                _ => json!({
                    "text": doc.text,
                    "path": doc.path,
                    "doc_type": doc.doc_type.clone().unwrap_or_default(),
                    "gate_threshold": 0.05,
                    "verify": false,
                }),
            },
        })
        .collect()
}

/// The directories a workspace's repositories were cloned into.
///
/// Read out of the tenant metadata the portal writes, where `target` is the
/// directory and `name` is the fallback the settings themselves document. A
/// `local` source is skipped: there is no checkout to read.
pub fn checkout_dirs(settings: &Value) -> Vec<String> {
    let Some(repos) = settings.get("repos").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for repo in repos {
        if repo.get("source").and_then(Value::as_str) == Some("local") {
            continue;
        }
        let dir = repo
            .get("target")
            .and_then(Value::as_str)
            .filter(|t| !t.trim().is_empty())
            .or_else(|| repo.get("name").and_then(Value::as_str))
            .unwrap_or_default()
            .trim();
        if !dir.is_empty() && !out.iter().any(|d| d == dir) {
            out.push(dir.to_string());
        }
    }
    out
}

/// Join the bindings a caller named to the text a checkout holds.
///
/// A binding whose file the checkout does not have is dropped rather than sent
/// empty: a detector asked about nothing answers about nothing, and the run
/// would report a verdict for a document nobody read.
pub fn docs_for(
    wanted: &[(String, Option<String>)],
    by_path: &BTreeMap<String, String>,
) -> Vec<SpecDoc> {
    wanted
        .iter()
        .filter_map(|(path, doc_type)| {
            by_path.get(path).map(|text| SpecDoc {
                path: path.clone(),
                text: text.clone(),
                doc_type: doc_type.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_studio_document_goes_by_its_id_in_a_run() {
        let id = uuid::Uuid::from_u128(7);
        assert_eq!(
            studio_doc_path(id),
            "studio-doc/00000000-0000-0000-0000-000000000007.md"
        );
    }

    fn doc(path: &str, text: &str, ty: Option<&str>) -> SpecDoc {
        SpecDoc {
            path: path.to_string(),
            text: text.to_string(),
            doc_type: ty.map(str::to_string),
        }
    }

    #[test]
    fn only_the_four_detectors_are_accepted() {
        for name in ["purpose", "leak", "bloat", "traceability"] {
            assert_eq!(Detector::parse(name).map(Detector::as_str), Some(name));
        }
        assert_eq!(Detector::parse("PURPOSE"), Some(Detector::Purpose));
        // An unknown one fails here rather than as an upstream 404 inside a run.
        assert_eq!(Detector::parse("vibes"), None);
        assert_eq!(Detector::parse(""), None);
    }

    #[test]
    fn a_per_document_detector_gets_one_item_each() {
        let docs = vec![doc("a.md", "A", Some("prd")), doc("b.md", "B", Some("adr"))];
        let items = build_items(Detector::Purpose, &docs, "project");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "a.md");
        assert_eq!(items[0].payload["classify_doc_type"], json!(true));
        assert_eq!(items[0].payload["text"], json!("A"));
    }

    #[test]
    fn a_whole_set_detector_gets_one_item_carrying_every_document() {
        // `bloat` looks for text shared BETWEEN documents; one document on its
        // own has no answer, which is why this cannot be split per item.
        let docs = vec![doc("a.md", "A", None), doc("b.md", "B", None)];
        let items = build_items(Detector::Bloat, &docs, "project-1");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "project-1");
        assert_eq!(items[0].payload["docs"]["a.md"], json!("A"));
        assert_eq!(items[0].payload["docs"]["b.md"], json!("B"));
    }

    #[test]
    fn traceability_asks_for_extraction_and_no_second_opinion() {
        let items = build_items(Detector::Traceability, &[doc("a.md", "A", None)], "p");
        assert_eq!(items[0].payload["mode"], json!("extract"));
        assert_eq!(items[0].payload["verify"], json!(false));
    }

    #[test]
    fn leak_carries_the_type_the_document_claims() {
        let items = build_items(Detector::Leak, &[doc("a.md", "A", Some("prd"))], "p");
        assert_eq!(items[0].payload["doc_type"], json!("prd"));
        assert_eq!(items[0].payload["gate_threshold"], json!(0.05));
    }

    #[test]
    fn no_documents_is_no_items_rather_than_an_empty_analysis() {
        for d in [
            Detector::Purpose,
            Detector::Leak,
            Detector::Bloat,
            Detector::Traceability,
        ] {
            assert!(build_items(d, &[], "p").is_empty(), "{}", d.as_str());
        }
    }

    #[test]
    fn checkout_dirs_prefers_the_target_and_falls_back_to_the_name() {
        let settings = json!({ "repos": [
            { "name": "api", "target": "services/api", "source": "github" },
            { "name": "docs", "source": "gitlab" },
        ]});
        assert_eq!(checkout_dirs(&settings), vec!["services/api", "docs"]);
    }

    #[test]
    fn a_local_source_has_no_checkout_to_read() {
        let settings = json!({ "repos": [
            { "name": "notes", "source": "local" },
            { "name": "api", "source": "github" },
        ]});
        assert_eq!(checkout_dirs(&settings), vec!["api"]);
    }

    #[test]
    fn settings_with_no_repositories_name_no_directories() {
        assert!(checkout_dirs(&json!({})).is_empty());
        assert!(checkout_dirs(&json!({ "repos": [] })).is_empty());
    }

    #[test]
    fn a_directory_named_twice_is_read_once() {
        let settings = json!({ "repos": [
            { "name": "api", "target": "shared", "source": "github" },
            { "name": "shared", "source": "github" },
        ]});
        assert_eq!(checkout_dirs(&settings), vec!["shared"]);
    }

    fn inline(path: &str, text: &str, ty: Option<&str>) -> InlineDoc {
        InlineDoc {
            path: path.to_string(),
            text: text.to_string(),
            doc_type: ty.map(str::to_string),
        }
    }

    #[test]
    fn an_inline_text_is_analysed_as_given_under_its_path() {
        let docs = inline_docs(vec![inline(" docs/prd.md ", "# PRD\nunsaved", Some("prd"))])
            .expect("within the caps");
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].path, "docs/prd.md");
        assert_eq!(docs[0].text, "# PRD\nunsaved");
        assert_eq!(docs[0].doc_type.as_deref(), Some("prd"));
    }

    #[test]
    fn more_inline_documents_than_the_cap_are_refused() {
        let many: Vec<_> = (0..=MAX_INLINE_DOCUMENTS)
            .map(|i| inline(&format!("d{i}.md"), "x", None))
            .collect();
        let why = inline_docs(many).err().expect("one over the cap");
        assert!(why.contains("at most 20"), "{why}");
        let exactly: Vec<_> = (0..MAX_INLINE_DOCUMENTS)
            .map(|i| inline(&format!("d{i}.md"), "x", None))
            .collect();
        assert_eq!(
            inline_docs(exactly).map(|d| d.len()),
            Ok(MAX_INLINE_DOCUMENTS)
        );
    }

    #[test]
    fn an_inline_text_over_its_size_cap_is_refused() {
        let big = "a".repeat(MAX_INLINE_TEXT_BYTES + 1);
        let why = inline_docs(vec![inline("big.md", &big, None)])
            .err()
            .expect("over the per-text cap");
        assert!(why.contains("big.md"), "{why}");
        let fits = "a".repeat(MAX_INLINE_TEXT_BYTES);
        assert!(inline_docs(vec![inline("fits.md", &fits, None)]).is_ok());
    }

    #[test]
    fn inline_texts_over_the_total_cap_are_refused_though_each_fits() {
        let each = "a".repeat(MAX_INLINE_TEXT_BYTES);
        let count = MAX_INLINE_TOTAL_BYTES / MAX_INLINE_TEXT_BYTES + 1;
        let docs: Vec<_> = (0..count)
            .map(|i| inline(&format!("d{i}.md"), &each, None))
            .collect();
        let why = inline_docs(docs).err().expect("over the total cap");
        assert!(why.contains("together"), "{why}");
    }

    #[test]
    fn an_inline_document_needs_a_path_and_only_one_copy_of_it() {
        assert!(inline_docs(vec![inline("  ", "x", None)]).is_err());
        let long = "p".repeat(MAX_INLINE_PATH_CHARS + 1);
        assert!(inline_docs(vec![inline(&long, "x", None)]).is_err());
        let why = inline_docs(vec![
            inline("a.md", "one", None),
            inline("a.md", "two", None),
        ])
        .err()
        .expect("the same path twice");
        assert!(why.contains("twice"), "{why}");
    }

    #[test]
    fn an_empty_inline_text_is_left_out_like_an_empty_file() {
        let docs = inline_docs(vec![
            inline("a.md", " \n ", None),
            inline("b.md", "B", None),
        ])
        .expect("within the caps");
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].path, "b.md");
    }

    #[test]
    fn an_inline_text_replaces_the_servers_copy_at_the_same_path() {
        // The binding's copy is the older text of the same document; judging
        // both would have `bloat` find it duplicating itself.
        let read = vec![
            doc("docs/prd.md", "old text", Some("prd")),
            doc("docs/adr.md", "ADR", Some("adr")),
        ];
        let brought = inline_docs(vec![inline("docs/prd.md", "new text", None)]).unwrap();
        let docs = with_inline(read, brought);
        assert_eq!(docs.len(), 2);
        assert_eq!(docs[0].path, "docs/adr.md");
        assert_eq!(docs[1].path, "docs/prd.md");
        assert_eq!(docs[1].text, "new text");
        // The type the binding settled on survives, since the caller named none.
        assert_eq!(docs[1].doc_type.as_deref(), Some("prd"));
    }

    #[test]
    fn an_inline_type_wins_over_the_bindings_and_new_paths_are_added() {
        let read = vec![
            doc("a.md", "A", Some("prd")),
            doc("studio-doc/x.md", "X", Some("adr")),
        ];
        let brought = inline_docs(vec![
            inline("a.md", "A2", Some("feature")),
            inline("unbound.md", "U", None),
        ])
        .unwrap();
        let docs = with_inline(read, brought);
        let paths: Vec<_> = docs.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(paths, vec!["studio-doc/x.md", "a.md", "unbound.md"]);
        assert_eq!(docs[1].doc_type.as_deref(), Some("feature"));
        assert_eq!(docs[2].doc_type, None);
        // A set detector then sees each document exactly once.
        let items = build_items(Detector::Bloat, &docs, "p");
        assert_eq!(items[0].payload["docs"]["a.md"], json!("A2"));
        assert_eq!(
            items[0].payload["docs"].as_object().map(|m| m.len()),
            Some(3)
        );
    }

    #[test]
    fn no_inline_texts_leave_what_the_server_read_alone() {
        let docs = with_inline(vec![doc("a.md", "A", None)], Vec::new());
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].text, "A");
    }

    #[test]
    fn a_binding_the_checkout_does_not_hold_is_dropped() {
        // Sending it with empty text would have the run report a verdict for a
        // document nobody read.
        let mut by_path = BTreeMap::new();
        by_path.insert("a.md".to_string(), "A".to_string());
        let wanted = vec![
            ("a.md".to_string(), Some("prd".to_string())),
            ("gone.md".to_string(), None),
        ];
        let docs = docs_for(&wanted, &by_path);
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].path, "a.md");
        assert_eq!(docs[0].doc_type.as_deref(), Some("prd"));
    }
}
