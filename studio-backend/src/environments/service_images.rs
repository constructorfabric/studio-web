//! Images in two contexts (ADR-0062 §4, §5): a project's own records -- what
//! its builds published or it imported, where each runs, pin, delete,
//! promote, retention -- and an organization's registries as they are,
//! compared with the records. A project sees only its own `project_id`; the
//! organization's routes need `environment.manage`.

use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{EnvironmentService, Refusal, Result, service_context};
use crate::connectors::sdk as connectors;
use crate::environments::build;
use crate::environments::image_tasks::{self, ImageOp, Side};
use crate::environments::images::{
    self, ImageKind, ImageRecord, ImageState, Orphan, Reference, RegistryVersion, Retention,
};
use crate::environments::images_sink::Published;
use crate::environments::model::{Deployment, DeploymentList, Environment};
use crate::environments::records::{Assigned, Assignment, ImageFilter, now_ms};
use crate::environments::{DEPLOYMENTS_METADATA_TYPE, ENVIRONMENTS_METADATA_TYPE};

/// Where a record runs: one live release that uses it.
#[derive(Debug, Clone)]
pub struct RunsIn {
    pub environment_id: Uuid,
    pub environment_name: String,
    pub deployment_id: Uuid,
    pub namespace: String,
    pub deployed_at: String,
}

/// A record and where it runs.
pub type Placed = (ImageRecord, Vec<RunsIn>);

/// One registry an organization's environments use.
#[derive(Debug, Clone)]
pub struct OrgRegistry {
    pub connection_id: Uuid,
    pub label: String,
    pub host: String,
    pub kind: String,
    pub prefixes: Vec<String>,
    /// `(id, name)`.
    pub environments: Vec<(Uuid, String)>,
    /// `push`, `pull` or `push_pull`.
    pub role: String,
}

/// One repository of a registry, as the organization sees it.
#[derive(Debug, Clone)]
pub struct OrgRepository {
    pub name: String,
    pub project_id: Option<Uuid>,
    pub project_name: Option<String>,
    pub recorded: usize,
}

/// One version of a repository, with its record when there is one.
#[derive(Debug, Clone)]
pub struct OrgVersion {
    pub version: connectors::CatalogVersion,
    pub image_id: Option<Uuid>,
    pub project_id: Option<Uuid>,
    pub running_in: Vec<RunsIn>,
}

/// A retention policy and where it comes from.
#[derive(Debug, Clone)]
pub struct RetentionOf {
    pub scope: &'static str,
    pub policy: Retention,
    /// The project has none of its own: the organization's applies.
    pub inherited: bool,
}

/// Whose retention policy a request names.
#[derive(Debug, Clone, Copy)]
pub enum RetentionScope {
    Organization(Uuid),
    Project(Uuid),
}

fn runs_in(r: &ImageRecord, live: &[Deployment]) -> Vec<RunsIn> {
    live.iter()
        .filter(|d| images::runs(r, d))
        .map(|d| RunsIn {
            environment_id: d.environment_id,
            environment_name: d.environment_name.clone(),
            deployment_id: d.id,
            namespace: d.namespace.clone(),
            deployed_at: d
                .decided_at
                .clone()
                .unwrap_or_else(|| d.requested_at.clone()),
        })
        .collect()
}

fn internal(e: anyhow::Error) -> Refusal {
    Refusal::Internal(format!("{e:#}"))
}

/// `acme/shop/api` of project `shop` → `api`: a repository's path inside the
/// project's own, so a promotion keeps it under the other registry's.
fn inside_project(repository: &str, slug: &str) -> String {
    let marker = format!("/{slug}/");
    match repository.find(&marker) {
        Some(at) => repository[at + marker.len()..].to_owned(),
        None => repository
            .rsplit('/')
            .next()
            .unwrap_or(repository)
            .to_owned(),
    }
}

impl EnvironmentService {
    /// The releases that run now in the organization.
    async fn live(&self, org: Uuid) -> Result<Vec<Deployment>> {
        let svc = service_context(org).map_err(internal)?;
        let (history, _) = self
            .store
            .read::<DeploymentList>(&svc, org, DEPLOYMENTS_METADATA_TYPE)
            .await?;
        Ok(images::live_deployments(&history.items)
            .into_iter()
            .cloned()
            .collect())
    }

    /* ── a project's images ── */

    pub async fn images(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        filter: &ImageFilter,
        cursor: Option<&str>,
        limit: u64,
    ) -> Result<(Vec<Placed>, u64, Option<String>)> {
        let records = self.records_or_unavailable()?;
        let org = self.organization_of_project(ctx, project).await?;
        let offset: u64 = match cursor {
            None | Some("") => 0,
            Some(c) => c
                .parse()
                .map_err(|_| Refusal::Invalid(format!("'{c}' is not a cursor this list gave")))?,
        };
        let limit = limit.clamp(1, 200);
        let (list, total) = records
            .images(org, project, filter, offset, limit)
            .await
            .map_err(internal)?;
        let live = self.live(org).await?;
        let next = (offset + (list.len() as u64) < total).then(|| (offset + limit).to_string());
        Ok((
            list.into_iter()
                .map(|r| {
                    let runs = runs_in(&r, &live);
                    (r, runs)
                })
                .collect(),
            total,
            next,
        ))
    }

    async fn own_image(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        id: Uuid,
    ) -> Result<(Uuid, ImageRecord)> {
        let records = self.records_or_unavailable()?;
        let org = self.organization_of_project(ctx, project).await?;
        let r = records
            .image(org, project, id)
            .await
            .map_err(internal)?
            .ok_or_else(|| {
                Refusal::NotFound(
                    id.to_string(),
                    format!("project {project} has no image {id}"),
                )
            })?;
        Ok((org, r))
    }

    pub async fn image(&self, ctx: &SecurityContext, project: Uuid, id: Uuid) -> Result<Placed> {
        let (org, r) = self.own_image(ctx, project, id).await?;
        let live = self.live(org).await?;
        let runs = runs_in(&r, &live);
        Ok((r, runs))
    }

    pub async fn pin_image(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        id: Uuid,
        pinned: bool,
    ) -> Result<Placed> {
        let (org, _) = self.own_image(ctx, project, id).await?;
        self.records_or_unavailable()?
            .set_pinned(org, id, pinned)
            .await
            .map_err(internal)?;
        self.image(ctx, project, id).await
    }

    /// Delete a record's digest from its registry: refused while it runs or
    /// is pinned. 202 with the run.
    pub async fn delete_image(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        id: Uuid,
    ) -> Result<Uuid> {
        let (org, r) = self.own_image(ctx, project, id).await?;
        if r.pinned {
            return Err(Refusal::Conflict(
                "IMAGE_PINNED",
                format!("{} is pinned: unpin it first", r.reference()),
            ));
        }
        let live = self.live(org).await?;
        let runs = runs_in(&r, &live);
        if let Some(at) = runs.first() {
            return Err(Refusal::Conflict(
                "IMAGE_RUNNING",
                format!(
                    "{} runs in {} ({}): deploy something else there first",
                    r.reference(),
                    at.environment_name,
                    at.namespace
                ),
            ));
        }
        let connection_id = r.registry_connection_id.ok_or_else(|| {
            Refusal::Precondition(
                "IMAGE_REGISTRY_UNKNOWN",
                "Studio does not know which registry connection pushed this image, so it cannot \
                 delete it"
                    .into(),
            )
        })?;
        let op = ImageOp::Delete {
            organization_id: org,
            image_id: Some(r.id),
            side: Side {
                connection_id: Some(connection_id),
                from: org,
                host: r.registry_host.clone(),
                repository: r.repository.clone(),
            },
            digest: r.digest.clone(),
        };
        self.enqueue_image(org, &op, &format!("delete:{}", r.id))
            .await
    }

    async fn enqueue_image(&self, org: Uuid, op: &ImageOp, key: &str) -> Result<Uuid> {
        build::enqueue(
            &self.hub,
            org,
            image_tasks::TASK_TYPE,
            serde_json::to_value(op).map_err(anyhow::Error::from)?,
            &format!("images:{org}"),
            &format!("{key}:{}", Uuid::new_v4()),
        )
        .await
        .map_err(|e| Refusal::Unavailable(format!("the image run could not be queued: {e:#}")))
    }

    /// The registry an environment pushes to, and the project's path in it.
    async fn project_registry(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
        environment: Uuid,
    ) -> Result<(Environment, Uuid, String)> {
        let env = self
            .project_environment(ctx, org, project, environment)
            .await?;
        let connection = env.registry_connection_id.ok_or_else(|| {
            Refusal::Precondition(
                "ENVIRONMENT_HAS_NO_REGISTRY",
                format!("environment '{}' has no registry login", env.name),
            )
        })?;
        let place = self.place(ctx, org, project, &env).await?;
        Ok((env, connection, place.prefix))
    }

    /// Copy a record by digest into another environment's registry, under
    /// the project's path there. 202 with the run and the new record's id.
    pub async fn promote_image(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        id: Uuid,
        environment: Uuid,
    ) -> Result<(Uuid, Uuid)> {
        let (org, r) = self.own_image(ctx, project, id).await?;
        let source_connection = r.registry_connection_id.ok_or_else(|| {
            Refusal::Precondition(
                "IMAGE_REGISTRY_UNKNOWN",
                "Studio does not know which registry connection pushed this image".into(),
            )
        })?;
        let (env, connection, prefix) = self
            .project_registry(ctx, org, project, environment)
            .await?;
        let slug = self.slug(ctx, org, project).await?;
        let (host, path) = prefix.split_once('/').unwrap_or((prefix.as_str(), ""));
        let repository = format!("{path}/{}", inside_project(&r.repository, &slug));
        if host == r.registry_host && repository == r.repository {
            return Err(Refusal::Invalid(format!(
                "{} is in environment '{}''s registry already",
                r.reference(),
                env.name
            )));
        }
        let person = self.person(ctx).await;
        let made = ImageRecord {
            id: Uuid::new_v4(),
            registry_connection_id: Some(connection),
            registry_host: host.to_owned(),
            repository: repository.clone(),
            pushed_by: Some(person.id),
            pushed_at_ms: now_ms(),
            state: ImageState::Present,
            pinned: false,
            promoted_from: Some(r.id),
            ..r.clone()
        };
        let reference = r.digest.clone();
        let op = ImageOp::Copy {
            organization_id: org,
            source: Side {
                connection_id: Some(source_connection),
                from: org,
                host: r.registry_host.clone(),
                repository: r.repository.clone(),
            },
            reference,
            dest: Side {
                connection_id: Some(connection),
                from: env.connections_from(org),
                host: host.to_owned(),
                repository,
            },
            tags: r.tags.clone(),
            record: Box::new(made.clone()),
        };
        let run = self
            .enqueue_image(org, &op, &format!("promote:{}", r.id))
            .await?;
        Ok((run, made.id))
    }

    /// Import an external image (or an OCI chart) into the project's own
    /// path, `<prefix>/<slug>/mirror/<name>`, copied by digest with where it
    /// came from recorded. 202 with the run and the record's id.
    pub async fn import_image(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        environment: Uuid,
        source: &str,
        name: Option<&str>,
        kind: ImageKind,
    ) -> Result<(Uuid, Uuid)> {
        self.records_or_unavailable()?;
        let org = self.organization_of_project(ctx, project).await?;
        let src = Reference::parse(source).ok_or_else(|| {
            Refusal::Invalid(format!(
                "'{source}' is not an image reference, e.g. docker.io/library/postgres:16"
            ))
        })?;
        if src.tag.is_none() && src.digest.is_none() {
            return Err(Refusal::Invalid(format!(
                "'{source}' names no tag or digest: say which version to import"
            )));
        }
        let name = match name.map(str::trim).filter(|n| !n.is_empty()) {
            Some(n) => images::checked_mirror_name(n).map_err(Refusal::Invalid)?,
            None => images::default_mirror_name(&src),
        };
        let (env, connection, prefix) = self
            .project_registry(ctx, org, project, environment)
            .await?;
        let (host, path) = prefix.split_once('/').unwrap_or((prefix.as_str(), ""));
        let sub = match kind {
            ImageKind::Image => name.clone(),
            ImageKind::Chart => format!("charts/{name}"),
        };
        let repository = format!("{path}/mirror/{sub}");
        let tags: Vec<String> = src.tag.clone().into_iter().collect();
        let person = self.person(ctx).await;
        let made = ImageRecord {
            id: Uuid::new_v4(),
            organization_id: org,
            project_id: project,
            registry_connection_id: Some(connection),
            registry_host: host.to_owned(),
            repository: repository.clone(),
            tags: tags.clone(),
            digest: String::new(),
            media_type: None,
            size_bytes: None,
            platforms: Vec::new(),
            build_id: None,
            app: Some(name),
            commit: None,
            description_revision: None,
            lock_hash: None,
            pushed_by: Some(person.id),
            pushed_at_ms: now_ms(),
            kind,
            state: ImageState::Present,
            pinned: false,
            promoted_from: None,
            source_ref: Some(src.to_text()),
        };
        let op = ImageOp::Copy {
            organization_id: org,
            source: Side {
                connection_id: None,
                from: org,
                host: src.host.clone(),
                repository: src.repository.clone(),
            },
            reference: src
                .digest
                .clone()
                .or(src.tag.clone())
                .unwrap_or_else(|| "latest".into()),
            dest: Side {
                connection_id: Some(connection),
                from: env.connections_from(org),
                host: host.to_owned(),
                repository,
            },
            tags,
            record: Box::new(made.clone()),
        };
        let run = self
            .enqueue_image(org, &op, &format!("import:{project}"))
            .await?;
        Ok((run, made.id))
    }

    /* ── retention ── */

    pub async fn retention(
        &self,
        ctx: &SecurityContext,
        scope: RetentionScope,
    ) -> Result<RetentionOf> {
        let records = self.records_or_unavailable()?;
        match scope {
            RetentionScope::Organization(org) => Ok(RetentionOf {
                scope: "organization",
                policy: records
                    .retention(org, org)
                    .await
                    .map_err(internal)?
                    .unwrap_or_default(),
                inherited: false,
            }),
            RetentionScope::Project(project) => {
                let org = self.organization_of_project(ctx, project).await?;
                match records.retention(org, project).await.map_err(internal)? {
                    Some(p) => Ok(RetentionOf {
                        scope: "project",
                        policy: p,
                        inherited: false,
                    }),
                    None => Ok(RetentionOf {
                        scope: "project",
                        policy: records
                            .retention(org, org)
                            .await
                            .map_err(internal)?
                            .unwrap_or_default(),
                        inherited: true,
                    }),
                }
            }
        }
    }

    pub async fn put_retention(
        &self,
        ctx: &SecurityContext,
        scope: RetentionScope,
        policy: Retention,
    ) -> Result<RetentionOf> {
        let records = self.records_or_unavailable()?;
        let policy = images::checked_retention(policy).map_err(Refusal::Invalid)?;
        let (org, id) = match scope {
            RetentionScope::Organization(org) => {
                self.require_manage(ctx, org).await?;
                (org, org)
            }
            RetentionScope::Project(project) => {
                (self.organization_of_project(ctx, project).await?, project)
            }
        };
        let by = self.person(ctx).await.id;
        records
            .put_retention(org, id, policy, &by)
            .await
            .map_err(internal)?;
        self.keep_sweeping_images(org).await;
        self.retention(ctx, scope).await
    }

    async fn keep_sweeping_images(&self, org: Uuid) {
        let Ok(schedules) = self.hub.get::<dyn crate::scheduler::port::Schedules>() else {
            tracing::warn!("studio-environments: no scheduler here; images are swept only by hand");
            return;
        };
        let Ok(svc) = service_context(org) else {
            return;
        };
        if let Err(e) = schedules
            .ensure(
                &svc,
                crate::scheduler::port::ScheduleSpec {
                    name: format!("Sweep the images of {org} by their retention"),
                    task_type: image_tasks::SWEEP_TASK_TYPE,
                    payload: serde_json::json!({ "organization_id": org }),
                    cron: image_tasks::SWEEP_CRON.to_owned(),
                    enabled: true,
                },
            )
            .await
        {
            tracing::warn!(error = ?e, organization = %org, "studio-environments: the image sweep could not be scheduled");
        }
    }

    /* ── an organization's registries ── */

    async fn org_environments(&self, ctx: &SecurityContext, org: Uuid) -> Result<Vec<Environment>> {
        let svc = service_context(org).map_err(internal)?;
        let _ = ctx;
        Ok(self
            .store
            .read::<crate::environments::model::EnvironmentList>(
                &svc,
                org,
                ENVIRONMENTS_METADATA_TYPE,
            )
            .await?
            .0
            .items)
    }

    pub async fn registries(&self, ctx: &SecurityContext, org: Uuid) -> Result<Vec<OrgRegistry>> {
        self.require_manage(ctx, org).await?;
        let envs = self.org_environments(ctx, org).await?;
        let am = self.store.am().as_ref();
        let mut out: Vec<OrgRegistry> = Vec::new();
        for e in &envs {
            let roles = [
                (e.registry_connection_id, "push"),
                (e.boundaries.registry_pull_connection_id, "pull"),
            ];
            for (id, role) in roles {
                let Some(id) = id else { continue };
                if let Some(r) = out.iter_mut().find(|r| r.connection_id == id) {
                    if !r.prefixes.contains(&e.registry) {
                        r.prefixes.push(e.registry.clone());
                    }
                    if !r.environments.iter().any(|(i, _)| *i == e.id) {
                        r.environments.push((e.id, e.name.clone()));
                    }
                    if r.role != role {
                        r.role = "push_pull".into();
                    }
                    continue;
                }
                let (label, host) = match connectors::connection_by_id(am, ctx, org, id).await {
                    Some((_, c)) => (
                        c.label.clone(),
                        connectors::RegistryAccess::parse(&c.base_url, "host-only")
                            .map(|a| a.host)
                            .unwrap_or_default(),
                    ),
                    None => (id.to_string(), String::new()),
                };
                let kind = if host == "ghcr.io" { "ghcr" } else { "oci" };
                out.push(OrgRegistry {
                    connection_id: id,
                    label,
                    host,
                    kind: kind.into(),
                    prefixes: vec![e.registry.clone()],
                    environments: vec![(e.id, e.name.clone())],
                    role: role.into(),
                });
            }
        }
        Ok(out)
    }

    /// A registry of the organization's environments, its catalogue, and the
    /// paths under its host the environments use.
    async fn catalog(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        connection: Uuid,
    ) -> Result<(Box<dyn connectors::RegistryCatalog>, String, Vec<String>)> {
        self.require_manage(ctx, org).await?;
        let envs = self.org_environments(ctx, org).await?;
        let paths: Vec<String> = envs
            .iter()
            .filter(|e| {
                e.registry_connection_id == Some(connection)
                    || e.boundaries.registry_pull_connection_id == Some(connection)
            })
            .map(|e| build::registry_path(&e.registry).to_owned())
            .collect();
        if paths.is_empty() {
            return Err(Refusal::NotFound(
                connection.to_string(),
                format!("no environment of the organization uses registry connection {connection}"),
            ));
        }
        let svc = service_context(org).map_err(internal)?;
        let access = crate::environments::deploy::registry_access(&self.hub, &svc, org, connection)
            .await
            .map_err(|e| {
                Refusal::Precondition("REGISTRY_CONNECTION_UNREADABLE", format!("{e:#}"))
            })?;
        let host = access.host.clone();
        let catalog = connectors::catalog_for(&self.http, &access)
            .await
            .map_err(|e| Refusal::Unavailable(format!("{e:#}")))?;
        Ok((catalog, host, paths))
    }

    pub async fn registry_repositories(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        connection: Uuid,
    ) -> Result<Vec<OrgRepository>> {
        let (catalog, host, paths) = self.catalog(ctx, org, connection).await?;
        let records = self.records();
        let slugs = match records {
            Some(r) => r.slugs(org).await.map_err(internal)?,
            None => Vec::new(),
        };
        let recorded = match records {
            Some(r) => r.images_on(org, &host).await.map_err(internal)?,
            None => Vec::new(),
        };
        let mut out = Vec::new();
        for path in &paths {
            for name in catalog
                .repositories(path)
                .await
                .map_err(|e| Refusal::Unavailable(format!("{e:#}")))?
            {
                if out.iter().any(|r: &OrgRepository| r.name == name) {
                    continue;
                }
                let project_id = images::repository_owner(path, &name, &slugs);
                let project_name = match project_id {
                    // Shown only: a name that cannot be read is none, logged.
                    Some(p) => match self.store.tenant_name(ctx, p).await {
                        Ok(n) => Some(n),
                        Err(e) => {
                            tracing::warn!(project_id = %p, error = %format!("{e:#}"), "studio-environments: a repository's project name could not be read");
                            None
                        }
                    },
                    None => None,
                };
                out.push(OrgRepository {
                    recorded: recorded.iter().filter(|r| r.repository == name).count(),
                    name,
                    project_id,
                    project_name,
                });
            }
        }
        Ok(out)
    }

    pub async fn registry_tags(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        connection: Uuid,
        repository: &str,
    ) -> Result<Vec<OrgVersion>> {
        let (catalog, host, _) = self.catalog(ctx, org, connection).await?;
        let recorded = match self.records() {
            Some(r) => r.images_on(org, &host).await.map_err(internal)?,
            None => Vec::new(),
        };
        let live = self.live(org).await?;
        Ok(catalog
            .versions(repository)
            .await
            .map_err(|e| Refusal::Unavailable(format!("{e:#}")))?
            .into_iter()
            .map(|v| {
                let rec = recorded.iter().find(|r| {
                    r.repository == repository && v.digest.as_deref() == Some(r.digest.as_str())
                });
                OrgVersion {
                    image_id: rec.map(|r| r.id),
                    project_id: rec.map(|r| r.project_id),
                    running_in: rec.map(|r| runs_in(r, &live)).unwrap_or_default(),
                    version: v,
                }
            })
            .collect())
    }

    pub async fn delete_registry_version(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        connection: Uuid,
        repository: &str,
        digest: &str,
    ) -> Result<Uuid> {
        if !images::is_digest(digest) {
            return Err(Refusal::Invalid(format!("'{digest}' is not a digest")));
        }
        let (_, host, _) = self.catalog(ctx, org, connection).await?;
        let live = self.live(org).await?;
        if let Some(d) = live.iter().find(|d| {
            d.images
                .iter()
                .any(|i| i.image.ends_with(&format!("@{digest}")))
        }) {
            return Err(Refusal::Conflict(
                "IMAGE_RUNNING",
                format!(
                    "{repository}@{digest} runs in {} ({}): it is not deleted",
                    d.environment_name, d.namespace
                ),
            ));
        }
        let image_id = match self.records() {
            Some(r) => r
                .image_by_digest(org, &host, repository, digest)
                .await
                .map_err(internal)?
                .map(|r| r.id),
            None => None,
        };
        let op = ImageOp::Delete {
            organization_id: org,
            image_id,
            side: Side {
                connection_id: Some(connection),
                from: org,
                host,
                repository: repository.to_owned(),
            },
            digest: digest.to_owned(),
        };
        self.enqueue_image(org, &op, &format!("delete:{repository}@{digest}"))
            .await
    }

    pub async fn registry_orphans(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        connection: Uuid,
    ) -> Result<Vec<Orphan>> {
        let (catalog, host, paths) = self.catalog(ctx, org, connection).await?;
        let (slugs, recorded) = match self.records() {
            Some(r) => (
                r.slugs(org).await.map_err(internal)?,
                r.images_on(org, &host).await.map_err(internal)?,
            ),
            None => (Vec::new(), Vec::new()),
        };
        let live = self.live(org).await?;
        let running = |r: &ImageRecord| live.iter().any(|d| images::runs(r, d));
        let mut out = Vec::new();
        for path in &paths {
            let mut held = Vec::new();
            for repo in catalog
                .repositories(path)
                .await
                .map_err(|e| Refusal::Unavailable(format!("{e:#}")))?
            {
                for v in catalog
                    .versions(&repo)
                    .await
                    .map_err(|e| Refusal::Unavailable(format!("{e:#}")))?
                {
                    held.push(RegistryVersion {
                        repository: repo.clone(),
                        digest: v.digest,
                        tags: v.tags,
                        size_bytes: v.size_bytes,
                        pushed_at: v.pushed_at,
                    });
                }
            }
            let prefix = format!("{}/", path.trim_matches('/'));
            let mine: Vec<ImageRecord> = recorded
                .iter()
                .filter(|r| r.repository.starts_with(&prefix))
                .cloned()
                .collect();
            out.extend(images::orphans(path, &held, &mine, &slugs, &running));
        }
        Ok(out)
    }

    /* ── namespace assignments (ADR-0062 §3) ── */

    pub async fn namespace_assignments(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
    ) -> Result<Vec<Assignment>> {
        self.require_manage(ctx, org).await?;
        self.records_or_unavailable()?
            .assignments(org)
            .await
            .map_err(internal)
    }

    /// An administrator gives `project` a namespace in `environment`: on a
    /// cluster that gives namespaces, one of them; elsewhere, any the
    /// connection may work in. Replaces what was recorded.
    pub async fn assign_namespace(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Uuid,
        environment: Uuid,
        namespace: &str,
        build_namespace: Option<&str>,
    ) -> Result<Assignment> {
        self.require_manage(ctx, org).await?;
        let records = self.records_or_unavailable()?;
        let env = self.environment(ctx, org, environment).await?;
        if !env.admits(project) {
            return Err(Refusal::Forbidden("ENVIRONMENT_NOT_FOR_THIS_PROJECT"));
        }
        let namespace = namespace.trim().to_owned();
        let build_namespace = build_namespace
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .unwrap_or(&namespace)
            .to_owned();
        for ns in [&namespace, &build_namespace] {
            if !crate::environments::model::is_dns_label(ns) {
                return Err(Refusal::Invalid(format!(
                    "'{ns}' is not a Kubernetes namespace"
                )));
            }
            if let Some(given) = &env.boundaries.namespaces
                && !given.contains(ns)
            {
                return Err(Refusal::Invalid(format!(
                    "'{ns}' is not one of the namespaces environment '{}' says the cluster gives ({})",
                    env.name,
                    given.join(", ")
                )));
            }
        }
        let a = Assignment {
            project_id: project,
            environment_id: env.id,
            cluster_connection_id: env.connection_id,
            namespace,
            build_namespace,
            assigned_by: self.person(ctx).await.id,
            assigned_at_ms: now_ms(),
        };
        match records.assign(org, &a, true).await.map_err(internal)? {
            Assigned::Kept(a) => Ok(a),
            Assigned::Taken => Err(Refusal::Conflict(
                "NAMESPACE_TAKEN",
                format!(
                    "namespace {} of this cluster is another project's already",
                    a.namespace
                ),
            )),
        }
    }

    /* ── a pipeline's images ── */

    /// Record what a pipeline's manifest published (ADR-0062 §4): each image
    /// and the chart, on the registry of the organization's environment
    /// whose prefix holds it.
    pub async fn record_published(&self, p: &Published<'_>) -> anyhow::Result<()> {
        let Some(records) = self.records().cloned() else {
            return Ok(());
        };
        let project: Uuid = p.project_id.parse()?;
        let org = crate::organizations::sdk::organization_of(
            self.store.am().as_ref(),
            &service_context(project)?,
            project,
        )
        .await
        .ok_or_else(|| anyhow::anyhow!("project {project} is in no organization"))?;
        let svc = service_context(org)?;
        let envs = self
            .store
            .read::<crate::environments::model::EnvironmentList>(
                &svc,
                org,
                ENVIRONMENTS_METADATA_TYPE,
            )
            .await?
            .0
            .items;
        let connection = |image: &str| {
            envs.iter()
                .find(|e| {
                    !e.registry.is_empty()
                        && image
                            .strip_prefix(&e.registry)
                            .is_some_and(|rest| rest.starts_with('/'))
                })
                .and_then(|e| e.registry_connection_id)
        };
        let first = p
            .images
            .first()
            .map(|(_, i)| i.as_str())
            .or(p.chart_ref)
            .unwrap_or_default();
        let made = images::from_manifest(
            org,
            project,
            connection(first.trim_start_matches("oci://")),
            p.build_id,
            p.commit,
            p.description_revision,
            p.lock_hash,
            p.pushed_by,
            now_ms(),
            p.images,
            p.chart_ref.zip(p.chart_version).map(|(r, v)| (r, v, None)),
        );
        for r in made {
            records.record_image(&r).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_promotion_keeps_the_path_inside_the_project() {
        assert_eq!(inside_project("acme/shop/api", "shop"), "api");
        assert_eq!(
            inside_project("acme/shop/mirror/postgres", "shop"),
            "mirror/postgres"
        );
        assert_eq!(inside_project("legacy/api", "shop"), "api");
    }
}
