//! Gears in plain words: an organization's explanation of each gear, for the
//! people who put a product together and do not read `gear.gdl`.
//!
//! Most gears in the corpus have no description, so the product map's tiles
//! said nothing to a person. An explanation is two or three sentences --
//! what the gear is, what a product gets from it, when to pick it -- either
//! written by a model from the catalogue's facts and the crate's README
//! (`generated`), or written by a person (`edited`). A generated one never
//! replaces what a person wrote unless they ask for it ([`may_generate`]).
//!
//! Kept as one account-management metadata row on the organization, keyed by
//! the gear's engine id. Written only by this gear, as the service, after the
//! caller was shown to reach the organization (`?organization_id=`) and to
//! administer it ([`may_explain`]; reading stays open to members): the PDP
//! refuses anybody else's write of the row
//! (`studio_authz_plugin::GEAR_HELD_METADATA`), so the length and source
//! rules here are the only way it changes.

use std::collections::BTreeMap;
use std::sync::Arc;

use account_management_sdk::{AccountManagementClient, UpsertMetadataRequest};
use anyhow::anyhow;
use gts::GtsTypeId;
use serde::{Deserialize, Serialize};
use toolkit_canonical_errors::CanonicalError;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::llm_proxy::port::CompletionRequest;

/// The metadata type the explanations are kept under, on the organization.
pub const EXPLANATIONS_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.product.gear_explanations.v1~";

/// The documents this gear keeps as domain objects, each record of their
/// lists an object (ADR-0051 §8a, `storage.metadata`).
/// The gear's `storage.metadata` setting, read at init.
pub(crate) static STORAGE: std::sync::OnceLock<crate::model_metadata::MetadataStorage> =
    std::sync::OnceLock::new();

pub(crate) static MODEL_KINDS: &[crate::model_metadata::Kind] = {
    use crate::model_metadata::{Kind, Part};
    &[Kind {
        type_id: EXPLANATIONS_METADATA_TYPE,
        gear: "studio-product",
        parts: &[Part {
            field: "items",
            entity: "gear-explanation",
            name: "Gear Explanation",
            description: "What a gear does in plain words, written for an organization's people.",
            key: &[],
        }],
    }]
};

/// The subject this gear writes as. Fixed, so an audit of account-management
/// says which gear changed the row.
pub const SERVICE_SUBJECT_ID: Uuid = Uuid::from_u128(0x9d1e_57a2_0c4b_4e8f_a3d6_71b0_e2c5_8f14);

/// The longest explanation kept, in characters: a few sentences, not a page.
pub const MAX_TEXT_CHARS: usize = 1_200;

/// The most README text a question carries.
pub const MAX_README_BYTES: usize = 6 * 1024;

/// The answer's budget.
const MAX_TOKENS: u32 = 400;

/// How many times a write re-reads and tries again when somebody else wrote
/// the row in between.
const WRITE_ATTEMPTS: usize = 4;

/// Who wrote an explanation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// A model, from the catalogue's facts.
    #[default]
    Generated,
    /// A person.
    Edited,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Generated => "generated",
            Self::Edited => "edited",
        }
    }
}

/// One gear's explanation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Explanation {
    pub text: String,
    pub source: Source,
    /// RFC 3339.
    pub updated_at: String,
}

/// The stored row: every explanation of the organization, by engine id.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Explanations {
    #[serde(default)]
    pub items: BTreeMap<String, Explanation>,
}

/// What the catalogue knows of one gear: the facts an explanation is written
/// from. Built by `gearbox::gear_brief`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GearBrief {
    /// The engine's id: what an explanation is keyed by.
    pub id: String,
    pub crate_name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub maturity: Option<String>,
    /// `rest`, `db`, … as `#[toolkit::gear]` declares them.
    pub runtime_caps: Vec<String>,
    /// The gear this one plugs into, when it is a plugin.
    pub host: Option<String>,
    /// The choices it opens (its extension points), when it is a host.
    pub points: Vec<String>,
    /// The plugins that fill those choices.
    pub plugins: Vec<String>,
    /// Gears that must run beside it.
    pub brings: Vec<String>,
    /// The crate's directory in the corpus, relative to its root.
    pub path: Option<String>,
    /// The crate's README, when it has one.
    pub readme: Option<String>,
}

/// The privilege that changes the organization's explanations: the one that
/// curates its gear catalogue (ADR-0041 P2), since an explanation is how the
/// catalogue reads to the organization's people. The role ladder gives it to
/// owners and admins, never to editors or viewers.
pub const EXPLAIN_PRIVILEGE: &str = "component.registry";

/// May the caller change `org`'s explanations (save their words, or have a
/// model write them)? An organization administrator or a platform
/// administrator may, as studio-user answers it (ADR-0019 §3: the gear answers
/// administration, never the PDP, whose tenant clamp admits every member).
/// Without studio-user nobody can be shown to hold it, so nobody does.
/// Reading them stays open to every member.
pub async fn may_explain(
    authority: Option<&dyn crate::user_profile::OrgAuthority>,
    ctx: &SecurityContext,
    org: Uuid,
) -> bool {
    match authority {
        Some(authority) => authority.may_administer(ctx, org, EXPLAIN_PRIVILEGE).await,
        None => false,
    }
}

/// Whether a model may write `existing`'s explanation: always where there is
/// none or a generated one, over a person's words only when asked (`force`).
pub fn may_generate(existing: Option<&Explanation>, force: bool) -> bool {
    force || existing.is_none_or(|e| e.source != Source::Edited)
}

/// A person's explanation, checked: trimmed, not empty, not too long.
pub fn checked_text(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("an explanation cannot be empty".to_owned());
    }
    let chars = text.chars().count();
    if chars > MAX_TEXT_CHARS {
        return Err(format!(
            "the explanation is {chars} characters; at most {MAX_TEXT_CHARS} are kept"
        ));
    }
    Ok(text.to_owned())
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

fn present(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// The question: the gear's facts and README, and the shape of the answer.
pub fn explanation_request(brief: &GearBrief) -> CompletionRequest {
    let system = "You explain the building blocks of software products (\"gears\") to people \
                  who are not engineers: product managers, founders, analysts. Write two or \
                  three short, plain sentences: what this part is, what a product gets from \
                  it, and when to pick it. Use everyday words; no jargon, no crate, trait or \
                  code names, no markdown, no lists, no quotes, no heading. Say only what the \
                  facts support; never invent features. Answer with the sentences and nothing \
                  else."
        .to_owned();
    let mut prompt = String::new();
    let name = present(&brief.display_name).unwrap_or(&brief.crate_name);
    prompt.push_str(&format!("Gear: {name}\n"));
    if brief.crate_name != name {
        prompt.push_str(&format!("Crate: {}\n", brief.crate_name));
    }
    if let Some(c) = present(&brief.category) {
        prompt.push_str(&format!("Area: {c}\n"));
    }
    if let Some(m) = present(&brief.maturity) {
        prompt.push_str(&format!("Maturity: {m}\n"));
    }
    if let Some(d) = present(&brief.description) {
        prompt.push_str(&format!("Its own description: {d}\n"));
    }
    if !brief.runtime_caps.is_empty() {
        prompt.push_str(&format!(
            "Runtime capabilities: {}\n",
            brief.runtime_caps.join(", ")
        ));
    }
    if let Some(h) = present(&brief.host) {
        prompt.push_str(&format!(
            "It is a plugin: one of the choices for {h}, which it plugs into.\n"
        ));
    }
    if !brief.points.is_empty() {
        prompt.push_str(&format!(
            "Choices it lets a product make (extension points): {}\n",
            brief.points.join(", ")
        ));
    }
    if !brief.plugins.is_empty() {
        prompt.push_str(&format!(
            "Plugins available for those choices: {}\n",
            brief.plugins.join(", ")
        ));
    }
    if !brief.brings.is_empty() {
        prompt.push_str(&format!(
            "Gears that always come with it: {}\n",
            brief.brings.join(", ")
        ));
    }
    if let Some(readme) = brief.readme.as_deref().filter(|r| !r.trim().is_empty()) {
        prompt.push_str("README:\n");
        prompt.push_str(bounded(readme.trim(), MAX_README_BYTES));
        prompt.push('\n');
    }
    CompletionRequest {
        system,
        prompt,
        max_tokens: MAX_TOKENS,
    }
}

/// A model's answer as an explanation: the code fence, heading marks, a
/// leading label, surrounding quotes and markdown emphasis taken off,
/// whitespace collapsed to single spaces, and cut at a sentence end when it
/// is longer than [`MAX_TEXT_CHARS`]. An answer with nothing left is refused.
pub fn clean_answer(answer: &str) -> Result<String, String> {
    let mut text = answer.trim();
    // A fenced block: its inside.
    if let Some(rest) = text.strip_prefix("```") {
        let rest = rest.split_once('\n').map_or(rest, |(_, body)| body);
        text = rest
            .rsplit_once("```")
            .map_or(rest, |(body, _)| body)
            .trim();
    }
    let mut lines: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim().trim_start_matches('#').trim();
        let line = line
            .strip_prefix("- ")
            .or_else(|| line.strip_prefix("* "))
            .unwrap_or(line);
        if !line.is_empty() {
            lines.push(line.to_owned());
        }
    }
    let mut joined = lines.join(" ").replace("**", "").replace("__", "");
    // A label the model put in front: "Explanation: …".
    for label in [
        "explanation:",
        "answer:",
        "in plain words:",
        "plain explanation:",
    ] {
        if joined
            .get(..label.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(label))
        {
            joined = joined[label.len()..].trim_start().to_owned();
        }
    }
    let mut text: String = joined.split_whitespace().collect::<Vec<_>>().join(" ");
    for (open, close) in [('"', '"'), ('\u{201c}', '\u{201d}'), ('\'', '\'')] {
        if text.len() >= 2 && text.starts_with(open) && text.ends_with(close) {
            text = text[open.len_utf8()..text.len() - close.len_utf8()]
                .trim()
                .to_owned();
        }
    }
    if text.is_empty() {
        return Err("the model answered nothing".to_owned());
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        let cut: String = text.chars().take(MAX_TEXT_CHARS).collect();
        text = match cut.rfind(['.', '!', '?']) {
            Some(end) if end > 0 => cut[..=end].to_owned(),
            _ => cut.trim_end().to_owned(),
        };
    }
    Ok(text)
}

/// Now, as an explanation's `updated_at` says it.
pub fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn service_context(tenant: Uuid) -> anyhow::Result<SecurityContext> {
    SecurityContext::builder()
        .subject_id(SERVICE_SUBJECT_ID)
        .subject_type("service")
        .subject_tenant_id(tenant)
        .token_scopes(vec!["*".to_owned()])
        .build()
        .map_err(|e| anyhow!("studio-product: cannot build a service context: {e}"))
}

/// The organization's explanations row, in account-management.
#[derive(Clone)]
pub struct Store {
    am: Arc<dyn AccountManagementClient>,
}

impl Store {
    pub fn new(am: Arc<dyn AccountManagementClient>) -> Self {
        Self { am }
    }

    /// Every explanation of `org` and the row's version; none and version 0
    /// before the first is written. Any other failure is an error: treating
    /// it as "empty" and writing would wipe the row.
    pub async fn read(&self, org: Uuid) -> anyhow::Result<(Explanations, i64)> {
        let ctx = service_context(org)?;
        match self
            .am
            .get_metadata(&ctx, org, GtsTypeId::new(EXPLANATIONS_METADATA_TYPE))
            .await
        {
            Ok(entry) => {
                let value = serde_json::from_value(entry.value)
                    .map_err(|e| anyhow!("the stored gear explanations are unreadable: {e}"))?;
                Ok((value, entry.version))
            }
            Err(CanonicalError::NotFound { .. }) => Ok((Explanations::default(), 0)),
            Err(e) => Err(anyhow!("cannot read the gear explanations: {e}")),
        }
    }

    /// Read, change and write back `org`'s row, version-checked so two
    /// writers do not lose each other's change. `change` may refuse; its
    /// refusal is returned and nothing is written.
    pub async fn update<R, E>(
        &self,
        org: Uuid,
        mut change: impl FnMut(&mut Explanations) -> Result<R, E>,
    ) -> anyhow::Result<Result<R, E>> {
        let ctx = service_context(org)?;
        let mut last = None;
        for _ in 0..WRITE_ATTEMPTS {
            let (mut value, version) = self.read(org).await?;
            let answer = match change(&mut value) {
                Ok(answer) => answer,
                Err(refused) => return Ok(Err(refused)),
            };
            let mut request = UpsertMetadataRequest::new(
                GtsTypeId::new(EXPLANATIONS_METADATA_TYPE),
                serde_json::to_value(&value)?,
            );
            if version > 0 {
                request = request.with_expected_version(version);
            }
            match self.am.upsert_metadata(&ctx, org, request).await {
                Ok(_) => return Ok(Ok(answer)),
                Err(e) => last = Some(e),
            }
        }
        Err(anyhow!(
            "cannot keep the gear explanations: {}",
            last.map(|e| e.to_string()).unwrap_or_default()
        ))
    }
}

#[cfg(test)]
#[path = "explanations_tests.rs"]
mod tests;
