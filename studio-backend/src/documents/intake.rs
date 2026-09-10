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

use super::model::{DocumentType, Question, QuestionKind};

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
/// The shape is the prototype's, kept deliberately: front matter, an `H1` of
/// `<type name> — <title>`, then every declared section as an `H2` with the
/// answers that target it, each under its own prompt. Sections with no answers
/// are still emitted — they are the checklist `validate` reports against, and a
/// document that silently omits them would conform by having nothing to fail.
pub fn generate(ty: &DocumentType, title: &str, answers: &[Answer]) -> String {
    let capabilities = seeded_capabilities(ty, answers);

    let mut out = String::from("---\nstatus: draft\nowner: \n");
    if !capabilities.is_empty() {
        out.push_str(&format!("capabilities: {}\n", capabilities.join(", ")));
    }
    out.push_str("---\n\n");
    out.push_str(&format!("# {} — {}\n\n", ty.name, title.trim()));

    for section in &ty.template.sections {
        out.push_str(&format!("## {}\n\n", section.title));
        for question in ty
            .template
            .questionnaire
            .iter()
            .filter(|q| q.section.as_deref() == Some(section.key.as_str()))
        {
            let answer = answers.iter().find(|a| a.question_id == question.id);
            let text = answer_text(question, answer);
            if !text.is_empty() {
                out.push_str(&format!("**{}**\n\n{text}\n\n", question.prompt));
            }
        }
    }
    out
}

/// The capabilities a document declares, read back out of its front matter.
///
/// The counterpart to what [`generate`] writes, and the reason the column can be
/// an index rather than a second source of truth: a hand-edited document is
/// re-indexed from its own text on the next write.
pub fn declared_capabilities(content: &str) -> Vec<String> {
    let Some(rest) = content.strip_prefix("---\n") else {
        return Vec::new();
    };
    let Some(end) = rest.find("\n---") else {
        return Vec::new();
    };
    rest[..end]
        .lines()
        .find_map(|line| line.trim().strip_prefix("capabilities:"))
        .map(|list| {
            list.split(',')
                .map(str::trim)
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

    fn app_spec() -> DocumentType {
        builtin_types()
            .into_iter()
            .find(|t| t.key == "app_spec")
            .expect("app_spec is a built-in")
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

    /// Enough answers to satisfy every required section of the App Spec.
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

    #[test]
    fn a_generated_document_conforms_to_its_own_type() {
        // The point of generating server-side: what comes out passes the check
        // the same type declares. If these two ever disagree, every document the
        // questionnaire produces is born non-conforming.
        let ty = app_spec();
        let body = generate(&ty, "Constructor Studio", &full_answers());

        let report = validate(&body, &ty.template);
        assert!(report.conforms, "issues: {:?}", report.issues);
    }

    #[test]
    fn every_declared_section_is_emitted_even_with_no_answers() {
        // A section left out would conform by having nothing to fail.
        let ty = app_spec();
        let body = generate(&ty, "Empty", &[]);
        for section in &ty.template.sections {
            assert!(
                body.contains(&format!("## {}", section.title)),
                "missing section {}",
                section.title
            );
        }
    }

    #[test]
    fn an_unanswered_question_leaves_no_trace() {
        let ty = app_spec();
        let body = generate(&ty, "Empty", &[]);
        assert!(!body.contains("**Who are the primary users?**"));
    }

    #[test]
    fn a_no_answer_does_not_seed_its_capability() {
        // "Do you need billing? No" must not put `billing` in front of the
        // composer -- but it is still an answer, so it is not simply skipped.
        let ty = app_spec();
        let seeded = seeded_capabilities(&ty, &[flag("billing", false)]);
        assert!(seeded.is_empty());

        let seeded = seeded_capabilities(&ty, &[flag("billing", true)]);
        assert_eq!(seeded, vec!["billing"]);
    }

    #[test]
    fn capabilities_survive_the_round_trip_through_the_document() {
        // `generate` writes them into front matter and the column is indexed
        // back out of it. If these two disagree the index is silently wrong.
        let ty = app_spec();
        let answers = full_answers();
        let expected = seeded_capabilities(&ty, &answers);
        assert!(!expected.is_empty(), "the fixture should seed something");

        let body = generate(&ty, "Constructor Studio", &answers);
        assert_eq!(declared_capabilities(&body), expected);
    }

    #[test]
    fn a_document_with_no_capabilities_has_no_capabilities_line() {
        let ty = app_spec();
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
        let mut ty = app_spec();
        let first = ty.template.questionnaire[0].clone();
        let mut second = first.clone();
        second.id = format!("{}_again", first.id);
        ty.template.questionnaire.push(second.clone());

        let seeded =
            seeded_capabilities(&ty, &[text(&first.id, "yes"), text(&second.id, "also yes")]);
        assert_eq!(seeded.len(), 1, "got {seeded:?}");
    }
}
