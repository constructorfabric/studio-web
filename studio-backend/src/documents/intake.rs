//! Turning questionnaire answers into a document.
//!
//! This lived in the prototype's UI (`generateFromQuestionnaire` in
//! `studio-frontend-prototype/src/documents.tsx`), which made it one client's
//! opinion about what a document type produces. A type is catalogue data now
//! (ADR-0014), so the thing that renders it belongs next to the catalogue:
//! the portal, the prototype and an agent writing through the API all get the
//! same document from the same answers.
//!
//! ## Capabilities are text first, index second
//!
//! A generated document declares its capabilities in front matter, because the
//! markdown ends up in a repository where a person reads it and nothing else is
//! there to explain what the document asked for. The `capabilities` column is an
//! INDEX over that text, re-derived on every write — not a second place to
//! store it. That is what stops the two from drifting when someone edits the
//! document by hand, which they can, and which no answer store would survive.

use serde::{Deserialize, Serialize};

use super::model::{DocumentType, Question, QuestionKind, Section};
use super::validate::normalize_heading;

/// One answer, as the wire carries it. Exactly one field is meaningful per
/// question kind; the rest are `None`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Answer {
    pub question_id: String,
    /// `text`, `long_text` and `single`.
    #[serde(default)]
    pub text: Option<String>,
    /// `multi`.
    #[serde(default)]
    pub choices: Option<Vec<String>>,
    /// `bool`.
    #[serde(default)]
    pub flag: Option<bool>,
}

/// The answer rendered as markdown. An unanswered question renders empty and is
/// left out of the document entirely.
fn answer_text(question: &Question, answer: Option<&Answer>) -> String {
    let Some(answer) = answer else {
        return String::new();
    };
    match question.kind {
        QuestionKind::Bool => match answer.flag {
            Some(true) => "Yes".to_string(),
            Some(false) => "No".to_string(),
            None => String::new(),
        },
        QuestionKind::Multi => answer
            .choices
            .as_ref()
            .map(|c| c.join(", "))
            .unwrap_or_default(),
        _ => answer
            .text
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_string(),
    }
}

/// Was the question answered at all?
///
/// A boolean is always answered once it is present — `false` is an answer, and
/// the prototype treated it as one. It just does not SEED a capability, which is
/// a different question and handled below.
fn answered(question: &Question, answer: Option<&Answer>) -> bool {
    let Some(answer) = answer else {
        return false;
    };
    match question.kind {
        QuestionKind::Bool => answer.flag.is_some(),
        QuestionKind::Multi => answer.choices.as_ref().is_some_and(|c| !c.is_empty()),
        _ => answer.text.as_deref().is_some_and(|t| !t.trim().is_empty()),
    }
}

/// The capabilities a set of answers seeds, in questionnaire order, deduplicated.
///
/// A `false` boolean does not seed: "do you need billing? no" must not put
/// `billing` in front of the composer. This is the one rule in here that is not
/// obvious from the shapes, and it is the prototype's rule.
pub fn seeded_capabilities(ty: &DocumentType, answers: &[Answer]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for question in &ty.template.questionnaire {
        let Some(capability) = question.capability.as_ref() else {
            continue;
        };
        let answer = answers.iter().find(|a| a.question_id == question.id);
        if !answered(question, answer) {
            continue;
        }
        if matches!(question.kind, QuestionKind::Bool) && answer.and_then(|a| a.flag) != Some(true)
        {
            continue;
        }
        if !seen.iter().any(|k| k == capability) {
            seen.push(capability.clone());
        }
    }
    seen
}

/// Build a document from a type's questionnaire and a set of answers.
///
/// The questionnaire fills the type's template; it does not replace it. The
/// template body is the document: its front matter gains the seeded
/// `capabilities`, its `H1` names the title, and each answer is written under
/// the heading of the section its question targets, each under its own prompt,
/// ahead of whatever guidance the template leaves there. A declared section the
/// template has no heading for is appended as an `H2` -- answered or not, since
/// the sections are the checklist `validate` reports against and a document that
/// silently omitted one would conform by having nothing to fail.
pub fn generate(ty: &DocumentType, title: &str, answers: &[Answer]) -> String {
    let capabilities = seeded_capabilities(ty, answers);
    let (front, body) = split_raw_front_matter(&ty.template.body);

    let mut out = String::from("---\n");
    for key in ["status: draft", "owner: "] {
        let name = key.split(':').next().unwrap_or_default();
        if !front.iter().any(|l| front_key(l) == name) {
            out.push_str(key);
            out.push('\n');
        }
    }
    for line in front.iter().filter(|l| front_key(l) != "capabilities") {
        out.push_str(line);
        out.push('\n');
    }
    if !capabilities.is_empty() {
        out.push_str(&format!("capabilities: {}\n", capabilities.join(", ")));
    }
    out.push_str("---\n\n");

    let answered_under = |section: &Section| -> String {
        let mut block = String::new();
        for question in ty
            .template
            .questionnaire
            .iter()
            .filter(|q| q.section.as_deref() == Some(section.key.as_str()))
        {
            let answer = answers.iter().find(|a| a.question_id == question.id);
            let text = answer_text(question, answer);
            if !text.is_empty() {
                block.push_str(&format!("**{}**\n\n{text}\n\n", question.prompt));
            }
        }
        block
    };

    let mut lines: Vec<String> = body.lines().map(str::to_string).collect();
    let heading = format!("# {} — {}", title_prefix(&lines, &ty.name), title.trim());
    match lines.iter().position(|l| l.starts_with("# ")) {
        Some(i) => lines[i] = heading,
        None => lines.insert(0, heading),
    }

    let mut appended = String::new();
    for section in &ty.template.sections {
        let block = answered_under(section);
        match find_heading(&lines, section) {
            Some(i) if !block.is_empty() => {
                lines.insert(i + 1, format!("\n{}", block.trim_end()));
            }
            Some(_) => {}
            None => appended.push_str(&format!("## {}\n\n{block}", section.title)),
        }
    }

    out.push_str(lines.join("\n").trim_start());
    out.push('\n');
    if !appended.is_empty() {
        out.push('\n');
        out.push_str(&appended);
    }
    out
}

/// The template's front-matter lines, verbatim, and the body after it.
fn split_raw_front_matter(content: &str) -> (Vec<&str>, &str) {
    let Some(rest) = content.strip_prefix("---\n") else {
        return (Vec::new(), content);
    };
    let Some(end) = rest.find("\n---\n") else {
        return (Vec::new(), content);
    };
    (rest[..end].lines().collect(), &rest[end + 5..])
}

fn front_key(line: &str) -> &str {
    line.split(':').next().unwrap_or_default().trim()
}

/// What the template's `H1` calls the document before its title placeholder
/// (`PRD` in `# PRD — {Gear/Feature Name}`), or the type's name.
fn title_prefix(lines: &[String], type_name: &str) -> String {
    lines
        .iter()
        .find_map(|l| l.strip_prefix("# "))
        .and_then(|h| h.split_once(" — "))
        .map(|(prefix, _)| prefix.trim().to_string())
        .unwrap_or_else(|| type_name.to_string())
}

/// The line holding `section`'s heading, matched the way `validate` matches it
/// and never inside a fenced block.
fn find_heading(lines: &[String], section: &Section) -> Option<usize> {
    let wanted: Vec<String> = section.titles().map(normalize_heading).collect();
    let mut in_fence = false;
    lines.iter().position(|line| {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            return false;
        }
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        !in_fence
            && (1..=6).contains(&hashes)
            && trimmed.chars().nth(hashes) == Some(' ')
            && wanted.contains(&normalize_heading(&trimmed[hashes..]))
    })
}

/// The capabilities a document declares, read back out of its front matter.
///
/// The counterpart to what [`generate`] writes, and the reason the column can be
/// an index rather than a second source of truth: a hand-edited document is
/// re-indexed from its own text on the next write.
pub fn declared_capabilities(content: &str) -> Vec<String> {
    // A file checked out on Windows, or written by an editor that says so,
    // arrives with CRLF; it declares what it declares all the same.
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let Some(rest) = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
    else {
        return Vec::new();
    };
    let Some(end) = rest.find("\n---") else {
        return Vec::new();
    };
    rest[..end]
        .lines()
        .find_map(|line| line.trim().strip_prefix("capabilities:"))
        .map(|list| {
            // `a, b` is what Studio writes; `[a, b]` and quoted items are what a
            // person writing YAML by hand writes, and mean the same.
            list.trim()
                .trim_start_matches('[')
                .trim_end_matches(']')
                .split(',')
                .map(|s| s.trim().trim_matches(|c| c == '"' || c == '\''))
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use crate::documents::model::builtin_types;
    use crate::documents::validate::validate;

    /// The one built-in with a questionnaire, which is what this module is
    /// about. It was `app_spec` until the catalogue narrowed to the five types
    /// Spec Quality analyses; the questions are the same ones.
    fn prd() -> DocumentType {
        builtin_types()
            .into_iter()
            .find(|t| t.key == "prd")
            .expect("prd is a built-in")
    }

    fn text(id: &str, value: &str) -> Answer {
        Answer {
            question_id: id.to_string(),
            text: Some(value.to_string()),
            ..Answer::default()
        }
    }

    fn flag(id: &str, value: bool) -> Answer {
        Answer {
            question_id: id.to_string(),
            flag: Some(value),
            ..Answer::default()
        }
    }

    fn multi(id: &str, values: &[&str]) -> Answer {
        Answer {
            question_id: id.to_string(),
            choices: Some(values.iter().map(|v| (*v).to_string()).collect()),
            ..Answer::default()
        }
    }

    /// One answer per question the intake cannot do without.
    fn full_answers() -> Vec<Answer> {
        vec![
            text(
                "product",
                "A portal that turns a product idea into a running application by                  composing gears, so a team can go from an intent to a deployed                  service without writing the plumbing themselves.",
            ),
            text(
                "primary_users",
                "Product teams and the platform engineers supporting them",
            ),
            text("tenancy", "Hierarchical tenants"),
            text("auth", "SSO / OIDC (Keycloak)"),
            flag("rbac", true),
            multi("storage", &["Relational (Postgres)", "Documents / graph"]),
            text("deploy", "Kubernetes"),
        ]
    }

    /// The text between `heading` and the next `## `, for asserting where an
    /// answer landed.
    fn under<'a>(body: &'a str, heading: &str) -> &'a str {
        let start = body.find(heading).expect("heading present") + heading.len();
        let rest = &body[start..];
        &rest[..rest.find("\n## ").unwrap_or(rest.len())]
    }

    /// What the questionnaire produces, and what it deliberately does not.
    ///
    /// The questionnaire fills the PRD template; it is not a form of its own.
    /// So the skeleton survives whole, every answer sits under the template
    /// section its question names, and the document does not conform -- eleven
    /// answers do not make a PRD, and the template's markers say exactly what a
    /// person still has to write.
    #[test]
    fn a_generated_document_is_the_template_with_the_answers_written_in() {
        let ty = prd();
        let body = generate(&ty, "Constructor Studio", &full_answers());

        assert!(body.contains("# PRD — Constructor Studio\n"), "{body}");
        assert!(
            body.starts_with("---\ntype: prd\nstatus: draft\n"),
            "{body}"
        );
        assert!(body.contains("### 1.1 Purpose"), "the skeleton survives");
        assert!(
            body.contains("## 14. Traceability"),
            "the skeleton survives"
        );

        assert!(under(&body, "## 1. Overview").contains("A portal that turns"));
        assert!(under(&body, "## 2. Actors").contains("Hierarchical tenants"));
        assert!(under(&body, "## 3. Operational Concept & Environment").contains("Kubernetes"));
        assert!(under(&body, "## 5. Functional Requirements").contains("SSO / OIDC"));

        let report = validate(&body, &ty.template);
        for section in ["Overview", "Actors", "Functional Requirements"] {
            assert!(
                !report.issues.iter().any(|i| i.contains(section)),
                "the questionnaire fills {section}: {:?}",
                report.issues
            );
        }
        assert!(
            !report.conforms,
            "a PRD from eleven answers is not finished"
        );
        assert!(
            report.issues.iter().any(|i| i.contains("placeholder")),
            "{:?}",
            report.issues
        );
    }

    #[test]
    fn every_declared_section_is_emitted_even_with_no_answers() {
        // A section left out would conform by having nothing to fail.
        let ty = prd();
        let body = generate(&ty, "Empty", &[]);
        let report = validate(&body, &ty.template);
        for section in &report.sections {
            assert!(section.present, "missing section {}", section.title);
        }
    }

    /// A workspace type whose template lacks a heading its checklist declares
    /// still gets that section, with its answers, at the end.
    #[test]
    fn a_section_the_template_has_no_heading_for_is_appended() {
        let mut ty = prd();
        ty.template.body = "# Brief — <title>\n\n## 1. Overview\n".to_string();
        let body = generate(&ty, "Short", &full_answers());
        assert!(under(&body, "## 1. Overview").contains("A portal that turns"));
        assert!(under(&body, "## Actors").contains("Hierarchical tenants"));
        assert!(body.starts_with("---\nstatus: draft\n"));
        assert!(body.contains("# Brief — Short\n"));
    }

    #[test]
    fn an_unanswered_question_leaves_no_trace() {
        let ty = prd();
        let body = generate(&ty, "Empty", &[]);
        assert!(!body.contains("**Who are the primary users?**"));
    }

    #[test]
    fn the_first_answer_alone_seeds_the_domain_capability() {
        // Project creation sends exactly this one answer for a `product`
        // project: the card's brief IS this question, word for word ("What are
        // we building? Describe the product and its core domain"). The project
        // then opens with one capability for the component matcher to work
        // from instead of an empty spec, so a single-answer intake is a
        // supported shape rather than an accident.
        let ty = prd();
        let answers = vec![text("product", "A billing portal for resellers.")];
        assert_eq!(seeded_capabilities(&ty, &answers), vec!["domain"]);

        let body = generate(&ty, "Reseller Billing", &answers);
        assert_eq!(declared_capabilities(&body), vec!["domain"]);
        assert!(body.contains("A billing portal for resellers."));
        // Every other section is still emitted, so the document reads as a
        // spec with the rest to fill in rather than as a one-line note.
        assert!(body.contains("## 3. Operational Concept & Environment"));
    }

    #[test]
    fn a_no_answer_does_not_seed_its_capability() {
        // "Do you need billing? No" must not put `billing` in front of the
        // composer -- but it is still an answer, so it is not simply skipped.
        let ty = prd();
        let seeded = seeded_capabilities(&ty, &[flag("billing", false)]);
        assert!(seeded.is_empty());

        let seeded = seeded_capabilities(&ty, &[flag("billing", true)]);
        assert_eq!(seeded, vec!["billing"]);
    }

    #[test]
    fn capabilities_survive_the_round_trip_through_the_document() {
        // `generate` writes them into front matter and the column is indexed
        // back out of it. If these two disagree the index is silently wrong.
        let ty = prd();
        let answers = full_answers();
        let expected = seeded_capabilities(&ty, &answers);
        assert!(!expected.is_empty(), "the fixture should seed something");

        let body = generate(&ty, "Constructor Studio", &answers);
        assert_eq!(declared_capabilities(&body), expected);
    }

    #[test]
    fn a_document_with_no_capabilities_has_no_capabilities_line() {
        let ty = prd();
        let body = generate(&ty, "Empty", &[]);
        assert!(!body.contains("capabilities:"));
        assert!(declared_capabilities(&body).is_empty());
    }

    #[test]
    fn reading_capabilities_out_of_a_document_without_front_matter_is_not_an_error() {
        assert!(
            declared_capabilities(
                "# Just a heading
"
            )
            .is_empty()
        );
        assert!(declared_capabilities("").is_empty());
        assert!(
            declared_capabilities(
                "---
status: draft
---
"
            )
            .is_empty()
        );
    }

    #[test]
    fn a_capability_seeded_twice_appears_once() {
        // `facade` and `connectors` are distinct keys but `compliance` is seeded
        // by one question only; construct the duplicate explicitly instead of
        // relying on the built-in questionnaire having one.
        let mut ty = prd();
        let first = ty.template.questionnaire[0].clone();
        let mut second = first.clone();
        second.id = format!("{}_again", first.id);
        ty.template.questionnaire.push(second.clone());

        let seeded =
            seeded_capabilities(&ty, &[text(&first.id, "yes"), text(&second.id, "also yes")]);
        assert_eq!(seeded.len(), 1, "got {seeded:?}");
    }

    #[test]
    fn capabilities_read_the_way_people_write_them() {
        // What Studio writes.
        assert_eq!(
            declared_capabilities("---\ntype: prd\ncapabilities: auth, storage\n---\n# X\n"),
            vec!["auth", "storage"]
        );
        // A checkout on Windows.
        assert_eq!(
            declared_capabilities(
                "---\r\ntype: prd\r\ncapabilities: auth, storage\r\n---\r\n# X\r\n"
            ),
            vec!["auth", "storage"]
        );
        // YAML by hand: a flow list, quoted items.
        assert_eq!(
            declared_capabilities("---\ncapabilities: [auth, \"storage\", 'deploy']\n---\n"),
            vec!["auth", "storage", "deploy"]
        );
    }
}
