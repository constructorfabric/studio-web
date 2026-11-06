//! What a build or a deploy checks before it is queued, so that each failure
//! names its cause at once instead of as a 403, or a build's "no pod left",
//! in the middle of a Job.
//!
//! **The connections are read as the run will read them.** A build clones the
//! project's repository with the token of the connection it is reached
//! through, read as the organization's service; the environment's cluster and
//! registry connections are read as the service of the tenant they are found
//! from (ADR-0054 §5). A personal connection's token is readable by its owner
//! alone, never by the service, so a build through one could only fail when
//! it starts. Each is read here, the same way, before anything is queued.
//!
//! **The cluster is asked, not assumed.** With the cluster connection's own
//! credential: does the project's namespace exist; if it does, may the
//! connection create secrets, Jobs and Deployments in it; if it does not, may
//! the connection create it and give itself `admin` there -- the rights the
//! cluster's bootstrap manifest gives (ADR-0043,
//! `deploy/k8s/studio-environments/bootstrap.yaml`). A namespace the
//! connection may not even read is a refusal too, not an assumption that it
//! exists.
//!
//! The decisions are plain functions over what was read, so they are tested
//! without a cluster or a credential store.

use k8s_openapi::api::core::v1::Namespace;

use crate::connectors::sdk::{BOOTSTRAP_FILE, BOOTSTRAP_RIGHTS, ClusterRight, NAMESPACE_RIGHTS};

/// A refusal: the precondition code a problem carries, and the sentence.
pub type Refused = (&'static str, String);

/// The project's repository is reached through a personal connection: the
/// server cannot read a person's token, so a build could never clone it.
pub const REPOSITORY_CONNECTION_PERSONAL: &str = "REPOSITORY_CONNECTION_PERSONAL";
/// The repository's connection could not be read as the build will read it.
pub const REPOSITORY_CONNECTION_UNREADABLE: &str = "REPOSITORY_CONNECTION_UNREADABLE";
/// The environment's registry connection could not be read as the run will.
pub const REGISTRY_CONNECTION_UNREADABLE: &str = "REGISTRY_CONNECTION_UNREADABLE";
/// The environment's cluster connection could not be read as the run will.
pub const CLUSTER_CONNECTION_UNREADABLE: &str = "CLUSTER_CONNECTION_UNREADABLE";
/// The project's namespace is not there, and the connection may not make it
/// and give itself `admin` in it.
pub const CLUSTER_CANNOT_CREATE_NAMESPACE: &str = "CLUSTER_CANNOT_CREATE_NAMESPACE";
/// The connection may not read the project's namespace, so whether it is
/// there cannot be told.
pub const CLUSTER_CANNOT_READ_NAMESPACE: &str = "CLUSTER_CANNOT_READ_NAMESPACE";
/// The namespace is there, but the connection may not create in it what a
/// build or a deploy creates.
pub const CLUSTER_NAMESPACE_RIGHTS_MISSING: &str = "CLUSTER_NAMESPACE_RIGHTS_MISSING";

/// Which of an operation's connections one is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The project's repository, which a build clones.
    Source,
    /// The environment's registry, which a build pushes to and a deploy
    /// pulls from.
    Registry,
    /// The environment's cluster.
    Cluster,
}

/// What is known of a connection that was read, or tried.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Seen {
    /// Its label and scope, when the connection itself could be found.
    pub label: Option<String>,
    pub scope: Option<String>,
    /// Why its credential could not be read; `None` when it was.
    pub unreadable: Option<String>,
}

/// Whether a connection the run will read stops the operation now. A
/// personal repository connection always does: even when the caller owns it,
/// the run reads as the service. `repo` names the repository a source
/// connection reaches.
pub fn connection_refusal(
    role: Role,
    id: &str,
    seen: &Seen,
    repo: Option<&str>,
) -> Option<Refused> {
    let label = seen.label.as_deref().unwrap_or(id);
    let scope = seen.scope.as_deref().unwrap_or("unknown");
    if role == Role::Source && scope == "personal" {
        return Some((
            REPOSITORY_CONNECTION_PERSONAL,
            format!(
                "the project's repository {} is reached through connection '{label}', which is \
                 personal (scope {scope}): a build Studio runs clones as the service, which cannot \
                 read a person's token. Connect the repository through a shared connection (workspace \
                 or organization scope), then build again",
                repo.unwrap_or("(unnamed)")
            ),
        ));
    }
    let why = seen.unreadable.as_deref()?;
    Some(match role {
        Role::Source => (
            REPOSITORY_CONNECTION_UNREADABLE,
            format!(
                "the project's repository {} is reached through connection '{label}' (scope \
                 {scope}), whose token the server cannot read as a build would: {why}",
                repo.unwrap_or("(unnamed)")
            ),
        ),
        Role::Registry => (
            REGISTRY_CONNECTION_UNREADABLE,
            format!(
                "the environment's registry connection '{label}' (scope {scope}) cannot be read \
                 as the build or deploy would read it: {why}"
            ),
        ),
        Role::Cluster => (
            CLUSTER_CONNECTION_UNREADABLE,
            format!(
                "the environment's cluster connection '{label}' (scope {scope}) cannot be read \
                 as the build or deploy would read it: {why}"
            ),
        ),
    })
}

/// Whether the project's namespace is there, as the connection sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NamespaceSeen {
    Exists,
    Missing,
    /// The cluster refused to say: what it answered.
    Forbidden(String),
}

/// What the cluster said about one namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClusterFacts {
    pub namespace: String,
    pub seen: NamespaceSeen,
    /// The rights asked about that the cluster refused, each as
    /// [`ClusterRight::describe`] says it: the namespace's own when it
    /// exists, the bootstrap manifest's when it does not.
    pub denied: Vec<String>,
    /// Its `studio.constructor.tech/project` label, when it exists and has
    /// one (ADR-0062 §3).
    pub project_label: Option<String>,
}

/// The cluster is not bootstrapped far enough for Studio: what is missing.
pub const CLUSTER_NOT_BOOTSTRAPPED: &str = "CLUSTER_NOT_BOOTSTRAPPED";
/// The environment's registry connection is personal: a server build pushes
/// as the organization's service.
pub const REGISTRY_CONNECTION_PERSONAL: &str = "REGISTRY_CONNECTION_PERSONAL";
/// The registry token reaches past pushing and pulling.
pub const REGISTRY_TOKEN_TOO_BROAD: &str = "REGISTRY_TOKEN_TOO_BROAD";

/// Whether a registry token's scopes stop a server build: any that
/// administers, deletes or reaches the repositories, unless the environment
/// allows it.
pub fn token_refusal(label: &str, broad: &[String], allowed: bool) -> Option<Refused> {
    if broad.is_empty() || allowed {
        return None;
    }
    Some((
        REGISTRY_TOKEN_TOO_BROAD,
        format!(
            "the environment's registry connection '{label}' holds a token that may also {}: a \
             build Studio runs pushes only with a token that pushes and pulls packages \
             (write:packages, read:packages). Replace the token, or let the environment take a \
             broad one",
            broad.join(", ")
        ),
    ))
}

/// What a cluster's readiness stops: a partial bootstrap, or a cluster that
/// gives namespaces when the project's are not among them.
pub fn bootstrap_refusal(
    r: &crate::connectors::sdk::Readiness,
    namespaces: &[&str],
) -> Option<Refused> {
    use crate::connectors::sdk::Readiness;
    match r {
        Readiness::Bootstrapped { .. } => None,
        Readiness::Partial { missing } => Some((
            CLUSTER_NOT_BOOTSTRAPPED,
            format!(
                "the cluster is not bootstrapped for Studio; missing: {}",
                missing.join("; ")
            ),
        )),
        Readiness::NamespaceLimited { namespaces: given } => {
            let absent: Vec<&str> = namespaces
                .iter()
                .copied()
                .filter(|n| !given.iter().any(|g| g == n))
                .collect();
            (!absent.is_empty()).then(|| {
                (
                    super::placement::NAMESPACE_NOT_ASSIGNED,
                    format!(
                        "the cluster gives Studio only {} and may not make namespaces: {} is not \
                         among them -- an administrator assigns the project one in Infrastructure",
                        given.join(", "),
                        absent.join(", ")
                    ),
                )
            })
        }
    }
}

/// Whether what the cluster said stops the operation now.
pub fn cluster_refusal(f: &ClusterFacts) -> Option<Refused> {
    let ns = &f.namespace;
    match &f.seen {
        NamespaceSeen::Forbidden(why) => Some((
            CLUSTER_CANNOT_READ_NAMESPACE,
            format!(
                "the cluster connection may not read namespace {ns}, so Studio cannot tell \
                 whether it exists: a cluster administrator applies {BOOTSTRAP_FILE}, or gives \
                 the connection's account admin in {ns} ({why})"
            ),
        )),
        NamespaceSeen::Missing if !f.denied.is_empty() => Some((
            CLUSTER_CANNOT_CREATE_NAMESPACE,
            format!(
                "namespace {ns} does not exist, and the cluster connection may not make it and \
                 give itself admin there (it may not {}): a cluster administrator applies \
                 {BOOTSTRAP_FILE}, or creates {ns} and gives the connection's account admin in it",
                f.denied.join(", ")
            ),
        )),
        NamespaceSeen::Exists if !f.denied.is_empty() => Some((
            CLUSTER_NAMESPACE_RIGHTS_MISSING,
            format!(
                "namespace {ns} exists, but the cluster connection may not {}: a cluster \
                 administrator gives the connection's account admin in {ns}",
                f.denied.join(", ")
            ),
        )),
        _ => None,
    }
}

/// Ask the cluster, as the connection, about the project's namespace. An
/// error is a cluster that did not answer.
pub async fn cluster_facts(client: &kube::Client, namespace: &str) -> anyhow::Result<ClusterFacts> {
    let namespaces: kube::Api<Namespace> = kube::Api::all(client.clone());
    let mut project_label = None;
    let seen = match namespaces.get_opt(namespace).await {
        Ok(Some(found)) => {
            project_label = found
                .metadata
                .labels
                .and_then(|l| l.get(super::placement::PROJECT_LABEL).cloned());
            NamespaceSeen::Exists
        }
        Ok(None) => NamespaceSeen::Missing,
        Err(kube::Error::Api(status)) if status.code == 403 => {
            NamespaceSeen::Forbidden(status.message)
        }
        Err(e) => return Err(anyhow::anyhow!("the cluster did not answer: {e}")),
    };
    let asked: Vec<(ClusterRight, Option<&str>)> = match seen {
        NamespaceSeen::Exists => NAMESPACE_RIGHTS
            .iter()
            .map(|r| (*r, Some(namespace)))
            .collect(),
        NamespaceSeen::Missing => BOOTSTRAP_RIGHTS.iter().map(|r| (*r, None)).collect(),
        NamespaceSeen::Forbidden(_) => Vec::new(),
    };
    let mut denied = Vec::new();
    for (right, ns) in asked {
        if !right.allowed(client, ns).await? {
            denied.push(right.describe(ns));
        }
    }
    Ok(ClusterFacts {
        namespace: namespace.to_owned(),
        seen,
        denied,
        project_label,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(scope: &str, unreadable: Option<&str>) -> Seen {
        Seen {
            label: Some("GitHub (alice)".into()),
            scope: Some(scope.into()),
            unreadable: unreadable.map(str::to_owned),
        }
    }

    #[test]
    fn a_personal_repository_connection_is_refused_even_when_its_owner_asks() {
        let (code, why) = connection_refusal(
            Role::Source,
            "c1",
            &seen("personal", None),
            Some("acme/shop"),
        )
        .expect("refused");
        assert_eq!(code, REPOSITORY_CONNECTION_PERSONAL);
        assert!(why.contains("'GitHub (alice)'"), "{why}");
        assert!(why.contains("personal"), "{why}");
        assert!(why.contains("acme/shop"), "{why}");
    }

    #[test]
    fn a_shared_repository_connection_the_server_reads_is_fine() {
        for scope in ["workspace", "organization"] {
            assert_eq!(
                connection_refusal(Role::Source, "c1", &seen(scope, None), Some("acme/shop")),
                None
            );
        }
    }

    #[test]
    fn an_unreadable_connection_names_itself_its_scope_and_why() {
        let (code, why) = connection_refusal(
            Role::Source,
            "c1",
            &seen("organization", Some("the token was removed")),
            Some("acme/shop"),
        )
        .expect("refused");
        assert_eq!(code, REPOSITORY_CONNECTION_UNREADABLE);
        assert!(why.contains("scope organization") && why.contains("the token was removed"));
        let (code, _) =
            connection_refusal(Role::Registry, "r1", &seen("organization", Some("x")), None)
                .unwrap();
        assert_eq!(code, REGISTRY_CONNECTION_UNREADABLE);
        let (code, _) =
            connection_refusal(Role::Cluster, "k1", &seen("workspace", Some("x")), None).unwrap();
        assert_eq!(code, CLUSTER_CONNECTION_UNREADABLE);
    }

    #[test]
    fn a_connection_that_cannot_be_found_is_named_by_its_id() {
        let (_, why) = connection_refusal(
            Role::Cluster,
            "99f7f5ae",
            &Seen {
                unreadable: Some("connection 99f7f5ae not found".into()),
                ..Seen::default()
            },
            None,
        )
        .unwrap();
        assert!(why.contains("'99f7f5ae'"), "{why}");
    }

    fn facts(seen: NamespaceSeen, denied: &[&str]) -> ClusterFacts {
        ClusterFacts {
            namespace: "shop-dev".into(),
            seen,
            denied: denied.iter().map(|s| s.to_string()).collect(),
            project_label: None,
        }
    }

    #[test]
    fn a_broad_registry_token_is_refused_unless_the_environment_allows_it() {
        let broad = vec!["admin:org".to_owned()];
        let (code, why) = token_refusal("GHCR acme", &broad, false).unwrap();
        assert_eq!(code, REGISTRY_TOKEN_TOO_BROAD);
        assert!(why.contains("admin:org"), "{why}");
        assert!(token_refusal("GHCR acme", &broad, true).is_none());
        assert!(token_refusal("GHCR acme", &[], false).is_none());
    }

    #[test]
    fn a_partial_cluster_is_refused_with_what_it_lacks() {
        use crate::connectors::sdk::Readiness;
        let partial = Readiness::Partial {
            missing: vec!["create namespaces".into()],
        };
        let (code, why) = bootstrap_refusal(&partial, &["shop-dev"]).unwrap();
        assert_eq!(code, CLUSTER_NOT_BOOTSTRAPPED);
        assert!(why.contains("create namespaces"), "{why}");
        let limited = Readiness::NamespaceLimited {
            namespaces: vec!["studio-web-dev".into()],
        };
        assert!(bootstrap_refusal(&limited, &["studio-web-dev"]).is_none());
        let (code, _) =
            bootstrap_refusal(&limited, &["studio-web-dev", "studioweb-build"]).unwrap();
        assert_eq!(code, crate::environments::placement::NAMESPACE_NOT_ASSIGNED);
        assert!(bootstrap_refusal(&Readiness::Bootstrapped { version: 2 }, &["x"]).is_none());
    }

    #[test]
    fn a_missing_namespace_the_connection_cannot_make_names_it_and_the_bootstrap() {
        let (code, why) =
            cluster_refusal(&facts(NamespaceSeen::Missing, &["create namespaces"])).unwrap();
        assert_eq!(code, CLUSTER_CANNOT_CREATE_NAMESPACE);
        assert!(why.contains("shop-dev"), "{why}");
        assert!(why.contains(BOOTSTRAP_FILE), "{why}");
        assert!(why.contains("create namespaces"), "{why}");
    }

    #[test]
    fn a_missing_namespace_the_connection_may_make_is_fine() {
        assert_eq!(cluster_refusal(&facts(NamespaceSeen::Missing, &[])), None);
    }

    #[test]
    fn a_namespace_the_connection_cannot_read_is_refused_not_assumed() {
        let (code, why) = cluster_refusal(&facts(
            NamespaceSeen::Forbidden("namespaces \"shop-dev\" is forbidden".into()),
            &[],
        ))
        .unwrap();
        assert_eq!(code, CLUSTER_CANNOT_READ_NAMESPACE);
        assert!(
            why.contains(BOOTSTRAP_FILE) && why.contains("forbidden"),
            "{why}"
        );
    }

    #[test]
    fn an_existing_namespace_without_the_rights_says_which() {
        let (code, why) = cluster_refusal(&facts(
            NamespaceSeen::Exists,
            &["create jobs.batch in shop-dev"],
        ))
        .unwrap();
        assert_eq!(code, CLUSTER_NAMESPACE_RIGHTS_MISSING);
        assert!(why.contains("create jobs.batch in shop-dev"), "{why}");
        assert_eq!(cluster_refusal(&facts(NamespaceSeen::Exists, &[])), None);
    }
}
