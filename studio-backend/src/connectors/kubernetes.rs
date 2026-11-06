//! Kubernetes driver: a cluster an organization's products are deployed into
//! (ADR-0043).
//!
//! A connection of this kind holds the cluster's API server as its address
//! and, as its credential, either a service-account token or a kubeconfig.
//! A token alone works for a cluster whose certificate a public CA signed; a
//! kubeconfig carries the cluster's own CA. Either way the credential stays in
//! credstore and is used only by the server -- a member's machine never holds
//! it (ADR-0027).
//!
//! ## What a kubeconfig may say
//!
//! A kubeconfig is more than credentials: it can name an `exec` plugin, a file
//! to read, a proxy. On a person's laptop that is their business; on the
//! server it would be a way to make Studio run a program or read its own
//! files. So [`ClusterAccess::parse`] keeps only inline data -- the server, the
//! CA, a token or an inline client certificate -- and refuses a kubeconfig
//! that needs anything else, saying what. The connection's address is the
//! server, and a kubeconfig that points elsewhere is refused, so the URL guard
//! that checked the address checked where the credential goes.

use anyhow::{Context, anyhow, bail};
use async_trait::async_trait;
use serde_yaml::Value;

use super::driver::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverCheck, DriverIdentity,
};

pub struct KubernetesDriver;

#[async_trait]
impl ConnectorDriver for KubernetesDriver {
    fn provider(&self) -> &'static str {
        "kubernetes"
    }

    fn display_name(&self) -> &'static str {
        "Kubernetes cluster"
    }

    fn default_base_url(&self) -> &'static str {
        "https://kubernetes.example.com:6443"
    }

    fn category(&self) -> ConnectorCategory {
        ConnectorCategory::Cluster
    }

    fn credential_label(&self) -> &'static str {
        "Service-account token or kubeconfig"
    }

    fn credential_hint(&self) -> &'static str {
        "eyJhbGciOi… or a kubeconfig with the cluster's CA"
    }

    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity> {
        let access = ClusterAccess::parse(&auth.base_url, &auth.token)?;
        let client = access.client().await?;
        let version = client
            .apiserver_version()
            .await
            .map_err(|e| anyhow!("the cluster did not answer: {e}"))?;
        // What the cluster's bootstrap manifest gives (ADR-0043): reported,
        // so a half-bootstrapped cluster says so here rather than with a 403
        // in the middle of a build. A missing right does not fail the test.
        let mut checks = Vec::new();
        for right in BOOTSTRAP_RIGHTS {
            checks.push(match right.allowed(&client, None).await {
                Ok(ok) => bootstrap_check(&right, ok),
                Err(e) => DriverCheck {
                    name: right.describe(None),
                    ok: false,
                    detail: format!("the cluster did not say ({e:#})"),
                },
            });
        }
        Ok(DriverIdentity {
            checks,
            account: format!("Kubernetes {}", version.git_version),
            display_name: Some(access.server.clone()),
        })
    }
}

/// The manifest a cluster administrator applies so Studio can make each
/// project's namespace (ADR-0043), as the repository keeps it.
pub const BOOTSTRAP_FILE: &str = "deploy/k8s/studio-environments/bootstrap.yaml";

/// One thing a cluster connection may or may not do, as a
/// SelfSubjectAccessReview asks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClusterRight {
    pub verb: &'static str,
    /// The API group: `""` for the core one.
    pub group: &'static str,
    pub resource: &'static str,
    /// One object of the resource, when the right is for it alone.
    pub name: Option<&'static str>,
}

/// What [`BOOTSTRAP_FILE`] gives the connection's account cluster-wide: make
/// a project's namespace and give itself `admin` inside it.
pub const BOOTSTRAP_RIGHTS: [ClusterRight; 3] = [
    ClusterRight {
        verb: "create",
        group: "",
        resource: "namespaces",
        name: None,
    },
    ClusterRight {
        verb: "create",
        group: "rbac.authorization.k8s.io",
        resource: "rolebindings",
        name: None,
    },
    ClusterRight {
        verb: "bind",
        group: "rbac.authorization.k8s.io",
        resource: "clusterroles",
        name: Some("admin"),
    },
];

/// What a build and a deploy create in a project's namespace: the
/// repository token and the pull secret, the build's Job, the product's
/// Deployments.
pub const NAMESPACE_RIGHTS: [ClusterRight; 3] = [
    ClusterRight {
        verb: "create",
        group: "",
        resource: "secrets",
        name: None,
    },
    ClusterRight {
        verb: "create",
        group: "batch",
        resource: "jobs",
        name: None,
    },
    ClusterRight {
        verb: "create",
        group: "apps",
        resource: "deployments",
        name: None,
    },
];

impl ClusterRight {
    /// `create namespaces`, `create jobs.batch in shop-dev`,
    /// `bind clusterroles/admin`.
    pub fn describe(&self, namespace: Option<&str>) -> String {
        let resource = if self.group.is_empty() {
            self.resource.to_owned()
        } else if self.group.contains('.') {
            // rbac.authorization.k8s.io: the resource alone reads better.
            self.resource.to_owned()
        } else {
            format!("{}.{}", self.resource, self.group)
        };
        let what = match self.name {
            Some(name) => format!("{} {resource}/{name}", self.verb),
            None => format!("{} {resource}", self.verb),
        };
        match namespace {
            Some(ns) => format!("{what} in {ns}"),
            None => what,
        }
    }

    /// Whether the connection may: asked of the cluster as the connection
    /// itself, in `namespace` or cluster-wide.
    pub async fn allowed(
        &self,
        client: &kube::Client,
        namespace: Option<&str>,
    ) -> anyhow::Result<bool> {
        use k8s_openapi::api::authorization::v1::{
            ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
        };
        let review = SelfSubjectAccessReview {
            spec: SelfSubjectAccessReviewSpec {
                resource_attributes: Some(ResourceAttributes {
                    verb: Some(self.verb.to_owned()),
                    group: Some(self.group.to_owned()),
                    resource: Some(self.resource.to_owned()),
                    name: self.name.map(str::to_owned),
                    namespace: namespace.map(str::to_owned),
                    ..ResourceAttributes::default()
                }),
                ..SelfSubjectAccessReviewSpec::default()
            },
            ..SelfSubjectAccessReview::default()
        };
        let answer = kube::Api::<SelfSubjectAccessReview>::all(client.clone())
            .create(&kube::api::PostParams::default(), &review)
            .await
            .map_err(|e| anyhow!("the cluster did not answer an access review: {e}"))?;
        Ok(answer.status.map(|s| s.allowed).unwrap_or(false))
    }
}

/// A connection test's line for one bootstrap right.
fn bootstrap_check(right: &ClusterRight, ok: bool) -> DriverCheck {
    DriverCheck {
        name: right.describe(None),
        ok,
        detail: if ok {
            String::new()
        } else {
            format!(
                "Studio cannot make a project's namespace on its own: a cluster administrator \
                 applies {BOOTSTRAP_FILE}, or prepares each namespace and gives this account \
                 admin in it"
            )
        },
    }
}

/// How the server reaches one cluster: everything inline, nothing to run or
/// read.
#[derive(Clone)]
pub struct ClusterAccess {
    /// The API server, `https://…`.
    pub server: String,
    /// base64 PEM of the cluster's CA, as a kubeconfig carries it.
    ca_data: Option<String>,
    token: Option<String>,
    client_certificate_data: Option<String>,
    client_key_data: Option<String>,
}

impl std::fmt::Debug for ClusterAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClusterAccess")
            .field("server", &self.server)
            .field("ca", &self.ca_data.is_some())
            .finish_non_exhaustive()
    }
}

/// The cluster fields a kubeconfig may carry here.
const CLUSTER_KEYS: [&str; 3] = ["server", "certificate-authority-data", "tls-server-name"];
/// The user fields a kubeconfig may carry here.
const USER_KEYS: [&str; 3] = ["token", "client-certificate-data", "client-key-data"];

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// The entry named `name` in a kubeconfig list (`clusters`, `users`,
/// `contexts`), unwrapped from its `{name, <kind>: …}` envelope.
fn named<'a>(doc: &'a Value, list: &str, kind: &str, name: &str) -> anyhow::Result<&'a Value> {
    doc.get(list)
        .and_then(Value::as_sequence)
        .and_then(|items| {
            items
                .iter()
                .find(|i| i.get("name").and_then(Value::as_str) == Some(name))
        })
        .and_then(|i| i.get(kind))
        .ok_or_else(|| anyhow!("the kubeconfig has no {kind} '{name}'"))
}

/// Refuse every key of `v` outside `allowed` that has a value, naming them.
fn only(v: &Value, allowed: &[&str], what: &str) -> anyhow::Result<()> {
    let Some(map) = v.as_mapping() else {
        bail!("the kubeconfig's {what} is not a mapping");
    };
    let extra: Vec<String> = map
        .iter()
        .filter(|(_, value)| !value.is_null())
        .filter_map(|(k, _)| k.as_str())
        .filter(|k| !allowed.contains(k))
        .map(str::to_owned)
        .collect();
    if extra.is_empty() {
        Ok(())
    } else {
        Err(anyhow!(
            "the kubeconfig's {what} uses {}, which the server does not run or read: \
             give it a service-account token, or inline data only ({})",
            extra.join(", "),
            allowed.join(", ")
        ))
    }
}

/// `https://host:port` without a trailing slash, for comparing addresses.
fn same_server(a: &str, b: &str) -> bool {
    a.trim().trim_end_matches('/') == b.trim().trim_end_matches('/')
}

impl ClusterAccess {
    /// Read a connection's credential: a bare token, or a kubeconfig whose
    /// current context (or only context) is used.
    pub fn parse(base_url: &str, secret: &str) -> anyhow::Result<Self> {
        let server = base_url.trim().trim_end_matches('/').to_owned();
        if !server.starts_with("https://") {
            bail!("a cluster's address is an https:// URL");
        }
        let secret = secret.trim();
        if secret.is_empty() {
            bail!("the credential is empty: paste a service-account token or a kubeconfig");
        }
        if !secret.contains('\n') && !secret.contains(':') {
            return Ok(Self {
                server,
                ca_data: None,
                token: Some(secret.to_owned()),
                client_certificate_data: None,
                client_key_data: None,
            });
        }
        let doc: Value = serde_yaml::from_str(secret)
            .context("the credential is neither a token nor a kubeconfig")?;
        let context_name = match text(&doc, "current-context") {
            Some(c) => c,
            None => {
                let contexts = doc
                    .get("contexts")
                    .and_then(Value::as_sequence)
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                match contexts {
                    [one] => one
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    _ => bail!(
                        "the kubeconfig names no current-context and has not exactly one context"
                    ),
                }
            }
        };
        let context = named(&doc, "contexts", "context", &context_name)?;
        let cluster_name =
            text(context, "cluster").ok_or_else(|| anyhow!("the context names no cluster"))?;
        let user_name =
            text(context, "user").ok_or_else(|| anyhow!("the context names no user"))?;
        let cluster = named(&doc, "clusters", "cluster", &cluster_name)?;
        let user = named(&doc, "users", "user", &user_name)?;
        only(cluster, &CLUSTER_KEYS, "cluster")?;
        only(user, &USER_KEYS, "user")?;
        if let Some(theirs) = text(cluster, "server")
            && !same_server(&theirs, &server)
        {
            bail!(
                "the kubeconfig points at {theirs}, the connection at {server}: \
                 set the connection's address to the cluster's"
            );
        }
        let access = Self {
            server,
            ca_data: text(cluster, "certificate-authority-data"),
            token: text(user, "token"),
            client_certificate_data: text(user, "client-certificate-data"),
            client_key_data: text(user, "client-key-data"),
        };
        let cert = access.client_certificate_data.is_some() && access.client_key_data.is_some();
        if access.token.is_none() && !cert {
            bail!(
                "the kubeconfig's user has neither a token nor an inline client certificate and key"
            );
        }
        Ok(access)
    }

    /// A kubeconfig holding exactly this access, for `helm --kubeconfig`.
    /// Secret: written to a file only the server reads, and removed after.
    pub fn kubeconfig_yaml(&self) -> String {
        let mut cluster = serde_json::json!({ "server": self.server });
        if let Some(ca) = &self.ca_data {
            cluster["certificate-authority-data"] = ca.clone().into();
        }
        let mut user = serde_json::Map::new();
        if let Some(t) = &self.token {
            user.insert("token".into(), t.clone().into());
        }
        if let Some(c) = &self.client_certificate_data {
            user.insert("client-certificate-data".into(), c.clone().into());
        }
        if let Some(k) = &self.client_key_data {
            user.insert("client-key-data".into(), k.clone().into());
        }
        let doc = serde_json::json!({
            "apiVersion": "v1",
            "kind": "Config",
            "clusters": [{ "name": "studio", "cluster": cluster }],
            "users": [{ "name": "studio", "user": user }],
            "contexts": [{ "name": "studio", "context": { "cluster": "studio", "user": "studio" } }],
            "current-context": "studio",
        });
        serde_yaml::to_string(&doc).unwrap_or_default()
    }

    /// A client for the cluster's API.
    pub async fn client(&self) -> anyhow::Result<kube::Client> {
        let kubeconfig = kube::config::Kubeconfig::from_yaml(&self.kubeconfig_yaml())
            .map_err(|e| anyhow!("cannot read the cluster's access: {e}"))?;
        let config = kube::Config::from_custom_kubeconfig(
            kubeconfig,
            &kube::config::KubeConfigOptions::default(),
        )
        .await
        .map_err(|e| anyhow!("cannot read the cluster's access: {e}"))?;
        kube::Client::try_from(config).map_err(|e| anyhow!("cannot reach the cluster: {e}"))
    }
}

/* ── how far a cluster is bootstrapped (ADR-0062 §6) ── */

/// The label the bootstrap manifest puts on its ClusterRole, with its version.
pub const BOOTSTRAP_VERSION_LABEL: &str = "studio.constructor.tech/bootstrap-version";
/// The version of `deploy/k8s/studio-environments/bootstrap.yaml` this Studio
/// needs: 2 lets the account read its own ClusterRole, so the version can be
/// told at all.
pub const BOOTSTRAP_VERSION: u32 = 2;
/// The ClusterRole the manifest makes.
pub const BOOTSTRAP_CLUSTER_ROLE: &str = "constructor-studio-environments";

/// How far a cluster lets Studio go, as its connection is asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Readiness {
    /// The current manifest is applied: Studio makes each project's namespace,
    /// and the admission policy holds it to Studio's own.
    Bootstrapped { version: u32 },
    /// Studio may not make namespaces, but works in these, which the cluster
    /// gives it: each project is assigned one of them.
    NamespaceLimited { namespaces: Vec<String> },
    /// Something the manifest gives is missing, each said as what to do.
    Partial { missing: Vec<String> },
}

impl Readiness {
    pub fn level(&self) -> &'static str {
        match self {
            Self::Bootstrapped { .. } => "bootstrapped",
            Self::NamespaceLimited { .. } => "namespace_limited",
            Self::Partial { .. } => "partial",
        }
    }
}

/// What [`cluster_readiness`] found, beside the level.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadinessReport {
    pub readiness: Readiness,
    /// The version the ClusterRole's label says; `None` when it could not
    /// be read or has none.
    pub version: Option<u32>,
    /// Whether the admission policy refused a namespace without Studio's
    /// label, asked as a dry run.
    pub policy_enforced: bool,
}

/// What a cluster says to each question [`cluster_readiness`] asks: the
/// decision, apart from the asking, so it is tested without a cluster.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReadinessFacts {
    /// The bootstrap rights the connection lacks, described.
    pub denied: Vec<String>,
    /// Whether a dry-run create of an unlabelled namespace was refused by the
    /// policy; `None` when it was not asked (no create right).
    pub policy_refused_unlabelled: Option<bool>,
    pub version: Option<u32>,
    /// The namespaces the environment says the cluster gives, with whether
    /// the connection may work in each.
    pub given: Vec<(String, bool)>,
}

/// The level `f` comes to.
pub fn readiness_of(f: &ReadinessFacts) -> ReadinessReport {
    let usable: Vec<String> = f
        .given
        .iter()
        .filter(|(_, ok)| *ok)
        .map(|(n, _)| n.clone())
        .collect();
    let readiness = if f.denied.is_empty() {
        let mut missing = Vec::new();
        if f.policy_refused_unlabelled != Some(true) {
            missing.push(format!(
                "the admission policy of {BOOTSTRAP_FILE}: a namespace without Studio's label was \
                 not refused, so the account could take a namespace that is not Studio's"
            ));
        }
        match f.version {
            Some(v) if v >= BOOTSTRAP_VERSION => {}
            Some(v) => missing.push(format!(
                "bootstrap version {BOOTSTRAP_VERSION} (the cluster has {v}): apply the current \
                 {BOOTSTRAP_FILE}"
            )),
            None => missing.push(format!(
                "the bootstrap version label on ClusterRole {BOOTSTRAP_CLUSTER_ROLE}: apply the \
                 current {BOOTSTRAP_FILE}"
            )),
        }
        if missing.is_empty() {
            Readiness::Bootstrapped {
                version: f.version.unwrap_or(BOOTSTRAP_VERSION),
            }
        } else {
            Readiness::Partial { missing }
        }
    } else if !usable.is_empty() {
        Readiness::NamespaceLimited { namespaces: usable }
    } else {
        let mut missing: Vec<String> = f.denied.clone();
        for (n, ok) in &f.given {
            if !ok {
                missing.push(format!("create secrets, jobs and deployments in {n}"));
            }
        }
        Readiness::Partial { missing }
    };
    ReadinessReport {
        readiness,
        version: f.version,
        policy_enforced: f.policy_refused_unlabelled == Some(true),
    }
}

/// Ask the cluster how far it is bootstrapped: the manifest's rights (one
/// SelfSubjectAccessReview each), a dry-run create of a namespace without
/// Studio's label (which the policy must refuse), and the version label on
/// the manifest's ClusterRole. `given` are the namespaces an environment says
/// the cluster gives without a create right.
pub async fn cluster_readiness(
    client: &kube::Client,
    given: &[String],
) -> anyhow::Result<ReadinessReport> {
    use k8s_openapi::api::core::v1::Namespace;
    use k8s_openapi::api::rbac::v1::ClusterRole;
    let mut facts = ReadinessFacts::default();
    for right in BOOTSTRAP_RIGHTS {
        if !right.allowed(client, None).await? {
            facts.denied.push(right.describe(None));
        }
    }
    if facts.denied.is_empty() {
        let probe = Namespace {
            metadata: kube::api::ObjectMeta {
                name: Some(format!(
                    "studio-readiness-{}",
                    &uuid::Uuid::new_v4().simple().to_string()[..8]
                )),
                ..Default::default()
            },
            ..Default::default()
        };
        let dry = kube::api::PostParams {
            dry_run: true,
            ..Default::default()
        };
        facts.policy_refused_unlabelled = Some(
            match kube::Api::<Namespace>::all(client.clone())
                .create(&dry, &probe)
                .await
            {
                Ok(_) => false,
                // The policy's own refusal: a plain RBAC 403 was ruled out by
                // the access review above.
                Err(kube::Error::Api(s)) => matches!(s.code, 400 | 403 | 422),
                Err(e) => return Err(anyhow!("the cluster did not answer: {e}")),
            },
        );
    }
    facts.version = match kube::Api::<ClusterRole>::all(client.clone())
        .get_opt(BOOTSTRAP_CLUSTER_ROLE)
        .await
    {
        Ok(Some(role)) => role
            .metadata
            .labels
            .as_ref()
            .and_then(|l| l.get(BOOTSTRAP_VERSION_LABEL))
            .and_then(|v| v.parse().ok()),
        _ => None,
    };
    for ns in given {
        let mut ok = true;
        for right in NAMESPACE_RIGHTS {
            if !right.allowed(client, Some(ns)).await? {
                ok = false;
                break;
            }
        }
        facts.given.push((ns.clone(), ok));
    }
    Ok(readiness_of(&facts))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "https://k8s.acme.example:6443";

    fn kubeconfig(cluster: &str, user: &str) -> String {
        format!(
            "apiVersion: v1\nkind: Config\ncurrent-context: c\n\
             contexts:\n- name: c\n  context: {{cluster: k, user: u}}\n\
             clusters:\n- name: k\n  cluster:\n    server: {SERVER}\n{cluster}\
             users:\n- name: u\n  user:\n{user}"
        )
    }

    #[test]
    fn a_bare_token_is_a_token() {
        let a = ClusterAccess::parse(SERVER, " eyJhbGciOiJSUzI1NiJ9.abc.def \n").unwrap();
        assert!(
            a.kubeconfig_yaml()
                .contains("token: eyJhbGciOiJSUzI1NiJ9.abc.def")
        );
    }

    #[test]
    fn a_kubeconfig_gives_its_ca_and_token() {
        let a = ClusterAccess::parse(
            SERVER,
            &kubeconfig("    certificate-authority-data: Q0E=\n", "    token: t0k\n"),
        )
        .unwrap();
        let yaml = a.kubeconfig_yaml();
        assert!(yaml.contains("certificate-authority-data: Q0E="));
        assert!(yaml.contains("token: t0k"));
        assert!(
            format!("{a:?}").find("t0k").is_none(),
            "Debug must not print the token"
        );
    }

    #[test]
    fn a_kubeconfig_that_runs_or_reads_something_is_refused() {
        for (cluster, user) in [
            (
                "",
                "    exec: {command: aws, apiVersion: client.authentication.k8s.io/v1}\n",
            ),
            ("", "    tokenFile: /var/run/secrets/token\n"),
            ("    certificate-authority: /etc/ca.pem\n", "    token: t\n"),
            ("    insecure-skip-tls-verify: true\n", "    token: t\n"),
            ("", "    auth-provider: {name: gcp}\n"),
        ] {
            let e = ClusterAccess::parse(SERVER, &kubeconfig(cluster, user)).unwrap_err();
            assert!(e.to_string().contains("does not run or read"), "{e}");
        }
    }

    #[test]
    fn a_kubeconfig_for_another_server_is_refused() {
        let e = ClusterAccess::parse(
            "https://other.example:6443",
            &kubeconfig("", "    token: t\n"),
        )
        .unwrap_err();
        assert!(e.to_string().contains("points at"), "{e}");
    }

    #[test]
    fn a_user_without_credentials_is_refused() {
        let e = ClusterAccess::parse(SERVER, &kubeconfig("", "    {}\n")).unwrap_err();
        assert!(e.to_string().contains("neither a token"), "{e}");
    }

    #[test]
    fn a_right_reads_as_what_it_lets_the_connection_do() {
        assert_eq!(BOOTSTRAP_RIGHTS[0].describe(None), "create namespaces");
        assert_eq!(BOOTSTRAP_RIGHTS[1].describe(None), "create rolebindings");
        assert_eq!(
            BOOTSTRAP_RIGHTS[2].describe(None),
            "bind clusterroles/admin"
        );
        assert_eq!(
            NAMESPACE_RIGHTS[0].describe(Some("shop-dev")),
            "create secrets in shop-dev"
        );
        assert_eq!(
            NAMESPACE_RIGHTS[1].describe(Some("shop-dev")),
            "create jobs.batch in shop-dev"
        );
    }

    #[test]
    fn a_missing_bootstrap_right_is_reported_with_the_manifest_not_failed() {
        let held = bootstrap_check(&BOOTSTRAP_RIGHTS[0], true);
        assert!(held.ok && held.detail.is_empty());
        let missing = bootstrap_check(&BOOTSTRAP_RIGHTS[0], false);
        assert!(!missing.ok);
        assert!(
            missing.detail.contains(BOOTSTRAP_FILE),
            "{}",
            missing.detail
        );
    }

    #[test]
    fn a_cluster_is_bootstrapped_only_with_the_policy_and_the_current_version() {
        let full = ReadinessFacts {
            policy_refused_unlabelled: Some(true),
            version: Some(BOOTSTRAP_VERSION),
            ..ReadinessFacts::default()
        };
        assert_eq!(
            readiness_of(&full).readiness,
            Readiness::Bootstrapped {
                version: BOOTSTRAP_VERSION
            }
        );
        let no_policy = ReadinessFacts {
            policy_refused_unlabelled: Some(false),
            ..full.clone()
        };
        let Readiness::Partial { missing } = readiness_of(&no_policy).readiness else {
            panic!("partial");
        };
        assert!(missing[0].contains("admission policy"), "{missing:?}");
        let old = ReadinessFacts {
            version: Some(1),
            ..full.clone()
        };
        let Readiness::Partial { missing } = readiness_of(&old).readiness else {
            panic!("partial");
        };
        assert!(missing[0].contains("the cluster has 1"), "{missing:?}");
    }

    #[test]
    fn without_a_create_right_the_namespaces_the_cluster_gives_are_listed() {
        let limited = ReadinessFacts {
            denied: vec!["create namespaces".into()],
            given: vec![("shop-dev".into(), true), ("shop-test".into(), false)],
            ..ReadinessFacts::default()
        };
        assert_eq!(
            readiness_of(&limited).readiness,
            Readiness::NamespaceLimited {
                namespaces: vec!["shop-dev".into()]
            }
        );
        let none = ReadinessFacts {
            denied: vec!["create namespaces".into()],
            given: vec![("shop-test".into(), false)],
            ..ReadinessFacts::default()
        };
        let Readiness::Partial { missing } = readiness_of(&none).readiness else {
            panic!("partial");
        };
        assert_eq!(missing.len(), 2, "{missing:?}");
    }

    #[test]
    fn plain_http_is_refused() {
        assert!(ClusterAccess::parse("http://k8s.acme.example", "t").is_err());
    }
}
