//! Kubernetes session driver (ADR-0003, the k8s successor).
//!
//! One Pod + one ClusterIP Service per session, created in the backend's own
//! namespace through the in-cluster API. The Pod is unprivileged, mounts
//! `/workspace` (an ephemeral `emptyDir`, or a per-workspace claim when
//! `k8s_workspace_persistent` is set — see [`KubernetesDriver::launch`]), and is
//! never exposed directly: the backend proxies the browser to the Service
//! after checking the caller owns the session (see the REST proxy). A bare Pod
//! (not a Deployment) is deliberate — a session is a single lifetime; the
//! reaper and relaunch replace it rather than a controller restarting it.

use std::collections::BTreeMap;

use anyhow::{Context, anyhow};
use async_trait::async_trait;
use k8s_openapi::api::core::v1::{
    Capabilities, Container, ContainerPort, EmptyDirVolumeSource, EnvVar, HTTPGetAction,
    LocalObjectReference, PersistentVolumeClaim, PersistentVolumeClaimSpec,
    PersistentVolumeClaimVolumeSource, Pod, PodSecurityContext, PodSpec, Probe,
    ResourceRequirements, SeccompProfile, SecurityContext, Service, ServicePort, ServiceSpec,
    Volume, VolumeMount, VolumeResourceRequirements,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::Client;
use kube::api::{Api, DeleteParams, ListParams, PostParams};
use uuid::Uuid;

use super::config::StudioSessionConfig;
use super::driver::{AdoptedSession, LaunchSpec, LaunchedSession, SessionAddress, SessionDriver};

const SESSION_LABEL: &str = "cf.studio.session";
const WS_LABEL: &str = "cf.studio.workspace_id";
const TENANT_LABEL: &str = "cf.studio.tenant_id";
const PORT_LABEL: &str = "cf.studio.port";
const POD_LABEL: &str = "cf.studio.pod";
const THEIA_PORT: i32 = 3003;
const SESSION_READY_PATH: &str = "/__studio_session_ready__";
const SESSION_TOKEN_ENV: &str = "STUDIO_SESSION_TOKEN";

pub struct KubernetesDriver {
    client: Client,
    namespace: String,
    cfg: StudioSessionConfig,
}

impl KubernetesDriver {
    /// Connect using the in-cluster ServiceAccount (or a local kubeconfig when
    /// developing against a cluster). The namespace comes from the mounted
    /// ServiceAccount token unless the config pins one.
    pub async fn connect(cfg: StudioSessionConfig) -> anyhow::Result<Self> {
        let client = Client::try_default().await.context(
            "cannot build a Kubernetes client (in-cluster ServiceAccount or kubeconfig)",
        )?;
        let namespace = cfg.k8s_namespace.clone().unwrap_or_else(|| {
            std::fs::read_to_string("/var/run/secrets/kubernetes.io/serviceaccount/namespace")
                .map(|s| s.trim().to_string())
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "default".to_string())
        });
        Ok(Self {
            client,
            namespace,
            cfg,
        })
    }

    fn pods(&self) -> Api<Pod> {
        Api::namespaced(self.client.clone(), &self.namespace)
    }
    fn services(&self) -> Api<Service> {
        Api::namespaced(self.client.clone(), &self.namespace)
    }
    fn claims(&self) -> Api<PersistentVolumeClaim> {
        Api::namespaced(self.client.clone(), &self.namespace)
    }

    /// Create the workspace's claim, or accept the one already there — the
    /// second case is the whole point, so a 409 is success.
    async fn ensure_workspace_claim(
        &self,
        claim_name: &str,
        labels: &BTreeMap<String, String>,
    ) -> anyhow::Result<()> {
        let claim = workspace_claim(claim_name, labels, &self.cfg);
        match self.claims().create(&PostParams::default(), &claim).await {
            Ok(_) => {
                tracing::info!(claim = %claim_name, "studio-session: workspace volume created");
                Ok(())
            }
            Err(kube::Error::Api(ae)) if ae.code == 409 => {
                tracing::info!(claim = %claim_name, "studio-session: reusing the workspace volume");
                Ok(())
            }
            Err(e) => Err(anyhow!("failed to create the workspace volume claim: {e}")),
        }
    }

    /// Wait for a deleted Pod to actually be gone.
    ///
    /// Only needed for a persistent workspace: the claim is `ReadWriteOnce`,
    /// so a Pod that is still terminating still holds the volume and the
    /// replacement sits in `Pending` with a multi-attach error until the
    /// kubelet lets go. Bounded — on timeout the launch proceeds and the
    /// readiness probe absorbs the rest, which is no worse than not waiting.
    async fn await_pod_gone(&self, name: &str) {
        for _ in 0..60 {
            match self.pods().get_opt(name).await {
                Ok(None) => return,
                Ok(Some(_)) | Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
        }
        tracing::warn!(
            pod = %name,
            "studio-session: previous session Pod still terminating — \
             the replacement may wait for its workspace volume"
        );
    }

    /// The Service that fronts a session Pod — same name (a session is one
    /// Pod), so destroy/adopt can derive one from the other.
    fn service_dns(&self, pod_name: &str) -> String {
        format!("{pod_name}.{}.svc.cluster.local", self.namespace)
    }

    /// `[K=V, …]` → Kubernetes env entries (split on the first `=`).
    fn env_vars(env: &[String]) -> Vec<EnvVar> {
        env.iter()
            .filter_map(|kv| {
                let (name, value) = kv.split_once('=')?;
                Some(EnvVar {
                    name: name.to_string(),
                    value: Some(value.to_string()),
                    value_from: None,
                })
            })
            .collect()
    }

    fn label_map(
        labels: &std::collections::HashMap<String, String>,
        pod_name: &str,
    ) -> BTreeMap<String, String> {
        let mut m: BTreeMap<String, String> =
            labels.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        // A stable selector for the Service → this exact Pod.
        m.insert(POD_LABEL.to_string(), pod_name.to_string());
        m
    }
}

#[async_trait]
impl SessionDriver for KubernetesDriver {
    /// The kubelet pulls per `imagePullPolicy`; there is no local image to
    /// inspect from the backend.
    async fn image_present(&self) -> bool {
        true
    }

    /// No-op: image freshness is the kubelet's job.
    async fn refresh_image(&self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn launch(&self, spec: &LaunchSpec) -> anyhow::Result<LaunchedSession> {
        if !spec.local_binds.is_empty() {
            return Err(anyhow!(
                "local folder sources are not supported by the Kubernetes driver \
                 (no backend host filesystem to mount) — use git sources"
            ));
        }

        let name = spec.name.clone();
        let labels = Self::label_map(&spec.labels, &name);

        // A leftover Pod/Service from a crashed session holds the name; clear
        // it first (the service only launches when no LIVE session exists).
        let _ = self.destroy(&name).await;

        // `/workspace`: ephemeral by default, or the workspace's own claim.
        // The claim is named after the Pod, which is itself per-workspace, so
        // the same workspace comes back to the same volume — clones, agent
        // worktrees and uncommitted work included. It deliberately outlives
        // the session; `destroy` does not touch it.
        let workspace_volume = if self.cfg.k8s_workspace_persistent {
            let claim_name = workspace_claim_name(&name);
            self.ensure_workspace_claim(&claim_name, &labels).await?;
            self.await_pod_gone(&name).await;
            Volume {
                name: "workspace".to_string(),
                persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource {
                    claim_name,
                    read_only: None,
                }),
                ..Default::default()
            }
        } else {
            Volume {
                name: "workspace".to_string(),
                empty_dir: Some(EmptyDirVolumeSource::default()),
                ..Default::default()
            }
        };

        let image_pull_secrets = self
            .cfg
            .k8s_image_pull_secret
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|s| {
                vec![LocalObjectReference {
                    name: s.to_string(),
                }]
            });

        let mut requests = BTreeMap::new();
        requests.insert("cpu".to_string(), Quantity("250m".to_string()));
        requests.insert("memory".to_string(), Quantity("512Mi".to_string()));
        let mut limits = BTreeMap::new();
        limits.insert("cpu".to_string(), Quantity("2".to_string()));
        limits.insert("memory".to_string(), Quantity("2Gi".to_string()));

        let pod = Pod {
            metadata: ObjectMeta {
                name: Some(name.clone()),
                namespace: Some(self.namespace.clone()),
                labels: Some(labels.clone()),
                ..Default::default()
            },
            spec: Some(PodSpec {
                // A session is one lifetime: a crash is a dead session, not a
                // restart onto a fresh (empty) workspace.
                restart_policy: Some("Never".to_string()),
                automount_service_account_token: Some(false),
                security_context: Some(PodSecurityContext {
                    run_as_non_root: Some(true),
                    seccomp_profile: Some(SeccompProfile {
                        type_: "RuntimeDefault".to_string(),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                image_pull_secrets,
                containers: vec![Container {
                    name: "theia".to_string(),
                    image: Some(spec.image.clone()),
                    ports: Some(vec![ContainerPort {
                        container_port: THEIA_PORT,
                        name: Some("http".to_string()),
                        ..Default::default()
                    }]),
                    env: Some(Self::env_vars(&spec.env)),
                    volume_mounts: Some(vec![VolumeMount {
                        name: "workspace".to_string(),
                        mount_path: "/workspace".to_string(),
                        ..Default::default()
                    }]),
                    resources: Some(ResourceRequirements {
                        requests: Some(requests),
                        limits: Some(limits),
                        ..Default::default()
                    }),
                    // The entrypoint first holds port 3003 with a preparation
                    // splash, then hands it to the authenticated session gate.
                    // A bare TCP probe would mark the splash as ready and let
                    // the portal hit the tiny hand-over gap, producing a 502.
                    // The splash answers this path with 503; only the gate
                    // answers 204, so the Service publishes an endpoint after
                    // the hand-over has completed.
                    readiness_probe: Some(Probe {
                        http_get: Some(HTTPGetAction {
                            path: Some(SESSION_READY_PATH.to_string()),
                            port: IntOrString::Int(THEIA_PORT),
                            ..Default::default()
                        }),
                        initial_delay_seconds: Some(1),
                        period_seconds: Some(1),
                        timeout_seconds: Some(1),
                        failure_threshold: Some(180),
                        success_threshold: Some(1),
                        ..Default::default()
                    }),
                    security_context: Some(SecurityContext {
                        run_as_non_root: Some(true),
                        run_as_user: Some(1000),
                        allow_privilege_escalation: Some(false),
                        capabilities: Some(Capabilities {
                            drop: Some(vec!["ALL".to_string()]),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                }],
                volumes: Some(vec![workspace_volume]),
                ..Default::default()
            }),
            ..Default::default()
        };

        self.pods()
            .create(&PostParams::default(), &pod)
            .await
            .context("failed to create the session Pod")?;

        let service = Service {
            metadata: ObjectMeta {
                name: Some(name.clone()),
                namespace: Some(self.namespace.clone()),
                labels: Some(labels),
                ..Default::default()
            },
            spec: Some(ServiceSpec {
                selector: Some(BTreeMap::from([(POD_LABEL.to_string(), name.clone())])),
                ports: Some(vec![ServicePort {
                    port: THEIA_PORT,
                    target_port: Some(IntOrString::Int(THEIA_PORT)),
                    name: Some("http".to_string()),
                    ..Default::default()
                }]),
                cluster_ip: None,
                type_: Some("ClusterIP".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };

        if let Err(e) = self
            .services()
            .create(&PostParams::default(), &service)
            .await
        {
            // Roll back the Pod so a failed Service does not orphan it.
            let _ = self.pods().delete(&name, &DeleteParams::default()).await;
            return Err(anyhow!("failed to create the session Service: {e}"));
        }

        Ok(LaunchedSession {
            handle: name.clone(),
            address: SessionAddress::Service {
                host: self.service_dns(&name),
                port: THEIA_PORT as u16,
            },
        })
    }

    async fn is_running(&self, handle: &str) -> bool {
        match self.pods().get_opt(handle).await {
            Ok(Some(pod)) => pod
                .status
                .and_then(|s| s.phase)
                .map(|p| p == "Running" || p == "Pending")
                .unwrap_or(false),
            _ => false,
        }
    }

    async fn is_reachable(&self, address: &SessionAddress) -> bool {
        let addr = match address {
            SessionAddress::Loopback { port } => format!("127.0.0.1:{port}"),
            SessionAddress::Service { host, port } => format!("{host}:{port}"),
        };
        tokio::time::timeout(
            std::time::Duration::from_millis(800),
            tokio::net::TcpStream::connect(&addr),
        )
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false)
    }

    async fn destroy(&self, handle: &str) -> anyhow::Result<()> {
        // Pod and Service only. A persistent workspace's claim is NOT deleted
        // here: surviving the session is what it is for, and the next launch
        // of the same workspace binds it again. Nothing reclaims it yet —
        // deleting a workspace should, and does not.
        // Delete both; a NotFound on either is fine (idempotent teardown).
        let dp = DeleteParams::default();
        if let Err(e) = self.services().delete(handle, &dp).await
            && !matches!(&e, kube::Error::Api(ae) if ae.code == 404)
        {
            return Err(anyhow!("failed to delete session Service: {e}"));
        }
        if let Err(e) = self.pods().delete(handle, &dp).await
            && !matches!(&e, kube::Error::Api(ae) if ae.code == 404)
        {
            return Err(anyhow!("failed to delete session Pod: {e}"));
        }
        Ok(())
    }

    async fn list_adoptable(&self) -> anyhow::Result<Vec<AdoptedSession>> {
        let pods = self
            .pods()
            .list(&ListParams::default().labels(&format!("{SESSION_LABEL}=1")))
            .await
            .context("failed to list session Pods")?;

        let mut out = Vec::new();
        for pod in pods {
            let labels = pod.metadata.labels.clone().unwrap_or_default();
            let (Some(ws), Some(tenant), Some(port)) = (
                labels.get(WS_LABEL).and_then(|v| v.parse::<Uuid>().ok()),
                labels
                    .get(TENANT_LABEL)
                    .and_then(|v| v.parse::<Uuid>().ok()),
                labels.get(PORT_LABEL).and_then(|v| v.parse::<u16>().ok()),
            ) else {
                continue;
            };
            let name = pod.metadata.name.clone().unwrap_or_default();
            let running = pod
                .status
                .as_ref()
                .and_then(|s| s.phase.as_deref())
                .map(|p| p == "Running")
                .unwrap_or(false);
            // Recover the gate token from the Pod's env — visible to anyone who
            // can read Pods in this namespace, so it hands out nothing new.
            let session_token = pod
                .spec
                .as_ref()
                .and_then(|s| s.containers.first())
                .and_then(|c| c.env.as_ref())
                .and_then(|env| {
                    env.iter()
                        .find(|e| e.name == SESSION_TOKEN_ENV)
                        .and_then(|e| e.value.clone())
                })
                .unwrap_or_default();
            out.push(AdoptedSession {
                workspace_id: ws,
                tenant_id: tenant,
                handle: name.clone(),
                address: SessionAddress::Service {
                    host: self.service_dns(&name),
                    port,
                },
                running,
                created_at_epoch_secs: pod
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|t| t.0.as_second().max(0) as u64)
                    .unwrap_or(0),
                session_token,
            });
        }
        Ok(out)
    }
}

/// The claim that backs one workspace, derived from the Pod name — which is
/// itself per-workspace, so this is stable across sessions and needs no
/// registry of its own.
fn workspace_claim_name(pod_name: &str) -> String {
    format!("{pod_name}-workspace")
}

/// `ReadWriteOnce` is the right mode and not a limitation: the service admits
/// one live session per workspace, so exactly one Pod ever writes here. The
/// session labels are carried onto the claim so it can be found — and one day
/// reclaimed — the same way Pods are.
fn workspace_claim(
    claim_name: &str,
    labels: &BTreeMap<String, String>,
    cfg: &StudioSessionConfig,
) -> PersistentVolumeClaim {
    let mut requests = BTreeMap::new();
    requests.insert(
        "storage".to_string(),
        Quantity(cfg.k8s_workspace_volume_size.clone()),
    );
    PersistentVolumeClaim {
        metadata: ObjectMeta {
            name: Some(claim_name.to_string()),
            labels: Some(labels.clone()),
            ..Default::default()
        },
        spec: Some(PersistentVolumeClaimSpec {
            access_modes: Some(vec!["ReadWriteOnce".to_string()]),
            resources: Some(VolumeResourceRequirements {
                requests: Some(requests),
                limits: None,
            }),
            storage_class_name: cfg
                .k8s_workspace_storage_class
                .clone()
                .filter(|c| !c.trim().is_empty()),
            ..Default::default()
        }),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::{StudioSessionConfig, workspace_claim, workspace_claim_name};
    use std::collections::BTreeMap;

    fn labels() -> BTreeMap<String, String> {
        BTreeMap::from([("cf.studio.session".to_string(), "1".to_string())])
    }

    #[test]
    fn the_claim_name_follows_the_workspace_pod() {
        assert_eq!(
            workspace_claim_name("cf-studio-session-abc123"),
            "cf-studio-session-abc123-workspace"
        );
    }

    #[test]
    fn claims_one_writer_and_the_configured_size() {
        let cfg = StudioSessionConfig::default();
        let claim = workspace_claim("ws-claim", &labels(), &cfg);
        let spec = claim.spec.expect("claim has a spec");
        assert_eq!(
            spec.access_modes.as_deref(),
            Some(["ReadWriteOnce".to_string()].as_slice())
        );
        let requests = spec
            .resources
            .expect("resources")
            .requests
            .expect("requests");
        assert_eq!(requests["storage"].0, cfg.k8s_workspace_volume_size);
        assert_eq!(claim.metadata.name.as_deref(), Some("ws-claim"));
        // Carried so the claim is discoverable the same way its Pod is.
        assert_eq!(claim.metadata.labels, Some(labels()));
    }

    /// An unset or blank class must leave the field absent, so the cluster
    /// default applies; an empty string means "no dynamic provisioning" to
    /// Kubernetes, which would leave the claim Pending forever.
    #[test]
    fn a_blank_storage_class_is_not_sent() {
        let mut cfg = StudioSessionConfig::default();
        assert!(
            workspace_claim("c", &labels(), &cfg)
                .spec
                .unwrap()
                .storage_class_name
                .is_none()
        );
        cfg.k8s_workspace_storage_class = Some("   ".to_string());
        assert!(
            workspace_claim("c", &labels(), &cfg)
                .spec
                .unwrap()
                .storage_class_name
                .is_none()
        );
        cfg.k8s_workspace_storage_class = Some("fast-ssd".to_string());
        assert_eq!(
            workspace_claim("c", &labels(), &cfg)
                .spec
                .unwrap()
                .storage_class_name
                .as_deref(),
            Some("fast-ssd")
        );
    }
}
