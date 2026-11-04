//! What `studio-environments` keeps in its own tables (ADR-0062): a project's
//! immutable slug, the namespace it was given in each environment, its image
//! and chart records, and their retention. Every row is keyed by the
//! organization (`tenant_col`), resolved by the caller from the project, never
//! taken from the tenant a request acts in.
//!
//! PostgreSQL only, like every gear table here (studio-backend/AGENTS.md).

use sea_orm::{ActiveValue, ColumnTrait, Condition, EntityTrait, Order};
use toolkit_db::Db;
use toolkit_db::secure::{SecureEntityExt, SecureInsertExt, SecureOnConflict, SecureUpdateExt};
use toolkit_security::AccessScope;
use uuid::Uuid;

use super::images::{ImageKind, ImageRecord, ImageState, Retention};

pub mod slug {
    use sea_orm::entity::prelude::*;
    use toolkit_db::secure::Scopable;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_env_project_slugs")]
    #[secure(tenant_col = "organization_id", no_owner, no_type, no_resource)]
    pub struct Model {
        pub organization_id: Uuid,
        #[sea_orm(primary_key, auto_increment = false)]
        pub project_id: Uuid,
        pub slug: String,
        pub created_at_ms: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_env_project_slugs has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod namespace {
    use sea_orm::entity::prelude::*;
    use toolkit_db::secure::Scopable;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_env_namespaces")]
    #[secure(tenant_col = "organization_id", no_owner, no_type, no_resource)]
    pub struct Model {
        pub organization_id: Uuid,
        #[sea_orm(primary_key, auto_increment = false)]
        pub project_id: Uuid,
        #[sea_orm(primary_key, auto_increment = false)]
        pub environment_id: Uuid,
        pub cluster_connection_id: Uuid,
        pub namespace: String,
        pub build_namespace: String,
        pub assigned_by: String,
        pub assigned_at_ms: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_env_namespaces has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod image {
    use sea_orm::entity::prelude::*;
    use toolkit_db::secure::Scopable;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_env_images")]
    #[secure(tenant_col = "organization_id", resource_col = "id", no_owner, no_type)]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub organization_id: Uuid,
        pub project_id: Uuid,
        pub registry_connection_id: Option<Uuid>,
        pub registry_host: String,
        pub repository: String,
        /// A JSON array of strings.
        #[sea_orm(column_type = "Text")]
        pub tags: String,
        pub digest: String,
        pub media_type: Option<String>,
        pub size_bytes: Option<i64>,
        /// A JSON array of strings.
        #[sea_orm(column_type = "Text")]
        pub platforms: String,
        pub build_id: Option<String>,
        pub app: Option<String>,
        pub commit_sha: Option<String>,
        pub description_revision: Option<i64>,
        pub lock_hash: Option<String>,
        pub pushed_by: Option<String>,
        pub pushed_at_ms: i64,
        pub kind: String,
        pub state: String,
        pub pinned: bool,
        pub promoted_from: Option<Uuid>,
        pub source_ref: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_env_images has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod retention {
    use sea_orm::entity::prelude::*;
    use toolkit_db::secure::Scopable;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel, Scopable)]
    #[sea_orm(table_name = "studio_env_image_retention")]
    #[secure(tenant_col = "organization_id", no_owner, no_type, no_resource)]
    pub struct Model {
        pub organization_id: Uuid,
        #[sea_orm(primary_key, auto_increment = false)]
        pub scope_id: Uuid,
        pub keep_last: Option<i32>,
        pub keep_days: Option<i32>,
        pub updated_by: String,
        pub updated_at_ms: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {}

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            unreachable!("studio_env_image_retention has no relations")
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

/// The namespace a project was given in one environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assignment {
    pub project_id: Uuid,
    pub environment_id: Uuid,
    pub cluster_connection_id: Uuid,
    pub namespace: String,
    pub build_namespace: String,
    pub assigned_by: String,
    pub assigned_at_ms: i64,
}

impl From<namespace::Model> for Assignment {
    fn from(m: namespace::Model) -> Self {
        Self {
            project_id: m.project_id,
            environment_id: m.environment_id,
            cluster_connection_id: m.cluster_connection_id,
            namespace: m.namespace,
            build_namespace: m.build_namespace,
            assigned_by: m.assigned_by,
            assigned_at_ms: m.assigned_at_ms,
        }
    }
}

/// What an assignment came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Assigned {
    /// Recorded now, or recorded before with the same namespace.
    Kept(Assignment),
    /// Another project holds that namespace on that cluster.
    Taken,
}

fn strings(text: &str) -> Vec<String> {
    serde_json::from_str(text).unwrap_or_default()
}

fn json(list: &[String]) -> String {
    serde_json::to_string(list).unwrap_or_else(|_| "[]".into())
}

impl From<image::Model> for ImageRecord {
    fn from(m: image::Model) -> Self {
        Self {
            id: m.id,
            organization_id: m.organization_id,
            project_id: m.project_id,
            registry_connection_id: m.registry_connection_id,
            registry_host: m.registry_host,
            repository: m.repository,
            tags: strings(&m.tags),
            digest: m.digest,
            media_type: m.media_type,
            size_bytes: m.size_bytes,
            platforms: strings(&m.platforms),
            build_id: m.build_id,
            app: m.app,
            commit: m.commit_sha,
            description_revision: m.description_revision,
            lock_hash: m.lock_hash,
            pushed_by: m.pushed_by,
            pushed_at_ms: m.pushed_at_ms,
            kind: ImageKind::parse(&m.kind).unwrap_or(ImageKind::Image),
            state: ImageState::parse(&m.state).unwrap_or(ImageState::Present),
            pinned: m.pinned,
            promoted_from: m.promoted_from,
            source_ref: m.source_ref,
        }
    }
}

fn row(r: &ImageRecord) -> image::ActiveModel {
    image::ActiveModel {
        id: ActiveValue::Set(r.id),
        organization_id: ActiveValue::Set(r.organization_id),
        project_id: ActiveValue::Set(r.project_id),
        registry_connection_id: ActiveValue::Set(r.registry_connection_id),
        registry_host: ActiveValue::Set(r.registry_host.clone()),
        repository: ActiveValue::Set(r.repository.clone()),
        tags: ActiveValue::Set(json(&r.tags)),
        digest: ActiveValue::Set(r.digest.clone()),
        media_type: ActiveValue::Set(r.media_type.clone()),
        size_bytes: ActiveValue::Set(r.size_bytes),
        platforms: ActiveValue::Set(json(&r.platforms)),
        build_id: ActiveValue::Set(r.build_id.clone()),
        app: ActiveValue::Set(r.app.clone()),
        commit_sha: ActiveValue::Set(r.commit.clone()),
        description_revision: ActiveValue::Set(r.description_revision),
        lock_hash: ActiveValue::Set(r.lock_hash.clone()),
        pushed_by: ActiveValue::Set(r.pushed_by.clone()),
        pushed_at_ms: ActiveValue::Set(r.pushed_at_ms),
        kind: ActiveValue::Set(r.kind.as_str().to_owned()),
        state: ActiveValue::Set(r.state.as_str().to_owned()),
        pinned: ActiveValue::Set(r.pinned),
        promoted_from: ActiveValue::Set(r.promoted_from),
        source_ref: ActiveValue::Set(r.source_ref.clone()),
    }
}

/// Which of a project's records a list asks for.
#[derive(Debug, Clone, Default)]
pub struct ImageFilter {
    pub app: Option<String>,
    pub kind: Option<ImageKind>,
    pub state: Option<ImageState>,
    pub build_id: Option<String>,
}

pub fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default(),
    )
    .unwrap_or(i64::MAX)
}

pub struct Records {
    db: Db,
}

impl Records {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /* ── slugs ── */

    /// The project's slug, made from `name` the first time and kept from
    /// then on. A slug another project took gets `-2`, `-3`, … and at last
    /// a piece of the project's id.
    pub async fn slug(&self, org: Uuid, project: Uuid, name: &str) -> anyhow::Result<String> {
        if let Some(s) = self.slug_of(org, project).await? {
            return Ok(s);
        }
        let base = super::model::slug(name);
        let base = if base.is_empty() {
            "project".to_owned()
        } else {
            // Room for a suffix inside a namespace's 63, with `-build` and an
            // environment after it.
            base.chars()
                .take(30)
                .collect::<String>()
                .trim_end_matches('-')
                .to_owned()
        };
        let short: String = project.simple().to_string().chars().take(8).collect();
        let tries = std::iter::once(base.clone())
            .chain((2..=9).map(|n| format!("{base}-{n}")))
            .chain(std::iter::once(format!("{base}-{short}")));
        let conn = self.db.conn()?;
        for candidate in tries {
            let made = slug::ActiveModel {
                organization_id: ActiveValue::Set(org),
                project_id: ActiveValue::Set(project),
                slug: ActiveValue::Set(candidate.clone()),
                created_at_ms: ActiveValue::Set(now_ms()),
            };
            let inserted = slug::Entity::insert(made)
                .secure()
                .scope_unchecked(&AccessScope::for_tenant(org))?
                .exec(&conn)
                .await;
            match inserted {
                Ok(_) => return Ok(candidate),
                // The project's own row, made by a request racing this one.
                Err(_) => {
                    if let Some(s) = self.slug_of(org, project).await? {
                        return Ok(s);
                    }
                }
            }
        }
        anyhow::bail!("no slug could be made for project {project}")
    }

    pub async fn slug_of(&self, org: Uuid, project: Uuid) -> anyhow::Result<Option<String>> {
        let conn = self.db.conn()?;
        Ok(slug::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .filter(Condition::all().add(slug::Column::ProjectId.eq(project)))
            .one(&conn)
            .await?
            .map(|m| m.slug))
    }

    /// Every slug of the organization's projects, `(slug, project)`.
    pub async fn slugs(&self, org: Uuid) -> anyhow::Result<Vec<(String, Uuid)>> {
        let conn = self.db.conn()?;
        Ok(slug::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .all(&conn)
            .await?
            .into_iter()
            .map(|m| (m.slug, m.project_id))
            .collect())
    }

    /* ── namespace assignments ── */

    pub async fn assignment(
        &self,
        org: Uuid,
        project: Uuid,
        environment: Uuid,
    ) -> anyhow::Result<Option<Assignment>> {
        let conn = self.db.conn()?;
        Ok(namespace::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .filter(
                Condition::all()
                    .add(namespace::Column::ProjectId.eq(project))
                    .add(namespace::Column::EnvironmentId.eq(environment)),
            )
            .one(&conn)
            .await?
            .map(Assignment::from))
    }

    pub async fn assignments(&self, org: Uuid) -> anyhow::Result<Vec<Assignment>> {
        let conn = self.db.conn()?;
        Ok(namespace::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .order_by(namespace::Column::AssignedAtMs, Order::Asc)
            .all(&conn)
            .await?
            .into_iter()
            .map(Assignment::from)
            .collect())
    }

    /// Record `a` unless the project has one there already, which is kept
    /// (`replace` replaces it: an administrator's assignment). A namespace
    /// another project holds on the same cluster is [`Assigned::Taken`].
    pub async fn assign(
        &self,
        org: Uuid,
        a: &Assignment,
        replace: bool,
    ) -> anyhow::Result<Assigned> {
        if !replace && let Some(had) = self.assignment(org, a.project_id, a.environment_id).await? {
            return Ok(Assigned::Kept(had));
        }
        let made = namespace::ActiveModel {
            organization_id: ActiveValue::Set(org),
            project_id: ActiveValue::Set(a.project_id),
            environment_id: ActiveValue::Set(a.environment_id),
            cluster_connection_id: ActiveValue::Set(a.cluster_connection_id),
            namespace: ActiveValue::Set(a.namespace.clone()),
            build_namespace: ActiveValue::Set(a.build_namespace.clone()),
            assigned_by: ActiveValue::Set(a.assigned_by.clone()),
            assigned_at_ms: ActiveValue::Set(a.assigned_at_ms),
        };
        let on_conflict = SecureOnConflict::<namespace::Entity>::columns([
            namespace::Column::ProjectId,
            namespace::Column::EnvironmentId,
        ])
        .update_columns([
            namespace::Column::ClusterConnectionId,
            namespace::Column::Namespace,
            namespace::Column::BuildNamespace,
            namespace::Column::AssignedBy,
            namespace::Column::AssignedAtMs,
        ])?;
        let conn = self.db.conn()?;
        let inserted = namespace::Entity::insert(made)
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(org))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await;
        match inserted {
            Ok(_) => Ok(Assigned::Kept(a.clone())),
            // The unique (cluster, namespace) index: another project's.
            Err(_) => match self.assignment(org, a.project_id, a.environment_id).await? {
                Some(had) if had.namespace == a.namespace => Ok(Assigned::Kept(had)),
                _ => Ok(Assigned::Taken),
            },
        }
    }

    /* ── images ── */

    /// Record `r`, or merge it into the record of the same digest in the
    /// same repository: its tags joined, what it says filled in, its state
    /// back to present. The record kept is returned.
    pub async fn record_image(&self, r: &ImageRecord) -> anyhow::Result<ImageRecord> {
        let org = r.organization_id;
        if let Some(mut had) = self
            .image_by_digest(org, &r.registry_host, &r.repository, &r.digest)
            .await?
        {
            for t in &r.tags {
                if !had.tags.contains(t) {
                    had.tags.push(t.clone());
                }
            }
            had.build_id = had.build_id.or_else(|| r.build_id.clone());
            had.app = had.app.or_else(|| r.app.clone());
            had.commit = had.commit.or_else(|| r.commit.clone());
            had.description_revision = had.description_revision.or(r.description_revision);
            had.lock_hash = had.lock_hash.or_else(|| r.lock_hash.clone());
            had.media_type = had.media_type.or_else(|| r.media_type.clone());
            had.size_bytes = had.size_bytes.or(r.size_bytes);
            had.registry_connection_id = had.registry_connection_id.or(r.registry_connection_id);
            if matches!(had.state, ImageState::Missing | ImageState::Deleted) {
                had.state = ImageState::Present;
            }
            self.update_image(&had).await?;
            return Ok(had);
        }
        let conn = self.db.conn()?;
        image::Entity::insert(row(r))
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(org))?
            .exec(&conn)
            .await?;
        Ok(r.clone())
    }

    async fn update_image(&self, r: &ImageRecord) -> anyhow::Result<()> {
        let conn = self.db.conn()?;
        toolkit_db::secure::secure_update_with_scope::<image::Entity>(
            row(r),
            &AccessScope::for_tenant(r.organization_id),
            r.id,
            &conn,
        )
        .await?;
        Ok(())
    }

    pub async fn image_by_digest(
        &self,
        org: Uuid,
        host: &str,
        repository: &str,
        digest: &str,
    ) -> anyhow::Result<Option<ImageRecord>> {
        let conn = self.db.conn()?;
        Ok(image::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .filter(
                Condition::all()
                    .add(image::Column::RegistryHost.eq(host))
                    .add(image::Column::Repository.eq(repository))
                    .add(image::Column::Digest.eq(digest)),
            )
            .one(&conn)
            .await?
            .map(ImageRecord::from))
    }

    /// One record of `project`; `None` when it is another project's.
    pub async fn image(
        &self,
        org: Uuid,
        project: Uuid,
        id: Uuid,
    ) -> anyhow::Result<Option<ImageRecord>> {
        let conn = self.db.conn()?;
        Ok(image::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .filter(
                Condition::all()
                    .add(image::Column::Id.eq(id))
                    .add(image::Column::ProjectId.eq(project)),
            )
            .one(&conn)
            .await?
            .map(ImageRecord::from))
    }

    /// The project's records, newest first: `limit` from `offset`, and how
    /// many there are.
    pub async fn images(
        &self,
        org: Uuid,
        project: Uuid,
        f: &ImageFilter,
        offset: u64,
        limit: u64,
    ) -> anyhow::Result<(Vec<ImageRecord>, u64)> {
        let mut cond = Condition::all().add(image::Column::ProjectId.eq(project));
        if let Some(app) = &f.app {
            cond = cond.add(image::Column::App.eq(app.clone()));
        }
        if let Some(kind) = f.kind {
            cond = cond.add(image::Column::Kind.eq(kind.as_str()));
        }
        if let Some(state) = f.state {
            cond = cond.add(image::Column::State.eq(state.as_str()));
        }
        if let Some(b) = &f.build_id {
            cond = cond.add(image::Column::BuildId.eq(b.clone()));
        }
        let conn = self.db.conn()?;
        let all = image::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .filter(cond)
            .order_by(image::Column::PushedAtMs, Order::Desc)
            .all(&conn)
            .await?;
        let total = all.len() as u64;
        Ok((
            all.into_iter()
                .skip(usize::try_from(offset).unwrap_or(usize::MAX))
                .take(usize::try_from(limit).unwrap_or(usize::MAX))
                .map(ImageRecord::from)
                .collect(),
            total,
        ))
    }

    /// Every record of the organization on `host`: what its registry browser
    /// compares the registry with.
    pub async fn images_on(&self, org: Uuid, host: &str) -> anyhow::Result<Vec<ImageRecord>> {
        let conn = self.db.conn()?;
        Ok(image::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .filter(Condition::all().add(image::Column::RegistryHost.eq(host)))
            .all(&conn)
            .await?
            .into_iter()
            .map(ImageRecord::from)
            .collect())
    }

    /// Every record of the organization.
    pub async fn org_images(&self, org: Uuid) -> anyhow::Result<Vec<ImageRecord>> {
        let conn = self.db.conn()?;
        Ok(image::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .order_by(image::Column::PushedAtMs, Order::Desc)
            .all(&conn)
            .await?
            .into_iter()
            .map(ImageRecord::from)
            .collect())
    }

    pub async fn set_pinned(&self, org: Uuid, id: Uuid, pinned: bool) -> anyhow::Result<()> {
        use sea_orm::sea_query::Expr;
        let conn = self.db.conn()?;
        image::Entity::update_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .filter(Condition::all().add(image::Column::Id.eq(id)))
            .col_expr(image::Column::Pinned, Expr::value(pinned))
            .exec(&conn)
            .await?;
        Ok(())
    }

    pub async fn set_state(&self, org: Uuid, id: Uuid, state: ImageState) -> anyhow::Result<()> {
        use sea_orm::sea_query::Expr;
        let conn = self.db.conn()?;
        image::Entity::update_many()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .filter(Condition::all().add(image::Column::Id.eq(id)))
            .col_expr(image::Column::State, Expr::value(state.as_str()))
            .exec(&conn)
            .await?;
        Ok(())
    }

    /* ── retention ── */

    /// The policy of `scope` (a project, or the organization itself).
    pub async fn retention(&self, org: Uuid, scope: Uuid) -> anyhow::Result<Option<Retention>> {
        let conn = self.db.conn()?;
        Ok(retention::Entity::find()
            .secure()
            .scope_with(&AccessScope::for_tenant(org))
            .filter(Condition::all().add(retention::Column::ScopeId.eq(scope)))
            .one(&conn)
            .await?
            .map(|m| Retention {
                keep_last: m.keep_last.and_then(|n| u32::try_from(n).ok()),
                keep_days: m.keep_days.and_then(|n| u32::try_from(n).ok()),
            }))
    }

    pub async fn put_retention(
        &self,
        org: Uuid,
        scope: Uuid,
        r: Retention,
        by: &str,
    ) -> anyhow::Result<()> {
        let made = retention::ActiveModel {
            organization_id: ActiveValue::Set(org),
            scope_id: ActiveValue::Set(scope),
            keep_last: ActiveValue::Set(r.keep_last.and_then(|n| i32::try_from(n).ok())),
            keep_days: ActiveValue::Set(r.keep_days.and_then(|n| i32::try_from(n).ok())),
            updated_by: ActiveValue::Set(by.to_owned()),
            updated_at_ms: ActiveValue::Set(now_ms()),
        };
        let on_conflict =
            SecureOnConflict::<retention::Entity>::columns([retention::Column::ScopeId])
                .update_columns([
                    retention::Column::KeepLast,
                    retention::Column::KeepDays,
                    retention::Column::UpdatedBy,
                    retention::Column::UpdatedAtMs,
                ])?;
        let conn = self.db.conn()?;
        retention::Entity::insert(made)
            .secure()
            .scope_unchecked(&AccessScope::for_tenant(org))?
            .on_conflict(on_conflict)
            .exec(&conn)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "records_tests.rs"]
mod tests;
