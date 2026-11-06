//! A project's infra services (ADR-0064): which ones its product runs, and
//! what a deploy to an environment will do with each.

use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{EnvironmentService, Refusal, Result};
use crate::environments::BINDINGS_METADATA_TYPE;
use crate::environments::images;
use crate::environments::infra::{self, InfraInstall, InfraPlacement, InfraService, PlanItem};
use crate::environments::model::{BindingList, Environment, EnvironmentKind};

/// What a deploy of a project to one environment does with its infra
/// services.
#[derive(Debug, Clone)]
pub struct InfraPlan {
    pub environment_id: Uuid,
    pub environment_name: String,
    pub placement: infra::Placement,
    /// The namespace they run in with the product.
    pub namespace: String,
    pub items: Vec<PlanItem>,
}

/// Is `reference` (an image, or an `oci://` chart) under the project's path
/// `prefix` in `env`'s registry? An environment without a registry takes
/// images as named.
fn under_project(
    env: &Environment,
    prefix: &str,
    reference: &str,
) -> std::result::Result<(), String> {
    if env.registry.is_empty() || images::is_under(reference, prefix) {
        Ok(())
    } else {
        Err(format!(
            "'{reference}' is not under the project's path {prefix}: a deploy runs only images \
             and charts in the organization's registry; import it first (POST /images/imports)"
        ))
    }
}

impl EnvironmentService {
    /// The project's infra services.
    pub async fn project_infra(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
    ) -> Result<Vec<InfraService>> {
        self.organization_of_project(ctx, project).await?;
        Ok(self
            .store
            .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
            .await?
            .0
            .infra)
    }

    /// Set the project's infra services, as a member who may write its
    /// settings.
    pub async fn put_project_infra(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        services: Vec<InfraService>,
    ) -> Result<Vec<InfraService>> {
        self.organization_of_project(ctx, project).await?;
        let services = infra::checked_services(services).map_err(Refusal::Invalid)?;
        self.store
            .update::<BindingList, Vec<InfraService>, Refusal>(
                ctx,
                project,
                BINDINGS_METADATA_TYPE,
                |row| {
                    row.infra = services.clone();
                    Ok(services.clone())
                },
            )
            .await?
            .map(|(_, s)| s)
    }

    /// What a deploy of `project` to `environment` does with its infra
    /// services now: how each comes, from which image or chart, what it
    /// gives the product, and what would refuse the deploy.
    pub async fn infra_plan(
        &self,
        ctx: &SecurityContext,
        project: Uuid,
        environment: Uuid,
    ) -> Result<InfraPlan> {
        let org = self.organization_of_project(ctx, project).await?;
        let env = self
            .project_environment(ctx, org, project, environment)
            .await?;
        // As a deploy of the newest build whose lock says its services
        // (ADR-0065 §3), else of the project's records alone (ADR-0064).
        let list = self
            .store
            .read::<BindingList>(ctx, project, BINDINGS_METADATA_TYPE)
            .await?
            .0;
        let services = match list.built_infra.first() {
            Some(built) => infra::built_services(built, &list.infra),
            None => list.infra,
        };
        let placement = env.boundaries.infra.clone().unwrap_or_default();
        if env.kind != EnvironmentKind::Kubernetes {
            return Ok(InfraPlan {
                environment_id: env.id,
                environment_name: env.name.clone(),
                placement: placement.placement,
                namespace: String::new(),
                items: Vec::new(),
            });
        }
        let place = self.place(ctx, org, project, &env).await?;
        let items = infra::plan(Some(&placement), &services, |r| {
            under_project(&env, &place.prefix, r)
        });
        Ok(InfraPlan {
            environment_id: env.id,
            environment_name: env.name.clone(),
            placement: placement.placement,
            namespace: place.namespace,
            items,
        })
    }

    /// Refuse a deploy whose infra services cannot come as planned.
    pub(super) fn check_infra(
        &self,
        env: &Environment,
        prefix: &str,
        installs: &[InfraInstall],
    ) -> Result<()> {
        let services: Vec<InfraService> = installs.iter().map(|i| i.service.clone()).collect();
        let placement: Option<&InfraPlacement> = env.boundaries.infra.as_ref();
        for item in infra::plan(placement, &services, |r| under_project(env, prefix, r)) {
            if let Some((code, why)) = item.refusal {
                return Err(Refusal::Precondition(code, why));
            }
        }
        Ok(())
    }
}
