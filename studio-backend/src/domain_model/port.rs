//! What the domain model offers another gear in the assembly: write an object
//! by key, and read a type's objects. The reports gear mirrors a roadmap
//! plan's units, teams, people and memberships through it.
//!
//! Narrow on purpose. Both calls go through the same path as `POST /objects`
//! and `GET /objects` -- the caller's `SecurityContext`, the PDP's answer for
//! `domain.edit` and `domain.view` (ADR-0035), validation in `warn` -- so a
//! gear can do through here exactly what its caller could do over REST, and
//! nothing more.
//!
//! A gear whose own records move into the model (ADR-0051: the process
//! catalogue first) also writes and reads them in one tenant's scope, deletes
//! them, and makes sure the model has the type and fields they need
//! ([`DomainObjects::ensure_type`]) -- the one model change offered, and only
//! ever additive.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use toolkit_security::SecurityContext;

use super::ontology::{EntitySpec, FieldSpec};
use super::service::{DomainModelService, WriteOptions};
use super::validate::ValidateMode;

/// A type a gear needs in the model, with the fields it writes.
#[derive(Clone, Debug, Default)]
pub struct TypeNeed {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The type it extends, when it has to be created.
    pub extends: Option<String>,
    pub bucket: Option<String>,
    /// `(name, type expression, description)` of each field.
    pub fields: Vec<(String, String, String)>,
    /// `(name, target entity, verb)` of each relation the type declares.
    pub relations: Vec<(String, String, String)>,
    /// The gear that keeps this type's objects: the generic object writes
    /// refuse them (ADR-0051 §8a). `None` leaves the type open.
    pub held_by: Option<String>,
    /// Whether people search these records by meaning: a held type is not
    /// embedded otherwise — an embedding costs memory and time on every
    /// write, and a deployment or a budget is found by its fields.
    pub searchable: bool,
}

/// One object a gear writes with its own id.
#[derive(Clone, Debug)]
pub struct OwnedObject {
    pub id: String,
    /// The tenant it belongs to (a project, a workspace); empty is the
    /// organization.
    pub scope: String,
    pub payload: Value,
}

/// One stored object.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredObject {
    pub instance_id: String,
    pub payload: Value,
}

#[async_trait]
pub trait DomainObjects: Send + Sync {
    /// Create or replace the object of `entity` (`team`, `org-unit`, …) keyed
    /// by `key`, organization-wide. Answers its instance id, the same for the
    /// same key every time.
    async fn upsert(
        &self,
        ctx: &SecurityContext,
        entity: &str,
        key: &str,
        payload: Value,
    ) -> anyhow::Result<String>;

    /// The objects of `entity` the caller may read.
    async fn list(&self, ctx: &SecurityContext, entity: &str) -> anyhow::Result<Vec<StoredObject>>;

    /// Create or replace the object of `entity` keyed by `key` in one
    /// tenant's scope (`scope` is its id: a project, a workspace, an
    /// organization). Written unchecked: the gear owns the shape.
    async fn upsert_in(
        &self,
        _ctx: &SecurityContext,
        _entity: &str,
        _key: &str,
        _scope: &str,
        _payload: Value,
    ) -> anyhow::Result<String> {
        anyhow::bail!("scoped writes are not offered here")
    }

    /// The objects of `entity` in one tenant's scope the caller may read.
    async fn list_in(
        &self,
        _ctx: &SecurityContext,
        _entity: &str,
        _scope: &str,
    ) -> anyhow::Result<Vec<StoredObject>> {
        anyhow::bail!("scoped reads are not offered here")
    }

    /// Delete an object (it is marked, see `store::DELETED_FIELD`).
    async fn delete(&self, _ctx: &SecurityContext, _instance_id: &str) -> anyhow::Result<()> {
        anyhow::bail!("deletes are not offered here")
    }

    /// Make sure the caller's model has the type and its fields, adding what
    /// is missing. Never changes or removes what is there.
    async fn ensure_type(&self, _ctx: &SecurityContext, _need: &TypeNeed) -> anyhow::Result<()> {
        anyhow::bail!("model changes are not offered here")
    }

    /// Store Studio's own model for the caller's organization and register
    /// its types: what a new organization gets before anything is written in
    /// it. A model already stored only gains the Studio types it lacks.
    async fn prepare_model(&self, _ctx: &SecurityContext) -> anyhow::Result<()> {
        Ok(())
    }

    /// Write a gear's objects of `entity` under the ids it chose, in batches
    /// (ADR-0051 §8a): the target scheme, where the gear keeps no store of
    /// its own.
    async fn put_objects(
        &self,
        _ctx: &SecurityContext,
        _entity: &str,
        _objects: Vec<OwnedObject>,
    ) -> anyhow::Result<usize> {
        anyhow::bail!("batch writes are not offered here")
    }

    /// Create one object only if its id is free: `false` when it is taken.
    /// A gear serializes concurrent writers with it.
    async fn claim(
        &self,
        _ctx: &SecurityContext,
        _entity: &str,
        _id: &str,
        _payload: Value,
    ) -> anyhow::Result<bool> {
        anyhow::bail!("claims are not offered here")
    }

    /// Delete a gear's objects by id; writing an id again brings it back.
    async fn remove_objects(
        &self,
        _ctx: &SecurityContext,
        _entity: &str,
        _ids: Vec<String>,
    ) -> anyhow::Result<usize> {
        anyhow::bail!("batch deletes are not offered here")
    }

    /// Relate a gear's objects: `(source entity, relation, from id, to id)`.
    /// Answers `(written, skipped)`; an edge whose end is missing is skipped.
    async fn link_objects(
        &self,
        _ctx: &SecurityContext,
        _links: Vec<(String, String, String, String)>,
    ) -> anyhow::Result<(usize, usize)> {
        anyhow::bail!("batch links are not offered here")
    }

    /// Run a query (the body `POST /query` takes) without the screen's page
    /// bound, answering the rows as stored objects and how many matched.
    async fn query(
        &self,
        _ctx: &SecurityContext,
        _body: Value,
    ) -> anyhow::Result<(Vec<StoredObject>, usize)> {
        anyhow::bail!("queries are not offered here")
    }

    /// Every type of the tenant's model, and whether it is abstract.
    async fn entity_types(&self, _ctx: &SecurityContext) -> anyhow::Result<Vec<(String, bool)>> {
        Ok(Vec::new())
    }

    /// The relations of `names` in the tenant, as `(relation, from, to)`.
    async fn relations(
        &self,
        _ctx: &SecurityContext,
        _names: &[&str],
    ) -> anyhow::Result<Vec<(String, String, String)>> {
        anyhow::bail!("relation reads are not offered here")
    }

    /// Objects of `entities` the text finds, best first, with their node type.
    async fn search(
        &self,
        _ctx: &SecurityContext,
        _text: &str,
        _entities: &[&str],
        _limit: u32,
    ) -> anyhow::Result<Vec<(String, StoredObject)>> {
        Ok(Vec::new())
    }
}

/// The domain model's answer to [`DomainObjects`].
pub struct Objects(pub Arc<DomainModelService>);

/// Whether `e` is the domain-object PDP refusing the caller, or a gear's
/// record refusing a generic write: a 403, not a failure.
pub fn is_refusal(e: &anyhow::Error) -> bool {
    super::access::access_error(e).is_some_and(|a| {
        matches!(
            a,
            super::access::AccessError::Denied | super::access::AccessError::Held(_)
        )
    })
}

/// The port over a model kept in memory: what another gear's tests write to
/// and query, with the real query and write rules.
#[cfg(test)]
pub fn in_memory() -> Arc<dyn DomainObjects> {
    Arc::new(Objects(Arc::new(DomainModelService::new(Arc::new(
        super::store::InMemoryDomainStore::default(),
    )))))
}

#[async_trait]
impl DomainObjects for Objects {
    async fn upsert(
        &self,
        ctx: &SecurityContext,
        entity: &str,
        key: &str,
        payload: Value,
    ) -> anyhow::Result<String> {
        let options = WriteOptions {
            scope: None,
            if_absent: false,
            validate: ValidateMode::Warn,
        };
        Ok(self
            .0
            .create_object(ctx, entity, key, options, payload)
            .await?
            .instance_id)
    }

    async fn list(&self, ctx: &SecurityContext, entity: &str) -> anyhow::Result<Vec<StoredObject>> {
        Ok(self
            .0
            .list_objects(ctx, Some(entity), None)
            .await?
            .into_iter()
            .map(|n| StoredObject {
                instance_id: n.instance_id,
                payload: n.value,
            })
            .collect())
    }

    async fn upsert_in(
        &self,
        ctx: &SecurityContext,
        entity: &str,
        key: &str,
        scope: &str,
        payload: Value,
    ) -> anyhow::Result<String> {
        let options = WriteOptions {
            scope: Some(scope),
            if_absent: false,
            validate: ValidateMode::Off,
        };
        Ok(self
            .0
            .create_object(ctx, entity, key, options, payload)
            .await?
            .instance_id)
    }

    async fn list_in(
        &self,
        ctx: &SecurityContext,
        entity: &str,
        scope: &str,
    ) -> anyhow::Result<Vec<StoredObject>> {
        Ok(self
            .0
            .list_objects(ctx, Some(entity), Some(scope))
            .await?
            .into_iter()
            .map(|n| StoredObject {
                instance_id: n.instance_id,
                payload: n.value,
            })
            .collect())
    }

    async fn delete(&self, ctx: &SecurityContext, instance_id: &str) -> anyhow::Result<()> {
        self.0.delete_object(ctx, instance_id).await
    }

    async fn prepare_model(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
        self.0.prepare_model(ctx).await
    }

    async fn ensure_type(&self, ctx: &SecurityContext, need: &TypeNeed) -> anyhow::Result<()> {
        if let Some(gear) = &need.held_by {
            crate::data_places::held(gear, &need.id);
        }
        if !self.0.knows_type(ctx, &need.id).await? {
            self.0
                .add_type(
                    ctx,
                    EntitySpec {
                        id: need.id.clone(),
                        name: need.name.clone(),
                        description: Some(need.description.clone()).filter(|d| !d.is_empty()),
                        bucket: need.bucket.clone(),
                        extends: need.extends.clone(),
                        origin: Some("studio".to_string()),
                    },
                )
                .await?;
        }
        // Fields, relations and the gear's hold in one model version: a gear
        // taking in a type of twenty fields is one change, not twenty-two.
        let fields: Vec<FieldSpec> = need
            .fields
            .iter()
            .map(|(name, type_name, description)| FieldSpec {
                name: name.clone(),
                type_name: type_name.clone(),
                description: Some(description.clone()).filter(|d| !d.is_empty()),
                required: false,
            })
            .collect();
        let hold = need.held_by.clone().map(|gear| {
            (
                gear,
                need.fields.iter().map(|f| f.0.clone()).collect(),
                need.searchable,
            )
        });
        self.0
            .take_in(ctx, &need.id, &fields, &need.relations, hold)
            .await?;
        Ok(())
    }

    async fn put_objects(
        &self,
        ctx: &SecurityContext,
        entity: &str,
        objects: Vec<OwnedObject>,
    ) -> anyhow::Result<usize> {
        self.0
            .put_objects_trusted(
                ctx,
                entity,
                objects
                    .into_iter()
                    .map(|o| (o.id, o.scope, o.payload))
                    .collect(),
            )
            .await
    }

    async fn remove_objects(
        &self,
        ctx: &SecurityContext,
        entity: &str,
        ids: Vec<String>,
    ) -> anyhow::Result<usize> {
        self.0.remove_objects_trusted(ctx, entity, ids).await
    }

    async fn link_objects(
        &self,
        ctx: &SecurityContext,
        links: Vec<(String, String, String, String)>,
    ) -> anyhow::Result<(usize, usize)> {
        self.0.link_objects_trusted(ctx, links).await
    }

    async fn query(
        &self,
        ctx: &SecurityContext,
        body: Value,
    ) -> anyhow::Result<(Vec<StoredObject>, usize)> {
        let q = super::query::Query::from_json(body).map_err(|e| anyhow::anyhow!(e))?;
        let out = self.0.query_bulk(ctx, &q).await.map_err(|e| match e {
            super::query::QueryError::Invalid(m) => anyhow::anyhow!(m),
            super::query::QueryError::Failed(e) => e,
        })?;
        Ok((
            out.rows
                .items
                .into_iter()
                .map(|r| StoredObject {
                    instance_id: r.id,
                    payload: r.value,
                })
                .collect(),
            out.rows.total,
        ))
    }

    async fn relations(
        &self,
        ctx: &SecurityContext,
        names: &[&str],
    ) -> anyhow::Result<Vec<(String, String, String)>> {
        self.0.relations_named(ctx, names).await
    }

    async fn entity_types(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<(String, bool)>> {
        self.0.entity_kinds(ctx).await
    }

    async fn claim(
        &self,
        ctx: &SecurityContext,
        entity: &str,
        id: &str,
        payload: Value,
    ) -> anyhow::Result<bool> {
        self.0.claim_trusted(ctx, entity, id, payload).await
    }

    async fn search(
        &self,
        ctx: &SecurityContext,
        text: &str,
        entities: &[&str],
        limit: u32,
    ) -> anyhow::Result<Vec<(String, StoredObject)>> {
        Ok(self
            .0
            .search_objects(ctx, text, entities, limit)
            .await?
            .into_iter()
            .map(|n| {
                (
                    n.type_id,
                    StoredObject {
                        instance_id: n.instance_id,
                        payload: n.value,
                    },
                )
            })
            .collect())
    }
}
