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
    TCPSocketAction, Volume, VolumeMount, VolumeResourceRequirements,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::Client;
use kube::api::{Api, DeleteParams, ListParams, PostParams};
use uuid::Uuid;

use super::config::StudioSessionConfig;
use super::driver::{
    AdoptedSession, LaunchSpec, LaunchedSession, NoCapacity, SessionAddress, SessionDriver,
};

const SESSION_LABEL: &str = "cf.studio.session";
const WS_LABEL: &str = "cf.studio.workspace_id";
const TENANT_LABEL: &str = "cf.studio.tenant_id";
const PORT_LABEL: &str = "cf.studio.port";
const LAUNCH_LABEL: &str = "cf.studio.launch_id";
const POD_LABEL: &str = "cf.studio.pod";
const THEIA_PORT: i32 = 3003;
const SESSION_READY_PATH: &str = "/__studio_session_ready__";
const SESSION_TOKEN_ENV: &str = "STUDIO_SESSION_TOKEN";
/// The Theia backend-control token (ADR-0022), recovered on adoption so a
/// restarted backend can still reach the node it launched.
const CONTROL_TOKEN_ENV: &str = "STUDIO_THEIA_S2S_TOKEN";
/// The two variables a session's source summary is rebuilt from.
const ROOT_URL_ENV: &str = "STUDIO_ROOT_URL";
const SOURCES_ENV: &str = "STUDIO_SOURCES";

/// Whether a Pod phase means the session is still here — on its way up, or up.
///
/// `Pending` counts, and that is the whole point of this function. A Pod is
/// `Pending` while it is being scheduled, while its image is pulled and while
/// the kubelet mounts the workspace volume: seconds on a warm node, longer on a
/// cold one. Reading that as "gone" makes `SessionService::refresh` record the
/// session as `Stopped`, and `session.await_ready` treats `Stopped` as terminal
/// — so a launch fails with "stopped before it became ready" while the Pod is
/// quietly still starting, and the user's retry then collides with the delete
/// of the Pod the previous attempt gave up on (`AlreadyExists: object is being
/// deleted`).
///
/// Both callers go through here because they used to disagree: the single-Pod
/// check accepted `Pending`, the listing that feeds the session cache did not.
fn pod_phase_is_live(phase: Option<&str>) -> bool {
    matches!(phase, Some("Running" | "Pending"))
}

/// How often the liveness probe looks, and how many misses restart the
/// container: a minute with nothing on the session's port.
const LIVENESS_PERIOD_SECONDS: i32 = 10;
const LIVENESS_FAILURES: i32 = 6;

/// How long a `Running` Pod may stay not Ready before a launch stops reusing
/// it. Well past a slow first clone and the liveness restart above, so this
/// only catches a Pod nothing will bring back.
const STUCK_UNREADY_SECS: i64 = 10 * 60;

/// Whether a session Pod can be handed to the portal: live by phase, and not a
/// `Running` Pod that has been unready for longer than [`STUCK_UNREADY_SECS`].
///
/// Phase alone said yes to a Pod whose gate had died: `Running`, unreachable,
/// and reused on every open until somebody deleted it by hand.
fn pod_is_live(pod: &Pod, now: k8s_openapi::jiff::Timestamp) -> bool {
    let status = pod.status.as_ref();
    let phase = status.and_then(|s| s.phase.as_deref());
    if !pod_phase_is_live(phase) {
        return false;
    }
    let stuck = phase == Some("Running")
        && status
            .and_then(|s| s.conditions.as_ref())
            .and_then(|conditions| conditions.iter().find(|c| c.type_ == "Ready"))
            .is_some_and(|ready| {
                ready.status == "False"
                    && ready.last_transition_time.as_ref().is_some_and(|since| {
                        now.duration_since(since.0).as_secs() > STUCK_UNREADY_SECS
                    })
            });
    !stuck
}

/// The Service that fronts a session Pod — same name (a session is one Pod),
/// so destroy/adopt can derive one from the other.
fn service_dns(pod_name: &str, namespace: &str) -> String {
    format!("{pod_name}.{namespace}.svc.cluster.local")
}

/// Where this driver publishes a session: its Service, on the one port that
/// Service declares.
///
/// Both the launch and the adoption path go through here. They used to build the
/// address separately, and the adoption path read the port from the
/// `cf.studio.port` label — which carries the Docker driver's published host
/// port, not this one. A session adopted that way was addressed on a port the
/// Service does not expose, so the reachability probe could never promote it out
/// of `starting`: the IDE answered on 3003 while the backend dialled 41000. The
/// launch itself was correct, until the first cache refresh replaced its address
/// with the adopted one.
fn session_address(pod_name: &str, namespace: &str) -> SessionAddress {
    SessionAddress::Service {
        host: service_dns(pod_name, namespace),
        port: THEIA_PORT as u16,
    }
}

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

    /// The node this backend runs on, when the chart told us
    /// (`spec.nodeName` → `STUDIO_NODE_NAME`). Blank counts as absent: an
    /// unset env var renders as an empty string, not as a missing key.
    fn node_name(&self) -> Option<&str> {
        self.cfg
            .k8s_node_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
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

    /// Create the session Pod, absorbing the two refusals that are not faults.
    ///
    /// The Pod's name is derived from the workspace, so relaunching one while
    /// its predecessor is still terminating collides with ITSELF — Kubernetes
    /// answers 409 `AlreadyExists` with "object is being deleted". That is the
    /// ordinary shape of "open the IDE again right after closing it", and it
    /// used to surface as an internal error: on the dev stand the portal
    /// retried 52 times in twenty minutes and every attempt lost the same race.
    /// Waiting for the old Pod to go and trying once more is the whole fix.
    ///
    /// The other is 403 with `exceeded quota`, which no amount of waiting
    /// clears — somebody has to raise the quota or free a session — so it is
    /// reported as [`NoCapacity`] rather than retried here.
    async fn create_pod(&self, name: &str, pod: &Pod) -> anyhow::Result<()> {
        match self.pods().create(&PostParams::default(), pod).await {
            Ok(_) => Ok(()),
            Err(e) => match classify_create(e) {
                CreateRefusal::Terminating(_) => {
                    tracing::info!(
                        pod = %name,
                        "studio-session: the previous session Pod is still terminating —                          waiting for it before launching the replacement"
                    );
                    self.await_pod_gone(name).await;
                    // Once. A second collision means something other than the
                    // predecessor holds the name, and retrying forever would
                    // turn a launch into a hang.
                    match self.pods().create(&PostParams::default(), pod).await {
                        Ok(_) => Ok(()),
                        Err(again) => match classify_create(again) {
                            CreateRefusal::NoRoom(detail) => Err(anyhow!(NoCapacity { detail })),
                            CreateRefusal::Terminating(again) | CreateRefusal::Other(again) => {
                                Err(anyhow::Error::new(again).context(
                                    "failed to create the session Pod after waiting for its                                      predecessor to terminate",
                                ))
                            }
                        },
                    }
                }
                CreateRefusal::NoRoom(detail) => Err(anyhow!(NoCapacity { detail })),
                CreateRefusal::Other(e) => {
                    Err(anyhow::Error::new(e).context("failed to create the session Pod"))
                }
            },
        }
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

        // `/workspace`: a shared claim, the workspace's own claim, or ephemeral.
        //
        // The shared claim is the only one of the three the backend can read
        // too — it mounts the same volume, and each workspace lives in a
        // `subPath` named after itself, which is exactly the layout
        // artifact-ingest looks for (`{root}/{workspace_id}/{repo_dir}`). One
        // clone then serves both the IDE and the analyses, instead of each side
        // fetching its own copy of the same repository.
        //
        // The per-workspace claim below cannot serve that purpose: it is created
        // during a launch, and a long-running backend Pod cannot mount a volume
        // that did not exist when it started.
        let shared_claim = self
            .cfg
            .k8s_workspace_shared_claim
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let (workspace_volume, workspace_sub_path) = if let Some(claim) = shared_claim {
            // A ReadWriteOnce volume is attached to one node, so the session has
            // to run where the backend already holds it. Refuse rather than
            // schedule a Pod that would sit `Pending` on a multi-attach error:
            // the operator gets a sentence, not a stuck session.
            if self.node_name().is_none() {
                return Err(anyhow!(
                    "studio-session: k8s_workspace_shared_claim is set but the backend's node is \
                     unknown (k8s_node_name / STUDIO_NODE_NAME) — a session sharing that volume \
                     must be scheduled on the same node"
                ));
            }
            // The subPath is the workspace id and nothing else: it is the
            // directory name artifact-ingest resolves, so a different scheme
            // here would leave the backend reading an empty path with no error
            // anywhere.
            let Some(workspace_id) = labels.get(WS_LABEL).cloned() else {
                return Err(anyhow!(
                    "studio-session: a session sharing the workspaces claim needs its \
                     {WS_LABEL} label to name the subPath"
                ));
            };
            self.await_pod_gone(&name).await;
            (
                Volume {
                    name: "workspace".to_string(),
                    persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource {
                        claim_name: claim.to_string(),
                        read_only: None,
                    }),
                    ..Default::default()
                },
                Some(workspace_id),
            )
        } else if self.cfg.k8s_workspace_persistent {
            let claim_name = workspace_claim_name(&name);
            self.ensure_workspace_claim(&claim_name, &labels).await?;
            self.await_pod_gone(&name).await;
            (
                Volume {
                    name: "workspace".to_string(),
                    persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource {
                        claim_name,
                        read_only: None,
                    }),
                    ..Default::default()
                },
                None,
            )
        } else {
            (
                Volume {
                    name: "workspace".to_string(),
                    empty_dir: Some(EmptyDirVolumeSource::default()),
                    ..Default::default()
                },
                None,
            )
        };

        // `kubernetes.io/hostname` carries the node name, so this is the node
        // the backend itself is on. Absent unless a shared claim is in use —
        // an ephemeral or per-workspace volume follows the Pod wherever the
        // scheduler puts it, and constraining that would only cost capacity.
        let node_selector = workspace_sub_path.as_ref().and_then(|_| {
            self.node_name().map(|node| {
                BTreeMap::from([("kubernetes.io/hostname".to_string(), node.to_string())])
            })
        });

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

        /* The requests are what the scheduler reserves and so what has to fit
         * the hardware; the limits are the burst ceiling and what a namespace
         * ResourceQuota counts. They are configuration rather than constants
         * because they are the unit a quota is sized in — an operator staring
         * at `exceeded quota` should be able to lower a limit as readily as
         * raise the ceiling, and compare the two. */
        let mut requests = BTreeMap::new();
        requests.insert(
            "cpu".to_string(),
            Quantity(self.cfg.k8s_session_cpu_request.clone()),
        );
        requests.insert(
            "memory".to_string(),
            Quantity(self.cfg.k8s_session_memory_request.clone()),
        );
        let mut limits = BTreeMap::new();
        limits.insert(
            "cpu".to_string(),
            Quantity(self.cfg.k8s_session_cpu_limit.clone()),
        );
        limits.insert(
            "memory".to_string(),
            Quantity(self.cfg.k8s_session_memory_limit.clone()),
        );

        let pod = Pod {
            metadata: ObjectMeta {
                name: Some(name.clone()),
                namespace: Some(self.namespace.clone()),
                labels: Some(labels.clone()),
                ..Default::default()
            },
            spec: Some(PodSpec {
                // A container restart stays in this Pod, so `/workspace` (an
                // `emptyDir` lives as long as the Pod) and the session's
                // address survive it. The entrypoint skips sources it already
                // cloned. With `Never`, a dead gate left a Pod that was
                // `Running` forever and unreachable, and the portal kept
                // reusing it.
                restart_policy: Some("Always".to_string()),
                automount_service_account_token: Some(false),
                security_context: Some(PodSecurityContext {
                    run_as_non_root: Some(true),
                    // A claim-backed volume arrives owned by root, and this
                    // container is uid 1000 — without fsGroup the IDE cannot
                    // write its own workspace. `OnRootMismatch` keeps the
                    // recursive chown to first use instead of every start,
                    // which matters once a workspace holds a real checkout.
                    // The backend runs as 1000 too, so the shared tree stays
                    // writable from both sides.
                    fs_group: Some(1000),
                    fs_group_change_policy: Some("OnRootMismatch".to_string()),
                    seccomp_profile: Some(SeccompProfile {
                        type_: "RuntimeDefault".to_string(),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                // Pinned to the backend's node while a shared ReadWriteOnce
                // claim is in play: that volume can only be attached to one
                // node, and the backend is already holding it. This is the
                // constraint an ReadWriteMany class would remove.
                node_selector: node_selector.clone(),
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
                        // Only set for the shared claim: each workspace gets its
                        // own directory inside one volume.
                        sub_path: workspace_sub_path.clone(),
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
                    // Whether anything still holds the session's port. TCP, not
                    // the readiness path: while the workspace is prepared the
                    // splash holds the port and answers that path with 503, and
                    // a long clone is not a dead session. A minute with nothing
                    // listening restarts the container in place.
                    liveness_probe: Some(Probe {
                        tcp_socket: Some(TCPSocketAction {
                            port: IntOrString::Int(THEIA_PORT),
                            ..Default::default()
                        }),
                        initial_delay_seconds: Some(30),
                        period_seconds: Some(LIVENESS_PERIOD_SECONDS),
                        timeout_seconds: Some(3),
                        failure_threshold: Some(LIVENESS_FAILURES),
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

        self.create_pod(&name, &pod).await?;

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
            address: session_address(&name, &self.namespace),
        })
    }

    async fn is_running(&self, handle: &str) -> bool {
        match self.pods().get_opt(handle).await {
            Ok(Some(pod)) => pod_is_live(&pod, k8s_openapi::jiff::Timestamp::now()),
            _ => false,
        }
    }

    async fn is_reachable(&self, address: &SessionAddress) -> bool {
        let addr = address.dial_target(&self.cfg.control_reach_host);
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
            // The port label is still required — it is part of what this driver
            // writes, so demanding it keeps adoption to sessions this platform
            // started — but its VALUE is deliberately unused: it carries the
            // Docker driver's published host port, while a Pod is reached
            // through its Service on `THEIA_PORT`.
            let (Some(ws), Some(tenant), Some(_)) = (
                labels.get(WS_LABEL).and_then(|v| v.parse::<Uuid>().ok()),
                labels
                    .get(TENANT_LABEL)
                    .and_then(|v| v.parse::<Uuid>().ok()),
                labels.get(PORT_LABEL).and_then(|v| v.parse::<u16>().ok()),
            ) else {
                continue;
            };
            let name = pod.metadata.name.clone().unwrap_or_default();
            let running = pod_phase_is_live(pod.status.as_ref().and_then(|s| s.phase.as_deref()));
            // Recover what the Pod was started with — visible to anyone who can
            // read Pods in this namespace, so it hands out nothing new.
            let env = pod
                .spec
                .as_ref()
                .and_then(|s| s.containers.first())
                .and_then(|c| c.env.as_deref())
                .unwrap_or_default();
            let env_value = |name: &str| {
                env.iter()
                    .find(|e| e.name == name)
                    .and_then(|e| e.value.as_deref())
            };
            let session_token = env_value(SESSION_TOKEN_ENV).unwrap_or_default().to_string();
            let control_token = env_value(CONTROL_TOKEN_ENV).unwrap_or_default().to_string();
            let sources =
                super::driver::adopted_sources(env_value(ROOT_URL_ENV), env_value(SOURCES_ENV));
            out.push(AdoptedSession {
                workspace_id: ws,
                tenant_id: tenant,
                handle: name.clone(),
                address: session_address(&name, &self.namespace),
                running,
                created_at_epoch_secs: pod
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|t| t.0.as_second().max(0) as u64)
                    .unwrap_or(0),
                launch_id: labels
                    .get(LAUNCH_LABEL)
                    .and_then(|v| v.parse::<Uuid>().ok()),
                session_token,
                control_token,
                sources,
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

/// Why a Pod create was refused, in the only three shapes the launch cares about.
enum CreateRefusal {
    /// The name is taken by a Pod on its way out.
    Terminating(kube::Error),
    /// The namespace is full. The string is the runtime's own explanation.
    NoRoom(String),
    Other(kube::Error),
}

/// Read the refusal off the API error.
///
/// Matched on the status CODE plus the reason text, not on a parsed structure:
/// `exceeded quota` is what the quota admission controller writes and there is
/// no typed field for it, and a 403 that is NOT about quota (RBAC, say) is a
/// deployment fault that must keep looking like one.
fn classify_create(e: kube::Error) -> CreateRefusal {
    let kube::Error::Api(ref response) = e else {
        return CreateRefusal::Other(e);
    };
    match response.code {
        409 if response.message.contains("being deleted") => CreateRefusal::Terminating(e),
        403 if response.message.contains("exceeded quota") => {
            CreateRefusal::NoRoom(response.message.clone())
        }
        _ => CreateRefusal::Other(e),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CreateRefusal, STUCK_UNREADY_SECS, SessionAddress, StudioSessionConfig, THEIA_PORT,
        classify_create, pod_is_live, pod_phase_is_live, session_address, workspace_claim,
        workspace_claim_name,
    };
    use k8s_openapi::api::core::v1::{Pod, PodCondition, PodStatus};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
    use k8s_openapi::jiff::{SignedDuration, Timestamp};
    use std::collections::BTreeMap;

    /// An API refusal, shaped the way the apiserver actually sends it: the
    /// code and the sentence are the only parts the classifier reads.
    fn refusal(code: u16, message: &str) -> kube::Error {
        kube::Error::Api(Box::new(kube::core::Status {
            code,
            message: message.to_string(),
            ..Default::default()
        }))
    }

    /// The Pod's name comes from the workspace, so reopening an IDE straight
    /// after closing it races the previous Pod's own termination. Reported as
    /// an internal error, this was the whole of "Could not open … HTTP 500" on
    /// the dev stand — the portal retried 52 times in twenty minutes and lost
    /// the same race every time.
    #[test]
    fn a_pod_still_terminating_is_something_to_wait_for_not_an_error() {
        let e = refusal(
            409,
            "object is being deleted: pods \"cf-studio-session-01d89b55\" already exists",
        );
        assert!(matches!(classify_create(e), CreateRefusal::Terminating(_)));
    }

    /// A full namespace clears when a session ends or an operator raises the
    /// quota. Nothing is broken and the caller did nothing wrong, so it must
    /// not arrive as "an internal error occurred" — and the runtime's own
    /// sentence is kept, because the quota it names is what has to be raised.
    #[test]
    fn a_full_namespace_is_reported_as_having_no_room() {
        let message = "pods \"cf-studio-session-01d89b55\" is forbidden: exceeded quota:                        studio-dev, requested: limits.cpu=2, used: limits.cpu=8, limited:                        limits.cpu=8";
        match classify_create(refusal(403, message)) {
            CreateRefusal::NoRoom(detail) => assert_eq!(detail, message),
            _ => panic!("a quota refusal has to be recognised as one"),
        }
    }

    /// A 403 that is NOT about quota is a deployment fault — a missing Role,
    /// most likely — and waiting or apologising for capacity would bury it.
    #[test]
    fn a_forbidden_that_is_not_about_quota_stays_an_error() {
        let e = refusal(
            403,
            "pods is forbidden: User cannot create resource \"pods\"",
        );
        assert!(matches!(classify_create(e), CreateRefusal::Other(_)));
    }

    /// And a name held by a Pod that is NOT on its way out: waiting would
    /// never end, so it is not a thing to wait for.
    #[test]
    fn a_name_already_taken_by_a_live_pod_is_not_a_termination_race() {
        let e = refusal(409, "pods \"cf-studio-session-01d89b55\" already exists");
        assert!(matches!(classify_create(e), CreateRefusal::Other(_)));
    }

    /// A session is reached through its Service, which publishes exactly one
    /// port. The `cf.studio.port` label on the Pod is the Docker driver's
    /// published host port and has no meaning here — reading it as the Service
    /// port left the reachability probe dialling a closed port forever, so the
    /// session never left `starting` and the caller timed out on a healthy IDE.
    #[test]
    fn a_session_is_addressed_on_the_port_its_service_publishes() {
        match session_address("cf-studio-session-abc123", "studio-dev") {
            SessionAddress::Service { host, port } => {
                assert_eq!(
                    host,
                    "cf-studio-session-abc123.studio-dev.svc.cluster.local"
                );
                assert_eq!(port, THEIA_PORT as u16);
            }
            other => panic!("a Kubernetes session is reached through its Service, got {other:?}"),
        }
    }

    /// A Pod that is being scheduled, pulled or mounted is a session starting,
    /// not a session that stopped — `await_ready` gives up permanently on the
    /// second reading, and the whole launch fails while the IDE is still on its
    /// way up.
    #[test]
    fn a_pod_on_its_way_up_is_not_a_stopped_session() {
        assert!(pod_phase_is_live(Some("Running")));
        assert!(pod_phase_is_live(Some("Pending")));
    }

    #[test]
    fn a_finished_or_missing_pod_is_not_live() {
        assert!(!pod_phase_is_live(Some("Succeeded")));
        assert!(!pod_phase_is_live(Some("Failed")));
        assert!(!pod_phase_is_live(Some("Unknown")));
        assert!(!pod_phase_is_live(None));
    }

    /// A `Running` Pod with `Ready=False` since `unready_for` seconds ago.
    fn running_unready(now: Timestamp, unready_for: i64) -> Pod {
        Pod {
            status: Some(PodStatus {
                phase: Some("Running".to_string()),
                conditions: Some(vec![PodCondition {
                    type_: "Ready".to_string(),
                    status: "False".to_string(),
                    last_transition_time: Some(Time(now - SignedDuration::from_secs(unready_for))),
                    ..Default::default()
                }]),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// The dev stand's case: the gate died, the Pod stayed `Running` and
    /// unready, and every open of the IDE was handed its dead address.
    #[test]
    fn a_pod_unready_for_too_long_is_not_reused() {
        let now = Timestamp::now();
        assert!(!pod_is_live(
            &running_unready(now, STUCK_UNREADY_SECS + 1),
            now
        ));
    }

    /// Not every unready Pod is dead: one still preparing its workspace, or
    /// restarting its container, comes back on its own.
    #[test]
    fn a_pod_briefly_unready_or_ready_is_still_live() {
        let now = Timestamp::now();
        assert!(pod_is_live(&running_unready(now, 60), now));

        let mut ready = running_unready(now, STUCK_UNREADY_SECS + 1);
        if let Some(conditions) = ready.status.as_mut().and_then(|s| s.conditions.as_mut()) {
            conditions[0].status = "True".to_string();
        }
        assert!(pod_is_live(&ready, now));

        let pending = Pod {
            status: Some(PodStatus {
                phase: Some("Pending".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(pod_is_live(&pending, now), "a Pending Pod has no Ready yet");
    }

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
