//! What a deploy checks before and while it installs, so it fails in seconds
//! with the reason instead of after helm's whole wait with none.
//!
//! **Before.** The chart is rendered as it would be installed. Every secret
//! its workloads read and do not bring themselves must be in the namespace
//! once Studio has written its own (pull secret, configuration, database):
//! a missing one leaves the pod in `CreateContainerConfigError` until helm
//! gives up. A secret that holds a database password the environment does
//! not provide says so, and what to change.
//!
//! **While.** helm waits for the release; the pods are read beside it. A
//! container that cannot start -- its configuration names something that is
//! not there, its image cannot be pulled, it keeps crashing -- and still
//! cannot on the next look ends the install with that container's reason.
//!
//! **After an interrupted run.** A release left `pending-*` refuses every
//! later install ("another operation is in progress"). It is put back first:
//! a pending install is removed (it never ran), a pending upgrade or rollback
//! rolled back to the last revision that did.

use std::collections::{BTreeMap, BTreeSet};

use k8s_openapi::api::core::v1::Pod;
use serde::Deserialize as _;
use serde_yaml::Value;

use super::database::ServerNeed;
use super::model::DatabaseMode;

/// One secret the chart's workloads read, and the keys they read of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretUse {
    pub secret: String,
    /// Empty when the whole secret is read (`envFrom`, a volume).
    pub keys: BTreeSet<String>,
}

/// The pod templates of a rendered manifest.
fn pod_spec(doc: &Value) -> Option<&Value> {
    let spec = doc.get("spec")?;
    match doc.get("kind").and_then(Value::as_str)? {
        "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet" | "Job" => {
            spec.get("template")?.get("spec")
        }
        "CronJob" => spec
            .get("jobTemplate")?
            .get("spec")?
            .get("template")?
            .get("spec"),
        "Pod" => Some(spec),
        _ => None,
    }
}

fn optional(v: &Value) -> bool {
    v.get("optional").and_then(Value::as_bool) == Some(true)
}

fn seq(v: Option<&Value>) -> Vec<Value> {
    v.and_then(Value::as_sequence).cloned().unwrap_or_default()
}

/// The secrets the rendered chart's workloads need and the chart does not
/// create itself. Optional references are left out: a pod starts without them.
pub fn secrets_read(rendered: &str) -> Vec<SecretUse> {
    let mut read: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut created: BTreeSet<String> = BTreeSet::new();
    for doc in serde_yaml::Deserializer::from_str(rendered) {
        // A document that does not parse ends the stream: serde_yaml's
        // iterator answers the same error again forever rather than move on.
        let Ok(doc) = Value::deserialize(doc) else {
            break;
        };
        if doc.get("kind").and_then(Value::as_str) == Some("Secret") {
            if let Some(name) = doc
                .get("metadata")
                .and_then(|m| m.get("name"))
                .and_then(Value::as_str)
            {
                created.insert(name.to_owned());
            }
            continue;
        }
        let Some(spec) = pod_spec(&doc) else {
            continue;
        };
        let containers = seq(spec.get("containers"))
            .into_iter()
            .chain(seq(spec.get("initContainers")));
        for c in containers {
            for e in seq(c.get("env")) {
                let Some(r) = e.get("valueFrom").and_then(|v| v.get("secretKeyRef")) else {
                    continue;
                };
                if optional(r) {
                    continue;
                }
                if let Some(name) = r.get("name").and_then(Value::as_str) {
                    let keys = read.entry(name.to_owned()).or_default();
                    if let Some(key) = r.get("key").and_then(Value::as_str) {
                        keys.insert(key.to_owned());
                    }
                }
            }
            for e in seq(c.get("envFrom")) {
                let Some(r) = e.get("secretRef") else {
                    continue;
                };
                if optional(r) {
                    continue;
                }
                if let Some(name) = r.get("name").and_then(Value::as_str) {
                    read.entry(name.to_owned()).or_default();
                }
            }
        }
        for v in seq(spec.get("volumes")) {
            let Some(s) = v.get("secret") else { continue };
            if optional(s) {
                continue;
            }
            if let Some(name) = s.get("secretName").and_then(Value::as_str) {
                read.entry(name.to_owned()).or_default();
            }
        }
    }
    read.into_iter()
        .filter(|(name, _)| !created.contains(name))
        .map(|(secret, keys)| SecretUse { secret, keys })
        .collect()
}

/// Why the install would not start, or `None`: the secrets the chart reads
/// that the namespace does not have, each with what provides it.
pub fn missing_secrets(
    reads: &[SecretUse],
    present: &BTreeSet<String>,
    databases: &[ServerNeed],
    mode: DatabaseMode,
    namespace: &str,
) -> Option<String> {
    let missing: Vec<&SecretUse> = reads
        .iter()
        .filter(|r| !present.contains(&r.secret))
        .collect();
    if missing.is_empty() {
        return None;
    }
    let lines: Vec<String> = missing
        .iter()
        .map(|r| {
            let keys = if r.keys.is_empty() {
                String::new()
            } else {
                format!(" ({})", r.keys.iter().cloned().collect::<Vec<_>>().join(", "))
            };
            let db = databases.iter().find(|d| d.secrets.contains(&r.secret));
            match (db, mode) {
                (Some(d), DatabaseMode::None | DatabaseMode::Namespace) => format!(
                    "secret {}{keys} holds the password of Postgres '{}', which Studio was to prepare and did not",
                    r.secret, d.host
                ),
                (Some(d), DatabaseMode::Shared) => format!(
                    "secret {}{keys} holds the password of Postgres '{}' ({} database(s)), and the environment gives no database: set its database to the product's own, or create the secret",
                    r.secret,
                    d.host,
                    d.databases.len()
                ),
                (None, _) => format!(
                    "secret {}{keys} is read by the chart and nothing creates it: add it to the release's configuration secrets, or create it",
                    r.secret
                ),
            }
        })
        .collect();
    Some(format!(
        "namespace {namespace} lacks what the chart reads, so its pods could not start: {}",
        lines.join("; ")
    ))
}

/// One container that is not running, as its pod reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Waiting {
    pub pod: String,
    pub container: String,
    pub reason: String,
    pub message: String,
    pub restarts: i32,
    /// How it ended last, for one that keeps crashing: `exit 1 (Error)`.
    pub last_exit: Option<String>,
}

/// The containers of a pod that wait instead of running.
pub fn waiting(pod: &Pod) -> Vec<Waiting> {
    let name = pod.metadata.name.clone().unwrap_or_default();
    let Some(status) = &pod.status else {
        return Vec::new();
    };
    let statuses = status
        .init_container_statuses
        .iter()
        .flatten()
        .chain(status.container_statuses.iter().flatten());
    statuses
        .filter_map(|c| {
            let w = c.state.as_ref()?.waiting.as_ref()?;
            let last_exit = c
                .last_state
                .as_ref()
                .and_then(|s| s.terminated.as_ref())
                .map(|t| match &t.reason {
                    Some(r) => format!("exit {} ({r})", t.exit_code),
                    None => format!("exit {}", t.exit_code),
                });
            Some(Waiting {
                pod: name.clone(),
                container: c.name.clone(),
                reason: w.reason.clone().unwrap_or_default(),
                message: w.message.clone().unwrap_or_default(),
                restarts: c.restart_count,
                last_exit,
            })
        })
        .collect()
}

/// How often a crashing container restarts before the install stops waiting for it.
const CRASHES: i32 = 3;

/// Whether a waiting container will not start by itself, and why. Pulling,
/// creating and a first crash are not: they pass.
pub fn cannot_start(w: &Waiting) -> Option<String> {
    let fatal = match w.reason.as_str() {
        "CreateContainerConfigError"
        | "CreateContainerError"
        | "InvalidImageName"
        | "ErrImageNeverPull"
        | "ImagePullBackOff" => true,
        "CrashLoopBackOff" => w.restarts >= CRASHES,
        _ => false,
    };
    if !fatal {
        return None;
    }
    let mut why = format!("pod {} container {}: {}", w.pod, w.container, w.reason);
    if !w.message.is_empty() {
        why.push_str(": ");
        why.push_str(&first_line(&w.message, 300));
    }
    if w.reason == "CrashLoopBackOff"
        && let Some(exit) = &w.last_exit
    {
        why.push_str(&format!(", restarted {} times, last {exit}", w.restarts));
    }
    Some(why)
}

fn first_line(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or_default().trim();
    match line.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &line[..i]),
        None => line.to_owned(),
    }
}

/// Looks at the pods again and again; says why once a container could not
/// start on two looks in a row, so a state the kubelet is passing through
/// (a secret written a moment late) does not end the install.
#[derive(Debug, Default)]
pub struct StartWatch {
    seen: BTreeMap<(String, String), String>,
}

impl StartWatch {
    pub fn look(&mut self, now: &[Waiting]) -> Option<String> {
        let mut next = BTreeMap::new();
        let mut found = None;
        for w in now {
            let Some(why) = cannot_start(w) else { continue };
            let key = (w.pod.clone(), w.container.clone());
            if found.is_none() && self.seen.contains_key(&key) {
                found = Some(why.clone());
            }
            next.insert(key, why);
        }
        self.seen = next;
        found
    }
}

/// What a release's status asks of the next install: nothing, or the helm
/// arguments (after the command's own) that put it back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unstick {
    None,
    /// `pending-install`: it never ran; remove it.
    Uninstall,
    /// `pending-upgrade`, `pending-rollback`: back to the last good revision.
    Rollback,
}

/// From `helm status -o json`; a release that is not there needs nothing.
pub fn unstick(status_json: &str) -> Unstick {
    let status = serde_json::from_str::<serde_json::Value>(status_json)
        .ok()
        .and_then(|v| {
            v.get("info")
                .and_then(|i| i.get("status"))
                .and_then(|s| s.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_default();
    match status.as_str() {
        "pending-install" => Unstick::Uninstall,
        "pending-upgrade" | "pending-rollback" => Unstick::Rollback,
        _ => Unstick::None,
    }
}

/// What a rollout's pods say is wrong, for the status read back on demand:
/// every container that cannot start, one line each.
pub fn problems(pods: &[Pod]) -> Vec<String> {
    pods.iter()
        .flat_map(waiting)
        .filter_map(|w| cannot_start(&w))
        .collect()
}

/* ── the product's own identity provider (ADR-0062 §9) ── */

/// A product whose OIDC settings point at Studio's own identity provider:
/// a product signs its people in with an IdP of its own, never the
/// platform's realm or the platform's clients.
pub const PRODUCT_USES_PLATFORM_IDP: &str = "PRODUCT_USES_PLATFORM_IDP";

/// Studio's own first-party OIDC clients: a product that names one would
/// sign its people in as Studio.
pub const PLATFORM_CLIENTS: [&str; 3] = ["studio-portal", "studio-desktop", "studio-cli"];

/// The OIDC settings a text says: `(issuers, clients)`, read from the keys a
/// product's description, values or rendered chart write them under
/// (`issuer`, `issuer_url`, `oidc_issuer`, `client_id`, `audience`, in
/// snake or camel case, `=` or `:`).
pub fn oidc_settings(text: &str) -> (Vec<String>, Vec<String>) {
    const ISSUER: [&str; 5] = [
        "issuer_url",
        "issuerurl",
        "oidc_issuer",
        "issuer_uri",
        "issuer",
    ];
    const CLIENT: [&str; 4] = ["client_id", "clientid", "audience", "oidc_client_id"];
    let mut issuers = Vec::new();
    let mut clients = Vec::new();
    for line in text.lines() {
        let Some((k, v)) = line.split_once(['=', ':']) else {
            continue;
        };
        let key = k
            .trim()
            .trim_matches(['"', '\'', '-', ' '])
            .to_ascii_lowercase()
            .replace('-', "_");
        let value = v
            .trim()
            .trim_end_matches([',', ';'])
            .trim()
            .trim_matches(['"', '\''])
            .trim()
            .to_owned();
        if value.is_empty() {
            continue;
        }
        let last = key.rsplit(['.', ' ']).next().unwrap_or(&key).to_owned();
        if ISSUER.contains(&last.as_str()) && value.starts_with("http") {
            issuers.push(value.trim_end_matches('/').to_owned());
        } else if ISSUER.iter().any(|i| key.ends_with(i)) && line.contains("https://") {
            if let Some(at) = line.find("https://") {
                let url: String = line[at..]
                    .chars()
                    .take_while(|c| !c.is_whitespace() && !matches!(c, '"' | '\'' | ','))
                    .collect();
                issuers.push(url.trim_end_matches('/').to_owned());
            }
        } else if CLIENT.contains(&last.as_str()) {
            clients.push(value);
        }
    }
    issuers.sort();
    issuers.dedup();
    clients.sort();
    clients.dedup();
    (issuers, clients)
}

/// Whether `text` makes the product sign in through Studio's own IdP:
/// its issuer is `studio_issuer`, or a client is one of Studio's.
pub fn platform_idp_refusal(
    text: &str,
    studio_issuer: Option<&str>,
) -> Option<(&'static str, String)> {
    let (issuers, clients) = oidc_settings(text);
    let studio = studio_issuer.map(|s| s.trim().trim_end_matches('/'));
    if let Some(s) = studio.filter(|s| !s.is_empty())
        && let Some(i) = issuers.iter().find(|i| i.as_str() == s)
    {
        return Some((
            PRODUCT_USES_PLATFORM_IDP,
            format!(
                "the product's OIDC issuer {i} is Studio's own: a product signs its people in \
                 with an identity provider of its own (its own realm), not the platform's"
            ),
        ));
    }
    if let Some(c) = clients
        .iter()
        .find(|c| PLATFORM_CLIENTS.contains(&c.as_str()))
    {
        return Some((
            PRODUCT_USES_PLATFORM_IDP,
            format!(
                "the product's OIDC client '{c}' is one of Studio's own: give the product a \
                 client of its own in its own realm"
            ),
        ));
    }
    None
}

/// Studio's own issuer, as its deployment names it.
pub fn studio_issuer() -> Option<String> {
    std::env::var("STUDIO_OIDC_ISSUER")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// Each issuer whose discovery document does not answer, with why: a
/// warning, since the IdP may be deployed with the product.
pub async fn unreachable_issuers(http: &reqwest::Client, text: &str) -> Vec<String> {
    let (issuers, _) = oidc_settings(text);
    let mut out = Vec::new();
    for i in issuers {
        let url = format!("{i}/.well-known/openid-configuration");
        let answered = http
            .get(&url)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
            .map(|r| r.status().is_success());
        if !matches!(answered, Ok(true)) {
            out.push(format!(
                "the product's OIDC issuer {i} does not answer {url}: sign-in will fail until it \
                 does (fine if the product brings its IdP with it)"
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_product_on_studios_own_idp_is_refused() {
        let gdl = "plugin oidc-authn-plugin {\n  issuer_url = \"https://id.example.com/realms/studio/\"\n  client_id = \"shop-web\"\n}\n";
        let (issuers, clients) = oidc_settings(gdl);
        assert_eq!(issuers, ["https://id.example.com/realms/studio"]);
        assert_eq!(clients, ["shop-web"]);
        let (code, why) =
            platform_idp_refusal(gdl, Some("https://id.example.com/realms/studio")).unwrap();
        assert_eq!(code, PRODUCT_USES_PLATFORM_IDP);
        assert!(why.contains("Studio's own"), "{why}");
        assert!(platform_idp_refusal(gdl, Some("https://id.example.com/realms/shop")).is_none());
        let yaml =
            "oidc:\n  issuer: https://id.example.com/realms/shop\n  clientId: studio-portal\n";
        let (code, why) = platform_idp_refusal(yaml, None).unwrap();
        assert_eq!(code, PRODUCT_USES_PLATFORM_IDP);
        assert!(why.contains("studio-portal"), "{why}");
        assert_eq!(
            oidc_settings(yaml).0,
            ["https://id.example.com/realms/shop"]
        );
    }

    const CHART: &str = r#"
apiVersion: v1
kind: Secret
metadata: { name: shop-own }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: shop-api }
spec:
  template:
    spec:
      initContainers:
        - name: migrate
          envFrom:
            - secretRef: { name: shop-config }
      containers:
        - name: api
          env:
            - name: GEARS_PG_PASSWORD
              valueFrom: { secretKeyRef: { name: shop-db, key: GEARS_PG_PASSWORD } }
            - name: TOKEN
              valueFrom: { secretKeyRef: { name: shop-own, key: token } }
            - name: MAYBE
              valueFrom: { secretKeyRef: { name: shop-extra, key: x, optional: true } }
            - name: PLAIN
              value: "1"
      volumes:
        - name: tls
          secret: { secretName: shop-tls }
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: shop-sweep }
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: sweep
              env:
                - name: GEARS_PG_PASSWORD
                  valueFrom: { secretKeyRef: { name: shop-db, key: GEARS_PG_PASSWORD } }
"#;

    fn need(secret: &str) -> ServerNeed {
        ServerNeed {
            host: "postgres".into(),
            port: 5432,
            user: "gears".into(),
            password_env: "GEARS_PG_PASSWORD".into(),
            secrets: [secret.to_owned()].into(),
            databases: ["orders".to_owned(), "users".to_owned()].into(),
        }
    }

    fn names(reads: &[SecretUse]) -> Vec<&str> {
        reads.iter().map(|r| r.secret.as_str()).collect()
    }

    #[test]
    fn the_secrets_a_chart_reads_are_its_workloads_required_ones_it_does_not_create() {
        let reads = secrets_read(CHART);
        assert_eq!(names(&reads), ["shop-config", "shop-db", "shop-tls"]);
        let db = reads.iter().find(|r| r.secret == "shop-db").unwrap();
        assert_eq!(db.keys, ["GEARS_PG_PASSWORD".to_owned()].into());
        assert!(
            reads
                .iter()
                .find(|r| r.secret == "shop-config")
                .unwrap()
                .keys
                .is_empty()
        );
    }

    #[test]
    fn a_chart_that_reads_no_secret_or_does_not_parse_needs_none() {
        assert!(secrets_read("kind: ConfigMap\nmetadata: { name: x }\n").is_empty());
        assert!(secrets_read(": : not yaml [").is_empty());
        assert!(secrets_read("").is_empty());
    }

    #[test]
    fn nothing_is_missing_when_the_namespace_has_every_secret() {
        let reads = secrets_read(CHART);
        let present: BTreeSet<String> = ["shop-config", "shop-db", "shop-tls", "unrelated"]
            .map(str::to_owned)
            .into();
        assert_eq!(
            missing_secrets(&reads, &present, &[], DatabaseMode::None, "shop-dev"),
            None
        );
    }

    #[test]
    fn a_missing_database_secret_without_a_database_says_to_give_the_environment_one() {
        let reads = secrets_read(CHART);
        let present: BTreeSet<String> = ["shop-config", "shop-tls"].map(str::to_owned).into();
        let why = missing_secrets(
            &reads,
            &present,
            &[need("shop-db")],
            DatabaseMode::Shared,
            "shop-dev",
        )
        .unwrap();
        assert!(why.starts_with("namespace shop-dev lacks"), "{why}");
        assert!(why.contains("secret shop-db (GEARS_PG_PASSWORD)"), "{why}");
        assert!(why.contains("Postgres 'postgres' (2 database(s))"), "{why}");
        assert!(
            why.contains("set its database to the product's own"),
            "{why}"
        );
    }

    #[test]
    fn a_missing_database_secret_in_namespace_mode_is_studios_own_failure() {
        let reads = secrets_read(CHART);
        let present: BTreeSet<String> = ["shop-config", "shop-tls"].map(str::to_owned).into();
        let why = missing_secrets(
            &reads,
            &present,
            &[need("shop-db")],
            DatabaseMode::Namespace,
            "shop-dev",
        )
        .unwrap();
        assert!(why.contains("Studio was to prepare and did not"), "{why}");
    }

    #[test]
    fn any_other_missing_secret_says_nothing_creates_it() {
        let reads = secrets_read(CHART);
        let present: BTreeSet<String> = ["shop-db", "shop-config"].map(str::to_owned).into();
        let why = missing_secrets(&reads, &present, &[], DatabaseMode::None, "shop-dev").unwrap();
        assert!(
            why.contains("secret shop-tls is read by the chart and nothing creates it"),
            "{why}"
        );
        assert!(!why.contains("shop-db"), "{why}");
    }

    fn pod(json: serde_json::Value) -> Pod {
        serde_json::from_value(json).unwrap()
    }

    fn config_error_pod() -> Pod {
        pod(serde_json::json!({
            "metadata": { "name": "shop-api-7c9" },
            "status": { "containerStatuses": [{
                "name": "api", "image": "x", "imageID": "", "ready": false, "restartCount": 0,
                "state": { "waiting": { "reason": "CreateContainerConfigError",
                    "message": "secret \"shop-db\" not found" } }
            }]}
        }))
    }

    fn crashing_pod(restarts: i32) -> Pod {
        pod(serde_json::json!({
            "metadata": { "name": "shop-api-7c9" },
            "status": { "containerStatuses": [{
                "name": "api", "image": "x", "imageID": "", "ready": false, "restartCount": restarts,
                "state": { "waiting": { "reason": "CrashLoopBackOff", "message": "back-off 40s" } },
                "lastState": { "terminated": { "exitCode": 1, "reason": "Error" } }
            }]}
        }))
    }

    #[test]
    fn a_container_without_its_configuration_cannot_start() {
        let why = problems(&[config_error_pod()]);
        assert_eq!(
            why,
            [
                "pod shop-api-7c9 container api: CreateContainerConfigError: secret \"shop-db\" not found"
            ]
        );
    }

    #[test]
    fn a_crash_is_a_problem_only_after_it_kept_crashing() {
        assert!(problems(&[crashing_pod(1)]).is_empty());
        let why = problems(&[crashing_pod(3)]);
        assert_eq!(why.len(), 1);
        assert!(
            why[0].ends_with("restarted 3 times, last exit 1 (Error)"),
            "{}",
            why[0]
        );
    }

    #[test]
    fn pulling_creating_and_running_are_not_problems() {
        let pulling = pod(serde_json::json!({
            "metadata": { "name": "p" },
            "status": { "containerStatuses": [
                { "name": "a", "image": "x", "imageID": "", "ready": false, "restartCount": 0,
                  "state": { "waiting": { "reason": "ContainerCreating" } } },
                { "name": "b", "image": "x", "imageID": "", "ready": false, "restartCount": 0,
                  "state": { "waiting": { "reason": "ErrImagePull" } } },
                { "name": "c", "image": "x", "imageID": "", "ready": true, "restartCount": 0,
                  "state": { "running": {} } }
            ]}
        }));
        assert!(
            problems(&[
                pulling,
                pod(serde_json::json!({ "metadata": { "name": "q" } }))
            ])
            .is_empty()
        );
    }

    #[test]
    fn the_watch_waits_for_a_second_look_before_it_gives_up() {
        let mut watch = StartWatch::default();
        let stuck = waiting(&config_error_pod());
        assert_eq!(watch.look(&stuck), None);
        let why = watch.look(&stuck).unwrap();
        assert!(why.contains("CreateContainerConfigError"), "{why}");
    }

    #[test]
    fn a_container_that_recovered_between_looks_starts_the_count_again() {
        let mut watch = StartWatch::default();
        let stuck = waiting(&config_error_pod());
        assert_eq!(watch.look(&stuck), None);
        assert_eq!(watch.look(&[]), None);
        assert_eq!(watch.look(&stuck), None);
        assert!(watch.look(&stuck).is_some());
    }

    #[test]
    fn a_long_message_is_cut_to_its_first_line() {
        let mut w = waiting(&config_error_pod()).remove(0);
        w.message = format!("{}\nsecond line", "x".repeat(400));
        let why = cannot_start(&w).unwrap();
        assert!(why.ends_with("…"), "{why}");
        assert!(!why.contains("second line"), "{why}");
    }

    #[test]
    fn an_interrupted_release_is_put_back_before_the_next_install() {
        let s = |status: &str| format!(r#"{{"name":"shop","info":{{"status":"{status}"}}}}"#);
        assert_eq!(unstick(&s("pending-install")), Unstick::Uninstall);
        assert_eq!(unstick(&s("pending-upgrade")), Unstick::Rollback);
        assert_eq!(unstick(&s("pending-rollback")), Unstick::Rollback);
        assert_eq!(unstick(&s("deployed")), Unstick::None);
        assert_eq!(unstick(&s("failed")), Unstick::None);
        assert_eq!(unstick(""), Unstick::None);
    }
}
