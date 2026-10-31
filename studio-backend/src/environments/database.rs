//! A product's database in its namespace (ADR-0048 §7).
//!
//! A generated chart says what it needs in the configuration it carries: a
//! `database.servers` entry per server (host, port, user, and the password as
//! `${NAME}`), a `dbname` per gear that keeps data, and the secret each
//! application reads that password from (`existingSecret`, key `NAME`). The
//! host is the profile's -- `postgres` unless somebody changed it -- and the
//! names are fixed by the gears, so two projects could not share one server
//! without their databases colliding.
//!
//! So a product whose gears keep data gets a Postgres of its own with every
//! deploy (an environment's `shared` mode aside), in the project's
//! namespace, under the name the profile gives the host: a StatefulSet with a volume, a Service, and its
//! password in a secret Studio keeps there. Before each install the run
//! renders the chart (`helm template`, the same chart and values), reads what
//! it needs with [`needs`], makes sure the server runs, creates the databases
//! that are missing with a Job, and writes the password into the secret the
//! chart reads. Nothing here keeps the password anywhere else: the secret in
//! the namespace is where it lives, and a later deploy reuses it.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use anyhow::{anyhow, bail};
use k8s_openapi::api::apps::v1::StatefulSet;
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{Secret, Service};
use kube::api::{DeleteParams, Patch, PatchParams, PropagationPolicy};
use serde::Deserialize as _;
use serde_yaml::Value;

/// The image a namespace's Postgres runs, unless the environment names one.
/// pgvector, because graph-storage asks for the `vector` extension.
pub const DEFAULT_IMAGE: &str = "pgvector/pgvector:pg18";

/// The volume a namespace's Postgres gets.
const STORAGE: &str = "10Gi";

/// The field manager this module writes as.
const MANAGER: &str = "constructor-studio";

/// One database server a chart's configuration names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerNeed {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// The variable the password is read from: `GEARS_PG_PASSWORD`.
    pub password_env: String,
    /// The secrets the applications read that variable from.
    pub secrets: BTreeSet<String>,
    /// The databases the gears on it keep.
    pub databases: BTreeSet<String>,
}

/// `${NAME}` → `NAME`.
fn env_name(v: &str) -> Option<String> {
    let name = v.trim().strip_prefix("${")?.strip_suffix('}')?;
    (!name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
        .then(|| name.to_owned())
}

/// What the rendered manifests of a chart need of databases: one entry per
/// server host, merged across the applications that name it.
pub fn needs(rendered: &str) -> anyhow::Result<Vec<ServerNeed>> {
    let mut servers: BTreeMap<String, ServerNeed> = BTreeMap::new();
    // env var -> secrets it is read from, across every workload.
    let mut secret_of: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for doc in serde_yaml::Deserializer::from_str(rendered) {
        let Ok(doc) = Value::deserialize(doc) else {
            continue;
        };
        match doc.get("kind").and_then(Value::as_str) {
            Some("ConfigMap") => {
                let Some(data) = doc.get("data").and_then(Value::as_mapping) else {
                    continue;
                };
                for text in data.values().filter_map(Value::as_str) {
                    let Ok(config) = serde_yaml::from_str::<Value>(text) else {
                        continue;
                    };
                    read_config(&config, &mut servers)?;
                }
            }
            Some("Deployment" | "StatefulSet") => {
                let containers = doc
                    .get("spec")
                    .and_then(|s| s.get("template"))
                    .and_then(|t| t.get("spec"))
                    .and_then(|s| s.get("containers"))
                    .and_then(Value::as_sequence)
                    .cloned()
                    .unwrap_or_default();
                for c in containers {
                    for e in c
                        .get("env")
                        .and_then(Value::as_sequence)
                        .cloned()
                        .unwrap_or_default()
                    {
                        let name = e.get("name").and_then(Value::as_str);
                        let secret = e
                            .get("valueFrom")
                            .and_then(|v| v.get("secretKeyRef"))
                            .and_then(|r| r.get("name"))
                            .and_then(Value::as_str);
                        if let (Some(name), Some(secret)) = (name, secret) {
                            secret_of
                                .entry(name.to_owned())
                                .or_default()
                                .insert(secret.to_owned());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let mut out: Vec<ServerNeed> = servers.into_values().collect();
    for s in &mut out {
        s.secrets = secret_of.get(&s.password_env).cloned().unwrap_or_default();
    }
    Ok(out)
}

/// The servers and databases one application's configuration names.
fn read_config(config: &Value, servers: &mut BTreeMap<String, ServerNeed>) -> anyhow::Result<()> {
    let Some(declared) = config
        .get("database")
        .and_then(|d| d.get("servers"))
        .and_then(Value::as_mapping)
    else {
        return Ok(());
    };
    // server key in this file -> host
    let mut host_of: BTreeMap<String, String> = BTreeMap::new();
    for (key, s) in declared {
        let Some(key) = key.as_str() else { continue };
        if s.get("engine")
            .and_then(Value::as_str)
            .is_some_and(|e| e != "postgres")
        {
            continue;
        }
        let host = s
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let user = s
            .get("user")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let Some(password_env) = s.get("password").and_then(Value::as_str).and_then(env_name)
        else {
            bail!("database server '{key}' does not read its password from a ${{NAME}}");
        };
        if host.is_empty() || user.is_empty() {
            bail!("database server '{key}' names no host or no user");
        }
        let port = s
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|p| u16::try_from(p).ok())
            .unwrap_or(5432);
        let entry = servers.entry(host.clone()).or_insert_with(|| ServerNeed {
            host: host.clone(),
            port,
            user: user.clone(),
            password_env: password_env.clone(),
            secrets: BTreeSet::new(),
            databases: BTreeSet::new(),
        });
        if entry.user != user || entry.password_env != password_env {
            bail!("applications name server '{host}' with different users or passwords");
        }
        host_of.insert(key.to_owned(), host);
    }
    if let Some(gears) = config.get("gears").and_then(Value::as_mapping) {
        for gear in gears.values() {
            let db = gear.get("database");
            let server = db.and_then(|d| d.get("server")).and_then(Value::as_str);
            let name = db.and_then(|d| d.get("dbname")).and_then(Value::as_str);
            if let (Some(server), Some(name)) = (server, name)
                && let Some(host) = host_of.get(server)
                && let Some(entry) = servers.get_mut(host)
            {
                entry.databases.insert(name.to_owned());
            }
        }
    }
    Ok(())
}

/// A database name or role Studio puts into SQL: what Postgres takes unquoted
/// and the gears use, so nothing needs escaping.
fn sql_name(v: &str) -> anyhow::Result<&str> {
    let ok = !v.is_empty()
        && v.len() <= 63
        && v.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && !v.as_bytes()[0].is_ascii_digit();
    if ok {
        Ok(v)
    } else {
        Err(anyhow!("'{v}' is not a database name Studio creates"))
    }
}

/// The script the Job runs: each missing database created, owned by the
/// server's user. `\gexec` because `CREATE DATABASE` takes no `IF NOT EXISTS`.
pub fn create_script(need: &ServerNeed) -> anyhow::Result<String> {
    let user = sql_name(&need.user)?;
    let mut sql = String::new();
    for db in &need.databases {
        let db = sql_name(db)?;
        sql.push_str(&format!(
            "SELECT 'CREATE DATABASE {db} OWNER {user}' WHERE NOT EXISTS \
             (SELECT FROM pg_database WHERE datname = '{db}')\\gexec\n"
        ));
    }
    Ok(sql)
}

/// The name the namespace's Postgres objects share, from the host it answers.
pub fn server_name(host: &str) -> String {
    format!("studio-postgres-{host}")
}

/// Whether `host` is a name inside the namespace: a Service Studio can be.
pub fn in_namespace(host: &str) -> bool {
    super::model::is_dns_label(host)
}

/// A password: two random UUIDs' hex, 64 characters, 244 bits.
fn new_password() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn labels(name: &str) -> BTreeMap<String, String> {
    [
        ("app.kubernetes.io/name".to_owned(), name.to_owned()),
        (
            "app.kubernetes.io/managed-by".to_owned(),
            MANAGER.to_owned(),
        ),
    ]
    .into()
}

/// Apply `object` (a full manifest) as Studio's field manager.
async fn apply<K>(api: &kube::Api<K>, name: &str, object: &serde_json::Value) -> anyhow::Result<()>
where
    K: kube::Resource + Clone + serde::de::DeserializeOwned + std::fmt::Debug,
{
    api.patch(
        name,
        &PatchParams::apply(MANAGER).force(),
        &Patch::Apply(object),
    )
    .await
    .map(|_| ())
    .map_err(|e| anyhow!("{name} could not be written: {e}"))
}

/// Make sure the namespace runs a Postgres for `need`, with its databases,
/// and that every secret the chart reads holds its password.
/// What [`ensure`] did about a server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ensured {
    /// Studio runs it: made, or found as Studio made it, with its databases.
    Studios,
    /// The namespace has a Service under the host that Studio did not make:
    /// the product's own, brought some other way, and not Studio's to change.
    LeftAlone,
}

/// Whether a Service's labels say Studio made it.
fn made_by_studio(labels: Option<&BTreeMap<String, String>>) -> bool {
    labels
        .and_then(|l| l.get("app.kubernetes.io/managed-by"))
        .is_some_and(|m| m == MANAGER)
}

pub async fn ensure(
    client: &kube::Client,
    namespace: &str,
    need: &ServerNeed,
    image: &str,
) -> anyhow::Result<Ensured> {
    if !in_namespace(&need.host) {
        bail!(
            "the product's database host is '{}': Studio gives a product a Postgres in its \
             namespace only under a plain name (the profile's default is `postgres`)",
            need.host
        );
    }
    let name = server_name(&need.host);
    let services: kube::Api<Service> = kube::Api::namespaced(client.clone(), namespace);
    match services.get_opt(&need.host).await {
        Ok(Some(s)) if !made_by_studio(s.metadata.labels.as_ref()) => {
            return Ok(Ensured::LeftAlone);
        }
        Ok(_) => {}
        Err(e) => bail!("the namespace's services could not be read: {e}"),
    }
    let secrets: kube::Api<Secret> = kube::Api::namespaced(client.clone(), namespace);

    // The password: the one already kept, or a new one.
    let password = match secrets.get_opt(&name).await {
        Ok(Some(s)) => s
            .data
            .as_ref()
            .and_then(|d| d.get("password"))
            .and_then(|b| String::from_utf8(b.0.clone()).ok())
            .filter(|p| !p.is_empty())
            .unwrap_or_else(new_password),
        Ok(None) => new_password(),
        Err(e) => bail!("the namespace's secrets could not be read: {e}"),
    };
    apply(
        &secrets,
        &name,
        &serde_json::json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": { "name": name, "labels": labels(&name) },
            "type": "Opaque",
            "stringData": { "password": password },
        }),
    )
    .await?;

    apply(
        &services,
        &need.host,
        &serde_json::json!({
            "apiVersion": "v1", "kind": "Service",
            "metadata": { "name": need.host, "labels": labels(&name) },
            "spec": {
                "selector": { "app.kubernetes.io/name": name },
                "ports": [{ "name": "postgres", "port": need.port, "targetPort": 5432 }],
            },
        }),
    )
    .await?;

    let sets: kube::Api<StatefulSet> = kube::Api::namespaced(client.clone(), namespace);
    apply(&sets, &name, &statefulset(&name, need, image)).await?;
    wait_ready(&sets, &name).await?;

    // The databases, by a Job in the namespace: the server is reached where
    // it runs, never from Studio.
    let script = create_script(need)?;
    if !script.is_empty() {
        run_job(client, namespace, &name, need, image, &script).await?;
    }

    // The secrets the chart reads the password from, under the variable's name.
    for secret in &need.secrets {
        apply(
            &secrets,
            secret,
            &serde_json::json!({
                "apiVersion": "v1", "kind": "Secret",
                "metadata": { "name": secret, "labels": labels(&name) },
                "type": "Opaque",
                "stringData": { need.password_env.clone(): password },
            }),
        )
        .await?;
    }
    Ok(Ensured::Studios)
}

/// The server: one replica, its data on a volume, running as the image's
/// `postgres` user. The init container hands the volume to that user, since
/// some storage classes mount a new volume as root whatever `fsGroup` says.
pub fn statefulset(name: &str, need: &ServerNeed, image: &str) -> serde_json::Value {
    serde_json::json!({
        "apiVersion": "apps/v1", "kind": "StatefulSet",
        "metadata": { "name": name, "labels": labels(name) },
        "spec": {
            "serviceName": need.host,
            "replicas": 1,
            "selector": { "matchLabels": { "app.kubernetes.io/name": name } },
            "template": {
                "metadata": { "labels": labels(name) },
                "spec": {
                    "securityContext": { "fsGroup": 999 },
                    "initContainers": [{
                        "name": "own-data",
                        "image": image,
                        "command": ["sh", "-c", "chown -R 999:999 /var/lib/postgresql/data"],
                        "securityContext": { "runAsUser": 0, "capabilities": { "drop": ["ALL"], "add": ["CHOWN", "FOWNER"] } },
                        "volumeMounts": [{ "name": "data", "mountPath": "/var/lib/postgresql/data" }],
                    }],
                    "containers": [{
                        "name": "postgres",
                        "image": image,
                        "env": [
                            { "name": "POSTGRES_USER", "value": need.user },
                            { "name": "POSTGRES_PASSWORD", "valueFrom": { "secretKeyRef": { "name": name, "key": "password" } } },
                            { "name": "PGDATA", "value": "/var/lib/postgresql/data/pgdata" },
                        ],
                        "ports": [{ "name": "postgres", "containerPort": 5432 }],
                        "readinessProbe": {
                            "exec": { "command": ["pg_isready", "-U", need.user] },
                            "periodSeconds": 5,
                        },
                        "securityContext": {
                            "runAsUser": 999, "runAsNonRoot": true,
                            "allowPrivilegeEscalation": false,
                            "capabilities": { "drop": ["ALL"] },
                            "seccompProfile": { "type": "RuntimeDefault" },
                        },
                        "volumeMounts": [{ "name": "data", "mountPath": "/var/lib/postgresql/data" }],
                    }],
                },
            },
            "volumeClaimTemplates": [{
                "metadata": { "name": "data" },
                "spec": {
                    "accessModes": ["ReadWriteOnce"],
                    "resources": { "requests": { "storage": STORAGE } },
                },
            }],
        },
    })
}

async fn wait_ready(sets: &kube::Api<StatefulSet>, name: &str) -> anyhow::Result<()> {
    for _ in 0..60 {
        match sets.get_opt(name).await {
            Ok(Some(s))
                if s.status
                    .as_ref()
                    .and_then(|st| st.ready_replicas)
                    .unwrap_or(0)
                    >= 1 =>
            {
                return Ok(());
            }
            Ok(_) => tokio::time::sleep(Duration::from_secs(5)).await,
            Err(e) => bail!("the cluster did not answer: {e}"),
        }
    }
    bail!("the product's Postgres ({name}) was not ready after 5 minutes")
}

async fn run_job(
    client: &kube::Client,
    namespace: &str,
    name: &str,
    need: &ServerNeed,
    image: &str,
    script: &str,
) -> anyhow::Result<()> {
    let jobs: kube::Api<Job> = kube::Api::namespaced(client.clone(), namespace);
    let job = format!("{name}-databases");
    // A finished Job of an earlier deploy is replaced, not reused.
    let _ = jobs
        .delete(
            &job,
            &DeleteParams {
                propagation_policy: Some(PropagationPolicy::Background),
                ..DeleteParams::default()
            },
        )
        .await;
    for _ in 0..12 {
        match jobs.get_opt(&job).await {
            Ok(None) => break,
            _ => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
    apply(
        &jobs,
        &job,
        &serde_json::json!({
            "apiVersion": "batch/v1", "kind": "Job",
            "metadata": { "name": job, "labels": labels(name) },
            "spec": {
                "backoffLimit": 3,
                "ttlSecondsAfterFinished": 3600,
                "template": {
                    "metadata": { "labels": labels(name) },
                    "spec": {
                        "restartPolicy": "Never",
                        "containers": [{
                            "name": "databases",
                            "image": image,
                            "command": ["sh", "-c", "printf '%s' \"$SCRIPT\" | psql -v ON_ERROR_STOP=1 -h \"$HOST\" -p \"$PORT\" -U \"$PGUSER\" -d postgres"],
                            "env": [
                                { "name": "HOST", "value": need.host },
                                { "name": "PORT", "value": need.port.to_string() },
                                { "name": "PGUSER", "value": need.user },
                                { "name": "PGPASSWORD", "valueFrom": { "secretKeyRef": { "name": name, "key": "password" } } },
                                { "name": "SCRIPT", "value": script },
                            ],
                            "securityContext": {
                                "runAsUser": 999, "runAsNonRoot": true,
                                "allowPrivilegeEscalation": false,
                                "capabilities": { "drop": ["ALL"] },
                                "seccompProfile": { "type": "RuntimeDefault" },
                            },
                        }],
                    },
                },
            },
        }),
    )
    .await?;
    for _ in 0..60 {
        match jobs.get_opt(&job).await {
            Ok(Some(j)) => {
                let st = j.status.unwrap_or_default();
                if st.succeeded.unwrap_or(0) >= 1 {
                    return Ok(());
                }
                if st.failed.unwrap_or(0) > 3 {
                    bail!("creating the product's databases failed: see Job {job} in {namespace}");
                }
            }
            Ok(None) => bail!("Job {job} disappeared"),
            Err(e) => bail!("the cluster did not answer: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    bail!("creating the product's databases did not finish in 3 minutes (Job {job})")
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_service_studio_did_not_make_is_the_products_own() {
        assert!(super::made_by_studio(Some(&super::labels("postgres-db"))));
        assert!(!super::made_by_studio(None));
        let theirs = [("app.kubernetes.io/managed-by".to_owned(), "Helm".to_owned())].into();
        assert!(!super::made_by_studio(Some(&theirs)));
    }

    use super::*;

    /// `helm template` of a chart `gearbox generate` wrote for a kubernetes
    /// profile, cut to what is read here.
    const RENDERED: &str = r#"
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: studio-web-api-gateway
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: studio-web-api-gateway-config
data:
  api-gateway.yaml: |
    server:
      home_dir: /var/lib/gearbox
    database:
      servers:
        pg:
          engine: postgres
          host: postgres
          port: 5432
          user: app
          password: ${GEARS_PG_PASSWORD}
    gears:
      account-management:
        database:
          server: pg
          dbname: account_management
        config: {}
      api-gateway:
        config:
          bind_addr: 0.0.0.0:8087
      types-registry:
        database:
          server: pg
          dbname: types_registry
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: studio-web-api-gateway
spec:
  template:
    spec:
      containers:
        - name: api-gateway
          env:
            - name: POD_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: "GEARS_PG_PASSWORD"
              valueFrom:
                secretKeyRef:
                  name: "studio-web-db"
                  key: "GEARS_PG_PASSWORD"
"#;

    #[test]
    fn a_rendered_chart_says_which_server_databases_and_secret_it_needs() {
        let needs = needs(RENDERED).unwrap();
        assert_eq!(needs.len(), 1);
        let n = &needs[0];
        assert_eq!(
            (n.host.as_str(), n.port, n.user.as_str()),
            ("postgres", 5432, "app")
        );
        assert_eq!(n.password_env, "GEARS_PG_PASSWORD");
        assert_eq!(n.secrets.iter().collect::<Vec<_>>(), ["studio-web-db"]);
        assert_eq!(
            n.databases.iter().collect::<Vec<_>>(),
            ["account_management", "types_registry"]
        );
    }

    #[test]
    fn a_chart_without_a_database_needs_none() {
        assert!(
            needs("apiVersion: v1\nkind: Service\nmetadata: {name: x}\n")
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn the_script_creates_each_missing_database_owned_by_the_user() {
        let n = &needs(RENDERED).unwrap()[0];
        let sql = create_script(n).unwrap();
        assert_eq!(sql.lines().count(), 2);
        assert!(sql.contains("CREATE DATABASE account_management OWNER app"));
        assert!(sql.contains("WHERE datname = 'types_registry')\\gexec"));
        let mut bad = n.clone();
        bad.databases.insert("x'; DROP".into());
        assert!(create_script(&bad).is_err());
    }

    #[test]
    fn only_a_plain_name_is_a_server_studio_runs_in_the_namespace() {
        assert!(in_namespace("postgres"));
        assert!(!in_namespace("db.acme.example"));
        assert_eq!(server_name("postgres"), "studio-postgres-postgres");
    }

    #[test]
    fn a_password_not_read_from_a_variable_is_refused() {
        let text = RENDERED.replace("${GEARS_PG_PASSWORD}", "plain");
        assert!(needs(&text).is_err());
    }

    #[test]
    fn the_server_runs_as_postgres_on_its_own_volume() {
        let n = &needs(RENDERED).unwrap()[0];
        let s = statefulset("studio-postgres-postgres", n, DEFAULT_IMAGE);
        let c = &s["spec"]["template"]["spec"]["containers"][0];
        assert_eq!(c["securityContext"]["runAsUser"], 999);
        assert_eq!(c["env"][0]["value"], "app");
        assert_eq!(s["spec"]["serviceName"], "postgres");
        assert_eq!(
            s["spec"]["volumeClaimTemplates"][0]["spec"]["resources"]["requests"]["storage"],
            STORAGE
        );
    }
}
