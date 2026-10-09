//! A model's suggestion for a registry entry (ADR-0041 P4): a description, a
//! category and capability keys, proposed from what the registry already
//! holds -- the name, the evidence, where it was found and its README.
//!
//! `POST /registry/{name}/suggest` asks studio-llm-proxy for one completion
//! on the caller's own key (`llm_proxy::port::ModelProviders::complete`,
//! ADR-0039: Studio's one way out to a provider, never a key Studio holds).
//! The answer is parsed deterministically: one JSON object, capability keys
//! kept only when they are in the organization's vocabulary, the category
//! only when it is one of the platform's ([`super::taxonomy::CATEGORIES`]).
//! The suggestion is stored on the entry and answered; it never moves the
//! entry. Applying it is an `edit` decision a person makes.

use std::collections::BTreeSet;

use serde_json::Value;
use toolkit_security::SecurityContext;

use super::registry::{self, EntryRecord, RegistryEntry, Suggestion};
use super::service::CatalogService;
use crate::llm_proxy::port::{CompletionError, CompletionRequest, ModelProviders};

/// The most README text a question carries.
pub const MAX_DOC_BYTES: usize = 8 * 1024;
/// The most occurrences a question names.
const MAX_PLACES: usize = 10;
/// The answer's budget.
const MAX_TOKENS: u32 = 600;

/// One capability of the vocabulary: its key and its label.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VocabularyEntry {
    pub key: String,
    pub label: String,
}

/// What a model proposed, after parsing.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Proposed {
    pub description: Option<String>,
    pub category: Option<String>,
    pub capabilities: Vec<String>,
}

/// Why there is no suggestion.
#[derive(Debug)]
pub enum SuggestFailure {
    NotFound(String),
    /// The caller has no model key: the words to show them.
    NoKey(String),
    /// The model answered something that is not the JSON asked for.
    Unreadable(String),
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for SuggestFailure {
    fn from(e: anyhow::Error) -> Self {
        Self::Failed(e)
    }
}

/// `text` cut to at most `max` bytes, on a character boundary.
fn bounded(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The question: the entry's facts, the vocabulary to choose from, and the
/// shape of the answer.
pub fn suggestion_request(
    entry: &RegistryEntry,
    vocabulary: &[VocabularyEntry],
) -> CompletionRequest {
    let e = &entry.entry;
    let system = format!(
        "You describe software components for a component registry. Answer with one JSON \
         object and nothing else: {{\"description\": string, \"category\": string or null, \
         \"capabilities\": [string]}}. The description is one or two plain sentences saying \
         what the component does for a product. The category is one of: {}; or null when \
         none fits. Capabilities are keys from the vocabulary the user gives, and only those; \
         an empty list when none fits.",
        super::taxonomy::CATEGORIES.join(", ")
    );
    let mut prompt = format!("Component: {}\nKind: {}\n", e.name, e.kind);
    if let Some(d) = e.description.as_deref().filter(|d| !d.trim().is_empty()) {
        prompt.push_str(&format!("Current description: {d}\n"));
    }
    if !e.evidence.is_empty() {
        prompt.push_str("Evidence:\n");
        for ev in &e.evidence {
            prompt.push_str(&format!("- {}\n", ev.detail));
        }
    }
    if !entry.occurrences.is_empty() {
        prompt.push_str("Found at:\n");
        for o in entry.occurrences.iter().take(MAX_PLACES) {
            prompt.push_str(&format!("- {} {}\n", o.repo, o.path));
        }
    }
    let doc = entry
        .occurrences
        .iter()
        .filter_map(|o| o.doc_text.as_deref())
        .find(|t| !t.trim().is_empty());
    if let Some(doc) = doc {
        prompt.push_str("README:\n");
        prompt.push_str(bounded(doc, MAX_DOC_BYTES));
        prompt.push('\n');
    }
    prompt.push_str("Capability vocabulary (key: label):\n");
    for v in vocabulary {
        prompt.push_str(&format!("- {}: {}\n", v.key, v.label));
    }
    CompletionRequest {
        system,
        prompt,
        max_tokens: MAX_TOKENS,
    }
}

/// The JSON object in a model's answer: the whole text, or the text inside
/// a fenced block, or from its first `{` to its last `}`.
fn json_object(text: &str) -> Option<serde_json::Map<String, Value>> {
    let text = text.trim();
    let candidates = [
        Some(text),
        text.split_once("```")
            .and_then(|(_, rest)| rest.split_once("```"))
            .map(|(inner, _)| inner.trim_start_matches("json").trim()),
        match (text.find('{'), text.rfind('}')) {
            (Some(a), Some(b)) if a < b => Some(&text[a..=b]),
            _ => None,
        },
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(|c| match serde_json::from_str::<Value>(c) {
            Ok(Value::Object(map)) => Some(map),
            _ => None,
        })
}

/// A model's answer as a suggestion. Deterministic: one JSON object;
/// `description` a string (blank is none), `category` one of the platform's
/// or none, `capabilities` the vocabulary's keys it names (case-blind, by
/// key or label), each once, in the vocabulary's spelling.
pub fn parse_suggestion(text: &str, vocabulary: &[VocabularyEntry]) -> Result<Proposed, String> {
    let obj = json_object(text).ok_or_else(|| {
        format!(
            "the model's answer is not a JSON object: {}",
            bounded(text.trim(), 200)
        )
    })?;
    let description = match obj.get("description") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.trim().to_owned()).filter(|s| !s.is_empty()),
        Some(_) => return Err("the model's `description` is not a string".to_owned()),
    };
    let category = match obj.get("category") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let c = s.trim().to_ascii_lowercase();
            super::taxonomy::is_category(&c).then_some(c)
        }
        Some(_) => return Err("the model's `category` is not a string".to_owned()),
    };
    let capabilities = match obj.get("capabilities") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut seen = BTreeSet::new();
            items
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|c| {
                    let c = c.trim();
                    vocabulary
                        .iter()
                        .find(|v| v.key.eq_ignore_ascii_case(c) || v.label.eq_ignore_ascii_case(c))
                })
                .filter(|v| seen.insert(v.key.clone()))
                .map(|v| v.key.clone())
                .collect()
        }
        Some(_) => return Err("the model's `capabilities` is not a list".to_owned()),
    };
    Ok(Proposed {
        description,
        category,
        capabilities,
    })
}

impl CatalogService {
    /// Ask a model, on the caller's key, what the entry `name` is, and keep
    /// the answer on the entry as its `suggestion`. Never moves the entry.
    pub async fn suggest_registry(
        &self,
        ctx: &SecurityContext,
        name: &str,
        vocabulary: &[VocabularyEntry],
        model: &dyn ModelProviders,
    ) -> Result<Suggestion, SuggestFailure> {
        let wanted = name.trim();
        let entry = self
            .registry_entry(ctx, wanted)
            .await?
            .ok_or_else(|| SuggestFailure::NotFound(wanted.to_owned()))?;
        let request = suggestion_request(&entry, vocabulary);
        let answer = model.complete(ctx, &request).await.map_err(|e| match e {
            CompletionError::NoKey(message) => SuggestFailure::NoKey(message),
            CompletionError::Failed(e) => SuggestFailure::Failed(e),
        })?;
        let proposed =
            parse_suggestion(&answer.text, vocabulary).map_err(SuggestFailure::Unreadable)?;
        let suggestion = Suggestion {
            description: proposed.description,
            category: proposed.category,
            capabilities: proposed.capabilities,
            at: registry::now(),
            model: format!("{}:{}", answer.provider, answer.model),
        };

        // Kept on the entry, read fresh so nothing a decision wrote between
        // is lost.
        let org = ctx.subject_tenant_id();
        let stored = registry::records::<EntryRecord>(
            self.sink
                .list(ctx, Some(super::gts::REGISTRY_ENTRY_TYPE))
                .await?,
        )
        .into_iter()
        .find(|(_, e)| e.organization_id == org && e.name.eq_ignore_ascii_case(&entry.entry.name));
        if let Some((id, mut record)) = stored {
            record.suggestion = Some(suggestion.clone());
            self.sink
                .upsert(
                    ctx,
                    &[super::gts::GtsNode {
                        type_id: super::gts::REGISTRY_ENTRY_TYPE,
                        instance_id: id,
                        value: serde_json::to_value(&record).map_err(anyhow::Error::from)?,
                    }],
                    &[],
                )
                .await?;
        }
        tracing::info!(organization_id = %org, entry = %entry.entry.name, model = %suggestion.model, "components-catalog: registry: a model suggested what a component is");
        Ok(suggestion)
    }
}

#[cfg(test)]
#[path = "registry_suggest_tests.rs"]
mod tests;
