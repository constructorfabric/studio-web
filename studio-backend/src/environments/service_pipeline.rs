//! What an agent following a project's pipeline reads one at a time: one
//! build as the project keeps it, one deployment, and an environment's
//! configuration secrets against what the product needs there.

use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{EnvironmentService, Refusal, Result};
use crate::artifact_ingest::port::BuildRecord;
use crate::environments::BINDINGS_METADATA_TYPE;
use crate::environments::infra::{self, LockedService};
use crate::environments::model::{BindingList, Deployment, EnvironmentKind};
use crate::environments::secret_needs::{self, SecretNeed};

/// One build of a project: its record, and the infra services its lock
/// resolved, which a deploy of it runs.
#[derive(Debug, Clone)]
pub struct BuildView {
    pub record: BuildRecord,
    /// `None` when the project keeps none for it: a build from before they
    /// were kept, older than the latest [`infra::MAX_LOCKED_BUILDS`], or not
    /// done yet.
    pub built_infra: Option<Vec<LockedService>>,
}

/// An environment's configuration secrets against what the product needs.
#[derive(Debug, Clone)]
pub struct SecretKeys {
    pub environment_id: Uuid,
    /// The profile the environment runs.
    pub profile: String,
    /// The description revision read; `None` before one is saved.
    pub revision: Option<i64>,
    /// The keys set there, values never.
    pub set: Vec<String>,
    pub needed: Vec<SecretNeed>,
}

impl EnvironmentService {
    /// The build `build_id` of `project`, as recorded.
    pub async fn build_view(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        build_id: &str,
    ) -> Result<BuildView> {
        self.organization_of_project(ctx, project).await?;
        let records = self
            .hub
            .get::<dyn crate::artifact_ingest::port::BuildRecords>()
            .map_err(|_| {
                Refusal::Unavailable("builds are not available in this deployment".into())
            })?;
        let record = records
            .build(ctx, &project.to_string(), build_id)
            .await
            .map_err(|e| Refusal::Internal(format!("{e:#}")))?
            .ok_or_else(|| {
                Refusal::NotFound(
                    build_id.to_owned(),
                    format!("project {project} has no build {build_id}"),
                )
            })?;
        let list = self
            .store
            .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
            .await?
            .0;
        let built_infra = list
            .built_infra
            .into_iter()
            .find(|b| b.build == build_id)
            .map(|b| b.services);
        Ok(BuildView {
            record,
            built_infra,
        })
    }

    /// One deployment of the organization `org` (of `project`, when named),
    /// with where its run has got to, as [`Self::deployments`] reads it.
    pub async fn deployment_view(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project: Option<Uuid>,
        id: Uuid,
    ) -> Result<Deployment> {
        self.deployments(ctx, org, project, None)
            .await?
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| {
                Refusal::NotFound(
                    id.to_string(),
                    match project {
                        Some(p) => format!("project {p} has no deployment {id}"),
                        None => format!("the organization has no deployment {id}"),
                    },
                )
            })
    }

    /// The configuration secrets of `project` in `environment`: the keys
    /// set, and what its description and infra services need there.
    pub async fn secret_keys(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        environment: Uuid,
    ) -> Result<SecretKeys> {
        let org = self.organization_of_project(ctx, project).await?;
        let env = self
            .project_environment(ctx, org, project, environment)
            .await?;
        let profile = self.profile_for(ctx, project, env.id).await;
        let list = self
            .store
            .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
            .await?
            .0;
        let set: Vec<String> = list
            .secrets
            .iter()
            .filter(|s| s.environment_id == env.id)
            .map(|s| s.key.clone())
            .collect();
        // The services a deploy now brings: the newest build's lock, else
        // the project's records, as `infra_plan` reads them.
        let services = match list.built_infra.first() {
            Some(built) => infra::from_lock(&built.services, &list.infra),
            None => list.infra.clone(),
        };
        let installs = if env.kind == EnvironmentKind::Kubernetes {
            infra::installs(
                env.boundaries.infra.as_ref(),
                &services,
                env.previews
                    .as_ref()
                    .and_then(|s| s.ingress_class.as_deref()),
            )
        } else {
            Vec::new()
        };
        let description = match self.hub.get::<dyn crate::product::port::ProjectProducts>() {
            Ok(products) => products
                .latest_description(ctx, project)
                .await
                .map_err(|e| {
                    Refusal::Internal(format!("the product description could not be read: {e:#}"))
                })?,
            Err(_) => None,
        };
        let needed = secret_needs::needs(
            description.as_ref().map(|d| d.text.as_str()),
            &profile,
            &installs,
            &set,
        );
        Ok(SecretKeys {
            environment_id: env.id,
            profile,
            revision: description.map(|d| d.revision),
            set,
            needed,
        })
    }
}
