//! Structural conformance check (v1).
//!
//! Given a document's markdown and its type's [`TemplateSpec`], decide whether
//! it structurally matches the template: required sections present (by heading),
//! per-section minimum length, required front-matter keys filled, no leftover
//! template placeholders, and a non-trivial title. Purely structural — no
//! semantics, so a genuinely filled document never trips a false positive.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::model::TemplateSpec;

/// Per-section result, driving the UI checklist.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SectionStatus {
    pub key: String,
    pub title: String,
    /// A matching heading was found.
    pub present: bool,
    /// Words in the section body (between this heading and the next).
    pub word_count: usize,
    /// Required, from the template.
    pub required: bool,
    /// Filled in: present, non-empty, and long enough. An optional section that
    /// is empty is `false` here and still lets the document conform — the
    /// checklist says what is left to do, `conforms` says what is wrong.
    pub ok: bool,
}

/// The whole conformance report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationReport {
    pub conforms: bool,
    pub sections: Vec<SectionStatus>,
    pub issues: Vec<String>,
    /// The maturity the document declares in its front matter, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maturity: Option<String>,
    /// What the full check would reject and this maturity lets stand: an
    /// unwritten section of an experiment, an open TODO in a preview. Reported
    /// so nothing is hidden, never counted against `conforms`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub open: Vec<String>,
}

/// The maturity levels a gear declares in its `gear.gdl` (gears-rust #5275).
pub const MATURITY_LEVELS: [&str; 5] =
    ["design", "experimental", "preview", "stable", "deprecated"];

/// How much of the template a document must meet. Specs are a tool, not a text
/// to finish before code: an experiment is written as far as it is known, a
/// preview may keep its open questions, and only a stable (or deprecated) gear,
/// or a document that declares nothing, gets the full check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Strictness {
    /// `design`, `experimental`: required sections may be missing or short.
    Explore,
    /// `preview`: every section written, `TODO` and `TBD` may stay.
    Preview,
    Full,
}

fn strictness(level: &str) -> Option<Strictness> {
    match level {
        "design" | "experimental" => Some(Strictness::Explore),
        "preview" => Some(Strictness::Preview),
        "stable" | "deprecated" => Some(Strictness::Full),
        _ => None,
    }
}

/// A heading found in the document: its level, normalized title, and the word
/// count of the body that follows it up to the next heading.
pub(super) struct Heading {
    pub(super) level: usize,
    pub(super) title_norm: String,
    pub(super) body_words: usize,
}

fn normalize(s: &str) -> String {
    s.trim().to_lowercase()
}

/// Split front-matter (a leading `--- ... ---` YAML-ish block) from the body,
/// returning the simple `key: value` pairs and the remaining markdown.
pub(super) fn split_front_matter(content: &str) -> (HashMap<String, String>, &str) {
    let mut fm = HashMap::new();
    let rest = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"));
    let Some(after) = rest else {
        return (fm, content);
    };
    // Find the closing fence line.
    let mut idx = 0usize;
    let bytes_lines: Vec<&str> = after.lines().collect();
    let mut end_line = None;
    for (i, line) in bytes_lines.iter().enumerate() {
        if line.trim() == "---" {
            end_line = Some(i);
            break;
        }
    }
    let Some(end) = end_line else {
        return (fm, content);
    };
    for line in &bytes_lines[..end] {
        if let Some((k, v)) = line.split_once(':') {
            fm.insert(normalize(k), v.trim().to_string());
        }
    }
    // Reconstruct the body offset: skip the fence, the fm lines and the closing
    // fence. Falling back to `content` is safe — only headings are read from it.
    for line in &bytes_lines[..=end] {
        idx += line.len() + 1;
    }
    let body = after.get(idx..).unwrap_or("");
    (fm, body)
}

/// A heading title reduced to what a template names it by: lowercased, with a
/// leading section number dropped. The SDLC templates number their headings
/// (`## 5. Functional Requirements`, `### 1.1 Purpose`) and a checklist naming
/// "Functional Requirements" must still find them.
pub(super) fn normalize_heading(s: &str) -> String {
    let t = s.trim();
    let numbered = t
        .split_once(char::is_whitespace)
        .filter(|(num, _)| {
            num.chars().next().is_some_and(|c| c.is_ascii_digit())
                && num.chars().all(|c| c.is_ascii_digit() || c == '.')
        })
        .map(|(_, rest)| rest);
    normalize(numbered.unwrap_or(t))
}

/// Parse all ATX headings and the word count of each one's body.
///
/// A heading's body runs to the next heading at the same or a higher level, so
/// `## 1. Overview` counts the prose of its `### 1.1 Purpose`. HTML comments are
/// template guidance, not content: they are neither counted nor searched for
/// headings. A `#` line inside a fenced block is a shell comment, not a heading.
pub(super) fn headings(body: &str) -> Vec<Heading> {
    // (level, title, words directly under this heading)
    let mut own: Vec<(usize, String, usize)> = Vec::new();
    let mut in_fence = false;
    let mut in_comment = false;

    for line in body.lines() {
        if !in_comment && is_fence(line) {
            in_fence = !in_fence;
            continue;
        }
        let visible = if in_fence {
            line.to_string()
        } else {
            strip_comments(line, &mut in_comment)
        };
        let trimmed = visible.trim_start();
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        let is_heading =
            !in_fence && (1..=6).contains(&hashes) && trimmed.chars().nth(hashes) == Some(' ');
        if is_heading {
            own.push((hashes, trimmed[hashes..].trim().to_string(), 0));
        } else if let Some(last) = own.last_mut() {
            last.2 += visible.split_whitespace().count();
        }
    }

    (0..own.len())
        .map(|i| {
            let (level, title, words) = &own[i];
            let nested: usize = own[i + 1..]
                .iter()
                .take_while(|(l, _, _)| l > level)
                .map(|(_, _, w)| w)
                .sum();
            Heading {
                level: *level,
                title_norm: normalize_heading(title),
                body_words: words + nested,
            }
        })
        .collect()
}

/// A line that opens or closes a fenced code block.
fn is_fence(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

/// The part of `line` outside HTML comments, carrying an open `<!--` across
/// lines in `in_comment`.
fn strip_comments(line: &str, in_comment: &mut bool) -> String {
    let mut out = String::new();
    let mut rest = line;
    loop {
        if *in_comment {
            match rest.find("-->") {
                Some(end) => {
                    *in_comment = false;
                    rest = &rest[end + 3..];
                }
                None => return out,
            }
        } else {
            match rest.find("<!--") {
                Some(start) => {
                    out.push_str(&rest[..start]);
                    *in_comment = true;
                    rest = &rest[start + 4..];
                }
                None => {
                    out.push_str(rest);
                    return out;
                }
            }
        }
    }
}

/// The maturity a front matter declares, normalized; `None` when it declares
/// none.
fn maturity_in(fm: &HashMap<String, String>) -> Option<String> {
    fm.get("maturity")
        .map(|v| normalize(v.trim_matches(|c| c == '"' || c == '\'')))
        .filter(|v| !v.is_empty())
}

/// The maturity a document declares in its front matter, as [`validate`]
/// reads it: what a review of it is held to (`approvals::advisory`).
pub(super) fn maturity_of(content: &str) -> Option<String> {
    maturity_in(&split_front_matter(content).0)
}

/// First `# ` (level-1) heading title, if any.
fn first_title(heads: &[Heading]) -> Option<String> {
    heads
        .iter()
        .find(|h| h.level == 1)
        .map(|h| h.title_norm.clone())
}

/// Run the structural check.
pub fn validate(content: &str, spec: &TemplateSpec) -> ValidationReport {
    let (fm, body) = split_front_matter(content);
    let heads = headings(body);
    let mut issues: Vec<String> = Vec::new();
    let mut sections: Vec<SectionStatus> = Vec::new();
    let mut open: Vec<String> = Vec::new();
    let mut conforms = true;

    let maturity = maturity_in(&fm);
    let level = match maturity.as_deref() {
        None => Strictness::Full,
        Some(m) => strictness(m).unwrap_or_else(|| {
            conforms = false;
            issues.push(format!(
                "Unknown maturity \"{m}\": use one of {}",
                MATURITY_LEVELS.join(", ")
            ));
            Strictness::Full
        }),
    };

    // Sections.
    for s in &spec.sections {
        let wanted: Vec<String> = s.titles().map(normalize_heading).collect();
        let found = heads.iter().find(|h| wanted.contains(&h.title_norm));
        let present = found.is_some();
        let word_count = found.map(|h| h.body_words).unwrap_or(0);
        let meets_min = match s.min_words {
            Some(m) => word_count >= m,
            None => true,
        };
        let ok = if s.required {
            present && word_count > 0 && meets_min
        } else {
            // An optional section that is present and EMPTY is the not-filled-in
            // state, which is what "optional" means -- it is reported through
            // `SectionStatus.ok` for the checklist and must not make the whole
            // document non-conforming. This module's own contract says the check
            // is about "required sections present" and that "a genuinely filled
            // document never trips a false positive"; counting an unanswered
            // optional section against conformance broke both, and it made every
            // questionnaire-generated document non-conforming on arrival, since
            // the generator emits every declared section so the checklist has
            // somewhere to point.
            //
            // Present, non-empty and too SHORT still fails: something was
            // written and it does not meet the length the type asks for.
            !present || word_count == 0 || meets_min
        };
        let satisfied = ok && present && word_count > 0;
        if !ok {
            let issue = if !present {
                format!("Missing required section: {}", s.title)
            } else if word_count == 0 {
                format!("Section is empty: {}", s.title)
            } else {
                format!(
                    "Section \"{}\" is too short ({} words, need {})",
                    s.title,
                    word_count,
                    s.min_words.unwrap_or(0)
                )
            };
            if level == Strictness::Explore {
                open.push(issue);
            } else {
                conforms = false;
                issues.push(issue);
            }
        }
        sections.push(SectionStatus {
            key: s.key.clone(),
            title: s.title.clone(),
            present,
            word_count,
            required: s.required,
            ok: satisfied,
        });
    }

    // Front-matter required keys.
    for key in &spec.rules.front_matter {
        let k = normalize(key);
        let filled = fm.get(&k).map(|v| !v.trim().is_empty()).unwrap_or(false);
        if !filled {
            conforms = false;
            issues.push(format!("Front-matter field \"{key}\" is missing or empty"));
        }
    }

    // Title.
    let title = fm
        .get("title")
        .cloned()
        .filter(|t| !t.is_empty())
        .or_else(|| first_title(&heads));
    let title_words = title
        .as_deref()
        .map(|t| t.split_whitespace().count())
        .unwrap_or(0);
    if title_words < spec.rules.min_title_words {
        conforms = false;
        issues.push(format!(
            "Title has {} word(s), need at least {}",
            title_words, spec.rules.min_title_words
        ));
    }

    // Placeholders.
    if spec.rules.forbid_placeholders {
        // Over the prose only. Technical writing quotes `<alpha-value>`,
        // `<head>` and `{{ .Values }}` inside code as examples, and a document
        // ingested from a real repository is full of them -- flagging those
        // would make the check useless on exactly the documents that need it.
        let prose = strip_code(content);
        if prose.contains("{{") {
            conforms = false;
            issues.push("Leftover placeholder: {{".to_string());
        }
        // A TODO is an open question, and below stable it closes with a spike
        // or a follow-up change, not another review round. `{{` and the
        // bracket markers are an unedited template at any level.
        for marker in ["TODO", "TBD"] {
            if prose.contains(marker) {
                if level == Strictness::Full {
                    conforms = false;
                    issues.push(format!("Leftover placeholder: {marker}"));
                } else {
                    open.push(format!("Open question: {marker}"));
                }
            }
        }
        if has_angle_placeholder(&prose) {
            conforms = false;
            issues.push("Leftover placeholder: <…> template marker".to_string());
        }
        if has_brace_placeholder(&prose) {
            conforms = false;
            issues.push("Leftover placeholder: {…} template marker".to_string());
        }
    }

    ValidationReport {
        conforms,
        sections,
        issues,
        maturity,
        open,
    }
}

/// The document with its code removed — fenced blocks and inline spans, and
/// its HTML comments.
///
/// Only the placeholder scan uses this. A document written against a template
/// leaves its markers in the prose; a document *about* software quotes angle-
/// and brace-wrapped tokens in code, and there is no way to tell the two apart
/// except by where they sit.
fn strip_code(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut in_fence = false;
    let mut in_comment = false;
    for raw in content.lines() {
        if !in_comment && is_fence(raw) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // A template explains itself in comments, and a document that keeps
        // that guidance has not left anything unfilled.
        let line = strip_comments(raw, &mut in_comment);
        // Inline spans, backticks included. The flag resets each line, so one
        // stray backtick costs the rest of that line and nothing more.
        let mut in_span = false;
        for ch in line.chars() {
            if ch == '`' {
                in_span = !in_span;
            } else if !in_span {
                out.push(ch);
            }
        }
        out.push('\n');
    }
    out
}

/// Detect `<title>`-style human placeholders (angle-wrapped words/spaces),
/// while ignoring real tags and generics (`</x>`, `<T>` with `=`/`/`, urls).
fn has_angle_placeholder(content: &str) -> bool {
    let bytes = content.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<'
            && let Some(close) = content[i + 1..].find('>')
        {
            let inner = &content[i + 1..i + 1 + close];
            let ok = !inner.is_empty()
                && inner.len() <= 40
                && inner
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == ' ' || c == '-')
                && inner.chars().any(|c| c.is_ascii_lowercase());
            if ok {
                return true;
            }
            i += close + 1;
            continue;
        }
        i += 1;
    }
    false
}

/// Detect `{Gear Name}`-style placeholders — the SDLC templates' marker for
/// "write this". A single brace pair on one line whose contents start with a
/// letter or digit; `{{…}}` is reported on its own, and JSON (`{"a": 1}`)
/// starts with a quote.
fn has_brace_placeholder(content: &str) -> bool {
    content.lines().any(|line| {
        let mut rest = line;
        while let Some(open) = rest.find('{') {
            let after = &rest[open + 1..];
            if after.starts_with('{') {
                rest = after.trim_start_matches('{');
                continue;
            }
            let Some(close) = after.find(['{', '}']) else {
                return false;
            };
            let inner = &after[..close];
            if after[close..].starts_with('}')
                && inner.len() <= 200
                && inner.chars().next().is_some_and(|c| c.is_alphanumeric())
                && inner.chars().any(|c| c.is_alphabetic())
            {
                return true;
            }
            rest = &after[close..];
        }
        false
    })
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use crate::documents::model::{Rules, Section};

    fn spec(sections: Vec<Section>) -> TemplateSpec {
        TemplateSpec {
            body: String::new(),
            sections,
            rules: Rules {
                front_matter: vec!["status".to_string()],
                ..Rules::default()
            },
            questionnaire: Vec::new(),
            review: None,
        }
    }

    fn sec(key: &str, title: &str, required: bool, min_words: Option<usize>) -> Section {
        Section {
            key: key.to_string(),
            title: title.to_string(),
            required,
            min_words,
            description: None,
            aliases: Vec::new(),
        }
    }

    const FRONT: &str = "---
status: draft
---

# A Real Title Here

";

    #[test]
    fn an_empty_optional_section_does_not_make_a_document_non_conforming() {
        // "Optional" has to mean "you do not have to fill this in". The
        // checklist still reports it as unfilled.
        let spec = spec(vec![
            sec("problem", "Problem", true, None),
            sec("risks", "Risks", false, None),
        ]);
        let body = format!(
            "{FRONT}## Problem

Something is broken.

## Risks

"
        );

        let report = validate(&body, &spec);
        assert!(report.conforms, "issues: {:?}", report.issues);
        let risks = report
            .sections
            .iter()
            .find(|s| s.key == "risks")
            .expect("risks reported");
        assert!(risks.present);
        assert!(!risks.ok, "the checklist still says it is unfilled");
    }

    #[test]
    fn an_optional_section_that_is_written_but_too_short_still_fails() {
        // Something was written and it does not meet the length the type asks
        // for. That is a defect, not an unanswered question.
        let spec = spec(vec![sec("risks", "Risks", false, Some(10))]);
        let body = format!(
            "{FRONT}## Risks

Too short.
"
        );

        let report = validate(&body, &spec);
        assert!(!report.conforms);
        assert!(
            report.issues.iter().any(|i| i.contains("too short")),
            "{:?}",
            report.issues
        );
    }

    #[test]
    fn a_missing_required_section_still_fails() {
        let spec = spec(vec![sec("problem", "Problem", true, None)]);
        let report = validate(FRONT, &spec);
        assert!(!report.conforms);
        assert!(
            report
                .issues
                .iter()
                .any(|i| i.contains("Missing required section")),
            "{:?}",
            report.issues
        );
    }

    fn with_maturity(level: &str, body: &str) -> String {
        format!("---\nstatus: draft\nmaturity: {level}\n---\n\n# A Real Title Here\n\n{body}")
    }

    #[test]
    fn an_experiment_may_leave_required_sections_unwritten_and_says_so() {
        let spec = spec(vec![
            sec("problem", "Problem", true, None),
            sec("design", "Design", true, Some(50)),
        ]);
        let body = with_maturity(
            "experimental",
            "## Problem\n\nTry it. TODO: measure.\n\n## Design\n\nShort.\n",
        );

        let report = validate(&body, &spec);
        assert!(report.conforms, "issues: {:?}", report.issues);
        assert_eq!(report.maturity.as_deref(), Some("experimental"));
        assert!(
            report.open.iter().any(|o| o.contains("too short")),
            "{:?}",
            report.open
        );
        assert!(
            report.open.iter().any(|o| o.contains("TODO")),
            "{:?}",
            report.open
        );
        let design = report
            .sections
            .iter()
            .find(|s| s.key == "design")
            .expect("design");
        assert!(!design.ok, "the checklist still says it is unfinished");
    }

    #[test]
    fn a_preview_keeps_its_open_questions_but_writes_every_section() {
        let spec = spec(vec![
            sec("problem", "Problem", true, None),
            sec("risks", "Risks", true, None),
        ]);
        let open_question = with_maturity(
            "preview",
            "## Problem\n\nKnown. TBD: the quota.\n\n## Risks\n\nFew.\n",
        );
        let report = validate(&open_question, &spec);
        assert!(report.conforms, "issues: {:?}", report.issues);
        assert_eq!(report.open, vec!["Open question: TBD".to_string()]);

        let missing = with_maturity("preview", "## Problem\n\nKnown.\n");
        assert!(
            !validate(&missing, &spec).conforms,
            "a preview still needs its sections"
        );
    }

    #[test]
    fn stable_and_undeclared_documents_get_the_full_check() {
        let spec = spec(vec![sec("problem", "Problem", true, None)]);
        for body in [
            with_maturity("stable", "## Problem\n\nTODO\n"),
            format!("{FRONT}## Problem\n\nTODO\n"),
        ] {
            let report = validate(&body, &spec);
            assert!(!report.conforms);
            assert!(report.open.is_empty());
        }
    }

    #[test]
    fn an_unedited_template_fails_at_any_maturity() {
        let spec = spec(vec![sec("problem", "Problem", true, None)]);
        let report = validate(
            &with_maturity("design", "## Problem\n\n{{problem}}\n"),
            &spec,
        );
        assert!(!report.conforms, "{:?}", report.issues);
    }

    #[test]
    fn an_unknown_maturity_is_reported_and_checked_in_full() {
        let spec = spec(vec![sec("problem", "Problem", true, None)]);
        let report = validate(&with_maturity("alpha", ""), &spec);
        assert!(!report.conforms);
        assert!(
            report.issues.iter().any(|i| i.contains("Unknown maturity")),
            "{:?}",
            report.issues
        );
        assert!(
            report
                .issues
                .iter()
                .any(|i| i.contains("Missing required section")),
            "{:?}",
            report.issues
        );
    }

    #[test]
    fn an_empty_required_section_still_fails() {
        let spec = spec(vec![sec("problem", "Problem", true, None)]);
        let body = format!(
            "{FRONT}## Problem

"
        );
        let report = validate(&body, &spec);
        assert!(!report.conforms);
        assert!(
            report.issues.iter().any(|i| i.contains("Section is empty")),
            "{:?}",
            report.issues
        );
    }

    /// Real technical prose quotes angle- and brace-wrapped tokens in code.
    /// Those are examples, not leftovers from a template — and a repository we
    /// ingest is full of them.
    #[test]
    fn code_spans_and_fences_are_not_placeholders() {
        let spec = spec(vec![sec("context", "Context", true, None)]);
        let body = format!(
            "{FRONT}## Context\n\n\
             Tailwind leaves a slot for `<alpha-value>`, and the sheet is loaded in `<head>`.\n\n\
             ```yaml\nimage: {{{{ .Values.image }}}}\n# TODO: not ours\n```\n\n\
             That is all.\n"
        );
        let report = validate(&body, &spec);
        assert!(
            report.issues.iter().all(|i| !i.contains("placeholder")),
            "{:?}",
            report.issues
        );
        assert!(report.conforms, "{:?}", report.issues);
    }

    /// A marker left in the prose is still a marker.
    #[test]
    fn placeholders_in_prose_are_still_caught() {
        let spec = spec(vec![sec("context", "Context", true, None)]);
        let body = format!("{FRONT}## Context\n\nTBD, see <the other doc>.\n");
        let report = validate(&body, &spec);
        assert!(!report.conforms);
        assert!(
            report.issues.iter().any(|i| i.contains("TBD")),
            "{:?}",
            report.issues
        );
        assert!(
            report.issues.iter().any(|i| i.contains('\u{2026}')),
            "{:?}",
            report.issues
        );
    }

    /// The SDLC templates number their headings and put the prose one level
    /// down. `## 1. Overview` followed by `### 1.1 Purpose` is a filled
    /// Overview, not a missing or empty one.
    #[test]
    fn numbered_headings_match_and_count_their_subsections() {
        let spec = spec(vec![sec("overview", "Overview", true, Some(5))]);
        let body = format!(
            "{FRONT}## 1. Overview\n\n### 1.1 Purpose\n\nThe gear keeps every tenant's files apart.\n\n## 2. Actors\n\nNobody.\n"
        );
        let report = validate(&body, &spec);
        assert!(report.conforms, "{:?}", report.issues);
        let overview = &report.sections[0];
        assert!(overview.present);
        assert_eq!(overview.word_count, 7, "Purpose's words, not Actors'");
    }

    #[test]
    fn an_alias_stands_in_for_the_title() {
        let mut context = sec("context", "Context and Problem Statement", true, None);
        context.aliases = vec!["Context".to_string()];
        let body = format!("{FRONT}## Context\n\nWe keep losing uploads.\n");
        let report = validate(&body, &spec(vec![context]));
        assert!(report.conforms, "{:?}", report.issues);
    }

    /// Guidance left in comments is not content: it neither fills a section
    /// nor counts as a leftover marker. A `#` inside a fence is not a heading.
    #[test]
    fn comments_are_ignored_and_fenced_hashes_are_not_headings() {
        let spec = spec(vec![sec("context", "Context", true, None)]);
        let body =
            format!("{FRONT}## Context\n\n<!--\n{{Describe the context}} <the problem>\n-->\n");
        let report = validate(&body, &spec);
        assert!(
            report.issues.iter().any(|i| i.contains("Section is empty")),
            "{:?}",
            report.issues
        );
        assert!(
            report.issues.iter().all(|i| !i.contains("placeholder")),
            "{:?}",
            report.issues
        );

        let fenced = format!("{FRONT}## Context\n\nSee below.\n\n```sh\n# Context\n```\n");
        assert_eq!(
            headings(split_front_matter(&fenced).1)
                .iter()
                .filter(|h| h.title_norm == "context")
                .count(),
            1
        );
    }

    #[test]
    fn a_brace_placeholder_in_prose_is_caught() {
        let spec = spec(vec![sec("context", "Context", true, None)]);
        let body = format!("{FRONT}## Context\n\n{{2-3 paragraphs: why this is needed now.}}\n");
        let report = validate(&body, &spec);
        assert!(!report.conforms);
        assert!(
            report.issues.iter().any(|i| i.contains("{…}")),
            "{:?}",
            report.issues
        );

        // JSON and code are not placeholders.
        let body = format!(
            "{FRONT}## Context\n\nThe body is {{\"id\": 1}} and `cpt-{{system}}` is an id.\n"
        );
        assert!(validate(&body, &spec).conforms);
    }

    /// Every built-in template carries each heading its own checklist asks for,
    /// and a document seeded from it and left alone is reported as unfilled —
    /// the template and its checklist cannot drift apart unnoticed.
    #[test]
    fn every_builtin_template_has_its_sections_and_is_unfilled_as_seeded() {
        for ty in crate::documents::model::builtin_types() {
            let report = validate(&ty.template.body, &ty.template);
            let missing: Vec<&str> = report
                .sections
                .iter()
                .filter(|s| !s.present)
                .map(|s| s.title.as_str())
                .collect();
            assert!(missing.is_empty(), "{}: template lacks {missing:?}", ty.key);
            assert!(
                !report.conforms,
                "{}: an untouched template conforms",
                ty.key
            );
            assert!(
                report.issues.iter().any(|i| i.contains("placeholder")),
                "{}: {:?}",
                ty.key,
                report.issues
            );
        }
    }
}
