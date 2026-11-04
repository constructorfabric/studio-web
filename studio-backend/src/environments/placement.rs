//! Where a project goes in one environment (ADR-0062 §3, §7): its immutable
//! slug, its runtime and build namespaces, and its own path in the registry.
//!
//! The namespace is recorded at the first build or deploy that made or found
//! it, and every later one -- build, deploy, a build's log, a preview -- reads
//! the record, so a rename of the project or a change of the environment's
//! pattern moves nothing that already runs. A cluster that gives Studio
//! namespaces instead of letting it make them (`namespaces` on the
//! environment) takes no guess: an administrator assigns one.

use std::sync::Arc;

use toolkit::client_hub::ClientHub;
use tracing::warn;
use uuid::Uuid;

use super::images;
use super::model::{self, Environment};
use super::records::{Assigned, Assignment, Records, now_ms};

/// A project's namespace in an environment that gives namespaces, not
/// assigned by an administrator yet.
pub const NAMESPACE_NOT_ASSIGNED: &str = "NAMESPACE_NOT_ASSIGNED";
/// The label a namespace Studio made names its project with.
pub const PROJECT_LABEL: &str = "studio.constructor.tech/project";
/// A namespace found in the cluster that another project's label claims.
pub const NAMESPACE_OF_ANOTHER_PROJECT: &str = "NAMESPACE_OF_ANOTHER_PROJECT";

/// Where a project goes in one environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    /// The project's immutable slug.
    pub slug: String,
    /// Where its releases run.
    pub namespace: String,
    /// Where its build Jobs, and their tokens, live.
    pub build_namespace: String,
    /// `ghcr.io/acme/shop`: the project's own path; empty for an environment
    /// with no registry.
    pub prefix: String,
    /// Whether the namespaces come from a record rather than the pattern.
    pub recorded: bool,
}

/// The place of a project with `slug` in `env`, given its recorded
/// assignment there. A record made on another cluster (the environment was
/// moved) is not this cluster's, and is made again.
pub fn place_of(
    env: &Environment,
    slug: &str,
    assignment: Option<&Assignment>,
) -> Result<Place, (&'static str, String)> {
    let prefix = if env.registry.is_empty() {
        String::new()
    } else {
        images::project_prefix(&env.registry, slug)
    };
    if let Some(a) = assignment.filter(|a| a.cluster_connection_id == env.connection_id) {
        return Ok(Place {
            slug: slug.to_owned(),
            namespace: a.namespace.clone(),
            build_namespace: a.build_namespace.clone(),
            prefix,
            recorded: true,
        });
    }
    if let Some(given) = &env.boundaries.namespaces {
        return Err((
            NAMESPACE_NOT_ASSIGNED,
            format!(
                "environment '{}' runs on a cluster that gives Studio its namespaces ({}) rather \
                 than letting it make them: an organization administrator assigns this project \
                 one of them, in Infrastructure",
                env.name,
                given.join(", ")
            ),
        ));
    }
    let namespace = model::namespace_for(&env.namespace_pattern, slug, &env.name)
        .map_err(|e| ("NAMESPACE_PATTERN_INVALID", e.to_string()))?;
    let build_namespace = env
        .build_namespace_for(slug)
        .map_err(|e| ("NAMESPACE_PATTERN_INVALID", e.to_string()))?;
    Ok(Place {
        slug: slug.to_owned(),
        namespace,
        build_namespace,
        prefix,
        recorded: false,
    })
}

/// Whether a namespace found in the cluster may be the project's: one whose
/// `studio.constructor.tech/project` label names another project is not;
/// one with no label is only when it was assigned by hand (a namespace the
/// cluster's administrator made, recorded by an organization administrator).
pub fn owner_refusal(
    namespace: &str,
    label: Option<&str>,
    project: Uuid,
    assigned: bool,
) -> Option<(&'static str, String)> {
    match label {
        Some(owner) if owner == project.to_string() => None,
        Some(owner) => Some((
            NAMESPACE_OF_ANOTHER_PROJECT,
            format!(
                "namespace {namespace} is labelled as project {owner}'s \
                 (studio.constructor.tech/project): Studio does not deploy one project into \
                 another's namespace"
            ),
        )),
        None if assigned => None,
        None => Some((
            NAMESPACE_NOT_ASSIGNED,
            format!(
                "namespace {namespace} exists, but Studio did not make it and no administrator \
                 assigned it to this project: assign it in Infrastructure, or let Studio make the \
                 project's own"
            ),
        )),
    }
}

/// Record that the run made or found `namespace` and `build_namespace` for
/// `project` in `environment`. Best effort: without the gear's tables the
/// pattern keeps naming them, as before.
pub async fn record(
    hub: &Arc<ClientHub>,
    org: Uuid,
    project: Uuid,
    environment: Uuid,
    cluster: Uuid,
    namespace: &str,
    build_namespace: &str,
) {
    let Ok(records) = hub.get::<Records>() else {
        return;
    };
    let a = Assignment {
        project_id: project,
        environment_id: environment,
        cluster_connection_id: cluster,
        namespace: namespace.to_owned(),
        build_namespace: build_namespace.to_owned(),
        assigned_by: "studio".to_owned(),
        assigned_at_ms: now_ms(),
    };
    match records.assign(org, &a, false).await {
        Ok(Assigned::Kept(_)) => {}
        Ok(Assigned::Taken) => {
            warn!(%project, %namespace, "studio-environments: the namespace is recorded as another project's on this cluster");
        }
        Err(e) => {
            warn!(%project, %namespace, "studio-environments: the namespace assignment could not be recorded ({e:#})");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::environments::model::{EnvironmentInput, EnvironmentList, checked};

    fn env(namespaces: Option<Vec<String>>) -> Environment {
        let mut e = checked(
            &EnvironmentList::default(),
            None,
            EnvironmentInput {
                name: "dev".into(),
                description: String::new(),
                kind: model::EnvironmentKind::Kubernetes,
                connection_id: Uuid::from_u128(7),
                research: None,
                registry: "ghcr.io/acme".into(),
                registry_connection_id: None,
                namespace_pattern: None,
                database: model::DatabaseMode::None,
                database_image: None,
                protected: false,
                promote_from: None,
                projects: None,
                previews: None,
                strictness: None,
                boundaries: model::Boundaries::default(),
            },
            String::new(),
            "t".into(),
        )
        .unwrap();
        e.boundaries.namespaces = namespaces;
        e
    }

    #[test]
    fn a_project_is_placed_by_its_slug_not_its_name() {
        let p = place_of(&env(None), "studioweb", None).unwrap();
        assert_eq!(p.namespace, "studioweb-dev");
        assert_eq!(p.build_namespace, "studioweb-build");
        assert_eq!(p.prefix, "ghcr.io/acme/studioweb");
        assert!(!p.recorded);
    }

    #[test]
    fn a_recorded_assignment_wins_on_its_own_cluster_only() {
        let e = env(Some(vec!["studio-web-dev".into()]));
        let refused = place_of(&e, "studioweb", None).unwrap_err();
        assert_eq!(refused.0, NAMESPACE_NOT_ASSIGNED);
        assert!(refused.1.contains("studio-web-dev"), "{}", refused.1);
        let mut a = Assignment {
            project_id: Uuid::nil(),
            environment_id: e.id,
            cluster_connection_id: e.connection_id,
            namespace: "studio-web-dev".into(),
            build_namespace: "studio-web-dev".into(),
            assigned_by: "alice".into(),
            assigned_at_ms: 1,
        };
        let p = place_of(&e, "studioweb", Some(&a)).unwrap();
        assert_eq!(p.namespace, "studio-web-dev");
        assert!(p.recorded);
        a.cluster_connection_id = Uuid::from_u128(99);
        assert!(
            place_of(&e, "studioweb", Some(&a)).is_err(),
            "another cluster's"
        );
    }

    #[test]
    fn a_found_namespace_must_be_the_projects_own() {
        let me = Uuid::from_u128(1);
        assert!(owner_refusal("shop-dev", Some(&me.to_string()), me, false).is_none());
        let (code, _) = owner_refusal("shop-dev", Some("someone-else"), me, true).unwrap();
        assert_eq!(code, NAMESPACE_OF_ANOTHER_PROJECT);
        assert_eq!(
            owner_refusal("shop-dev", None, me, false).unwrap().0,
            NAMESPACE_NOT_ASSIGNED
        );
        assert!(owner_refusal("shop-dev", None, me, true).is_none());
    }
}
