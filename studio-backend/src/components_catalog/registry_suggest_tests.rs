//! Model suggestions (ADR-0041 P4): the question, the deterministic parsing
//! of the answer, and that a suggestion is stored and never moves the entry.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use uuid::Uuid;

use super::*;
use crate::catalog_graph::MemorySink;
use crate::components_catalog::project_gears::LocalGear;
use crate::components_catalog::registry::{RepoRead, STATE_DECLARED, Walk, plan};
use crate::llm_proxy::port::{Completion, ModelInfo};

const ORG: Uuid = Uuid::from_u128(0x0a6);
const P1: Uuid = Uuid::from_u128(0x101);

fn vocabulary() -> Vec<VocabularyEntry> {
    [
        ("billing", "Billing"),
        ("storage", "File storage"),
        ("auth", "Authentication"),
    ]
    .into_iter()
    .map(|(k, l)| VocabularyEntry {
        key: k.into(),
        label: l.into(),
    })
    .collect()
}

#[test]
fn a_json_answer_is_read_and_its_capabilities_kept_to_the_vocabulary() {
    let p = parse_suggestion(
        r#"{"description":" Keeps the books. ","category":"BSS","capabilities":["Billing","file storage","teleport","billing"]}"#,
        &vocabulary(),
    )
    .unwrap();
    assert_eq!(p.description.as_deref(), Some("Keeps the books."));
    assert_eq!(p.category.as_deref(), Some("bss"));
    assert_eq!(
        p.capabilities,
        vec!["billing", "storage"],
        "by key or label, once, never invented"
    );

    // A fenced block, or an object inside prose, reads the same.
    let fenced = "Here it is:\n```json\n{\"description\":\"d\",\"capabilities\":[\"auth\"]}\n```";
    assert_eq!(
        parse_suggestion(fenced, &vocabulary())
            .unwrap()
            .capabilities,
        vec!["auth"]
    );
    let prose = "Sure. {\"description\": \"d\", \"category\": \"made-up\"} Hope that helps.";
    let p = parse_suggestion(prose, &vocabulary()).unwrap();
    assert_eq!(
        p.category, None,
        "a category the platform does not have is dropped"
    );
    assert!(p.capabilities.is_empty());
}

#[test]
fn an_answer_that_is_not_the_json_asked_for_is_refused() {
    for bad in [
        "I think it is a billing gear.",
        "[1, 2]",
        r#"{"description": 7}"#,
        r#"{"capabilities": "billing"}"#,
        r#"{"category": ["bss"]}"#,
    ] {
        assert!(parse_suggestion(bad, &vocabulary()).is_err(), "{bad}");
    }
}

fn entry_with_doc(doc: &str) -> RegistryEntry {
    RegistryEntry {
        entry: EntryRecord {
            organization_id: ORG,
            name: "ledger".into(),
            kind: "gear".into(),
            state: STATE_DECLARED.into(),
            ..EntryRecord::default()
        },
        occurrences: vec![registry::OccurrenceRecord {
            repo: "acme/app".into(),
            path: "gears/ledger".into(),
            doc_text: Some(doc.into()),
            ..registry::OccurrenceRecord::default()
        }],
    }
}

#[test]
fn the_question_names_the_vocabulary_and_bounds_the_readme() {
    let long = "é".repeat(MAX_DOC_BYTES);
    let req = suggestion_request(&entry_with_doc(&long), &vocabulary());
    assert!(req.prompt.contains("Component: ledger"));
    assert!(req.prompt.contains("acme/app gears/ledger"));
    assert!(req.prompt.contains("- storage: File storage"));
    assert!(
        req.prompt.len() < MAX_DOC_BYTES + 1024,
        "the README is bounded"
    );
    assert!(req.system.contains("bss"), "the categories are named");
}

/// Answers what it was set to, or that the caller has no key.
struct Model {
    answer: Option<String>,
    asked: Mutex<Vec<Uuid>>,
}

#[async_trait]
impl ModelProviders for Model {
    async fn list_models(
        &self,
        _provider: &str,
        _base_url: Option<&str>,
        _key: &str,
    ) -> anyhow::Result<Vec<ModelInfo>> {
        Ok(Vec::new())
    }

    async fn complete(
        &self,
        ctx: &SecurityContext,
        _request: &CompletionRequest,
    ) -> Result<Completion, CompletionError> {
        self.asked.lock().unwrap().push(ctx.subject_id());
        match &self.answer {
            Some(text) => Ok(Completion {
                provider: "anthropic".into(),
                model: "claude-sonnet-5-5".into(),
                text: text.clone(),
            }),
            None => Err(CompletionError::NoKey("No anthropic key for you.".into())),
        }
    }
}

fn model(answer: Option<&str>) -> Model {
    Model {
        answer: answer.map(str::to_owned),
        asked: Mutex::new(Vec::new()),
    }
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0xca7))
        .subject_type("user")
        .subject_tenant_id(ORG)
        .build()
        .expect("security context")
}

async fn seeded() -> CatalogService {
    let svc = CatalogService::new(Arc::new(MemorySink::default()), "k".to_string(), None);
    let w = Walk {
        org: ORG,
        now: "t1".into(),
        reads: vec![RepoRead {
            project_id: P1,
            project_name: "app".into(),
            repo: "acme/app".into(),
            repo_key: "k1".into(),
            fingerprint: "f1".into(),
            gears: vec![LocalGear {
                name: "ledger".into(),
                kind: "gear".into(),
                description: None,
                category: None,
                path: "gears/ledger".into(),
                declared_in: "gears/ledger/gear.toml".into(),
                repo: "acme/app".into(),
                capabilities: Vec::new(),
                runtime: Vec::new(),
                built: true,
                doc: Some(("gears/ledger/README.md".into(), "Keeps books.".into())),
            }],
            ..RepoRead::default()
        }],
        resolved: [(P1, "k1".to_string())].into_iter().collect(),
        projects_resolved: [P1].into_iter().collect(),
        in_scope: Some([P1].into_iter().collect()),
        ..Walk::default()
    };
    let p = plan(&w, &[], &[], &[]);
    svc.sink.upsert(&ctx(), &p.upsert, &p.edges).await.unwrap();
    svc
}

#[tokio::test]
async fn a_suggestion_is_kept_on_the_entry_and_moves_nothing() {
    let svc = seeded().await;
    let m = model(Some(
        r#"{"description":"Keeps the books.","category":"bss","capabilities":["billing","nope"]}"#,
    ));
    let s = svc
        .suggest_registry(&ctx(), "Ledger", &vocabulary(), &m)
        .await
        .unwrap();
    assert_eq!(s.capabilities, vec!["billing"]);
    assert_eq!(s.model, "anthropic:claude-sonnet-5-5");
    assert_eq!(
        m.asked.lock().unwrap().as_slice(),
        &[Uuid::from_u128(0xca7)],
        "on the caller's key"
    );

    let e = svc.registry_entry(&ctx(), "ledger").await.unwrap().unwrap();
    assert_eq!(e.entry.state, STATE_DECLARED, "never a state change");
    assert_eq!(e.entry.description, None, "applying it is a person's edit");
    let kept = e.entry.suggestion.expect("stored");
    assert_eq!(kept.description.as_deref(), Some("Keeps the books."));
    assert_eq!(kept.category.as_deref(), Some("bss"));
}

#[tokio::test]
async fn without_a_key_or_with_an_unreadable_answer_nothing_is_stored() {
    let svc = seeded().await;
    let no_key = svc
        .suggest_registry(&ctx(), "ledger", &vocabulary(), &model(None))
        .await
        .unwrap_err();
    assert!(matches!(no_key, SuggestFailure::NoKey(_)));
    let garbled = svc
        .suggest_registry(
            &ctx(),
            "ledger",
            &vocabulary(),
            &model(Some("a ledger, probably")),
        )
        .await
        .unwrap_err();
    assert!(matches!(garbled, SuggestFailure::Unreadable(_)));
    let missing = svc
        .suggest_registry(&ctx(), "nope", &vocabulary(), &model(Some("{}")))
        .await
        .unwrap_err();
    assert!(matches!(missing, SuggestFailure::NotFound(_)));
    let e = svc.registry_entry(&ctx(), "ledger").await.unwrap().unwrap();
    assert!(e.entry.suggestion.is_none());
}
