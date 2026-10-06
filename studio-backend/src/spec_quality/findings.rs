//! Reading what a detector found as FINDINGS: each one a claim about a place
//! in a document, with the detector's own reason and evidence.
//!
//! [`super::verdict`] answers "did the document pass". This answers the
//! question asked next, "what is wrong, and where". The detectors already say:
//! `purpose` names each failing section with its line range, a reason and the
//! model's evidence, and `bloat` names every duplicated passage with its lines
//! and the passage itself. Keeping only the pass/fail threw that away, so a
//! screen could count findings and never show one.
//!
//! ── What the shapes are based on ─────────────────────────────────────────────
//!
//! The service's OpenAPI types `result` as a bare `object`. The fields read
//! here come from real answers: the 23 `purpose` and one `bloat` analyses
//! stored on dev, and live `leak` calls made on 2026-10-01 (`leaks[]` with
//! `leaf`, `path`, `reads_as`, `line_start`, `line_end`, `confidence` and a
//! single `evidence` string). A field an answer does not have is absent from
//! the finding rather than an error. Every read is defensive for the same
//! reason the verdicts are.
//!
//! `traceability` produces no findings: in `extract` mode it finds no pairs at
//! all (`docs/upstream/spec-quality-issues.md` §2), so there is nothing to place.
//!
//! ── The fingerprint ──────────────────────────────────────────────────────────
//!
//! A finding's `id` is a hash of what it is about: the rule, the document, the
//! section and the passage. Line numbers are deliberately not in it. Lines
//! move whenever somebody edits above the passage, and the finding is still
//! the same finding: a person who marked it "as intended" must not see it come
//! back because a paragraph was added further up. When the passage itself
//! changes, the id changes, which is right: what was accepted is gone.

use serde_json::Value;
use sha2::{Digest, Sha256};

/// How sure a detector has to be before its finding is reported as `high`.
const HIGH_CONFIDENCE: f64 = 0.9;

/// Below this share of specification content a document is reported as not
/// being a specification. The prototype's `MIN_SPEC_SHARE`, for the reason it
/// gives there: real specifications measured 0.72–0.99, other files
/// 0.00–0.35.
pub const MIN_SPEC_SHARE: f64 = 0.5;

/// How bad a finding is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    High,
    Medium,
    Low,
}

impl Severity {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::High => "high",
            Severity::Medium => "medium",
            Severity::Low => "low",
        }
    }

    fn from_confidence(confidence: Option<f64>) -> Self {
        match confidence {
            Some(c) if c >= HIGH_CONFIDENCE => Severity::High,
            _ => Severity::Medium,
        }
    }
}

/// Where in a document a finding is. Every field is optional because the
/// detectors place things differently: `purpose` and `leak` by section and
/// lines, `bloat` by lines and the passage itself, and a document-wide finding
/// nowhere.
///
/// **Lines, not characters.** `bloat` also reports `char_start`/`char_end`,
/// and they are not read: checked against the files a live run analysed
/// (2026-10-01), one occurrence in six had offsets that cut out its own
/// passage, and one was two characters long for a 569-character passage. Its
/// line numbers were right every time. So a client places a finding by its
/// lines and, where there is one, finds the quote in them, comparing with
/// whitespace collapsed: the service quotes a passage reflowed onto one line.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Anchor {
    /// The section, as the detector named it. For `bloat` this is the full
    /// heading path (`Overview > Scope`), for `purpose` the heading itself.
    pub section: Option<String>,
    /// 1-based, inclusive, in the text that was analysed. For a `purpose` or
    /// `leak` section this is its body; the heading is just above.
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
    /// The passage itself, when the detector gives it. What a client looks for
    /// in the current text once the document has changed since the analysis.
    pub quote: Option<String>,
}

impl Anchor {
    fn is_empty(&self) -> bool {
        *self == Anchor::default()
    }
}

/// Another place the same finding is about: the other copy of a duplicated
/// passage, in this document or another one.
#[derive(Debug, Clone, PartialEq)]
pub struct Related {
    pub path: String,
    pub anchor: Anchor,
}

/// One thing a detector found.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    /// The fingerprint. Stable across re-runs; see the module comment.
    pub id: String,
    /// What was caught, e.g. `purpose.foreign_section`.
    pub rule: &'static str,
    /// The document the finding is about, as the run named it. `None` when
    /// the result did not echo a path, in which case it is the document the
    /// caller asked about.
    pub path: Option<String>,
    pub severity: Severity,
    pub message: String,
    /// `None` when the finding is about the document as a whole.
    pub anchor: Option<Anchor>,
    pub related: Vec<Related>,
    /// The detector's reasons, verbatim.
    pub evidence: Vec<String>,
    pub confidence: Option<f64>,
}

fn fingerprint(rule: &str, path: Option<&str>, anchor: Option<&Anchor>, extra: &str) -> String {
    let normalised_quote = anchor
        .and_then(|a| a.quote.as_deref())
        .map(|q| q.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    let section = anchor.and_then(|a| a.section.as_deref()).unwrap_or("");
    let mut hasher = Sha256::new();
    for part in [rule, path.unwrap_or(""), section, &normalised_quote, extra] {
        hasher.update(part.as_bytes());
        // A separator that cannot occur in any part, so ("ab", "c") and
        // ("a", "bc") do not hash alike.
        hasher.update([0u8]);
    }
    hasher.finalize()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn number(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
}

fn confidence_of(item: &Value) -> Option<f64> {
    item.get("confidence")
        .and_then(Value::as_f64)
        .filter(|c| c.is_finite())
}

/// `evidence` arrives as a list in a gate violation and as `{ role: [..] }` on
/// a section. Either way it is a list of reasons.
fn evidence_of(item: &Value) -> Vec<String> {
    let strings = |v: &Value| -> Vec<String> {
        v.as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|s| text(Some(s)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    match item.get("evidence") {
        Some(Value::Array(_)) => strings(&item["evidence"]),
        Some(Value::Object(by_role)) => by_role.values().flat_map(strings).collect(),
        Some(Value::String(s)) => text(Some(&Value::String(s.clone()))).into_iter().collect(),
        _ => Vec::new(),
    }
}

/// A section-level place, from the fields `purpose` uses and `leak` is
/// expected to.
fn section_anchor(item: &Value) -> Anchor {
    Anchor {
        section: text(item.get("section"))
            .or_else(|| text(item.get("leaf")))
            .or_else(|| text(item.get("path"))),
        line_start: number(item.get("line_start")),
        line_end: number(item.get("line_end")),
        quote: text(item.get("text")),
    }
}

/// The kind a passage read as: `role` on a `purpose` section, `reads_as` on a
/// `leak`.
fn role_of(item: &Value) -> Option<String> {
    text(item.get("role")).or_else(|| text(item.get("reads_as")))
}

/// Findings in a `purpose` answer.
///
/// One per gate violation (a section that reads as another kind of document),
/// and one for the document as a whole when most of it is not specification
/// content at all.
#[must_use]
pub fn purpose(result: Option<&Value>) -> Vec<Finding> {
    let empty = Value::Null;
    let r = result.unwrap_or(&empty);
    let path = text(r.get("path"));
    let mut out = Vec::new();

    let violations = r
        .get("gate")
        .and_then(|g| g.get("violations"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for v in violations {
        let anchor = section_anchor(v);
        let role = role_of(v);
        let confidence = confidence_of(v);
        let message = text(v.get("reason")).unwrap_or_else(|| match &role {
            Some(role) => format!("This section reads as {}", role.to_uppercase()),
            None => "This section reads as another kind of document".to_owned(),
        });
        let anchor = (!anchor.is_empty()).then_some(anchor);
        out.push(Finding {
            id: fingerprint(
                "purpose.foreign_section",
                path.as_deref(),
                anchor.as_ref(),
                role.as_deref().unwrap_or(""),
            ),
            rule: "purpose.foreign_section",
            path: path.clone(),
            severity: Severity::from_confidence(confidence),
            message,
            anchor,
            related: Vec::new(),
            evidence: evidence_of(v),
            confidence,
        });
    }

    // Only when the answer carried a mixture: without one, `doc_type` reads
    // the share as 1.0, and "not a spec" must not be inferred from nothing.
    if r.get("mixture").and_then(|m| m.get("other")).is_some() {
        let share = super::verdict::doc_type(Some(r)).spec_share;
        if share < MIN_SPEC_SHARE {
            out.push(Finding {
                id: fingerprint("purpose.not_a_spec", path.as_deref(), None, ""),
                rule: "purpose.not_a_spec",
                path: path.clone(),
                severity: Severity::Medium,
                message: format!(
                    "Only {:.0}% of this document reads as specification content.",
                    share * 100.0
                ),
                anchor: None,
                related: Vec::new(),
                evidence: Vec::new(),
                confidence: None,
            });
        }
    }
    out
}

/// Findings in a `leak` answer: one per passage that belongs in another kind
/// of document.
///
/// Read from `leaks[]`. When an answer has no `leaks` but does have
/// `sections[]`, a section marked `belongs: false` is the same claim, and is
/// read as one.
#[must_use]
pub fn leak(result: Option<&Value>) -> Vec<Finding> {
    let empty = Value::Null;
    let r = result.unwrap_or(&empty);
    let path = text(r.get("path"));

    let items: Vec<&Value> = match r.get("leaks").and_then(Value::as_array) {
        Some(leaks) => leaks.iter().collect(),
        None => r
            .get("sections")
            .and_then(Value::as_array)
            .map(|sections| {
                sections
                    .iter()
                    .filter(|s| s.get("belongs").and_then(Value::as_bool) == Some(false))
                    .collect()
            })
            .unwrap_or_default(),
    };

    items
        .into_iter()
        .filter(|item| item.is_object())
        .map(|item| {
            let anchor = section_anchor(item);
            let role = role_of(item);
            let confidence = confidence_of(item);
            let message = text(item.get("reason")).unwrap_or_else(|| match &role {
                Some(role) => {
                    format!("This passage reads as {role}, which belongs in another document type")
                }
                None => "This passage belongs in another document type".to_owned(),
            });
            let anchor = (!anchor.is_empty()).then_some(anchor);
            Finding {
                id: fingerprint(
                    "leak.foreign_content",
                    path.as_deref(),
                    anchor.as_ref(),
                    role.as_deref().unwrap_or(""),
                ),
                rule: "leak.foreign_content",
                path: path.clone(),
                severity: Severity::from_confidence(confidence),
                message,
                anchor,
                related: Vec::new(),
                evidence: evidence_of(item),
                confidence,
            }
        })
        .collect()
}

fn occurrence_anchor(o: &Value) -> Anchor {
    Anchor {
        section: text(o.get("section")),
        line_start: number(o.get("line")),
        line_end: number(o.get("line_end")).or_else(|| number(o.get("line"))),
        quote: text(o.get("text")),
    }
}

fn occurrence_lines(o: &Value) -> Option<(u32, u32)> {
    let start = number(o.get("line"))?;
    Some((start, number(o.get("line_end")).unwrap_or(start).max(start)))
}

/// Whether two line ranges share a line. Unknown lines overlap nothing: an
/// occurrence that cannot be placed is not merged into one that can.
fn overlaps(a: Option<(u32, u32)>, b: Option<(u32, u32)>) -> bool {
    match (a, b) {
        (Some((a0, a1)), Some((b0, b1))) => a0 <= b1 && b0 <= a1,
        _ => false,
    }
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Findings in a `bloat` answer, about the documents in `paths`.
///
/// One per occurrence of a duplicated passage in one of those documents, with
/// every other occurrence as `related`. An occurrence whose passage also
/// appears in another document is `bloat.cross_document`; one repeated only
/// inside its own document is the lesser `bloat.self_repeat`. A document named
/// in a cluster but not in `paths` gets no findings of its own, and still
/// appears as `related` for the ones that were asked about.
#[must_use]
pub fn bloat(result: Option<&Value>, paths: &[String]) -> Vec<Finding> {
    let empty = Value::Null;
    let r = result.unwrap_or(&empty);
    let clusters = r
        .get("clusters")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut out = Vec::new();

    for cluster in clusters {
        let mut occurrences: Vec<(&str, &Value)> = Vec::new();
        for o in cluster
            .get("occurrences")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let Some(file) = o
                .get("file")
                .and_then(Value::as_str)
                .filter(|f| !f.is_empty())
            else {
                continue;
            };
            // Two occurrences in one file whose lines overlap are one passage,
            // not a repeat. The service compares sentences and paragraphs
            // alike, so a paragraph and a sentence inside it came back as a
            // "duplicate" of each other in a live run (ADR-0018, line 327).
            let lines = occurrence_lines(o);
            if occurrences
                .iter()
                .any(|(f, earlier)| *f == file && overlaps(lines, occurrence_lines(earlier)))
            {
                continue;
            }
            occurrences.push((file, o));
        }
        if occurrences.len() < 2 {
            continue;
        }
        let confidence = confidence_of(cluster);

        for (index, (file, occurrence)) in occurrences.iter().enumerate() {
            if !paths.iter().any(|p| p == file) {
                continue;
            }
            let others: Vec<&str> = occurrences
                .iter()
                .map(|(f, _)| *f)
                .filter(|f| f != file)
                .collect();
            let cross = !others.is_empty();
            let anchor = occurrence_anchor(occurrence);
            let related = occurrences
                .iter()
                .enumerate()
                .filter(|(other, _)| *other != index)
                .map(|(_, (f, o))| Related {
                    path: (*f).to_owned(),
                    anchor: occurrence_anchor(o),
                })
                .collect();
            let (rule, severity, message) = if cross {
                let mut names: Vec<&str> = others.iter().map(|f| basename(f)).collect();
                names.sort_unstable();
                names.dedup();
                (
                    "bloat.cross_document",
                    Severity::Medium,
                    format!("This passage also appears in {}", names.join(", ")),
                )
            } else {
                (
                    "bloat.self_repeat",
                    Severity::Low,
                    format!(
                        "This passage appears {} times in this document",
                        occurrences.len()
                    ),
                )
            };
            // Two copies of one passage in one document hash alike by rule,
            // path, section and quote; the section usually tells them apart,
            // and when it does not, they are the same complaint twice.
            let anchor = Some(anchor);
            out.push(Finding {
                id: fingerprint(rule, Some(file), anchor.as_ref(), ""),
                rule,
                path: Some((*file).to_owned()),
                severity,
                message,
                anchor,
                related,
                evidence: Vec::new(),
                confidence,
            });
        }
    }
    // The same fingerprint twice is one finding: see the note above.
    let mut seen = std::collections::BTreeSet::new();
    out.retain(|f| seen.insert(f.id.clone()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn paths(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    /// A `purpose` answer in the shape stored on dev.
    fn purpose_answer() -> Value {
        json!({
            "path": "docs/PRD.md",
            "doc_type": "prd",
            "mixture": { "other": 0.1, "requirement": 0.66, "decision": 0.24 },
            "gate": {
                "passed": false,
                "doc_type": "prd",
                "threshold": 0.05,
                "leak_share": 0.238,
                "violations": [{
                    "role": "decision",
                    "share": 0.238,
                    "reason": "PRD section reads as DECISION (belongs in a decision doc, not a prd)",
                    "section": "Requested change",
                    "evidence": ["llm: Requests options and trade-offs."],
                    "line_start": 59,
                    "line_end": 69,
                    "n_tokens": 63,
                    "confidence": 0.96
                }]
            }
        })
    }

    // ---- purpose ---------------------------------------------------------

    #[test]
    fn a_gate_violation_is_a_finding_placed_on_its_section() {
        let found = purpose(Some(&purpose_answer()));
        assert_eq!(found.len(), 1);
        let f = &found[0];
        assert_eq!(f.rule, "purpose.foreign_section");
        assert_eq!(f.path.as_deref(), Some("docs/PRD.md"));
        assert_eq!(f.severity, Severity::High);
        assert!(f.message.starts_with("PRD section reads as DECISION"));
        let anchor = f.anchor.as_ref().expect("placed");
        assert_eq!(anchor.section.as_deref(), Some("Requested change"));
        assert_eq!((anchor.line_start, anchor.line_end), (Some(59), Some(69)));
        assert_eq!(f.evidence, vec!["llm: Requests options and trade-offs."]);
        assert_eq!(f.confidence, Some(0.96));
    }

    #[test]
    fn a_less_certain_violation_is_medium() {
        let mut answer = purpose_answer();
        answer["gate"]["violations"][0]["confidence"] = json!(0.7);
        assert_eq!(purpose(Some(&answer))[0].severity, Severity::Medium);
    }

    #[test]
    fn a_violation_without_a_reason_says_what_it_read_as() {
        let mut answer = purpose_answer();
        answer["gate"]["violations"][0]
            .as_object_mut()
            .unwrap()
            .remove("reason");
        assert_eq!(
            purpose(Some(&answer))[0].message,
            "This section reads as DECISION"
        );
    }

    /// The property a dismissal depends on.
    #[test]
    fn the_id_survives_the_section_moving_down_the_page() {
        let before = purpose(Some(&purpose_answer()));
        let mut moved = purpose_answer();
        moved["gate"]["violations"][0]["line_start"] = json!(80);
        moved["gate"]["violations"][0]["line_end"] = json!(90);
        assert_eq!(before[0].id, purpose(Some(&moved))[0].id);
    }

    #[test]
    fn the_id_changes_with_the_section_or_the_document() {
        let base = purpose(Some(&purpose_answer()))[0].id.clone();
        let mut other_section = purpose_answer();
        other_section["gate"]["violations"][0]["section"] = json!("Goals");
        let mut other_doc = purpose_answer();
        other_doc["path"] = json!("docs/OTHER.md");
        assert_ne!(base, purpose(Some(&other_section))[0].id);
        assert_ne!(base, purpose(Some(&other_doc))[0].id);
    }

    #[test]
    fn a_document_that_is_mostly_not_a_spec_says_so_once() {
        let answer = json!({ "path": "notes.md", "mixture": { "other": 0.8, "design": 0.2 } });
        let found = purpose(Some(&answer));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].rule, "purpose.not_a_spec");
        assert!(found[0].anchor.is_none());
        assert_eq!(
            found[0].message,
            "Only 20% of this document reads as specification content."
        );
    }

    #[test]
    fn no_mixture_is_not_evidence_that_a_document_is_not_a_spec() {
        assert!(purpose(Some(&json!({ "doc_type": "prd" }))).is_empty());
        assert!(purpose(None).is_empty());
    }

    // ---- leak ------------------------------------------------------------

    #[test]
    fn a_leak_is_a_finding_on_its_section() {
        let answer = json!({
            "path": "docs/ADR/0001.md",
            "passed": false,
            "leak_share": 0.4,
            // The shape a live call returned on 2026-10-01.
            "leaks": [{
                "belongs": false,
                "leaf": "Implementation",
                "path": "ADR-0001 > Decision > Implementation",
                "reads_as": "design",
                "line_start": 12,
                "line_end": 30,
                "n_tokens": 410,
                "confidence": 0.98,
                "evidence": "describes the component layout"
            }]
        });
        let found = leak(Some(&answer));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].rule, "leak.foreign_content");
        assert_eq!(found[0].severity, Severity::High);
        assert_eq!(
            found[0].message,
            "This passage reads as design, which belongs in another document type"
        );
        assert_eq!(found[0].evidence, vec!["describes the component layout"]);
        assert_eq!(found[0].anchor.as_ref().unwrap().line_start, Some(12));
    }

    #[test]
    fn without_leaks_a_section_that_does_not_belong_is_read_as_one() {
        let answer = json!({
            "sections": [
                { "leaf": "Context", "belongs": true },
                { "leaf": "Schema", "belongs": false, "reads_as": "design", "confidence": 0.5 }
            ]
        });
        let found = leak(Some(&answer));
        assert_eq!(found.len(), 1);
        assert_eq!(
            found[0].anchor.as_ref().unwrap().section.as_deref(),
            Some("Schema")
        );
        assert_eq!(found[0].severity, Severity::Medium);
    }

    #[test]
    fn a_clean_or_unreadable_leak_answer_has_no_findings() {
        assert!(leak(Some(&json!({ "passed": true, "leaks": [] }))).is_empty());
        assert!(leak(Some(&json!({ "leaks": [null, 3, "x"] }))).is_empty());
        assert!(leak(None).is_empty());
    }

    // ---- bloat -----------------------------------------------------------

    fn occurrence(file: &str, section: &str, line: u32, text: &str) -> Value {
        json!({
            "file": file, "section": section, "line": line, "line_end": line,
            "char_start": line * 100, "char_end": line * 100 + 40, "text": text
        })
    }

    #[test]
    fn a_passage_in_two_documents_is_a_finding_in_each_pointing_at_the_other() {
        let answer = json!({ "clusters": [{
            "text": "Explicit empty states",
            "confidence": 0.93,
            "occurrences": [
                occurrence("docs/a.md", "Scope", 35, "Explicit empty states."),
                occurrence("docs/b.md", "Overview", 7, "Explicit empty states."),
            ]
        }]});
        let found = bloat(Some(&answer), &paths(&["docs/a.md", "docs/b.md"]));
        assert_eq!(found.len(), 2);
        let a = found
            .iter()
            .find(|f| f.path.as_deref() == Some("docs/a.md"))
            .unwrap();
        assert_eq!(a.rule, "bloat.cross_document");
        assert_eq!(a.message, "This passage also appears in b.md");
        let anchor = a.anchor.as_ref().unwrap();
        assert_eq!((anchor.line_start, anchor.line_end), (Some(35), Some(35)));
        assert_eq!(anchor.section.as_deref(), Some("Scope"));
        assert_eq!(anchor.quote.as_deref(), Some("Explicit empty states."));
        assert_eq!(a.related.len(), 1);
        assert_eq!(a.related[0].path, "docs/b.md");
        assert_eq!(a.related[0].anchor.line_start, Some(7));
    }

    #[test]
    fn a_passage_repeated_inside_one_document_is_the_lesser_finding() {
        let answer = json!({ "clusters": [{ "occurrences": [
            occurrence("a.md", "One", 3, "Same words."),
            occurrence("a.md", "Two", 9, "Same words."),
        ]}]});
        let found = bloat(Some(&answer), &paths(&["a.md"]));
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|f| f.rule == "bloat.self_repeat"));
        assert!(found.iter().all(|f| f.severity == Severity::Low));
        assert_ne!(
            found[0].id, found[1].id,
            "different sections, different findings"
        );
    }

    /// From a live run: a paragraph and a sentence inside it, reported as a
    /// duplicate of each other.
    #[test]
    fn overlapping_lines_in_one_document_are_one_passage_not_a_repeat() {
        let paragraph = json!({ "file": "a.md", "section": "S", "line": 327, "line_end": 334,
            "text": "The tenant clamp comes from membership. Moved to the front by what was found." });
        let sentence = json!({ "file": "a.md", "section": "S", "line": 327, "line_end": 327,
            "text": "Moved to the front by what was found." });
        let alone = json!({ "clusters": [{ "occurrences": [paragraph.clone(), sentence] }] });
        assert!(bloat(Some(&alone), &paths(&["a.md"])).is_empty());

        // The same overlap beside a genuine copy elsewhere still reports the copy.
        let with_copy = json!({ "clusters": [{ "occurrences": [
            paragraph,
            json!({ "file": "a.md", "section": "S", "line": 330, "line_end": 330, "text": "x" }),
            occurrence("b.md", "T", 4, "The tenant clamp comes from membership."),
        ]}]});
        let found = bloat(Some(&with_copy), &paths(&["a.md"]));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].rule, "bloat.cross_document");
        assert_eq!(found[0].related.len(), 1);
    }

    #[test]
    fn only_the_documents_asked_about_get_findings() {
        let answer = json!({ "clusters": [{ "occurrences": [
            occurrence("asked.md", "S", 1, "x y z"),
            occurrence("other.md", "S", 1, "x y z"),
        ]}]});
        let found = bloat(Some(&answer), &paths(&["asked.md"]));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].related[0].path, "other.md");
    }

    #[test]
    fn the_id_ignores_whitespace_and_line_numbers_but_not_the_passage() {
        let at = |line: u32, text: &str| {
            json!({ "clusters": [{ "occurrences": [
                occurrence("a.md", "S", line, text),
                occurrence("b.md", "S", 1, text),
            ]}]})
        };
        let id = |answer: Value| bloat(Some(&answer), &paths(&["a.md"]))[0].id.clone();
        assert_eq!(id(at(3, "one  two\nthree")), id(at(40, "one two three")));
        assert_ne!(id(at(3, "one two three")), id(at(3, "one two four")));
    }

    #[test]
    fn a_cluster_shape_nobody_documented_is_skipped() {
        for answer in [
            json!(null),
            json!({ "clusters": "no" }),
            json!({ "clusters": [null, {}, { "occurrences": [{ "file": "" }] }] }),
            json!({ "clusters": [{ "occurrences": [{ "file": "a.md" }] }] }),
        ] {
            assert!(
                bloat(Some(&answer), &paths(&["a.md"])).is_empty(),
                "{answer}"
            );
        }
    }
}
