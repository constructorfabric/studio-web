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
}

/// A heading found in the document: its level, normalized title, and the word
/// count of the body that follows it up to the next heading.
struct Heading {
    level: usize,
    title_norm: String,
    body_words: usize,
}

fn normalize(s: &str) -> String {
    s.trim().to_lowercase()
}

/// Split front-matter (a leading `--- ... ---` YAML-ish block) from the body,
/// returning the simple `key: value` pairs and the remaining markdown.
fn split_front_matter(content: &str) -> (HashMap<String, String>, &str) {
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

/// Parse all ATX headings and the word count of each one's body.
fn headings(body: &str) -> Vec<Heading> {
    let lines: Vec<&str> = body.lines().collect();
    let mut heads: Vec<Heading> = Vec::new();
    let mut pending_body = 0usize;
    let mut have_head = false;
    let mut cur_level = 0usize;
    let mut cur_title = String::new();

    let flush = |heads: &mut Vec<Heading>, level: usize, title: &str, words: usize| {
        heads.push(Heading {
            level,
            title_norm: normalize(title),
            body_words: words,
        });
    };

    for line in lines {
        let trimmed = line.trim_start();
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        let is_heading = (1..=6).contains(&hashes) && trimmed.chars().nth(hashes) == Some(' ');
        if is_heading {
            if have_head {
                flush(&mut heads, cur_level, &cur_title, pending_body);
            }
            have_head = true;
            cur_level = hashes;
            cur_title = trimmed[hashes..].trim().to_string();
            pending_body = 0;
        } else if have_head {
            pending_body += line.split_whitespace().count();
        }
    }
    if have_head {
        flush(&mut heads, cur_level, &cur_title, pending_body);
    }
    heads
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
    let mut conforms = true;

    // Sections.
    for s in &spec.sections {
        let want = normalize(&s.title);
        let found = heads.iter().find(|h| h.title_norm == want);
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
            conforms = false;
            if !present {
                issues.push(format!("Missing required section: {}", s.title));
            } else if word_count == 0 {
                issues.push(format!("Section is empty: {}", s.title));
            } else if !meets_min {
                issues.push(format!(
                    "Section \"{}\" is too short ({} words, need {})",
                    s.title,
                    word_count,
                    s.min_words.unwrap_or(0)
                ));
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
        for marker in ["{{", "TODO", "TBD"] {
            if content.contains(marker) {
                conforms = false;
                issues.push(format!("Leftover placeholder: {marker}"));
            }
        }
        if has_angle_placeholder(content) {
            conforms = false;
            issues.push("Leftover placeholder: <…> template marker".to_string());
        }
    }

    ValidationReport {
        conforms,
        sections,
        issues,
    }
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
        }
    }

    fn sec(key: &str, title: &str, required: bool, min_words: Option<usize>) -> Section {
        Section {
            key: key.to_string(),
            title: title.to_string(),
            required,
            min_words,
            description: None,
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
}
