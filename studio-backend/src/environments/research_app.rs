//! A rendered chart as a Constructor Research application (ADR-0049 §4).
//!
//! Research runs an *application* of *services*, not Kubernetes objects. A
//! deploy to a Research environment renders the same chart ADR-0048 installs
//! (`helm template`) and reads it back as what Research can run:
//!
//! - each Deployment is a service, named as the Service in front of it is,
//!   since that is the name the other applications reach it by;
//! - a port an Ingress routes to is public; with no Ingress, the ports named
//!   `http` or `rest` are, since that is where a gear's REST API listens;
//! - a database server the configuration names (`database::needs`) is one
//!   more service, a Postgres with a volume and no public port.
//!
//! Research's public API takes a service's image, ports, variables, volumes
//! and hardware -- no files, no command, no secret variables. So:
//!
//! - what the chart mounts from a ConfigMap, its command and arguments and
//!   its scratch folders (`emptyDir`) are **baked into the image** when
//!   Research builds it ([`ServiceSpec::overlay`]); the image's reference
//!   carries a digest of them ([`ServiceSpec::bake`]), and a deploy whose
//!   chart asks for other ones refuses and asks for a new build;
//! - an environment variable read from a Secret is passed as a plain
//!   variable, which Research shows to whoever can open the service -- the
//!   deploy says so;
//! - Research reaches a service at `svc-<name>`, not `<name>`: an address of
//!   another service in a variable or a YAML file is rewritten to it.
//!
//! What Research has no equivalent for (a CronJob, a StatefulSet, a sidecar,
//! a Secret mounted as files, a custom resource) refuses the deploy and is
//! named, rather than dropped.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize as _, Serialize};
use serde_yaml::Value;
use sha2::Digest as _;

use super::database::{self, ServerNeed};
use crate::connectors::sdk::research::{EnvBody, PortBody, ServiceBody, VolumeBody};

/// Kinds that mean nothing outside Kubernetes: the identity a Pod runs as, its
/// permissions, its network policy. Read past, not refused.
const IGNORED: &[&str] = &[
    "ServiceAccount",
    "Role",
    "RoleBinding",
    "NetworkPolicy",
    "PodDisruptionBudget",
    "HorizontalPodAutoscaler",
];

/// Port names a gear's REST API listens on: public when no Ingress says.
const PUBLIC_PORT_NAMES: &[&str] = &["http", "rest"];

/// Where the Postgres service keeps its data.
const PG_DATA: &str = "/var/lib/postgresql/data";

/// The services a chart runs as.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Application {
    pub services: Vec<ServiceSpec>,
}

/// One service of an application.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServiceSpec {
    pub name: String,
    pub image: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub command: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    pub ports: Vec<PortSpec>,
    pub env: BTreeMap<String, String>,
    /// Variables the chart reads from a Secret. Research keeps no secret
    /// variables: they reach it as plain ones.
    pub secret_env: BTreeMap<String, String>,
    /// Files the chart mounts from a ConfigMap: baked into the image.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<FileSpec>,
    /// Folders the chart gives the container to write in (`emptyDir`):
    /// made in the image, writable by the user it runs as.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub scratch: Vec<String>,
    /// The user the Pod runs as (`runAsUser`), who owns the scratch folders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_as: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub volumes: Vec<VolumeSpec>,
    pub replicas: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hardware: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<HealthSpec>,
    /// A database server's Postgres: built `FROM` the environment's database
    /// image, not from the product's sources.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub database: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PortSpec {
    pub name: String,
    pub port: u16,
    pub public: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileSpec {
    pub path: String,
    pub content: String,
}

/// A volume that outlives a new revision of the application.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VolumeSpec {
    pub name: String,
    pub path: String,
    pub size: String,
}

/// What says the service is ready: an HTTP path on one of its ports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HealthSpec {
    pub path: String,
    pub port: u16,
}

/// What the deploy has to know beyond the chart.
pub struct Inputs<'a> {
    /// The binding's hardware configuration, given to every service.
    pub hardware: Option<&'a str>,
    /// The value of a key of a Secret the chart reads but does not render
    /// (the release's configuration secrets, the database password).
    pub secret: &'a dyn Fn(&str, &str) -> Option<String>,
    /// The database password, by server host, for the Postgres services.
    pub database_password: &'a dyn Fn(&str) -> String,
    /// The Postgres image.
    pub database_image: &'a str,
    /// The namespace the chart is rendered for: `<name>.<namespace>` and its
    /// `.svc` forms are another service's address too.
    pub namespace: &'a str,
}

/// Why a chart cannot run as a Research application.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal(pub String);

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Refusal {}

fn refuse<T>(why: impl Into<String>) -> Result<T, Refusal> {
    Err(Refusal(why.into()))
}

fn s<'v>(v: &'v Value, path: &[&str]) -> Option<&'v str> {
    at(v, path).and_then(Value::as_str)
}

fn at<'v>(v: &'v Value, path: &[&str]) -> Option<&'v Value> {
    path.iter().try_fold(v, |v, k| v.get(*k))
}

fn seq<'v>(v: &'v Value, path: &[&str]) -> &'v [Value] {
    at(v, path)
        .and_then(Value::as_sequence)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn name_of(doc: &Value) -> String {
    s(doc, &["metadata", "name"]).unwrap_or_default().to_owned()
}

/// The objects of a rendered chart, by kind.
#[derive(Default)]
struct Objects {
    deployments: Vec<Value>,
    services: Vec<Value>,
    config_maps: BTreeMap<String, Value>,
    secrets: BTreeMap<String, Value>,
    ingresses: Vec<Value>,
    /// `(secret, key)` of a database password, by the server host it opens.
    database_secrets: BTreeMap<(String, String), String>,
}

fn objects(rendered: &str) -> Result<Objects, Refusal> {
    let mut o = Objects::default();
    for doc in serde_yaml::Deserializer::from_str(rendered) {
        let Ok(doc) = Value::deserialize(doc) else {
            continue;
        };
        let Some(kind) = s(&doc, &["kind"]).map(str::to_owned) else {
            continue;
        };
        match kind.as_str() {
            "Deployment" => o.deployments.push(doc),
            "Service" => o.services.push(doc),
            "ConfigMap" => {
                o.config_maps.insert(name_of(&doc), doc);
            }
            "Secret" => {
                o.secrets.insert(name_of(&doc), doc);
            }
            "Ingress" => o.ingresses.push(doc),
            k if IGNORED.contains(&k) => {}
            k => {
                return refuse(format!(
                    "the chart has a {k} ({}), which Constructor Research cannot run",
                    name_of(&doc)
                ));
            }
        }
    }
    Ok(o)
}

/// A key of a rendered Secret, from `stringData` or base64 `data`.
fn rendered_secret(secret: &Value, key: &str) -> Option<String> {
    if let Some(v) = s(secret, &["stringData", key]) {
        return Some(v.to_owned());
    }
    use base64::Engine as _;
    let b64 = s(secret, &["data", key])?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    String::from_utf8(bytes).ok()
}

/// The Service whose selector picks the Deployment's Pods.
fn service_for<'o>(deployment: &Value, services: &'o [Value]) -> Option<&'o Value> {
    let labels = at(deployment, &["spec", "template", "metadata", "labels"])?.as_mapping()?;
    services.iter().find(|svc| {
        at(svc, &["spec", "selector"])
            .and_then(Value::as_mapping)
            .is_some_and(|sel| !sel.is_empty() && sel.iter().all(|(k, v)| labels.get(k) == Some(v)))
    })
}

/// The Service ports an Ingress routes to, as `(service, port name or number)`.
fn ingress_targets(ingresses: &[Value]) -> BTreeSet<(String, String)> {
    let mut out = BTreeSet::new();
    for ing in ingresses {
        for rule in seq(ing, &["spec", "rules"]) {
            for path in seq(rule, &["http", "paths"]) {
                let Some(svc) = s(path, &["backend", "service", "name"]) else {
                    continue;
                };
                let port = at(path, &["backend", "service", "port"]);
                if let Some(name) = port.and_then(|p| s(p, &["name"])) {
                    out.insert((svc.to_owned(), name.to_owned()));
                }
                if let Some(n) = port.and_then(|p| p.get("number")).and_then(Value::as_u64) {
                    out.insert((svc.to_owned(), n.to_string()));
                }
            }
        }
    }
    out
}

/// A rendered chart as the application Research runs.
pub fn application_of(rendered: &str, inputs: &Inputs<'_>) -> Result<Application, Refusal> {
    let mut o = objects(rendered)?;
    let routed = ingress_targets(&o.ingresses);
    let needs = database::needs(rendered).map_err(|e| Refusal(format!("{e:#}")))?;
    for need in needs.iter().filter(|n| database::in_namespace(&n.host)) {
        for secret in &need.secrets {
            o.database_secrets.insert(
                (secret.clone(), need.password_env.clone()),
                need.host.clone(),
            );
        }
    }
    let mut services = Vec::new();
    for d in &o.deployments {
        services.push(service_of(d, &o, &routed, inputs)?);
    }
    for need in needs.iter().filter(|n| database::in_namespace(&n.host)) {
        services.push(postgres(need, inputs)?);
    }
    let mut seen = BTreeSet::new();
    for svc in &services {
        if !seen.insert(svc.name.clone()) {
            return refuse(format!(
                "two services of the chart are both named {}",
                svc.name
            ));
        }
    }
    let names: BTreeSet<String> = services.iter().map(|s| s.name.clone()).collect();
    for svc in &mut services {
        readdress(svc, &names, inputs.namespace);
    }
    Ok(Application { services })
}

fn service_of(
    d: &Value,
    o: &Objects,
    routed: &BTreeSet<(String, String)>,
    inputs: &Inputs<'_>,
) -> Result<ServiceSpec, Refusal> {
    let deployment = name_of(d);
    let pod = at(d, &["spec", "template", "spec"])
        .cloned()
        .unwrap_or(Value::Null);
    if !seq(&pod, &["initContainers"]).is_empty() {
        return refuse(format!(
            "{deployment} has init containers, which a Constructor Research service cannot run"
        ));
    }
    let [c] = seq(&pod, &["containers"]) else {
        return refuse(format!(
            "{deployment} runs more than one container; a Constructor Research service runs one"
        ));
    };
    let front = service_for(d, &o.services);
    let name = front.map(name_of).unwrap_or_else(|| deployment.clone());
    let replicas = at(d, &["spec", "replicas"])
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(1);

    // Ports: the container's, public when routed to (or by name, with no Ingress).
    let mut ports = Vec::new();
    for p in seq(c, &["ports"]) {
        let Some(port) = p
            .get("containerPort")
            .and_then(Value::as_u64)
            .and_then(|n| u16::try_from(n).ok())
        else {
            continue;
        };
        let pname = s(p, &["name"]).unwrap_or_default().to_owned();
        let public = if o.ingresses.is_empty() {
            PUBLIC_PORT_NAMES.contains(&pname.as_str())
        } else {
            routed.contains(&(name.clone(), pname.clone()))
                || routed.contains(&(name.clone(), port.to_string()))
        };
        ports.push(PortSpec {
            name: pname,
            port,
            public,
        });
    }

    let mut env = BTreeMap::new();
    let mut secret_env = BTreeMap::new();
    for e in seq(c, &["env"]) {
        let Some(key) = s(e, &["name"]) else { continue };
        if let Some(v) = e.get("value") {
            env.insert(key.to_owned(), scalar(v));
        } else if let Some(field) = s(e, &["valueFrom", "fieldRef", "fieldPath"]) {
            // What the Pod knows of itself: the service stands for it.
            match field {
                "metadata.name" | "metadata.namespace" => {
                    env.insert(key.to_owned(), name.clone());
                }
                other => {
                    return refuse(format!("{deployment} reads {other} of its Pod into {key}"));
                }
            }
        } else if let Some(r) = at(e, &["valueFrom", "secretKeyRef"]) {
            let (secret, k) = (
                s(r, &["name"]).unwrap_or_default(),
                s(r, &["key"]).unwrap_or_default(),
            );
            secret_env.insert(
                key.to_owned(),
                secret_value(o, inputs, secret, k, &deployment)?,
            );
        } else if let Some(r) = at(e, &["valueFrom", "configMapKeyRef"]) {
            let (cm, k) = (
                s(r, &["name"]).unwrap_or_default(),
                s(r, &["key"]).unwrap_or_default(),
            );
            let v = o
                .config_maps
                .get(cm)
                .and_then(|m| s(m, &["data", k]))
                .ok_or_else(|| {
                    Refusal(format!(
                        "{deployment} reads {k} of ConfigMap {cm}, which the chart does not have"
                    ))
                })?;
            env.insert(key.to_owned(), v.to_owned());
        }
    }
    for from in seq(c, &["envFrom"]) {
        if let Some(cm) = s(from, &["configMapRef", "name"]) {
            let data = o
                .config_maps
                .get(cm)
                .and_then(|m| at(m, &["data"]))
                .and_then(Value::as_mapping);
            for (k, v) in data.into_iter().flatten() {
                if let Some(k) = k.as_str() {
                    env.insert(k.to_owned(), scalar(v));
                }
            }
        }
        if let Some(secret) = s(from, &["secretRef", "name"]) {
            let keys: Vec<String> = o
                .secrets
                .get(secret)
                .into_iter()
                .flat_map(|sec| {
                    ["data", "stringData"]
                        .map(|f| at(sec, &[f]).and_then(Value::as_mapping).cloned())
                })
                .flatten()
                .flat_map(|m| {
                    m.keys()
                        .filter_map(|k| k.as_str().map(str::to_owned))
                        .collect::<Vec<_>>()
                })
                .collect();
            if keys.is_empty() {
                return refuse(format!(
                    "{deployment} reads every key of Secret {secret}, which the chart does not render"
                ));
            }
            for k in keys {
                secret_env.insert(k.clone(), secret_value(o, inputs, secret, &k, &deployment)?);
            }
        }
    }

    // Volumes: a ConfigMap mounted is a file; a claim is a volume; emptyDir is scratch.
    let mut files = Vec::new();
    let mut scratch = Vec::new();
    let mut volumes = Vec::new();
    let pod_volumes: BTreeMap<String, &Value> = seq(&pod, &["volumes"])
        .iter()
        .filter_map(|v| s(v, &["name"]).map(|n| (n.to_owned(), v)))
        .collect();
    for m in seq(c, &["volumeMounts"]) {
        let (Some(vname), Some(path)) = (s(m, &["name"]), s(m, &["mountPath"])) else {
            continue;
        };
        let Some(v) = pod_volumes.get(vname) else {
            return refuse(format!(
                "{deployment} mounts {vname}, which its Pod does not declare"
            ));
        };
        if v.get("emptyDir").is_some() {
            scratch.push(path.to_owned());
            continue;
        }
        if let Some(cm) = s(v, &["configMap", "name"]) {
            let data = o
                .config_maps
                .get(cm)
                .and_then(|m| at(m, &["data"]))
                .and_then(Value::as_mapping)
                .ok_or_else(|| {
                    Refusal(format!(
                        "{deployment} mounts ConfigMap {cm}, which the chart does not have"
                    ))
                })?;
            match s(m, &["subPath"]) {
                Some(key) => {
                    let content = data.get(key).and_then(Value::as_str).ok_or_else(|| {
                        Refusal(format!("ConfigMap {cm} has no {key} for {deployment}"))
                    })?;
                    files.push(FileSpec {
                        path: path.to_owned(),
                        content: content.to_owned(),
                    });
                }
                None => {
                    for (k, content) in data {
                        if let (Some(k), Some(content)) = (k.as_str(), content.as_str()) {
                            files.push(FileSpec {
                                path: format!("{}/{k}", path.trim_end_matches('/')),
                                content: content.to_owned(),
                            });
                        }
                    }
                }
            }
            continue;
        }
        if v.get("persistentVolumeClaim").is_some() {
            volumes.push(VolumeSpec {
                name: vname.to_owned(),
                path: path.to_owned(),
                size: "10Gi".to_owned(),
            });
            continue;
        }
        return refuse(format!(
            "{deployment} mounts volume {vname} of a kind Constructor Research has no equivalent for"
        ));
    }

    let health = ["readinessProbe", "livenessProbe"]
        .iter()
        .find_map(|probe| {
            let get = at(c, &[probe, "httpGet"])?;
            let port = get.get("port")?;
            let port = port
                .as_u64()
                .and_then(|n| u16::try_from(n).ok())
                .or_else(|| {
                    let named = port.as_str()?;
                    ports.iter().find(|p| p.name == named).map(|p| p.port)
                })?;
            Some(HealthSpec {
                path: s(get, &["path"]).unwrap_or("/").to_owned(),
                port,
            })
        });

    Ok(ServiceSpec {
        name,
        image: s(c, &["image"])
            .ok_or_else(|| Refusal(format!("{deployment} names no image")))?
            .to_owned(),
        command: strings(c.get("command")),
        args: strings(c.get("args")),
        ports,
        env,
        secret_env,
        files,
        scratch,
        run_as: at(c, &["securityContext", "runAsUser"])
            .or_else(|| at(&pod, &["securityContext", "runAsUser"]))
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok()),
        volumes,
        replicas,
        hardware: inputs.hardware.map(str::to_owned),
        health,
        database: false,
    })
}

fn secret_value(
    o: &Objects,
    inputs: &Inputs<'_>,
    secret: &str,
    key: &str,
    deployment: &str,
) -> Result<String, Refusal> {
    if let Some(host) = o.database_secrets.get(&(secret.to_owned(), key.to_owned())) {
        return Ok((inputs.database_password)(host));
    }
    o.secrets
        .get(secret)
        .and_then(|sec| rendered_secret(sec, key))
        .or_else(|| (inputs.secret)(secret, key))
        .ok_or_else(|| {
            Refusal(format!(
                "{deployment} reads {key} of Secret {secret}, and Studio has no value for it"
            ))
        })
}

/// The Postgres service a database server of the configuration needs.
fn postgres(need: &ServerNeed, inputs: &Inputs<'_>) -> Result<ServiceSpec, Refusal> {
    let script = database::create_script(need).map_err(|e| Refusal(format!("{e:#}")))?;
    Ok(ServiceSpec {
        name: need.host.clone(),
        image: inputs.database_image.to_owned(),
        command: Vec::new(),
        args: Vec::new(),
        ports: vec![PortSpec {
            name: "postgres".to_owned(),
            port: need.port,
            public: false,
        }],
        env: BTreeMap::from([
            ("POSTGRES_USER".to_owned(), need.user.clone()),
            ("PGDATA".to_owned(), format!("{PG_DATA}/pgdata")),
        ]),
        secret_env: BTreeMap::from([(
            "POSTGRES_PASSWORD".to_owned(),
            (inputs.database_password)(&need.host),
        )]),
        // The image runs these once, on an empty data directory.
        files: vec![FileSpec {
            path: "/docker-entrypoint-initdb.d/studio-databases.sql".to_owned(),
            content: script,
        }],
        scratch: Vec::new(),
        run_as: None,
        volumes: vec![VolumeSpec {
            name: "data".to_owned(),
            path: PG_DATA.to_owned(),
            size: "10Gi".to_owned(),
        }],
        replicas: 1,
        hardware: inputs.hardware.map(str::to_owned),
        health: None,
        database: true,
    })
}

/* ── what an image carries, and how a deploy names it ── */

/// The repository a build's image reference starts with: Research names an
/// image by an id, which a chart's `repository:tag` carries as
/// `research-image/<bake>/<name>:<id>`.
pub const IMAGE_PREFIX: &str = "research-image";

/// The repository a build renders the chart with before its images exist.
pub const PENDING_IMAGE: &str = "studio-research-pending";

/// An image as a build records it.
pub fn image_reference(bake: &str, name: &str, id: &str) -> String {
    format!("{IMAGE_PREFIX}/{bake}/{name}:{id}")
}

/// A build's image, read back from the reference a chart renders.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRef {
    /// [`ServiceSpec::bake`] of what was baked into it.
    pub bake: String,
    pub name: String,
    /// Research's id of the image.
    pub id: String,
}

pub fn image_ref(image: &str) -> Option<ImageRef> {
    let rest = image.strip_prefix(IMAGE_PREFIX)?.strip_prefix('/')?;
    let (repo, id) = rest.rsplit_once(':')?;
    let (bake, name) = repo.split_once('/')?;
    (!id.is_empty() && !bake.is_empty()).then(|| ImageRef {
        bake: bake.to_owned(),
        name: name.to_owned(),
        id: id.to_owned(),
    })
}

/// What a build records a database server's Postgres image under, beside
/// the applications' (a values key no chart reads).
pub fn database_key(host: &str) -> String {
    format!("studio-database-{host}")
}

/// A name Research accepts for an image: ASCII letters, digits and hyphens,
/// at most 30.
pub fn image_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(30)
        .collect();
    match clean.trim_matches('-') {
        "" => "studio".to_owned(),
        n => n.to_owned(),
    }
}

impl ServiceSpec {
    /// Whether the image has anything baked in.
    fn baked(&self) -> bool {
        !(self.command.is_empty()
            && self.args.is_empty()
            && self.files.is_empty()
            && self.scratch.is_empty())
    }

    /// A digest of what [`Self::overlay`] bakes in: the build records it in
    /// the image's reference and a deploy compares.
    pub fn bake(&self) -> String {
        let what = serde_json::json!({
            "command": self.command,
            "args": self.args,
            "files": self.files.iter().map(|f| [&f.path, &f.content]).collect::<Vec<_>>(),
            "scratch": self.scratch,
            "run_as": self.run_as,
        });
        hex::encode(&sha2::Sha256::digest(what.to_string().as_bytes())[..6])
    }

    /// The files to lay out under the folder [`Self::overlay`] copies from,
    /// each a path relative to it and the content.
    pub fn overlay_files(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self
            .files
            .iter()
            .map(|f| {
                (
                    format!("files/{}", f.path.trim_start_matches('/')),
                    f.content.clone(),
                )
            })
            .collect();
        if !self.scratch.is_empty() {
            out.push(("scratch/.keep".to_owned(), String::new()));
        }
        out
    }

    /// Dockerfile lines that bake into the image what the chart would mount
    /// and run, from `dir` (a folder of the build context holding
    /// [`Self::overlay_files`]); empty when there is nothing to bake.
    /// Kubernetes' `command` replaces the image's entrypoint and `args` its
    /// command, and so do these.
    pub fn overlay(&self, dir: &str) -> String {
        if !self.baked() {
            return String::new();
        }
        let json = |v: &[String]| serde_json::to_string(v).unwrap_or_else(|_| "[]".into());
        let mut out = String::from(
            "\n# Constructor Studio (ADR-0049): what the chart mounts and runs, baked in,\n\
             # since a Constructor Research service takes neither files nor a command.\n",
        );
        if !self.files.is_empty() {
            out.push_str(&format!(
                "COPY {}\n",
                json(&[format!("{dir}/files/"), "/".to_owned()])
            ));
        }
        for path in &self.scratch {
            let owner = self
                .run_as
                .map(|u| format!("--chown={u}:{u} "))
                .unwrap_or_default();
            out.push_str(&format!(
                "COPY {owner}{}\n",
                json(&[
                    format!("{dir}/scratch/"),
                    format!("{}/", path.trim_end_matches('/'))
                ])
            ));
        }
        if !self.command.is_empty() {
            out.push_str(&format!("ENTRYPOINT {}\n", json(&self.command)));
            out.push_str(&format!("CMD {}\n", json(&self.args)));
        } else if !self.args.is_empty() {
            out.push_str(&format!("CMD {}\n", json(&self.args)));
        }
        out
    }

    /// The service as Research's API takes it, and what the person should
    /// know of the difference.
    pub fn body(
        &self,
        image_id: &str,
        hardware: &str,
    ) -> Result<(ServiceBody, Vec<String>), Refusal> {
        let name = &self.name;
        if name.len() > 55 || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return refuse(format!(
                "{name} cannot name a Constructor Research service \
                 (ASCII letters, digits and hyphens, at most 55)"
            ));
        }
        let mut notes = Vec::new();
        // Research has no secret variables: a Secret's value is a plain one.
        let mut vars = self.env.clone();
        vars.extend(self.secret_env.clone());
        let mut empty = Vec::new();
        let mut environment_variables = Vec::new();
        for (k, v) in vars {
            let ok = k
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            if !ok {
                return refuse(format!(
                    "{name} reads variable {k}, a name Constructor Research does not accept \
                     (letters, digits and _, not starting with a digit)"
                ));
            }
            if v.is_empty() {
                empty.push(k);
                continue;
            }
            environment_variables.push(EnvBody { name: k, value: v });
        }
        if !empty.is_empty() {
            notes.push(format!(
                "{name}: {} left unset, since Constructor Research takes no empty variable",
                empty.join(", ")
            ));
        }
        if self.replicas > 1 {
            notes.push(format!(
                "{name} runs one replica in Constructor Research, not {}",
                self.replicas
            ));
        }
        let mut seen = BTreeSet::new();
        let ports = self
            .ports
            .iter()
            .filter(|p| seen.insert(p.port))
            .map(|p| PortBody {
                number: p.port,
                expose_to_internet: p.public,
            })
            .collect();
        let volumes = self
            .volumes
            .iter()
            .map(|v| VolumeBody {
                name: volume_name(&v.name),
                mount_point: v.path.clone(),
                size_gb: size_gb(&v.size),
            })
            .collect();
        Ok((
            ServiceBody {
                name: name.clone(),
                image_id: image_id.to_owned(),
                hardware_configuration_id: hardware.to_owned(),
                volumes,
                ports,
                environment_variables,
            },
            notes,
        ))
    }
}

/// A volume name Research accepts: lowercase letters, digits and hyphens,
/// at most 30.
fn volume_name(name: &str) -> String {
    let clean: String = name
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(30)
        .collect();
    match clean.trim_matches('-') {
        "" => "data".to_owned(),
        n => n.to_owned(),
    }
}

/// A Kubernetes size (`10Gi`, `512Mi`, `1Ti`) in whole gigabytes, at least 1.
fn size_gb(size: &str) -> u32 {
    let s = size.trim();
    let split = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let Ok(n) = s[..split].parse::<u32>() else {
        return 10;
    };
    let gb = match &s[split..] {
        "Ti" | "T" => n.saturating_mul(1024),
        "Mi" | "M" => n.div_ceil(1024),
        "Ki" | "K" | "" => 1,
        _ => n,
    };
    gb.max(1)
}

/* ── addresses ── */

/// The host Research gives a service (its Kubernetes Service's name).
pub fn research_host(name: &str) -> String {
    format!("svc-{}", name.to_ascii_lowercase())
}

/// Research's host for `host` when it names one of `names`: bare, or with
/// the chart's namespace and its `.svc` forms.
fn service_host(host: &str, names: &BTreeSet<String>, namespace: &str) -> Option<String> {
    let (first, rest) = match host.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (host, None),
    };
    if !names.contains(first) {
        return None;
    }
    let ok = match rest {
        None => true,
        Some(rest) => {
            !namespace.is_empty()
                && (rest == namespace
                    || rest == format!("{namespace}.svc")
                    || rest == format!("{namespace}.svc.cluster.local"))
        }
    };
    ok.then(|| research_host(first))
}

/// `host[:port]` split at a port of digits.
fn split_port(s: &str) -> (&str, &str) {
    match s.rfind(':') {
        Some(c) if c + 1 < s.len() && s[c + 1..].bytes().all(|b| b.is_ascii_digit()) => {
            s.split_at(c)
        }
        _ => (s, ""),
    }
}

/// `value` with another service's address made Research's: the host of a
/// URL, `host:port`, or -- where the key says it is one -- a bare host.
fn readdressed(
    key: &str,
    value: &str,
    names: &BTreeSet<String>,
    namespace: &str,
) -> Option<String> {
    if let Some(i) = value.find("://") {
        let (scheme, after) = value.split_at(i + 3);
        let end = after.find(['/', '?', '#']).unwrap_or(after.len());
        let (authority, tail) = after.split_at(end);
        let (userinfo, hostport) = match authority.rfind('@') {
            Some(a) => authority.split_at(a + 1),
            None => ("", authority),
        };
        let (host, port) = split_port(hostport);
        let host = service_host(host, names, namespace)?;
        return Some(format!("{scheme}{userinfo}{host}{port}{tail}"));
    }
    let (host, port) = split_port(value);
    if !port.is_empty() {
        return service_host(host, names, namespace).map(|h| format!("{h}{port}"));
    }
    let k = key.to_ascii_lowercase();
    if ["host", "addr", "server", "endpoint"]
        .iter()
        .any(|w| k.contains(w))
    {
        return service_host(value, names, namespace);
    }
    None
}

fn readdress_yaml(v: &mut Value, key: &str, names: &BTreeSet<String>, namespace: &str) -> bool {
    match v {
        Value::String(s) => match readdressed(key, s, names, namespace) {
            Some(n) => {
                *s = n;
                true
            }
            None => false,
        },
        Value::Mapping(m) => {
            let mut changed = false;
            for (k, v) in m.iter_mut() {
                let k = k.as_str().unwrap_or(key).to_owned();
                changed |= readdress_yaml(v, &k, names, namespace);
            }
            changed
        }
        Value::Sequence(items) => items.iter_mut().fold(false, |changed, v| {
            readdress_yaml(v, key, names, namespace) | changed
        }),
        Value::Tagged(t) => readdress_yaml(&mut t.value, key, names, namespace),
        _ => false,
    }
}

/// Another service's address, in a variable or a YAML file, as Research's.
fn readdress(svc: &mut ServiceSpec, names: &BTreeSet<String>, namespace: &str) {
    for (k, v) in svc.env.iter_mut().chain(svc.secret_env.iter_mut()) {
        if let Some(n) = readdressed(k, v, names, namespace) {
            *v = n;
        }
    }
    for f in &mut svc.files {
        if !(f.path.ends_with(".yaml") || f.path.ends_with(".yml")) {
            continue;
        }
        let Ok(mut doc) = serde_yaml::from_str::<Value>(&f.content) else {
            continue;
        };
        if readdress_yaml(&mut doc, "", names, namespace)
            && let Ok(text) = serde_yaml::to_string(&doc)
        {
            f.content = text;
        }
    }
}

fn scalar(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => serde_yaml::to_string(other)
            .unwrap_or_default()
            .trim_end()
            .to_owned(),
    }
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_sequence)
        .map(|items| items.iter().map(scalar).collect())
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "research_app_tests.rs"]
mod tests;
