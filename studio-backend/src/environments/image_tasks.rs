//! The runs behind a project's image records (ADR-0062 §4): deleting a
//! digest from its registry, copying one by digest into the project's path of
//! another registry (a promotion, or an import of an external image), and
//! the retention sweep. Each acts on the server, through the registry's own
//! API: no Docker, nothing on a member's machine.

use std::sync::Arc;

use anyhow::{anyhow, bail};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use toolkit::client_hub::ClientHub;
use uuid::Uuid;

use super::deploy::registry_access;
use super::images::{self, ImageRecord, ImageState, Sweep};
use super::model::DeploymentList;
use super::records::Records;
use super::store::{Store, service_context};
use crate::connectors::sdk::{Oci, catalog_for};
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

/// Task types: a wire contract.
pub const TASK_TYPE: &str = "environments.images";
pub const SWEEP_TASK_TYPE: &str = "environments.image_sweep";
/// How often an organization with a retention policy is swept.
pub const SWEEP_CRON: &str = "17 3 * * *";

/// A registry a run reaches: a connection, read as the service of the
/// tenant it is found from; or none, for a public source read anonymously.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Side {
    #[serde(default)]
    pub connection_id: Option<Uuid>,
    /// The tenant the connection is found from (a project's own environment).
    pub from: Uuid,
    pub host: String,
    pub repository: String,
}

/// What an image run does.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ImageOp {
    /// Delete `digest` from `side`, and mark the record deleted.
    Delete {
        organization_id: Uuid,
        #[serde(default)]
        image_id: Option<Uuid>,
        side: Side,
        digest: String,
    },
    /// Copy `source@reference` into `dest`, by digest, with `tags`, and
    /// record it as `record` (whose digest the copy fills in).
    Copy {
        organization_id: Uuid,
        source: Side,
        reference: String,
        dest: Side,
        tags: Vec<String>,
        record: Box<ImageRecord>,
    },
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("constructor-studio")
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .unwrap_or_default()
}

async fn oci(hub: &Arc<ClientHub>, side: &Side) -> anyhow::Result<Oci> {
    match side.connection_id {
        Some(id) => {
            let svc = service_context(side.from)?;
            let access = registry_access(hub, &svc, side.from, id).await?;
            Ok(Oci::new(http(), &access))
        }
        None => Ok(Oci::anonymous(http(), &side.host)),
    }
}

/// Delete `digest` of `side`'s repository through the registry's catalogue
/// (GHCR's packages API, Harbor's, or the distribution API).
async fn delete(hub: &Arc<ClientHub>, side: &Side, digest: &str) -> anyhow::Result<()> {
    let id = side
        .connection_id
        .ok_or_else(|| anyhow!("a digest is deleted only from a registry Studio logs in to"))?;
    let svc = service_context(side.from)?;
    let access = registry_access(hub, &svc, side.from, id).await?;
    catalog_for(&http(), &access)
        .await?
        .delete(&side.repository, digest)
        .await
}

pub struct ImageTask {
    hub: Arc<ClientHub>,
}

impl ImageTask {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }

    async fn run_op(&self, ctx: &TaskContext, op: &ImageOp) -> anyhow::Result<String> {
        let records = self.hub.get::<Records>().ok();
        match op {
            ImageOp::Delete {
                organization_id,
                image_id,
                side,
                digest,
            } => {
                ctx.progress(format!("deleting {}@{digest}", side.repository))
                    .await;
                delete(&self.hub, side, digest).await?;
                if let (Some(records), Some(id)) = (records, image_id) {
                    records
                        .set_state(*organization_id, *id, ImageState::Deleted)
                        .await?;
                }
                Ok(format!(
                    "deleted {}/{}@{digest}",
                    side.host, side.repository
                ))
            }
            ImageOp::Copy {
                source,
                reference,
                dest,
                tags,
                record,
                ..
            } => {
                ctx.progress(format!(
                    "copying {}/{}:{reference} to {}/{}",
                    source.host, source.repository, dest.host, dest.repository
                ))
                .await;
                let src = oci(&self.hub, source).await?;
                let dst = oci(&self.hub, dest).await?;
                let digest = dst
                    .copy_from(&src, &source.repository, reference, &dest.repository, tags)
                    .await?;
                if let Some(records) = records {
                    let mut r = (**record).clone();
                    r.digest = digest.clone();
                    r.state = ImageState::Present;
                    if let Some((_, media, size)) =
                        dst.head_manifest(&dest.repository, &digest).await?
                    {
                        r.media_type = Some(media).filter(|m| !m.is_empty());
                        r.size_bytes = size;
                    }
                    records.record_image(&r).await?;
                }
                Ok(format!(
                    "copied to {}/{}@{digest}",
                    dest.host, dest.repository
                ))
            }
        }
    }
}

#[async_trait]
impl TaskHandler for ImageTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    fn max_attempts(&self) -> i16 {
        2
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let op: ImageOp = match serde_json::from_value(ctx.payload.clone()) {
            Ok(op) => op,
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "this run's payload is not an image run ({e})"
                ));
            }
        };
        match self.run_op(ctx, &op).await {
            Ok(said) => TaskOutcome::done_with(said, serde_json::json!({})),
            Err(e) => TaskOutcome::Failed(format!("{e:#}")),
        }
    }
}

/// What a sweep carries: the organization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SweepPayload {
    pub organization_id: Uuid,
}

pub struct SweepTask {
    hub: Arc<ClientHub>,
}

impl SweepTask {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }

    async fn sweep(&self, ctx: &TaskContext, org: Uuid) -> anyhow::Result<String> {
        let records = self
            .hub
            .get::<Records>()
            .map_err(|_| anyhow!("image records are not kept in this deployment"))?;
        let am = self
            .hub
            .get::<dyn account_management_sdk::AccountManagementClient>()
            .map_err(|_| anyhow!("account management is not available in this deployment"))?;
        let svc = service_context(org)?;
        let (history, _) = Store::new(am)
            .read::<DeploymentList>(&svc, org, super::DEPLOYMENTS_METADATA_TYPE)
            .await?;
        let live = images::live_deployments(&history.items);
        let running = |r: &ImageRecord| live.iter().any(|d| images::runs(r, d));
        let default = records.retention(org, org).await?;
        let mut by_project: std::collections::BTreeMap<Uuid, Vec<ImageRecord>> = Default::default();
        for r in records.org_images(org).await? {
            by_project.entry(r.project_id).or_default().push(r);
        }
        let now = super::records::now_ms();
        let (mut deleted, mut retained, mut failed) = (0usize, 0usize, Vec::new());
        for (project, list) in by_project {
            let Some(policy) = records.retention(org, project).await?.or(default) else {
                continue;
            };
            for (id, what) in images::sweep(&list, policy, &running, now) {
                let Some(r) = list.iter().find(|r| r.id == id) else {
                    continue;
                };
                match what {
                    Sweep::Retain => {
                        records.set_state(org, id, ImageState::Retained).await?;
                        retained += 1;
                    }
                    Sweep::Delete => {
                        ctx.progress(format!("deleting {}@{}", r.repository, r.digest))
                            .await;
                        let side = Side {
                            connection_id: r.registry_connection_id,
                            from: org,
                            host: r.registry_host.clone(),
                            repository: r.repository.clone(),
                        };
                        match delete(&self.hub, &side, &r.digest).await {
                            Ok(()) => {
                                records.set_state(org, id, ImageState::Deleted).await?;
                                deleted += 1;
                            }
                            Err(e) => failed.push(format!("{}@{}: {e:#}", r.repository, r.digest)),
                        }
                    }
                }
            }
        }
        if !failed.is_empty() {
            bail!(
                "deleted {deleted}, kept {retained} that run or are pinned; {} could not be deleted: {}",
                failed.len(),
                failed.join("; ")
            );
        }
        Ok(format!(
            "deleted {deleted}, kept {retained} that run or are pinned"
        ))
    }
}

#[async_trait]
impl TaskHandler for SweepTask {
    fn task_type(&self) -> &'static str {
        SWEEP_TASK_TYPE
    }

    fn max_attempts(&self) -> i16 {
        1
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let p: SweepPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "this run's payload is not an image sweep ({e})"
                ));
            }
        };
        match self.sweep(ctx, p.organization_id).await {
            Ok(said) => TaskOutcome::done_with(said, serde_json::json!({})),
            Err(e) => TaskOutcome::Failed(format!("{e:#}")),
        }
    }
}
