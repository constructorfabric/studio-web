//! The one write a screen needs: a batch of changes to domain objects and
//! their relations, in the order given (ADR-0051 §5–6).
//!
//! Beside `POST /query`, this is what makes a screen data rather than code: a
//! form saves with one request, whatever types and relations it touches, and
//! every change goes through the same checks as the routes it replaces —
//! the model (types, fields, declared relations) and the PDP (ADR-0035).
//!
//! An object created in the batch can be named by later operations: `as:
//! "r1"` on the upsert, `"$r1"` where an id goes. The batch is checked before
//! anything is written — operation names, types, references to names not yet
//! given — and then applied in order. The graph has no transactions, so a
//! failure part-way leaves what was applied before it; the error says which
//! operation failed and how many went in.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use toolkit_security::SecurityContext;

use super::service::{DomainModelService, WriteOptions};
use super::validate::ValidateMode;

/// How many operations one batch may carry. Each is a graph write of its
/// own, so this bounds what one request costs.
pub const MAX_OPERATIONS: usize = 500;

/// The prefix that names an object created earlier in the batch.
const NAMED: char = '$';

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
pub enum Operation {
    /// Create or replace the object of `type` keyed by `key`.
    Upsert {
        #[serde(rename = "type")]
        type_ref: String,
        key: String,
        #[serde(default)]
        project_id: Option<String>,
        #[serde(default)]
        value: Map<String, Value>,
        /// Refuse when the object exists instead of replacing it.
        #[serde(default)]
        if_absent: bool,
        /// A name later operations use for this object's id.
        #[serde(default, rename = "as")]
        alias: Option<String>,
    },
    /// Change some fields and keep the rest.
    Patch {
        id: String,
        #[serde(default)]
        set: Map<String, Value>,
        #[serde(default)]
        unset: Vec<String>,
    },
    Delete {
        id: String,
    },
    /// Relate two objects by a declared relation (`project.tracks`).
    Link {
        relation: String,
        from: String,
        to: String,
    },
    Unlink {
        relation: String,
        from: String,
        to: String,
    },
}

/// A batch the model or the caller's own request refuses.
#[derive(Debug)]
pub enum MutateError {
    /// Nothing was written.
    Invalid(String),
    /// Operations before `index` were applied; this one failed.
    Failed {
        index: usize,
        applied: usize,
        cause: anyhow::Error,
    },
}

/// What each operation did, in order.
#[derive(Debug, Clone)]
pub struct Applied {
    pub results: Vec<Value>,
}

fn names(op: &Operation) -> Vec<&str> {
    match op {
        Operation::Upsert { .. } => Vec::new(),
        Operation::Patch { id, .. } | Operation::Delete { id } => vec![id.as_str()],
        Operation::Link { from, to, .. } | Operation::Unlink { from, to, .. } => {
            vec![from.as_str(), to.as_str()]
        }
    }
}

/// Every check that needs no write: the batch's size, its names, and the
/// types it upserts.
async fn check(
    service: &DomainModelService,
    ctx: &SecurityContext,
    ops: &[Operation],
) -> Result<(), MutateError> {
    if ops.is_empty() {
        return Err(MutateError::Invalid("`operations` is empty".to_string()));
    }
    if ops.len() > MAX_OPERATIONS {
        return Err(MutateError::Invalid(format!(
            "a batch carries at most {MAX_OPERATIONS} operations, not {}",
            ops.len()
        )));
    }
    let mut given: Vec<&str> = Vec::new();
    for (i, op) in ops.iter().enumerate() {
        for name in names(op) {
            if let Some(n) = name.strip_prefix(NAMED)
                && !given.contains(&n)
            {
                return Err(MutateError::Invalid(format!(
                    "operation {i} names `{name}`, which no earlier upsert gave with `as`"
                )));
            }
        }
        if let Operation::Upsert {
            type_ref,
            key,
            alias,
            project_id,
            ..
        } = op
        {
            if key.trim().is_empty() {
                return Err(MutateError::Invalid(format!(
                    "operation {i}: `key` is empty"
                )));
            }
            // What a project-scoped grant is matched against, as on `POST /objects`.
            if let Some(p) = project_id
                && uuid::Uuid::parse_str(p.trim()).is_err()
            {
                return Err(MutateError::Invalid(format!(
                    "operation {i}: `project_id` is a project's tenant id, not `{p}`"
                )));
            }
            if !service
                .knows_type(ctx, type_ref)
                .await
                .map_err(|e| MutateError::Failed {
                    index: i,
                    applied: 0,
                    cause: e,
                })?
            {
                return Err(MutateError::Invalid(format!(
                    "operation {i}: unknown domain type `{type_ref}`"
                )));
            }
            if let Some(a) = alias {
                if given.contains(&a.as_str()) {
                    return Err(MutateError::Invalid(format!(
                        "operation {i}: `as: {a}` is already given"
                    )));
                }
                given.push(a);
            }
        }
    }
    Ok(())
}

fn resolve<'a>(id: &'a str, aliases: &'a HashMap<String, String>) -> &'a str {
    id.strip_prefix(NAMED)
        .and_then(|n| aliases.get(n))
        .map_or(id, String::as_str)
}

/// Check the batch, then apply it in order.
pub async fn run(
    service: &DomainModelService,
    ctx: &SecurityContext,
    ops: Vec<Operation>,
    validate: ValidateMode,
) -> Result<Applied, MutateError> {
    check(service, ctx, &ops).await?;
    let mut aliases: HashMap<String, String> = HashMap::new();
    let mut results = Vec::with_capacity(ops.len());
    for (index, op) in ops.into_iter().enumerate() {
        let failed = |cause: anyhow::Error| MutateError::Failed {
            index,
            applied: index,
            cause,
        };
        let result = match op {
            Operation::Upsert {
                type_ref,
                key,
                project_id,
                value,
                if_absent,
                alias,
            } => {
                let options = WriteOptions {
                    scope: project_id.as_deref(),
                    if_absent,
                    validate,
                };
                let created = service
                    .create_object(ctx, &type_ref, &key, options, Value::Object(value))
                    .await
                    .map_err(failed)?;
                if let Some(a) = alias {
                    aliases.insert(a, created.instance_id.clone());
                }
                json!({
                    "op": "upsert",
                    "id": created.instance_id,
                    "type_id": created.type_id,
                    "violations": created.report.violations.iter().map(|v| json!({"field": v.field, "detail": v.detail})).collect::<Vec<_>>(),
                })
            }
            Operation::Patch { id, set, unset } => {
                let id = resolve(&id, &aliases).to_string();
                let patched = service
                    .patch_object(ctx, &id, set, &unset, validate)
                    .await
                    .map_err(failed)?;
                json!({
                    "op": "patch",
                    "id": patched.instance_id,
                    "violations": patched.report.violations.iter().map(|v| json!({"field": v.field, "detail": v.detail})).collect::<Vec<_>>(),
                })
            }
            Operation::Delete { id } => {
                let id = resolve(&id, &aliases).to_string();
                service.delete_object(ctx, &id).await.map_err(failed)?;
                json!({"op": "delete", "id": id})
            }
            Operation::Link { relation, from, to } => {
                let (from, to) = (resolve(&from, &aliases), resolve(&to, &aliases));
                let created = service
                    .create_relation(ctx, &relation, from, to)
                    .await
                    .map_err(failed)?;
                json!({
                    "op": "link",
                    "relation": created.name,
                    "verb": created.verb,
                    "from": from,
                    "to": to,
                })
            }
            Operation::Unlink { relation, from, to } => {
                let (from, to) = (resolve(&from, &aliases), resolve(&to, &aliases));
                let removed = service
                    .delete_relation(ctx, &relation, from, to)
                    .await
                    .map_err(failed)?;
                json!({"op": "unlink", "from": from, "to": to, "removed": removed})
            }
        };
        results.push(result);
    }
    Ok(Applied { results })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use uuid::Uuid;

    use super::*;
    use crate::domain_model::query::Query;
    use crate::domain_model::store::InMemoryDomainStore;

    fn ctx() -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(1))
            .subject_tenant_id(Uuid::from_u128(1))
            .token_scopes(vec!["*".to_string()])
            .build()
            .expect("test security context")
    }

    fn ops(v: Value) -> Vec<Operation> {
        serde_json::from_value(v).expect("operations")
    }

    async fn names_of(s: &DomainModelService, ty: &str) -> Vec<String> {
        let q = Query {
            type_ref: ty.to_string(),
            selection: serde_json::from_value(json!({"order_by": [{"field": "name"}]})).unwrap(),
            ..Default::default()
        };
        s.query(&ctx(), &q)
            .await
            .unwrap()
            .rows
            .items
            .iter()
            .map(|r| r.value["name"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    #[tokio::test]
    async fn one_batch_creates_relates_patches_and_deletes() {
        let s = DomainModelService::new(Arc::new(InMemoryDomainStore::default()));
        let applied = run(
            &s,
            &ctx(),
            ops(json!([
                {"op": "upsert", "type": "team", "key": "core", "value": {"name": "Core"}, "as": "core"},
                {"op": "upsert", "type": "project", "key": "apollo", "value": {"name": "Apollo", "status": "active"}, "as": "apollo"},
                {"op": "upsert", "type": "project", "key": "gemini", "value": {"name": "Gemini"}, "as": "gemini"},
                {"op": "link", "relation": "team.delivers", "from": "$core", "to": "$apollo"},
                {"op": "link", "relation": "team.delivers", "from": "$core", "to": "$gemini"},
                {"op": "patch", "id": "$gemini", "set": {"status": "paused"}},
                {"op": "unlink", "relation": "team.delivers", "from": "$core", "to": "$gemini"},
                {"op": "delete", "id": "$apollo"},
            ])),
            ValidateMode::Off,
        )
        .await
        .unwrap_or_else(|e| panic!("{e:?}"));
        assert_eq!(applied.results.len(), 8);
        assert_eq!(applied.results[6]["removed"], json!(true));
        assert_eq!(
            names_of(&s, "project").await,
            vec!["Gemini"],
            "the deleted one is gone"
        );

        let q = Query {
            type_ref: "team".to_string(),
            selection: serde_json::from_value(json!({"include": {"delivers": {}}})).unwrap(),
            ..Default::default()
        };
        let out = s.query(&ctx(), &q).await.unwrap();
        assert_eq!(out.rows.items[0].relations["delivers"].total, 0);

        let q = Query {
            type_ref: "project".to_string(),
            selection: serde_json::from_value(json!({"where": {"status": {"_eq": "paused"}}}))
                .unwrap(),
            ..Default::default()
        };
        assert_eq!(
            s.query(&ctx(), &q).await.unwrap().rows.total,
            1,
            "the patch kept the name and set the status"
        );
    }

    #[tokio::test]
    async fn a_deleted_object_comes_back_when_written_again() {
        let s = DomainModelService::new(Arc::new(InMemoryDomainStore::default()));
        for batch in [
            json!([{"op": "upsert", "type": "team", "key": "core", "value": {"name": "Core"}, "as": "t"},
                   {"op": "delete", "id": "$t"}]),
            json!([{"op": "upsert", "type": "team", "key": "core", "value": {"name": "Core again"}}]),
        ] {
            run(&s, &ctx(), ops(batch), ValidateMode::Off)
                .await
                .unwrap_or_else(|e| panic!("{e:?}"));
        }
        assert_eq!(names_of(&s, "team").await, vec!["Core again"]);
    }

    #[tokio::test]
    async fn a_batch_is_checked_before_anything_is_written() {
        let s = DomainModelService::new(Arc::new(InMemoryDomainStore::default()));
        for (batch, says) in [
            (json!([]), "empty"),
            (
                json!([{"op": "upsert", "type": "team", "key": "a", "value": {}},
                       {"op": "upsert", "type": "no-such-type", "key": "b", "value": {}}]),
                "unknown domain type",
            ),
            (
                json!([{"op": "upsert", "type": "team", "key": "a", "value": {}},
                       {"op": "delete", "id": "$later"},
                       {"op": "upsert", "type": "team", "key": "b", "value": {}, "as": "later"}]),
                "no earlier upsert",
            ),
        ] {
            match run(&s, &ctx(), ops(batch), ValidateMode::Off).await {
                Err(MutateError::Invalid(m)) => assert!(m.contains(says), "{m}"),
                other => panic!("expected a refusal naming `{says}`, got {other:?}"),
            }
        }
        assert!(names_of(&s, "team").await.is_empty(), "nothing was written");
    }

    #[tokio::test]
    async fn a_failure_part_way_says_where_and_what_went_in() {
        let s = DomainModelService::new(Arc::new(InMemoryDomainStore::default()));
        let batch = json!([
            {"op": "upsert", "type": "team", "key": "a", "value": {"name": "A"}},
            {"op": "patch", "id": "no-such-object", "set": {"name": "B"}},
        ]);
        match run(&s, &ctx(), ops(batch), ValidateMode::Off).await {
            Err(MutateError::Failed { index, applied, .. }) => {
                assert_eq!((index, applied), (1, 1));
            }
            other => panic!("expected a failure at 1, got {other:?}"),
        }
        assert_eq!(names_of(&s, "team").await, vec!["A"]);
    }

    #[tokio::test]
    async fn a_type_added_to_the_model_takes_objects_and_fields_at_once() {
        use crate::domain_model::ontology::{EntitySpec, FieldSpec};
        let s = DomainModelService::new(Arc::new(InMemoryDomainStore::default()));
        s.add_type(
            &ctx(),
            EntitySpec {
                id: "team-space".to_string(),
                name: "Team space".to_string(),
                extends: Some("managed-object".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        s.add_field(
            &ctx(),
            "team-space",
            FieldSpec {
                name: "cost_center".to_string(),
                type_name: "string".to_string(),
                description: None,
                required: false,
            },
        )
        .await
        .unwrap();
        run(
            &s,
            &ctx(),
            ops(json!([{"op": "upsert", "type": "team-space", "key": "w", "value": {"name": "Labs", "cost_center": "CC-7"}}])),
            ValidateMode::Warn,
        )
        .await
        .unwrap_or_else(|e| panic!("{e:?}"));
        let q = Query {
            type_ref: "team-space".to_string(),
            selection: serde_json::from_value(json!({"where": {"cost_center": {"_eq": "CC-7"}}}))
                .unwrap(),
            ..Default::default()
        };
        assert_eq!(s.query(&ctx(), &q).await.unwrap().rows.total, 1);
        for bad in ["Team space", "2nd", "work_space", "managed-object"] {
            let e = s
                .add_type(
                    &ctx(),
                    EntitySpec {
                        id: bad.to_string(),
                        ..Default::default()
                    },
                )
                .await
                .unwrap_err();
            assert!(e.to_string().contains(bad), "{e}");
        }
    }

    #[tokio::test]
    async fn a_patch_answers_for_the_fields_it_touches() {
        let s = DomainModelService::new(Arc::new(InMemoryDomainStore::default()));
        // A project missing most of what its type requires.
        let batch = json!([
            {"op": "upsert", "type": "project", "key": "p", "value": {"name": "P"}, "as": "p"},
            {"op": "patch", "id": "$p", "set": {"status": "active"}},
            {"op": "patch", "id": "$p", "set": {"status": "done"}},
        ]);
        let applied = run(&s, &ctx(), ops(batch), ValidateMode::Warn)
            .await
            .unwrap_or_else(|e| panic!("{e:?}"));
        assert!(
            applied.results[0]["violations"]
                .as_array()
                .is_some_and(|v| !v.is_empty()),
            "the upsert still reports what the whole object lacks"
        );
        assert_eq!(
            applied.results[1]["violations"],
            json!([]),
            "{}",
            applied.results[1]
        );
        let fields: Vec<&str> = applied.results[2]["violations"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v["field"].as_str())
            .collect();
        assert_eq!(fields, ["status"], "{}", applied.results[2]);
    }

    #[tokio::test]
    async fn the_store_keeps_its_own_fields() {
        let s = DomainModelService::new(Arc::new(InMemoryDomainStore::default()));
        let batch = json!([
            {"op": "upsert", "type": "team", "key": "a", "value": {"name": "A"}, "as": "a"},
            {"op": "patch", "id": "$a", "set": {"_scope": "elsewhere"}},
        ]);
        match run(&s, &ctx(), ops(batch), ValidateMode::Off).await {
            Err(MutateError::Failed { cause, .. }) => {
                assert!(cause.to_string().contains("kept by the store"))
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }
}
