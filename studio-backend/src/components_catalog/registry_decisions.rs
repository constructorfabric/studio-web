//! The registry's lifecycle, moved by people (ADR-0041, phase P2).
//!
//! A walk only ever writes `declared`. Everything past it is a decision an
//! organization administrator makes, through
//! `POST /registry/{name}/decisions`:
//!
//! | Action | From | To |
//! |---|---|---|
//! | `register` | candidate, declared | registered (needs an owner) |
//! | `reject` | candidate, declared | rejected (needs a reason) |
//! | `deprecate` | registered, published | deprecated (optionally `replaced_by`) |
//! | `restore` | rejected | declared, or candidate when nothing declares it |
//! | `restore` | deprecated | registered |
//! | `publish` | registered | registered, with the `contribution` it opened (ADR-0042 §4, `registry_publish.rs`) |
//! | `mark_published` | registered | published (optionally a `version`; a platform administrator) |
//! | `merge` | anything but merged | merged, folded into `merge_into` |
//! | `edit` | any | unchanged: owner, kind, category, capabilities, description |
//!
//! The platform's sync moves a contributed entry to `published` itself, as
//! a `published` decision by `platform-sync`, once the platform's catalogue
//! has it (`registry::plan`).
//!
//! Declare it (`registry_declare.rs`, P3) records a `declare` decision on a
//! candidate without moving it: the walk moves it to `declared` once the pull
//! request it opened is merged and read.
//!
//! The rules are [`transition`] and [`apply`], pure; [`repoint`] moves a
//! merged entry's occurrences onto the entry it was merged into. Every
//! decision is recorded as a `registry_decision` node joined to its entry.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::gts::{self, GtsEdge, GtsNode};
use super::registry::{
    self, EntryRecord, OccurrenceRecord, Owner, RegistryEntry, STATE_CANDIDATE, STATE_DECLARED,
    STATE_DEPRECATED, STATE_MERGED, STATE_PUBLISHED, STATE_REGISTERED, STATE_REJECTED,
};
use super::service::CatalogService;

/// What a person can do to an entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Register,
    Reject,
    Deprecate,
    Restore,
    Publish,
    MarkPublished,
    Merge,
    Edit,
}

/// Every action, as the route spells it.
pub const ACTIONS: [&str; 8] = [
    "register",
    "reject",
    "deprecate",
    "restore",
    "publish",
    "mark_published",
    "merge",
    "edit",
];

impl Action {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.trim().to_ascii_lowercase().as_str() {
            "register" => Self::Register,
            "reject" => Self::Reject,
            "deprecate" => Self::Deprecate,
            "restore" => Self::Restore,
            "publish" => Self::Publish,
            "mark_published" => Self::MarkPublished,
            "merge" => Self::Merge,
            "edit" => Self::Edit,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Register => "register",
            Self::Reject => "reject",
            Self::Deprecate => "deprecate",
            Self::Restore => "restore",
            Self::Publish => "publish",
            Self::MarkPublished => "mark_published",
            Self::Merge => "merge",
            Self::Edit => "edit",
        }
    }
}

/// The state `action` moves an entry in state `from` to, or `None` when the
/// action does not apply there. `declared_somewhere`: a repository still
/// declares the entry, which is where a restored rejection goes back to.
pub fn transition(action: Action, from: &str, declared_somewhere: bool) -> Option<&'static str> {
    match (action, from) {
        (Action::Register, STATE_CANDIDATE | STATE_DECLARED) => Some(STATE_REGISTERED),
        (Action::Reject, STATE_CANDIDATE | STATE_DECLARED) => Some(STATE_REJECTED),
        (Action::Deprecate, STATE_REGISTERED | STATE_PUBLISHED) => Some(STATE_DEPRECATED),
        (Action::Restore, STATE_REJECTED) => Some(if declared_somewhere {
            STATE_DECLARED
        } else {
            STATE_CANDIDATE
        }),
        (Action::Restore, STATE_DEPRECATED) => Some(STATE_REGISTERED),
        // Publishing opens a contribution; the platform's sync, or a
        // platform administrator's `mark_published`, makes it `published`.
        (Action::Publish, STATE_REGISTERED) => Some(STATE_REGISTERED),
        (Action::MarkPublished, STATE_REGISTERED) => Some(STATE_PUBLISHED),
        (Action::Merge, s) if s != STATE_MERGED => Some(STATE_MERGED),
        (Action::Edit, s) => registry::STATES.iter().find(|k| **k == s).copied(),
        _ => None,
    }
}

/// A decision as the route sends it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DecisionInput {
    pub action: String,
    pub reason: Option<String>,
    pub owner: Option<Owner>,
    pub kind: Option<String>,
    pub category: Option<String>,
    pub capabilities: Option<Vec<String>>,
    pub description: Option<String>,
    pub replaced_by: Option<String>,
    pub merge_into: Option<String>,
    pub version: Option<String>,
    /// For `publish`: the pull request it opened into the platform's gear
    /// repository. Set by the service after opening it, never by a request.
    pub contribution: Option<super::registry::Contribution>,
    /// For `publish` only: answer what would be written, write nothing.
    pub dry_run: bool,
}

/// Why a decision was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecisionError {
    /// The action is not one of [`ACTIONS`].
    UnknownAction(String),
    /// The request is incomplete or malformed: the field, and what is wrong.
    Invalid {
        field: &'static str,
        message: String,
    },
    /// The action does not apply to the entry's state.
    Illegal { action: String, from: String },
    /// `replaced_by` or `merge_into` names no live entry.
    UnknownEntry { field: &'static str, name: String },
    /// The entry being decided does not exist.
    NotFound(String),
}

impl std::fmt::Display for DecisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownAction(a) => write!(f, "action `{a}` is not one of {ACTIONS:?}"),
            Self::Invalid { field, message } => write!(f, "{field}: {message}"),
            Self::Illegal { action, from } => {
                write!(f, "a `{from}` entry cannot be moved by `{action}`")
            }
            Self::UnknownEntry { field, name } => {
                write!(f, "{field}: the registry has no live component `{name}`")
            }
            Self::NotFound(name) => write!(f, "the registry has no component `{name}`"),
        }
    }
}

/// What a decision changes.
#[derive(Clone, Debug, PartialEq)]
pub struct Applied {
    pub action: Action,
    pub from: String,
    pub to: String,
    /// The entry after the decision.
    pub entry: EntryRecord,
    /// For a merge: the entry merged into (its id), after it took the
    /// merged entry's name among its aliases.
    pub target: Option<(String, EntryRecord)>,
    /// What the decision said beyond its action: the fields it set.
    pub details: Value,
}

fn trimmed(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn valid_owner(owner: &Owner) -> Result<Owner, DecisionError> {
    let kind = owner.kind.trim().to_ascii_lowercase();
    if kind != "person" && kind != "team" {
        return Err(DecisionError::Invalid {
            field: "owner.kind",
            message: format!("`{}` is not `person` or `team`", owner.kind),
        });
    }
    let name = owner.name.trim();
    if name.is_empty() {
        return Err(DecisionError::Invalid {
            field: "owner.name",
            message: "an owner needs a name".to_owned(),
        });
    }
    Ok(Owner {
        kind,
        id: trimmed(&owner.id),
        name: name.to_owned(),
    })
}

/// Apply the descriptive fields a register or an edit carries. Answers
/// whether any was given.
fn describe(
    entry: &mut EntryRecord,
    input: &DecisionInput,
    details: &mut Value,
) -> Result<bool, DecisionError> {
    let mut any = false;
    if let Some(owner) = &input.owner {
        let owner = valid_owner(owner)?;
        details["owner"] = json!(owner);
        entry.owner = Some(owner);
        any = true;
    }
    if let Some(kind) = trimmed(&input.kind) {
        details["kind"] = json!(kind);
        entry.kind = kind;
        any = true;
    }
    if input.category.is_some() {
        entry.category = trimmed(&input.category);
        details["category"] = json!(entry.category);
        any = true;
    }
    if input.description.is_some() {
        entry.description = trimmed(&input.description);
        details["description"] = json!(entry.description);
        any = true;
    }
    if let Some(caps) = &input.capabilities {
        let mut seen = BTreeSet::new();
        entry.capabilities = caps
            .iter()
            .map(|c| c.trim().to_owned())
            .filter(|c| !c.is_empty() && seen.insert(c.to_ascii_lowercase()))
            .collect();
        details["capabilities"] = json!(entry.capabilities);
        any = true;
    }
    Ok(any)
}

/// What a decision does to `entry`, by the rules. Pure.
///
/// `declared_somewhere`: a repository still declares the entry.
/// `lookup` answers a live entry (id and record) by name, case-blind; a
/// `merged` entry is not live, and neither is `entry` itself as its own
/// replacement or merge target.
pub fn apply(
    entry: &EntryRecord,
    declared_somewhere: bool,
    input: &DecisionInput,
    lookup: &dyn Fn(&str) -> Option<(String, EntryRecord)>,
) -> Result<Applied, DecisionError> {
    let action = Action::parse(&input.action)
        .ok_or_else(|| DecisionError::UnknownAction(input.action.clone()))?;
    let from = entry.state.clone();
    let to =
        transition(action, &from, declared_somewhere).ok_or_else(|| DecisionError::Illegal {
            action: action.as_str().to_owned(),
            from: from.clone(),
        })?;
    let mut next = entry.clone();
    next.state = to.to_owned();
    let mut details = json!({});
    let mut target = None;
    // Another live entry by name: never this one, never a merged one.
    let other = |field: &'static str, name: &str| -> Result<(String, EntryRecord), DecisionError> {
        match lookup(name) {
            Some((id, e))
                if e.state != STATE_MERGED && !e.name.eq_ignore_ascii_case(&entry.name) =>
            {
                Ok((id, e))
            }
            _ => Err(DecisionError::UnknownEntry {
                field,
                name: name.to_owned(),
            }),
        }
    };
    match action {
        Action::Register => {
            describe(&mut next, input, &mut details)?;
            if next.owner.is_none() {
                return Err(DecisionError::Invalid {
                    field: "owner",
                    message: "registering a component names who answers for it".to_owned(),
                });
            }
        }
        Action::Reject => {
            if trimmed(&input.reason).is_none() {
                return Err(DecisionError::Invalid {
                    field: "reason",
                    message: "rejecting a component says why".to_owned(),
                });
            }
        }
        Action::Deprecate => {
            next.replaced_by = match trimmed(&input.replaced_by) {
                Some(name) => Some(other("replaced_by", &name)?.1.name),
                None => None,
            };
            details["replaced_by"] = json!(next.replaced_by);
        }
        Action::Restore => {
            next.replaced_by = None;
        }
        Action::Publish => {
            let contribution = input.contribution.clone().ok_or(DecisionError::Invalid {
                field: "action",
                message:
                    "publishing opens a pull request into the platform's gear repository first"
                        .to_owned(),
            })?;
            details["contribution"] = json!(contribution);
            next.contribution = Some(contribution);
        }
        Action::MarkPublished => {
            next.version = trimmed(&input.version);
            details["version"] = json!(next.version);
        }
        Action::Merge => {
            let name = trimmed(&input.merge_into).ok_or(DecisionError::Invalid {
                field: "merge_into",
                message: "a merge names the entry to fold into".to_owned(),
            })?;
            let (id, mut into) = other("merge_into", &name)?;
            // The merged entry's name and every name it carried are the
            // target's now, once each, and never the target's own.
            for alias in std::iter::once(&entry.name).chain(entry.aliases.iter()) {
                if !alias.eq_ignore_ascii_case(&into.name)
                    && !into.aliases.iter().any(|a| a.eq_ignore_ascii_case(alias))
                {
                    into.aliases.push(alias.clone());
                }
            }
            if declared_somewhere {
                into.orphaned = false;
            }
            next.merged_into = Some(into.name.clone());
            next.aliases = Vec::new();
            // Its occurrences are the target's now; a merged entry is not
            // one "no repository declares any more".
            next.orphaned = false;
            details["merge_into"] = json!(into.name);
            target = Some((id, into));
        }
        Action::Edit => {
            if !describe(&mut next, input, &mut details)? {
                return Err(DecisionError::Invalid {
                    field: "action",
                    message: "an edit changes at least one of owner, kind, category, capabilities or description".to_owned(),
                });
            }
        }
    }
    Ok(Applied {
        action,
        from,
        to: to.to_owned(),
        entry: next,
        target,
        details,
    })
}

/// The occurrences of the merged entry `source_id`, re-pointed onto
/// `target_id`: the nodes to write under the target, the edges joining them
/// to it, and the ids to retire. Pure.
pub fn repoint(
    source_id: &str,
    target_id: &str,
    target_name: &str,
    occurrences: &[(String, OccurrenceRecord)],
) -> (Vec<GtsNode>, Vec<GtsEdge>, Vec<String>) {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut retire = Vec::new();
    for (id, occ) in occurrences.iter().filter(|(_, o)| o.entry_id == source_id) {
        let project = occ.project_id.map(|p| p.to_string()).unwrap_or_default();
        let new_id = gts::occurrence_instance_id(target_id, &project, &occ.repo, &occ.path);
        let mut moved = occ.clone();
        moved.entry = target_name.to_owned();
        moved.entry_id = target_id.to_owned();
        if let Ok(value) = serde_json::to_value(&moved) {
            edges.push(gts::found_in_edge(target_id, &new_id));
            nodes.push(gts::occurrence_node(new_id.clone(), value));
        }
        if *id != new_id {
            retire.push(id.clone());
        }
    }
    (nodes, edges, retire)
}

/// One decision, as stored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DecisionRecord {
    pub organization_id: Uuid,
    /// The entry's name when it was decided.
    pub entry: String,
    pub entry_id: String,
    pub action: String,
    pub from: String,
    pub to: String,
    /// The person who decided: their Studio id, else the token's subject.
    pub by: String,
    #[serde(default)]
    pub by_name: Option<String>,
    /// RFC 3339.
    pub at: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub details: Value,
}

/// A decision as a node under a fresh id, and the edge joining it to its
/// entry. `None` when it does not serialize.
pub(super) fn decision_node(record: DecisionRecord) -> Option<(GtsNode, GtsEdge)> {
    let id = Uuid::new_v4().to_string();
    let edge = gts::decided_edge(&record.entry_id, &id);
    let value = serde_json::to_value(record).ok()?;
    Some((gts::registry_decision_node(id, value), edge))
}

/// Who decides.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decider {
    pub id: String,
    pub name: Option<String>,
}

/// Decisions newest first. `at` is RFC 3339, compared as a time, so
/// `…:05Z` and `…:05.5Z` order right.
pub fn newest_first(mut decisions: Vec<DecisionRecord>) -> Vec<DecisionRecord> {
    use time::format_description::well_known::Rfc3339;
    let key = |d: &DecisionRecord| time::OffsetDateTime::parse(&d.at, &Rfc3339).ok();
    decisions.sort_by(|a, b| key(b).cmp(&key(a)).then_with(|| b.at.cmp(&a.at)));
    decisions
}

/// A decision refused by the rules, or a store that failed.
#[derive(Debug)]
pub enum DecideFailure {
    Refused(DecisionError),
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for DecideFailure {
    fn from(e: anyhow::Error) -> Self {
        Self::Failed(e)
    }
}

impl CatalogService {
    /// The decisions made about one entry (by its instance id), newest first.
    pub async fn registry_decisions(
        &self,
        ctx: &SecurityContext,
        entry_id: &str,
    ) -> anyhow::Result<Vec<DecisionRecord>> {
        let org = ctx.subject_tenant_id();
        Ok(newest_first(
            registry::records::<DecisionRecord>(
                self.sink
                    .list(ctx, Some(gts::REGISTRY_DECISION_TYPE))
                    .await?,
            )
            .into_iter()
            .map(|(_, d)| d)
            .filter(|d| d.organization_id == org && d.entry_id == entry_id)
            .collect(),
        ))
    }

    /// One entry with its decisions, by name (case-blind).
    pub async fn registry_entry_with_decisions(
        &self,
        ctx: &SecurityContext,
        name: &str,
    ) -> anyhow::Result<Option<(RegistryEntry, Vec<DecisionRecord>)>> {
        let Some(entry) = self.registry_entry(ctx, name).await? else {
            return Ok(None);
        };
        let id = gts::registry_entry_instance_id(
            &ctx.subject_tenant_id().to_string(),
            &entry.entry.name,
        );
        let decisions = self.registry_decisions(ctx, &id).await?;
        Ok(Some((entry, decisions)))
    }

    /// Make one decision about the entry `name`, as `by`: check it against
    /// the rules, write the entry (and for a merge the target and the
    /// re-pointed occurrences), and record it. Answers the entry after it,
    /// with its decisions. Whether `by` may decide at all is the caller's
    /// question (the route asks studio-user).
    pub async fn decide_registry(
        &self,
        ctx: &SecurityContext,
        name: &str,
        input: &DecisionInput,
        by: &Decider,
    ) -> Result<(RegistryEntry, Vec<DecisionRecord>), DecideFailure> {
        self.sink.register_types(ctx).await?;
        let org = ctx.subject_tenant_id();
        let org_s = org.to_string();
        let entries: Vec<(String, EntryRecord)> = registry::records::<EntryRecord>(
            self.sink.list(ctx, Some(gts::REGISTRY_ENTRY_TYPE)).await?,
        )
        .into_iter()
        .filter(|(_, e)| e.organization_id == org)
        .collect();
        let wanted = name.trim();
        let (source_id, source) = entries
            .iter()
            .find(|(_, e)| e.name.eq_ignore_ascii_case(wanted))
            .cloned()
            .ok_or_else(|| DecideFailure::Refused(DecisionError::NotFound(wanted.to_owned())))?;
        let occurrences: Vec<(String, OccurrenceRecord)> = registry::records::<OccurrenceRecord>(
            self.sink.list(ctx, Some(gts::OCCURRENCE_TYPE)).await?,
        )
        .into_iter()
        .filter(|(_, o)| o.organization_id == org)
        .collect();
        let declared_somewhere = occurrences
            .iter()
            .any(|(_, o)| o.entry_id == source_id && !o.detected());
        let lookup = |n: &str| {
            entries
                .iter()
                .find(|(_, e)| e.name.eq_ignore_ascii_case(n.trim()))
                .cloned()
        };
        let applied =
            apply(&source, declared_somewhere, input, &lookup).map_err(DecideFailure::Refused)?;

        let at = registry::now();
        let mut nodes = vec![GtsNode {
            type_id: gts::REGISTRY_ENTRY_TYPE,
            instance_id: source_id.clone(),
            value: serde_json::to_value(&applied.entry).map_err(anyhow::Error::from)?,
        }];
        let mut edges = Vec::new();
        let mut retire = Vec::new();
        let reason = trimmed(&input.reason);
        let mut record =
            |entry_id: &str, entry_name: &str, from: &str, to: &str, details: Value| {
                if let Some((node, edge)) = decision_node(DecisionRecord {
                    organization_id: org,
                    entry: entry_name.to_owned(),
                    entry_id: entry_id.to_owned(),
                    action: applied.action.as_str().to_owned(),
                    from: from.to_owned(),
                    to: to.to_owned(),
                    by: by.id.clone(),
                    by_name: by.name.clone(),
                    at: at.clone(),
                    reason: reason.clone(),
                    details,
                }) {
                    edges.push(edge);
                    nodes.push(node);
                }
            };
        record(
            &source_id,
            &source.name,
            &applied.from,
            &applied.to,
            applied.details.clone(),
        );
        if let Some((target_id, target)) = &applied.target {
            // The target hears of it too: its history says what it absorbed.
            record(
                target_id,
                &target.name,
                &target.state,
                &target.state,
                json!({ "merged_from": source.name }),
            );
            nodes.push(GtsNode {
                type_id: gts::REGISTRY_ENTRY_TYPE,
                instance_id: target_id.clone(),
                value: serde_json::to_value(target).map_err(anyhow::Error::from)?,
            });
            let (moved, joined, gone) = repoint(&source_id, target_id, &target.name, &occurrences);
            nodes.extend(moved);
            edges.extend(joined);
            retire.extend(gone);
        }
        self.sink.upsert(ctx, &nodes, &edges).await?;
        for id in &retire {
            if let Err(e) = self.sink.delete(ctx, id).await {
                tracing::warn!(instance_id = %id, error = %format!("{e:#}"), "components-catalog: registry: a merged occurrence could not be retired");
            }
        }
        tracing::info!(organization_id = %org_s, entry = %source.name, action = applied.action.as_str(), from = %applied.from, to = %applied.to, "components-catalog: registry decision");
        self.registry_entry_with_decisions(ctx, &source.name)
            .await?
            .ok_or_else(|| DecideFailure::Refused(DecisionError::NotFound(source.name.clone())))
    }
}

#[cfg(test)]
#[path = "registry_decisions_tests.rs"]
mod tests;
