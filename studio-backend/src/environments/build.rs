//! A product built by Studio, in the organization's cluster (ADR-0048 §9).
//!
//! The portal never compiles anything itself: Build asks the server, the
//! server starts a Kubernetes Job in the project's build namespace of the
//! chosen environment (ADR-0062 §7), and the Job does the work on the
//! organization's nodes:
//!
//! 1. `prepare` (the builder image, `studio-builder@sha256:…`, never the
//!    server's own: ADR-0062 §1; `studio-backend build-prepare`):
//!    clones the product's repository and the gear sources its description
//!    names, runs `gearbox generate` for the profile with the engine this
//!    Studio runs, and makes the tree buildable (constructorfabric/gearbox#12);
//! 2. `build` (BuildKit, rootless, daemonless): builds each application's
//!    image, labelled with where it came from, and pushes it under the
//!    project's own path `<prefix>/<project-slug>/` with a push token scoped
//!    to that path alone (ADR-0062 §2);
//! 3. `publish` (`studio-backend build-publish`): packages and pushes the chart
//!    beside the images, and leaves the manifest -- images by digest, chart
//!    and version -- as its termination message.
//!
//! The run that starts the Job ends at once; a watch run follows it, a few
//! minutes at a time, and records the build when the Job ends, so a build
//! outlives the task queue's lease and a restart of the portal. The
//! repository's token and the push token are Secrets in the build namespace
//! for the Job's lifetime and are removed when the build is recorded; the
//! runtime namespace gets only the pull secret.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use async_trait::async_trait;
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{Pod, Secret};
use kube::api::{DeleteParams, ListParams, LogParams, Patch, PatchParams};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use toolkit::client_hub::{ClientHub, ClientScope};
use tracing::warn;
use uuid::Uuid;

use super::deploy::{self, cluster_access, registry_access};
use crate::tasks::sdk::{TaskContext, TaskHandler, TaskOutcome};

/// Task types: a wire contract.
pub const TASK_TYPE: &str = "environments.build";
pub const WATCH_TASK_TYPE: &str = "environments.build.watch";

/// The image BuildKit runs in, rootless, unless `STUDIO_BUILDKIT_IMAGE` names
/// another: a cluster that admits only its own registry's images wants the
/// same image through that registry's proxy.
pub const BUILDKIT_IMAGE: &str = "moby/buildkit:v0.20.0-rootless";

/// How long a build may take before the cluster stops it.
const DEADLINE_SECS: i64 = 60 * 60;

/// How long one watch run waits before handing over to the next: well under
/// the queue's lease.
const WATCH_FOR: Duration = Duration::from_secs(10 * 60);
const WATCH_EVERY: Duration = Duration::from_secs(20);

/// The watch run past which a Job still running has outlived its deadline by
/// two rounds: the cluster should have stopped it, so nothing it says now can
/// be trusted, and the build is recorded as lost.
const LAST_WATCH_ROUND: u32 = (DEADLINE_SECS as u64 / WATCH_FOR.as_secs()) as u32 + 2;

/// How much of a failure a build keeps: a container's termination message is
/// at most 4 KiB, and the start of it names what broke.
const FAILURE_CHARS: usize = 3000;

/// Where the product's repository is, as the server read it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepoRef {
    /// The tenant whose connection reaches it.
    pub tenant: Uuid,
    pub connection_id: Uuid,
    /// `owner/name`.
    pub repo: String,
    pub branch: String,
}

/// What Build puts on the queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildPayload {
    pub build_id: String,
    pub organization_id: Uuid,
    pub project_id: Uuid,
    pub connection_id: Uuid,
    pub registry_connection_id: Uuid,
    pub namespace: String,
    /// `ghcr.io/acme`.
    pub prefix: String,
    pub profile: String,
    pub product_file: String,
    pub repo: RepoRef,
    /// A branch, tag or commit; the repository's branch when absent.
    #[serde(default)]
    pub git_ref: Option<String>,
    /// The image `prepare` and `publish` run in: the builder, by digest
    /// (ADR-0062 §1).
    pub builder_image: String,
    /// The `registry` connection the builder image is pulled with, when it
    /// is on another registry than the project's: a pull secret of its own
    /// in the Job, never the project's push login.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builder_registry_connection_id: Option<Uuid>,
    /// The namespace the Job runs in (ADR-0062 §7); absent from a build
    /// queued before builds had one of their own, which runs in
    /// [`Self::namespace`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_namespace: Option<String>,
    /// The `registry` connection the runtime namespace pulls with: the
    /// environment's read-only one, else [`Self::registry_connection_id`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_registry_connection_id: Option<Uuid>,
    /// The OCI labels every image gets, `key=value` (ADR-0062 §2): source,
    /// created, project, build, description revision. The revision is the
    /// commit `prepare` checked out.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<(String, String)>,
    /// Who asked for the build, recorded on its images.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<String>,
    /// The environment, whose namespace assignment the run records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment_id: Option<Uuid>,
    /// The image the `build` step runs BuildKit in. Absent from a build
    /// queued before it was recorded, which gets the default.
    #[serde(default = "default_buildkit_image")]
    pub buildkit_image: String,
    /// The tenant the build's record was started in: the caller's. Every
    /// later record of it is written there too, or the page that reads the
    /// caller's records keeps the first one, `running`, for ever. Absent from
    /// a build queued before it was recorded, whose records go to the run's
    /// own tenant.
    #[serde(default)]
    pub records_in: Option<Uuid>,
    /// The description revision Studio keeps that the build lays at
    /// `product_file` before it generates (ADR-0053 §2), and its text, which
    /// the Job's `prepare` gets in its environment. Absent when the project
    /// has none: `prepare` reads the file in the checkout (or, for a
    /// `product/…` ref, from that branch -- §4).
    #[serde(default)]
    pub description_revision: Option<i64>,
    #[serde(default)]
    pub description_text: Option<String>,
    /// The tenant the environment's connections are found from and read as
    /// (ADR-0054 §5): the project, for a project's own environment. Absent
    /// for an organization's, and from a build queued before it was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connections_from: Option<Uuid>,
    /// The repository's own Dockerfiles and chart (ADR-0054 §7); `None`
    /// builds `product_file` on gears.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub own: Option<super::model::OwnBuild>,
    /// `(description source id, ref)` for each `git(...)` source that is one
    /// of the project's repositories (ADR-0060 §3): fetched at its branch for
    /// a dev build, at the revision's pinned commit for a protected one,
    /// instead of the `rev` the text names.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_refs: Vec<(String, String)>,
    /// `dev` checks and generates the profile as a development one
    /// (ADR-0060 §5); absent or `prod` as the description says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strictness: Option<String>,
}

/// How `prepare` takes the description's sources beyond the repository it
/// clones (ADR-0060 §3, §5).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourceOptions {
    /// `(source id, ref)`: a `git(...)` source fetched at this ref, with the
    /// repository's credentials, instead of its `rev`.
    pub refs: Vec<(String, String)>,
    /// Mark the profile built `development = True`.
    pub development: bool,
}

impl SourceOptions {
    /// Read from the command line: each `--source-ref id=ref`, and
    /// `--strictness`.
    pub fn parse(refs: &[String], strictness: Option<&str>) -> anyhow::Result<Self> {
        let refs = refs
            .iter()
            .map(|r| {
                let (id, at) = r
                    .split_once('=')
                    .ok_or_else(|| anyhow!("--source-ref {r} is not id=ref"))?;
                Ok((id.trim().to_owned(), at.trim().to_owned()))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        Ok(Self {
            refs,
            development: strictness.map(str::trim) == Some("dev"),
        })
    }

    fn ref_of(&self, id: &str) -> Option<&str> {
        self.refs
            .iter()
            .find(|(i, _)| i == id)
            .map(|(_, r)| r.as_str())
    }
}

/// See [`crate::product::sdk::development_profile`].
pub use crate::product::sdk::development_profile;

/// The context a run reads an environment's connections as, and the tenant
/// it finds them from: the project's service for a project's own
/// environment, else the run's own (ADR-0054 §5).
pub(super) fn connection_reader(
    run: &toolkit_security::SecurityContext,
    org: Uuid,
    from: Option<Uuid>,
) -> anyhow::Result<(toolkit_security::SecurityContext, Uuid)> {
    match from {
        Some(tenant) if tenant != org => Ok((super::store::service_context(tenant)?, tenant)),
        _ => Ok((run.clone(), org)),
    }
}

/// The environment variable the Job's `prepare` reads the description from.
pub const DESCRIPTION_ENV: &str = "STUDIO_PRODUCT_DESCRIPTION";

fn default_buildkit_image() -> String {
    BUILDKIT_IMAGE.to_owned()
}

impl BuildPayload {
    /// Where the Job runs.
    pub fn job_namespace(&self) -> &str {
        self.build_namespace.as_deref().unwrap_or(&self.namespace)
    }
}

/// What a watch run carries: the Job to follow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchPayload {
    pub build_id: String,
    pub organization_id: Uuid,
    pub project_id: Uuid,
    pub connection_id: Uuid,
    /// The namespace the Job runs in: the build namespace.
    pub namespace: String,
    /// The registry it pushed to, whose push token the watch renews and
    /// whose records the published images go to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_connection_id: Option<Uuid>,
    /// The project's prefix the build pushes under (`ghcr.io/acme/shop`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    /// The repository paths the push token was minted for, once `prepare`
    /// named the images: empty until then.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub push_names: Vec<String>,
    /// When the push token lapses, milliseconds since the epoch; `None` when
    /// the registry did not say, or the build pushes with the login.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push_expires_at_ms: Option<i64>,
    /// See [`BuildPayload::requested_by`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<String>,
    pub job: String,
    pub repository: String,
    pub profile: String,
    /// How many watch runs came before this one.
    #[serde(default)]
    pub round: u32,
    /// The step last recorded as running, so a step is recorded once.
    #[serde(default)]
    pub step: Option<String>,
    /// See [`BuildPayload::records_in`].
    #[serde(default)]
    pub records_in: Option<Uuid>,
    /// See [`BuildPayload::description_revision`]: recorded beside `commit`.
    #[serde(default)]
    pub description_revision: Option<i64>,
    /// See [`BuildPayload::connections_from`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connections_from: Option<Uuid>,
}

/// The Job's name for a build: a DNS label.
pub fn job_name(build_id: &str) -> String {
    let id: String = build_id
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    format!("studio-build-{}", id.trim_start_matches("studio-"))
        .chars()
        .take(63)
        .collect::<String>()
        .trim_end_matches('-')
        .to_owned()
}

/// The repository-token Secret of a build.
pub fn git_secret_name(build_id: &str) -> String {
    format!("{}-git", job_name(build_id))
        .chars()
        .take(63)
        .collect()
}

/// The push-token Secret of a build: a Docker config holding a token scoped
/// to the project's path, for BuildKit and helm (ADR-0062 §2).
pub fn push_secret_name(build_id: &str) -> String {
    format!("{}-push", job_name(build_id))
        .chars()
        .take(63)
        .collect()
}

/// The builder-pull Secret of a build, when the builder image is on a
/// registry of its own (ADR-0062 §1).
pub fn builder_secret_name(build_id: &str) -> String {
    format!("{}-builder", job_name(build_id))
        .chars()
        .take(63)
        .collect()
}

/// The image BuildKit runs in: `STUDIO_BUILDKIT_IMAGE`, else [`BUILDKIT_IMAGE`].
pub fn buildkit_image() -> String {
    std::env::var("STUDIO_BUILDKIT_IMAGE")
        .ok()
        .map(|image| image.trim().to_owned())
        .filter(|image| !image.is_empty())
        .unwrap_or_else(default_buildkit_image)
}

/// The image a build's `prepare` and `publish` run in, and the engine in it
/// (ADR-0062 §1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuilderSpec {
    /// `…/studio-builder@sha256:…`.
    pub image: String,
    /// The Gearbox commit the image carries, when known before it runs.
    pub gearbox_version: Option<String>,
    /// Whether [`Self::image`] names a digest. A tag is taken only on a
    /// local stand that says so (`STUDIO_BUILDER_ALLOW_TAG=1`).
    pub pinned: bool,
    /// `environment` (an organization's mirror) or `platform`.
    pub from: &'static str,
    /// The connection the image is pulled with, when it is on another
    /// registry than the project's.
    pub pull_connection_id: Option<Uuid>,
}

/// A builder that cannot be used, and why.
pub const BUILDER_NOT_PINNED: &str = "BUILDER_NOT_PINNED";

/// Whether `image` names a digest: `…@sha256:<64 hex>`.
pub fn is_pinned(image: &str) -> bool {
    image
        .rsplit_once('@')
        .is_some_and(|(_, d)| super::images::is_digest(d))
}

/// The builder for a build in `env`: the environment's own (an
/// organization's mirror), else the platform's (`STUDIO_BUILDER_IMAGE`, the
/// `studio-builder` CI published by digest), else the one this server's
/// image was published with (`STUDIO_BUILDER_IMAGE_BUILT`, which CI bakes
/// in from the same commit). Never this server's image: a project's build
/// must not depend on the version of Studio that runs it. Refused unless it
/// names a digest, but on a stand that sets `STUDIO_BUILDER_ALLOW_TAG=1`.
pub fn builder_for(env: &super::model::Environment) -> Result<BuilderSpec, (&'static str, String)> {
    let var = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|i| i.trim().to_owned())
            .filter(|i| !i.is_empty())
    };
    let platform = var("STUDIO_BUILDER_IMAGE").or_else(|| var("STUDIO_BUILDER_IMAGE_BUILT"));
    let allow_tag = std::env::var("STUDIO_BUILDER_ALLOW_TAG")
        .is_ok_and(|v| matches!(v.trim(), "1" | "true" | "yes"));
    builder_from(env, platform.as_deref(), allow_tag)
}

/// [`builder_for`] with what the process environment says given.
pub fn builder_from(
    env: &super::model::Environment,
    platform: Option<&str>,
    allow_tag: bool,
) -> Result<BuilderSpec, (&'static str, String)> {
    let (image, from, gearbox) = match &env.boundaries.builder_image {
        Some(own) => (own.clone(), "environment", None),
        None => match platform {
            Some(p) => (
                p.to_owned(),
                "platform",
                std::env::var("STUDIO_BUILDER_GEARBOX")
                    .ok()
                    .map(|v| v.trim().to_owned())
                    .filter(|v| !v.is_empty()),
            ),
            None => {
                return Err((
                    BUILDER_NOT_PINNED,
                    "this Studio was deployed without a builder image, and its backend image \
                     carries none (a local build): set STUDIO_BUILDER_IMAGE \
                     (backend.builds.builderImage) to the studio-builder CI published, by \
                     digest (…/studio-builder@sha256:…), or give the environment a builder \
                     image of its own"
                        .into(),
                ));
            }
        },
    };
    let pinned = is_pinned(&image);
    if !pinned && !allow_tag {
        return Err((
            BUILDER_NOT_PINNED,
            format!(
                "the builder image {image} ({from}) names no digest: a build must run in an \
                 image that cannot change under it -- name it as …@sha256:…"
            ),
        ));
    }
    if !pinned {
        warn!(%image, "studio-environments: the builder image names no digest; taken because STUDIO_BUILDER_ALLOW_TAG is set (a local stand only)");
    }
    Ok(BuilderSpec {
        image,
        gearbox_version: gearbox,
        pinned,
        from,
        pull_connection_id: env.boundaries.builder_registry_connection_id,
    })
}

/// A label value as BuildKit's options carry it: no spaces, commas or
/// quotes, which would split an option.
fn label_value(v: &str) -> String {
    v.chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, ',' | '"' | '\'' | '='))
        .take(256)
        .collect()
}

/// The OCI labels of a build's images (ADR-0062 §2), but the source, which
/// the run adds once it has read the repository's address, and the revision,
/// which the Job adds once it has checked the commit out.
pub fn image_labels(
    created: &str,
    project: Uuid,
    build_id: &str,
    description_revision: Option<i64>,
) -> Vec<(String, String)> {
    let mut out = vec![
        (
            "org.opencontainers.image.created".to_owned(),
            label_value(created),
        ),
        (
            "studio.constructor.tech/project".to_owned(),
            project.to_string(),
        ),
        (
            "studio.constructor.tech/build".to_owned(),
            label_value(build_id),
        ),
    ];
    if let Some(r) = description_revision {
        out.push((
            "studio.constructor.tech/description-revision".to_owned(),
            r.to_string(),
        ));
    }
    out
}

/// The web address of a repository a clone URL names, without credentials:
/// what `org.opencontainers.image.source` says.
pub fn source_url(clone_url: &str) -> String {
    let Ok(mut url) = reqwest::Url::parse(clone_url) else {
        return String::new();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.as_str().trim_end_matches(".git").to_owned()
}

/// The script the `build` container runs: one rootless, daemonless BuildKit
/// build per application `prepare` listed, pushed with the namespace's
/// registry login.
const BUILD_SCRIPT: &str = r#"set -eu
# The push token comes once prepare has named the images: Studio mints it for
# exactly those repositories and writes it into the mounted Secret.
i=0
until [ -f /home/user/.studio-registry/ready ]; do
  i=$((i+1))
  if [ "$i" -gt 180 ]; then echo "Studio gave no push token in 15 minutes" >&2; exit 1; fi
  sleep 5
done
TAG="$(cat /work/tag)"
REV="$(cat /work/commit 2>/dev/null || true)"
mkdir -p /work/meta
OPTS=""
ANN=""
for kv in ${STUDIO_LABELS:-} ${REV:+org.opencontainers.image.revision=$REV}; do
  OPTS="$OPTS --opt label:$kv"
  ANN="$ANN,annotation.$kv"
done
while read -r app name dockerfile context filename; do
  echo "building $app as $PREFIX/$name:$TAG"
  # shellcheck disable=SC2086 # the labels are meant to split
  buildctl-daemonless.sh build --frontend dockerfile.v0 \
    --local context="$context" --local dockerfile="$dockerfile" --opt filename="${filename:-Dockerfile}" \
    $OPTS \
    --output "type=image,name=$PREFIX/$name:$TAG,push=true$ANN" \
    --metadata-file "/work/meta/$app.json"
done < /work/apps
"#;

/// Which ref a build takes its code from, and which (if any) only its
/// description (ADR-0053 §4). A `product/…` branch is a snapshot of the whole
/// repository from the day the description was saved on it, so a build of one
/// compiles the base branch's code and takes only `product.gdl` from the
/// product branch. Any other ref -- a branch, a tag, a commit somebody chose
/// -- is built as it is.
pub fn code_and_description_refs(git_ref: Option<&str>, base: &str) -> (String, Option<String>) {
    match git_ref.map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) if is_product_branch(r) => (base.to_owned(), Some(r.to_owned())),
        Some(r) => (r.to_owned(), None),
        None => (base.to_owned(), None),
    }
}

/// A branch Studio saved a product's description on: `product/<id>` or
/// `product/<id>-<digest>`.
pub fn is_product_branch(r: &str) -> bool {
    r.strip_prefix("product/")
        .or_else(|| r.strip_prefix("refs/heads/product/"))
        .is_some_and(|rest| !rest.is_empty())
}

/// The Job that builds `p`.
pub fn job_manifest(p: &BuildPayload, git_secret: bool) -> serde_json::Value {
    let name = job_name(&p.build_id);
    let labels = serde_json::json!({
        "app.kubernetes.io/managed-by": "constructor-studio",
        "app.kubernetes.io/name": "studio-build",
        "studio.constructor.tech/build": p.build_id,
    });
    let mut git_env = if git_secret {
        serde_json::json!([
            { "name": "GIT_USERNAME", "valueFrom": { "secretKeyRef": { "name": git_secret_name(&p.build_id), "key": "username" } } },
            { "name": "GIT_PASSWORD", "valueFrom": { "secretKeyRef": { "name": git_secret_name(&p.build_id), "key": "password" } } },
            { "name": "HOME", "value": "/work/home" },
        ])
    } else {
        serde_json::json!([{ "name": "HOME", "value": "/work/home" }])
    };
    // The description revision's text (ADR-0053 §2): kilobytes, in the Job's
    // own spec rather than a Secret -- it is no secret, and it goes with the
    // Job.
    let description = p.description_text.as_ref().filter(|t| !t.trim().is_empty());
    if let (Some(text), Some(env)) = (description, git_env.as_array_mut()) {
        env.push(serde_json::json!({ "name": DESCRIPTION_ENV, "value": text }));
    }
    let mut prepare_args = vec![
        "build-prepare".to_owned(),
        "--work".to_owned(),
        "/work".to_owned(),
        "--repo-url".to_owned(),
        repo_clone_placeholder(),
        "--product-file".to_owned(),
        p.product_file.clone(),
        "--profile".to_owned(),
        p.profile.clone(),
    ];
    let (code_ref, description_ref) =
        code_and_description_refs(p.git_ref.as_deref(), &p.repo.branch);
    prepare_args.push("--ref".to_owned());
    prepare_args.push(code_ref);
    match (description, p.description_revision) {
        (Some(_), Some(revision)) => {
            prepare_args.push("--description-revision".to_owned());
            prepare_args.push(revision.to_string());
        }
        _ => {
            if let Some(r) = description_ref {
                prepare_args.push("--description-ref".to_owned());
                prepare_args.push(r);
            }
        }
    }
    if let Some(own) = &p.own {
        prepare_args.push("--own".to_owned());
        prepare_args.push(serde_json::to_string(own).unwrap_or_default());
    }
    for (id, at) in &p.source_refs {
        prepare_args.push("--source-ref".to_owned());
        prepare_args.push(format!("{id}={at}"));
    }
    if let Some(strictness) = &p.strictness {
        prepare_args.push("--strictness".to_owned());
        prepare_args.push(strictness.clone());
    }
    let restricted = serde_json::json!({
        "runAsNonRoot": true, "runAsUser": 1000, "runAsGroup": 1000,
        "allowPrivilegeEscalation": false,
        "capabilities": { "drop": ["ALL"] },
        "seccompProfile": { "type": "RuntimeDefault" },
    });
    let labels_env = p
        .labels
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(" ");
    // The builder image comes from a registry of its own when it is pulled
    // with a connection of its own; else it is public, or the cluster's own
    // mirror. Never with the project's push login.
    let pull_secrets = if p.builder_registry_connection_id.is_some() {
        serde_json::json!([{ "name": builder_secret_name(&p.build_id) }])
    } else {
        serde_json::json!([])
    };
    serde_json::json!({
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": { "name": name, "labels": labels },
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": DEADLINE_SECS,
            "ttlSecondsAfterFinished": 86400,
            "template": {
                "metadata": { "labels": labels },
                "spec": {
                    "restartPolicy": "Never",
                    "securityContext": { "fsGroup": 1000 },
                    "automountServiceAccountToken": false,
                    "imagePullSecrets": pull_secrets,
                    "initContainers": [
                        {
                            "name": "prepare",
                            "image": p.builder_image,
                            "args": prepare_args,
                            "env": git_env,
                            "securityContext": restricted,
                            "terminationMessagePolicy": "FallbackToLogsOnError",
                            "resources": {
                                "requests": { "cpu": "250m", "memory": "512Mi" },
                                "limits": { "cpu": "2", "memory": "2Gi" },
                            },
                            "volumeMounts": [{ "name": "work", "mountPath": "/work" }],
                        },
                        {
                            "name": "build",
                            "image": p.buildkit_image,
                            "command": ["sh", "-c", BUILD_SCRIPT],
                            "env": [
                                { "name": "PREFIX", "value": p.prefix },
                                { "name": "BUILDKITD_FLAGS", "value": "--oci-worker-no-process-sandbox" },
                                { "name": "DOCKER_CONFIG", "value": "/home/user/.studio-registry" },
                                { "name": "STUDIO_LABELS", "value": labels_env },
                            ],
                            // What rootless BuildKit needs, and no more: no
                            // privilege, a non-root user, seccomp and AppArmor
                            // off for its own user namespace.
                            "securityContext": {
                                "runAsUser": 1000, "runAsGroup": 1000,
                                "seccompProfile": { "type": "Unconfined" },
                                "appArmorProfile": { "type": "Unconfined" },
                            },
                            "terminationMessagePolicy": "FallbackToLogsOnError",
                            "resources": {
                                "requests": { "cpu": "2", "memory": "4Gi" },
                                "limits": { "cpu": "6", "memory": "10Gi" },
                            },
                            "volumeMounts": [
                                { "name": "work", "mountPath": "/work" },
                                { "name": "buildkit", "mountPath": "/home/user/.local/share/buildkit" },
                                { "name": "registry", "mountPath": "/home/user/.studio-registry", "readOnly": true },
                            ],
                        },
                    ],
                    "containers": [{
                        "name": "publish",
                        "image": p.builder_image,
                        "args": ["build-publish", "--work", "/work", "--prefix", p.prefix, "--registry-config", "/registry/config.json"],
                        "env": [{ "name": "HOME", "value": "/work/home" }],
                        "securityContext": restricted,
                        "terminationMessagePolicy": "FallbackToLogsOnError",
                        "resources": {
                            "requests": { "cpu": "100m", "memory": "128Mi" },
                            "limits": { "cpu": "1", "memory": "512Mi" },
                        },
                        "volumeMounts": [
                            { "name": "work", "mountPath": "/work" },
                            { "name": "registry", "mountPath": "/registry", "readOnly": true },
                        ],
                    }],
                    "volumes": [
                        { "name": "work", "emptyDir": { "sizeLimit": "20Gi" } },
                        { "name": "buildkit", "emptyDir": { "sizeLimit": "40Gi" } },
                        // The push token, scoped to the images the build
                        // pushes under the project's path: the only registry
                        // credential the Job holds. Mounted whole, so the
                        // token written after `prepare` reaches the pod.
                        { "name": "registry", "secret": {
                            "secretName": push_secret_name(&p.build_id),
                        } },
                    ],
                },
            },
        },
    })
}

/// Stands in for the clone URL until the run knows it; replaced by
/// [`with_clone_url`], so a manifest built in a test needs no connection.
fn repo_clone_placeholder() -> String {
    "@CLONE_URL@".to_owned()
}

/// The Job manifest with the repository's clone URL in place.
pub fn with_clone_url(mut job: serde_json::Value, url: &str) -> serde_json::Value {
    if let Some(args) = job
        .pointer_mut("/spec/template/spec/initContainers/0/args")
        .and_then(|a| a.as_array_mut())
    {
        for a in args.iter_mut() {
            if a.as_str() == Some("@CLONE_URL@") {
                *a = url.into();
            }
        }
    }
    job
}

/* ── the server side: start, watch, record ── */

pub struct BuildTask {
    hub: Arc<ClientHub>,
}

impl BuildTask {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }
}

/// `ghcr.io/acme/shop` → `acme/shop`: a prefix's path on its host.
pub fn registry_path(prefix: &str) -> &str {
    prefix.split_once('/').map(|(_, p)| p).unwrap_or("")
}

/// Queue a run as the service of `tenant`.
pub async fn enqueue(
    hub: &Arc<ClientHub>,
    tenant: Uuid,
    task_type: &'static str,
    payload: serde_json::Value,
    partition: &str,
    idempotency: &str,
) -> anyhow::Result<Uuid> {
    let queue = hub
        .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
            crate::tasks::TASK_QUEUE_INSTANCE_ID,
        ))
        .map_err(|_| anyhow!("background runs are not available in this deployment"))?;
    let svc = super::store::service_context(tenant)?;
    queue
        .enqueue(
            &svc,
            crate::tasks::sdk::NewRun {
                tenant,
                task_type,
                payload,
                partition_key: Some(partition),
                idempotency_key: Some(idempotency),
                coalesce_queued: false,
                notify_workspace_id: None,
            },
        )
        .await
}

/// Keep what a build's lock says of its infra services on the project
/// (ADR-0065 §3), where its deploys read them.
async fn keep_infra(
    hub: &Arc<ClientHub>,
    org: Uuid,
    project: Uuid,
    build: &str,
    services: Vec<super::infra::LockedService>,
) -> anyhow::Result<()> {
    let am = hub
        .get::<dyn account_management_sdk::AccountManagementClient>()
        .map_err(|_| anyhow!("account management is not available"))?;
    let ctx = super::store::service_context(org)?;
    match super::store::Store::new(am)
        .update::<super::model::BindingList, (), std::convert::Infallible>(
            &ctx,
            project,
            super::BINDINGS_METADATA_TYPE,
            |row| {
                super::infra::keep_built(&mut row.built_infra, build, services.clone());
                Ok(())
            },
        )
        .await?
    {
        Ok(_) => Ok(()),
        Err(never) => match never {},
    }
}

/// Record a build's outcome in the project's graph: in `records_in`, the
/// tenant its first record went to, when it names one; else in the run's.
pub(super) async fn record_outcome(
    hub: &Arc<ClientHub>,
    ctx: &toolkit_security::SecurityContext,
    records_in: Option<Uuid>,
    project: Uuid,
    outcome: crate::artifact_ingest::port::BuildOutcome,
) -> anyhow::Result<()> {
    record(hub, ctx, records_in, project, outcome).await
}

async fn record(
    hub: &Arc<ClientHub>,
    ctx: &toolkit_security::SecurityContext,
    records_in: Option<Uuid>,
    project: Uuid,
    outcome: crate::artifact_ingest::port::BuildOutcome,
) -> anyhow::Result<()> {
    let builds = hub
        .get::<dyn crate::artifact_ingest::port::BuildRecords>()
        .map_err(|_| anyhow!("builds are not available in this deployment"))?;
    let there = match records_in {
        Some(tenant) if tenant != ctx.subject_tenant_id() => super::store::service_context(tenant)?,
        _ => ctx.clone(),
    };
    builds.record(&there, &project.to_string(), &outcome).await
}

#[async_trait]
impl TaskHandler for BuildTask {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }

    fn max_attempts(&self) -> i16 {
        2
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let p: BuildPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => {
                return TaskOutcome::Failed(format!("this run's payload is not a build ({e})"));
            }
        };
        match self.start(ctx, &p).await {
            Ok(job) => TaskOutcome::done_with(
                format!("building in {} as Job {job}", p.namespace),
                serde_json::json!({ "job": job }),
            ),
            Err(e) => {
                let failure = format!("{e:#}");
                let _ = record(
                    &self.hub,
                    &ctx.security,
                    p.records_in,
                    p.project_id,
                    crate::artifact_ingest::port::BuildOutcome::failed(
                        &p.build_id,
                        &p.repo.repo,
                        &p.profile,
                        &failure,
                        "start",
                    ),
                )
                .await;
                TaskOutcome::Failed(failure)
            }
        }
    }
}

impl BuildTask {
    async fn start(&self, ctx: &TaskContext, p: &BuildPayload) -> anyhow::Result<String> {
        ctx.progress("reading the cluster's access").await;
        let (reader, from) =
            connection_reader(&ctx.security, p.organization_id, p.connections_from)?;
        let access = cluster_access(&self.hub, &reader, from, p.connection_id).await?;
        let client = access.client().await?;
        let build_ns = p.job_namespace().to_owned();
        // The runtime namespace gets the pull identity alone; the build
        // namespace holds the Job and its tokens (ADR-0062 §7).
        deploy::prepare_namespace(&client, &p.namespace, p.project_id).await?;
        if build_ns != p.namespace {
            deploy::prepare_namespace(&client, &build_ns, p.project_id).await?;
        }
        if let Some(environment) = p.environment_id {
            super::placement::record(
                &self.hub,
                p.organization_id,
                p.project_id,
                environment,
                p.connection_id,
                &p.namespace,
                &build_ns,
            )
            .await;
        }
        let pull = registry_access(
            &self.hub,
            &reader,
            from,
            p.pull_registry_connection_id
                .unwrap_or(p.registry_connection_id),
        )
        .await?;
        deploy::write_pull_secret(&client, &p.namespace, &pull).await?;
        let secrets: kube::Api<Secret> = kube::Api::namespaced(client.clone(), &build_ns);
        let managed = |name: &str, kind: &str, data: serde_json::Value| {
            serde_json::json!({
                "apiVersion": "v1", "kind": "Secret",
                "metadata": { "name": name, "labels": { "app.kubernetes.io/managed-by": "constructor-studio", "studio.constructor.tech/build": p.build_id } },
                "type": kind,
                "stringData": data,
            })
        };

        // The push token comes once `prepare` has named the images (the
        // watch mints it, scoped to exactly those names under the project's
        // path, ADR-0062 §2); until then the Secret holds no login, and the
        // `build` step waits for it.
        let push_name = push_secret_name(&p.build_id);
        secrets
            .patch(
                &push_name,
                &PatchParams::apply("constructor-studio").force(),
                &Patch::Apply(&managed(
                    &push_name,
                    "Opaque",
                    serde_json::json!({ "config.json": "{\"auths\":{}}" }),
                )),
            )
            .await
            .map_err(|e| anyhow!("the push token's Secret could not be made: {e}"))?;

        // The builder from a registry of its own: its own pull secret.
        if let Some(id) = p.builder_registry_connection_id {
            let builder = registry_access(&self.hub, &reader, from, id).await?;
            let name = builder_secret_name(&p.build_id);
            secrets
                .patch(
                    &name,
                    &PatchParams::apply("constructor-studio").force(),
                    &Patch::Apply(&managed(
                        &name,
                        "kubernetes.io/dockerconfigjson",
                        serde_json::json!({ ".dockerconfigjson": builder.docker_config_json() }),
                    )),
                )
                .await
                .map_err(|e| anyhow!("the builder's pull secret could not be written: {e}"))?;
        }

        ctx.progress("reading the repository's access").await;
        let connectors = crate::connectors::sdk::Connectors::new(Arc::clone(&self.hub))
            .get()
            .ok_or_else(|| anyhow!("connections are not available in this deployment"))?;
        let (driver, auth, _) = connectors
            .driver_and_auth(&ctx.security, p.repo.tenant, p.repo.connection_id)
            .await
            .map_err(|e| {
                anyhow!("the repository's connection cannot be used by the server: {e:#}")
            })?;
        let url = driver.clone_url(&auth.base_url, &p.repo.repo)?;
        let (username, password) = driver.clone_credentials(&auth.token);
        let git_secret = !password.trim().is_empty();
        if git_secret {
            let name = git_secret_name(&p.build_id);
            let object = serde_json::json!({
                "apiVersion": "v1", "kind": "Secret",
                "metadata": { "name": name, "labels": { "app.kubernetes.io/managed-by": "constructor-studio", "studio.constructor.tech/build": p.build_id } },
                "type": "Opaque",
                "stringData": { "username": username, "password": password },
            });
            secrets
                .patch(
                    &name,
                    &PatchParams::apply("constructor-studio").force(),
                    &Patch::Apply(&object),
                )
                .await
                .map_err(|e| {
                    anyhow!("the repository token could not be given to the build: {e}")
                })?;
        }

        ctx.progress(format!("starting the build Job in {build_ns}"))
            .await;
        let job = job_name(&p.build_id);
        // The images say where they came from: the repository's address,
        // without the clone's credentials.
        let mut labelled = p.clone();
        if labelled
            .labels
            .iter()
            .all(|(k, _)| k != "org.opencontainers.image.source")
        {
            let source = label_value(&source_url(&url));
            if !source.is_empty() {
                labelled
                    .labels
                    .insert(0, ("org.opencontainers.image.source".into(), source));
            }
        }
        let manifest = with_clone_url(job_manifest(&labelled, git_secret), &url);
        let jobs: kube::Api<Job> = kube::Api::namespaced(client.clone(), &build_ns);
        jobs.patch(
            &job,
            &PatchParams::apply("constructor-studio").force(),
            &Patch::Apply(&manifest),
        )
        .await
        .map_err(|e| anyhow!("the build Job could not be started in {build_ns}: {e}"))?;

        let watch = WatchPayload {
            build_id: p.build_id.clone(),
            organization_id: p.organization_id,
            project_id: p.project_id,
            connection_id: p.connection_id,
            namespace: build_ns.clone(),
            registry_connection_id: Some(p.registry_connection_id),
            prefix: Some(p.prefix.clone()),
            push_names: Vec::new(),
            push_expires_at_ms: None,
            requested_by: p.requested_by.clone(),
            job: job.clone(),
            repository: p.repo.repo.clone(),
            profile: p.profile.clone(),
            round: 0,
            step: None,
            records_in: p.records_in,
            description_revision: p.description_revision,
            connections_from: p.connections_from,
        };
        enqueue(
            &self.hub,
            p.organization_id,
            WATCH_TASK_TYPE,
            serde_json::to_value(&watch)?,
            &format!("build-watch:{}", p.build_id),
            &format!("{}:watch:0", p.build_id),
        )
        .await?;
        Ok(job)
    }
}

pub struct WatchTask {
    hub: Arc<ClientHub>,
}

impl WatchTask {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }
}

/// What the Job says now.
enum JobState {
    Running,
    Succeeded,
    Failed(String),
}

fn job_state(job: &Job) -> JobState {
    let status = job.status.clone().unwrap_or_default();
    if status.succeeded.unwrap_or(0) > 0 {
        return JobState::Succeeded;
    }
    for c in status.conditions.unwrap_or_default() {
        if c.status == "True" && (c.type_ == "Failed") {
            return JobState::Failed(
                c.message
                    .or(c.reason)
                    .unwrap_or_else(|| "the Job failed".into()),
            );
        }
    }
    if status.failed.unwrap_or(0) > 0 {
        return JobState::Failed("the build pod failed".into());
    }
    JobState::Running
}

/// The termination message of `container` in the build's pod, and which step
/// failed: the first container, init or not, that ended other than 0.
fn pod_messages(pod: &Pod) -> (Option<String>, Option<(String, String)>) {
    let status = pod.status.clone().unwrap_or_default();
    let mut publish = None;
    let mut failed = None;
    for c in status
        .init_container_statuses
        .unwrap_or_default()
        .into_iter()
        .chain(status.container_statuses.unwrap_or_default())
    {
        let Some(t) = c.state.and_then(|s| s.terminated) else {
            continue;
        };
        if c.name == "publish" && t.exit_code == 0 {
            publish = t.message.clone();
        }
        if t.exit_code != 0 && failed.is_none() {
            let why = t
                .message
                .clone()
                .or(t.reason.clone())
                .unwrap_or_else(|| format!("exit {}", t.exit_code));
            failed = Some((c.name.clone(), why));
        }
    }
    (publish, failed)
}

/// What `prepare` says it made, in its termination message: the product and
/// the image names `build` pushes (relative to the project's prefix).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Named {
    pub product: String,
    pub images: Vec<String>,
}

/// A push token given to a build: the repositories it was minted for, and
/// when it lapses.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct PushGiven {
    names: Vec<String>,
    expires_at_ms: Option<i64>,
}

/// What `prepare` named, once it ended well.
fn prepared_names(pod: &Pod) -> Option<Named> {
    let status = pod.status.as_ref()?;
    let prepare = status
        .init_container_statuses
        .as_ref()?
        .iter()
        .find(|c| c.name == "prepare")?;
    let t = prepare.state.as_ref()?.terminated.as_ref()?;
    if t.exit_code != 0 {
        return None;
    }
    serde_json::from_str(t.message.as_deref()?.trim()).ok()
}

/// The repositories a build's push token is for: each image `prepare`
/// named, and the chart, under the project's path `path` (`acme/shop`). A
/// name that would step out of the path is refused.
pub fn push_names(path: &str, named: &Named) -> anyhow::Result<Vec<String>> {
    let ok = |n: &str| {
        !n.is_empty()
            && !n.contains("..")
            && !n.starts_with('/')
            && n.bytes().all(|b| {
                b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || matches!(b, b'.' | b'-' | b'_' | b'/')
            })
    };
    let mut out = Vec::new();
    for n in &named.images {
        if !ok(n) {
            bail!("prepare named '{n}', which is not an image name under the project's path");
        }
        out.push(format!("{path}/{n}"));
    }
    if !ok(&named.product) {
        bail!(
            "prepare named product '{}', which is not a chart name",
            named.product
        );
    }
    out.push(format!("{path}/charts/{}", named.product));
    Ok(out)
}

/// The step the build's pod is in: the first container, init or not, that
/// has not ended.
fn current_step(pod: &Pod) -> Option<String> {
    let status = pod.status.as_ref()?;
    status
        .init_container_statuses
        .iter()
        .flatten()
        .chain(status.container_statuses.iter().flatten())
        .find(|c| c.state.as_ref().is_none_or(|s| s.terminated.is_none()))
        .map(|c| c.name.clone())
}

/// A container that waits for what will not come: an image that cannot be
/// pulled, a configuration that cannot be made. Its step, and why.
fn stuck(pod: &Pod) -> Option<(String, String)> {
    const HOPELESS: [&str; 5] = [
        "ErrImagePull",
        "ImagePullBackOff",
        "InvalidImageName",
        "CreateContainerConfigError",
        "CreateContainerError",
    ];
    let status = pod.status.as_ref()?;
    status
        .init_container_statuses
        .iter()
        .flatten()
        .chain(status.container_statuses.iter().flatten())
        .find_map(|c| {
            let waiting = c.state.as_ref()?.waiting.as_ref()?;
            let reason = waiting.reason.as_deref()?;
            HOPELESS.contains(&reason).then(|| {
                (
                    c.name.clone(),
                    format!(
                        "{reason}: {}",
                        waiting
                            .message
                            .as_deref()
                            .unwrap_or("the container cannot start")
                    ),
                )
            })
        })
}

/// The last `n` characters of `s`: a log's end says most.
fn tail(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.trim().chars().collect();
    if chars.len() <= n {
        return chars.into_iter().collect();
    }
    format!("…{}", chars[chars.len() - n..].iter().collect::<String>())
}

/// The first `n` characters of `s`: an error list's start says most.
fn head(s: &str, n: usize) -> String {
    let s = s.trim();
    match s.char_indices().nth(n) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s.to_owned(),
    }
}

/// What a build records when its watch can no longer follow it: how it ended
/// is not known.
fn lost(why: &str) -> String {
    format!("Studio lost sight of the build: {why}. How it ended is not known; build again.")
}

#[async_trait]
impl TaskHandler for WatchTask {
    fn task_type(&self) -> &'static str {
        WATCH_TASK_TYPE
    }

    fn max_attempts(&self) -> i16 {
        3
    }

    async fn run(&self, ctx: &TaskContext) -> TaskOutcome {
        let p: WatchPayload = match serde_json::from_value(ctx.payload.clone()) {
            Ok(p) => p,
            Err(e) => {
                return TaskOutcome::Failed(format!(
                    "this run's payload is not a build watch ({e})"
                ));
            }
        };
        match self.watch(ctx, &p).await {
            Ok(said) => TaskOutcome::done_with(said, serde_json::json!({ "job": p.job })),
            // The last attempt: nobody watches after this one, so the build
            // says it is lost rather than running for ever.
            Err(e) if ctx.attempt >= self.max_attempts() => {
                let why = format!("{e:#}");
                let outcome = crate::artifact_ingest::port::BuildOutcome::failed(
                    &p.build_id,
                    &p.repository,
                    &p.profile,
                    &lost(&why),
                    "watch",
                );
                if let Err(e) = record(
                    &self.hub,
                    &ctx.security,
                    p.records_in,
                    p.project_id,
                    outcome,
                )
                .await
                {
                    warn!(build = %p.build_id, "studio-environments: a lost build could not be recorded ({e})");
                }
                TaskOutcome::Failed(why)
            }
            Err(e) => TaskOutcome::Retry(format!("{e:#}")),
        }
    }
}

impl WatchTask {
    async fn watch(&self, ctx: &TaskContext, p: &WatchPayload) -> anyhow::Result<String> {
        let (reader, from) =
            connection_reader(&ctx.security, p.organization_id, p.connections_from)?;
        let access = cluster_access(&self.hub, &reader, from, p.connection_id).await?;
        let client = access.client().await?;
        let jobs: kube::Api<Job> = kube::Api::namespaced(client.clone(), &p.namespace);
        let started = std::time::Instant::now();
        let pods: kube::Api<Pod> = kube::Api::namespaced(client.clone(), &p.namespace);
        let mut step = p.step.clone();
        let mut push = PushGiven {
            names: p.push_names.clone(),
            expires_at_ms: p.push_expires_at_ms,
        };
        loop {
            let Some(job) = jobs
                .get_opt(&p.job)
                .await
                .map_err(|e| anyhow!("the cluster did not answer: {e}"))?
            else {
                self.finish(
                    ctx,
                    &client,
                    p,
                    Err(("watch".into(), lost("its Job is gone from the cluster"))),
                )
                .await?;
                return Ok("the build Job is gone".into());
            };
            match job_state(&job) {
                JobState::Running => {
                    let pod = pods
                        .list(&ListParams::default().labels(&format!("job-name={}", p.job)))
                        .await
                        .ok()
                        .and_then(|l| l.items.into_iter().next());
                    // A pod that cannot start never fails the Job: it waits
                    // out the deadline. Say why now instead.
                    if let Some((at, why)) = pod.as_ref().and_then(stuck) {
                        let said = format!("failed in {at}: {why}");
                        self.finish(ctx, &client, p, Err((at, why))).await?;
                        let _ = jobs.delete(&p.job, &DeleteParams::background()).await;
                        return Ok(said);
                    }
                    // Once `prepare` named the images, mint the push token
                    // for exactly them; renew it when it is about to lapse.
                    if let Some(pod) = pod.as_ref() {
                        let due = push.names.is_empty()
                            || push
                                .expires_at_ms
                                .is_some_and(|t| t - super::records::now_ms() < 5 * 60 * 1000);
                        if due && let Some(named) = prepared_names(pod) {
                            match self.give_push_token(ctx, &client, p, &named).await {
                                Ok(given) => push = given,
                                Err(e) => {
                                    warn!(build = %p.build_id, "studio-environments: the push token could not be given ({e:#})");
                                }
                            }
                        }
                    }
                    let now = pod.as_ref().and_then(current_step);
                    if now.is_some() && now != step {
                        let mut running = crate::artifact_ingest::port::BuildOutcome::running(
                            &p.build_id,
                            &p.repository,
                            &p.profile,
                        );
                        running.step = now.clone();
                        if let Err(e) = record(
                            &self.hub,
                            &ctx.security,
                            p.records_in,
                            p.project_id,
                            running,
                        )
                        .await
                        {
                            warn!(build = %p.build_id, "studio-environments: the build's step could not be recorded ({e})");
                        }
                        step = now;
                    }
                    if started.elapsed() >= WATCH_FOR && p.round + 1 >= LAST_WATCH_ROUND {
                        let why = lost("its Job still runs past the hour a build may take");
                        self.finish(ctx, &client, p, Err(("watch".into(), why.clone())))
                            .await?;
                        let _ = jobs.delete(&p.job, &DeleteParams::background()).await;
                        return Ok(why);
                    }
                    if started.elapsed() >= WATCH_FOR {
                        let next = WatchPayload {
                            round: p.round + 1,
                            step: step.clone(),
                            push_names: push.names.clone(),
                            push_expires_at_ms: push.expires_at_ms,
                            ..p.clone()
                        };
                        enqueue(
                            &self.hub,
                            p.organization_id,
                            WATCH_TASK_TYPE,
                            serde_json::to_value(&next)?,
                            &format!("build-watch:{}", p.build_id),
                            &format!("{}:watch:{}", p.build_id, next.round),
                        )
                        .await?;
                        return Ok("still building; watching on".into());
                    }
                    ctx.progress(format!(
                        "building in {}: {}",
                        p.namespace,
                        step.as_deref().unwrap_or("starting")
                    ))
                    .await;
                    tokio::select! {
                        () = tokio::time::sleep(WATCH_EVERY) => {}
                        () = ctx.cancel.cancelled() => bail!("the watch was cancelled"),
                    }
                }
                state => {
                    let pod = pods
                        .list(&ListParams::default().labels(&format!("job-name={}", p.job)))
                        .await
                        .ok()
                        .and_then(|l| l.items.into_iter().next());
                    let (manifest, failed) = pod.as_ref().map(pod_messages).unwrap_or((None, None));
                    let outcome = match (state, manifest, failed) {
                        (JobState::Succeeded, Some(m), _) => Ok(m),
                        (_, _, Some((step, why))) => Err((step, why)),
                        (JobState::Failed(why), _, None) => Err(("build".into(), why)),
                        _ => Err(("publish".into(), "the build left no manifest".into())),
                    };
                    let said = match &outcome {
                        Ok(_) => "built and published".to_owned(),
                        Err((step, why)) => format!("failed in {step}: {}", tail(why, 300)),
                    };
                    self.finish(ctx, &client, p, outcome).await?;
                    return Ok(said);
                }
            }
        }
    }

    /// Mint a push token for the repositories `named` lists under the
    /// project's path, and write it into the build's push Secret with the
    /// `ready` mark the `build` step waits for. A registry without a token
    /// service cannot scope one: the build then pushes with the registry
    /// connection's own login, and says so.
    async fn give_push_token(
        &self,
        ctx: &TaskContext,
        client: &kube::Client,
        p: &WatchPayload,
        named: &Named,
    ) -> anyhow::Result<PushGiven> {
        let (Some(registry_id), Some(prefix)) = (p.registry_connection_id, p.prefix.as_deref())
        else {
            bail!("the build was queued before Studio minted push tokens");
        };
        let path = registry_path(prefix);
        let names = push_names(path, named)?;
        let (reader, from) =
            connection_reader(&ctx.security, p.organization_id, p.connections_from)?;
        let registry = registry_access(&self.hub, &reader, from, registry_id).await?;
        let http = reqwest::Client::builder()
            .user_agent("constructor-studio")
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        let (config, expires_at_ms) = match registry.push_token(&http, &names).await {
            Ok((token, expires_in)) => (
                registry.docker_config_with_token(&token),
                expires_in.map(|s| super::records::now_ms() + i64::try_from(s).unwrap_or(0) * 1000),
            ),
            Err(e) => {
                warn!(build = %p.build_id, "studio-environments: the registry gave no scoped push token ({e:#}); the build pushes with the registry connection's login");
                (registry.docker_config_json(), None)
            }
        };
        let secrets: kube::Api<Secret> = kube::Api::namespaced(client.clone(), &p.namespace);
        let name = push_secret_name(&p.build_id);
        let object = serde_json::json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": { "name": name, "labels": { "app.kubernetes.io/managed-by": "constructor-studio", "studio.constructor.tech/build": p.build_id } },
            "type": "Opaque",
            "stringData": { "config.json": config, "ready": "1" },
        });
        secrets
            .patch(
                &name,
                &PatchParams::apply("constructor-studio").force(),
                &Patch::Apply(&object),
            )
            .await
            .map_err(|e| anyhow!("the push token could not be written: {e}"))?;
        Ok(PushGiven {
            names,
            expires_at_ms,
        })
    }

    async fn finish(
        &self,
        ctx: &TaskContext,
        client: &kube::Client,
        p: &WatchPayload,
        outcome: Result<String, (String, String)>,
    ) -> anyhow::Result<()> {
        use crate::artifact_ingest::port::BuildOutcome;
        let mut chart_digest = None;
        let mut infra = Vec::new();
        let mut record_of = match outcome {
            Ok(manifest) => match serde_json::from_str::<Manifest>(manifest.trim()) {
                Ok(m) => {
                    chart_digest = m.chart.digest.clone();
                    infra = m.infra;
                    BuildOutcome {
                        build_id: p.build_id.clone(),
                        status: "passed".into(),
                        product: Some(m.product),
                        profile: Some(m.profile),
                        repository: Some(p.repository.clone()),
                        commit: Some(m.commit),
                        lock_hash: m.lock_hash,
                        images: m.images.into_iter().map(|i| (i.app, i.image)).collect(),
                        chart_ref: Some(m.chart.reference),
                        chart_version: Some(m.chart.version),
                        place: crate::artifact_ingest::port::BuildPlace {
                            gearbox_version: m.gearbox,
                            source_commits: (!m.sources.is_empty()).then(|| {
                                m.sources
                                    .iter()
                                    .map(|(id, c)| format!("{id}={c}"))
                                    .collect::<Vec<_>>()
                                    .join(",")
                            }),
                            ..Default::default()
                        },
                        ..BuildOutcome::default()
                    }
                }
                Err(e) => BuildOutcome::failed(
                    &p.build_id,
                    &p.repository,
                    &p.profile,
                    &format!("the build's manifest is not one: {e}"),
                    "publish",
                ),
            },
            Err((step, why)) => BuildOutcome::failed(
                &p.build_id,
                &p.repository,
                &p.profile,
                &tail(&why, FAILURE_CHARS),
                &step,
            ),
        };
        record_of.description_revision = p.description_revision;
        // The build's infra services are kept before it counts as passed, so
        // a passed build always has what its deploys run (ADR-0065 §3). Every
        // passed build is kept, one without infra too: a deploy can then tell
        // a build that chose none from one whose services are no longer kept.
        if record_of.status == "passed"
            && let Err(e) = keep_infra(
                &self.hub,
                p.organization_id,
                p.project_id,
                &p.build_id,
                std::mem::take(&mut infra),
            )
            .await
        {
            record_of = BuildOutcome::failed(
                &p.build_id,
                &p.repository,
                &p.profile,
                &format!("the build's infra services could not be kept: {e:#}"),
                "publish",
            );
            record_of.description_revision = p.description_revision;
        }
        // Each image and the chart becomes a record of the project
        // (ADR-0062 §4), from the manifest, before the build's own.
        if record_of.status == "passed"
            && let Ok(records) = self.hub.get::<super::records::Records>()
        {
            let made = super::images::from_manifest(
                p.organization_id,
                p.project_id,
                p.registry_connection_id,
                &p.build_id,
                record_of.commit.as_deref(),
                p.description_revision,
                record_of.lock_hash.as_deref(),
                p.requested_by.as_deref().unwrap_or("studio"),
                super::records::now_ms(),
                &record_of.images,
                record_of
                    .chart_ref
                    .as_deref()
                    .zip(record_of.chart_version.as_deref())
                    .map(|(r, v)| (r, v, chart_digest.as_deref())),
            );
            for image in made {
                if let Err(e) = records.record_image(&image).await {
                    warn!(build = %p.build_id, "studio-environments: an image of the build could not be recorded ({e:#})");
                }
            }
        }
        record(
            &self.hub,
            &ctx.security,
            p.records_in,
            p.project_id,
            record_of,
        )
        .await?;
        // The repository's and the registry's tokens go with the build.
        let secrets: kube::Api<Secret> = kube::Api::namespaced(client.clone(), &p.namespace);
        for name in [
            git_secret_name(&p.build_id),
            push_secret_name(&p.build_id),
            builder_secret_name(&p.build_id),
        ] {
            if let Err(e) = secrets.delete(&name, &DeleteParams::default()).await
                && !matches!(&e, kube::Error::Api(s) if s.code == 404)
            {
                warn!(build = %p.build_id, "studio-environments: the build's secret {name} could not be removed ({e})");
            }
        }
        Ok(())
    }
}

/* ── a build's log, read from its pod ── */

/// How much of a step's log is read: its end, where a failure says why.
const LOG_LINES: i64 = 500;
const LOG_BYTES: i64 = 256 * 1024;

/// One step of a build, as its pod shows it now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepLog {
    /// `prepare`, `build` or `publish`.
    pub step: String,
    /// `waiting` | `running` | `passed` | `failed`.
    pub state: String,
    /// The end of what it wrote; empty while it has not started.
    pub log: String,
}

/// Each step of the build's pod, in the order they run, and whether it has
/// started: what is read of a step's log.
fn steps_of(pod: &Pod) -> Vec<(String, &'static str)> {
    let Some(status) = pod.status.as_ref() else {
        return Vec::new();
    };
    status
        .init_container_statuses
        .iter()
        .flatten()
        .chain(status.container_statuses.iter().flatten())
        .map(|c| {
            let state = match c.state.as_ref() {
                Some(s) if s.running.is_some() => "running",
                Some(s) => match &s.terminated {
                    Some(t) if t.exit_code == 0 => "passed",
                    Some(_) => "failed",
                    None => "waiting",
                },
                None => "waiting",
            };
            (c.name.clone(), state)
        })
        .collect()
}

/// The build's steps and the end of each one's log, as its pod in
/// `namespace` has them; `None` when there is no such pod there (another
/// environment's, or gone a day after the build ended).
pub async fn step_logs(
    client: &kube::Client,
    namespace: &str,
    build_id: &str,
) -> anyhow::Result<Option<Vec<StepLog>>> {
    let pods: kube::Api<Pod> = kube::Api::namespaced(client.clone(), namespace);
    let Some(pod) = pods
        .list(&ListParams::default().labels(&format!("job-name={}", job_name(build_id))))
        .await
        .map_err(|e| anyhow!("the cluster did not answer: {e}"))?
        .items
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let name = pod.metadata.name.clone().unwrap_or_default();
    let mut out = Vec::new();
    for (step, state) in steps_of(&pod) {
        let log = if state == "waiting" {
            String::new()
        } else {
            let params = LogParams {
                container: Some(step.clone()),
                tail_lines: Some(LOG_LINES),
                limit_bytes: Some(LOG_BYTES),
                ..LogParams::default()
            };
            pods.logs(&name, &params)
                .await
                .unwrap_or_else(|e| format!("(the log could not be read: {e})"))
        };
        out.push(StepLog {
            step,
            state: state.to_owned(),
            log,
        });
    }
    Ok(Some(out))
}

/* ── the Job side: `studio-backend build-prepare` and `build-publish` ── */

/// The manifest `publish` leaves, the same shape a pipeline's
/// `studio-build.json` has.
#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub product: String,
    pub profile: String,
    pub commit: String,
    #[serde(default)]
    pub lock_hash: Option<String>,
    pub images: Vec<ManifestImage>,
    pub chart: ManifestChart,
    /// The engine's commit in the image `publish` ran in, so the build's
    /// record says which Gearbox generated it. Absent from a manifest
    /// written before it was recorded, and from a pipeline's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gearbox: Option<String>,
    /// `(source id, commit)` of every source the build fetched (ADR-0060
    /// §3): what a dev build actually took from each branch.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<(String, String)>,
    /// The infra services the build's lock resolved (ADR-0065 §3); empty
    /// for a product without `infra`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub infra: Vec<super::infra::LockedService>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestImage {
    pub app: String,
    pub image: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestChart {
    pub reference: String,
    pub version: String,
    /// The digest `helm push` reported; absent from a manifest written
    /// before it was kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

/// The digest `helm push` prints (`Digest: sha256:…`).
pub fn pushed_digest(output: &str) -> Option<String> {
    output.lines().find_map(|l| {
        let d = l.trim().strip_prefix("Digest:")?.trim();
        super::images::is_digest(d).then(|| d.to_owned())
    })
}

/// How much of a container's termination message the kubelet keeps.
const TERMINATION_MESSAGE_BYTES: usize = 4096;

/// What `prepare` leaves for `build` and `publish`, in `/work/build.json`.
#[derive(Debug, Serialize, Deserialize)]
pub struct Prepared {
    pub product: String,
    pub profile: String,
    pub commit: String,
    pub lock_hash: Option<String>,
    pub chart_dir: String,
    pub chart_base: String,
    /// `(app, image name)`.
    pub apps: Vec<(String, String)>,
    /// `(source id, commit)` of every source fetched.
    #[serde(default)]
    pub sources: Vec<(String, String)>,
    /// What the lock says of the product's infra services (ADR-0065 §3).
    #[serde(default)]
    pub infra: Vec<super::infra::LockedService>,
    /// The description revision Studio laid over the checkout, when it did:
    /// with the lock, what tells two builds of one commit apart.
    #[serde(default)]
    pub description_revision: Option<i64>,
}

/// The version a build publishes its chart at: `{base}-sha.{commit:12}`,
/// then `.r{revision}` and `.l{lock:8}` when the build has them, so two
/// builds of one commit with another description or lock never push over
/// each other's chart. SemVer, as Helm wants: each of them a pre-release
/// identifier of letters and digits.
pub fn chart_version(
    base: &str,
    commit: &str,
    description_revision: Option<i64>,
    lock_hash: Option<&str>,
) -> String {
    let short: String = commit.chars().take(12).collect();
    let mut version = format!("{base}-sha.{short}");
    if let Some(r) = description_revision {
        version.push_str(&format!(".r{r}"));
    }
    if let Some(lock) = lock_hash.filter(|l| l.bytes().all(|b| b.is_ascii_hexdigit())) {
        let lock: String = lock.chars().take(8).collect();
        if !lock.is_empty() {
            version.push_str(&format!(".l{}", lock.to_ascii_lowercase()));
        }
    }
    version
}

/// The applications `docker/build.sh` builds, `(app, image)`, and its build
/// context relative to `docker/`.
pub fn read_build_script(text: &str) -> anyhow::Result<(String, Vec<(String, String)>)> {
    let context = text
        .lines()
        .find_map(|l| {
            let at = l.find("\"$SCRIPT_DIR/\"'")?;
            let rest = &l[at + "\"$SCRIPT_DIR/\"'".len()..];
            rest.split('\'').next().map(str::to_owned)
        })
        .ok_or_else(|| anyhow!("docker/build.sh names no build context"))?;
    let mut apps: Vec<(String, String)> = Vec::new();
    for l in text.lines() {
        let l = l.trim();
        let Some(rest) = l.strip_prefix("build_one ") else {
            continue;
        };
        let mut parts = rest.splitn(2, ' ');
        let app = parts.next().unwrap_or_default().trim();
        let image = parts
            .next()
            .unwrap_or_default()
            .trim()
            .trim_start_matches('\'')
            .split('\'')
            .next()
            .unwrap_or_default();
        if !app.is_empty() && !image.is_empty() && !apps.iter().any(|(a, _)| a == app) {
            apps.push((app.to_owned(), image.to_owned()));
        }
    }
    if apps.is_empty() {
        bail!("docker/build.sh builds no application");
    }
    Ok((context, apps))
}

/// A generated Dockerfile with what its build stage lacks
/// (constructorfabric/gearbox#12): protoc and the protobuf well-known types
/// for the gRPC gears, cmake for zlib.
pub fn with_build_tools(dockerfile: &str) -> String {
    if dockerfile.contains("protobuf-compiler") {
        return dockerfile.to_owned();
    }
    let mut out = String::with_capacity(dockerfile.len() + 160);
    for line in dockerfile.lines() {
        out.push_str(line);
        out.push('\n');
        let l = line.trim();
        if l.starts_with("FROM rust:") && l.ends_with(" AS build") {
            out.push_str(
                "RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
                 protobuf-compiler libprotobuf-dev cmake && rm -rf /var/lib/apt/lists/*\n",
            );
        }
    }
    out
}

/// `Chart.yaml`'s `version`.
pub fn chart_base_version(chart_yaml: &str) -> String {
    chart_yaml
        .lines()
        .find_map(|l| l.trim().strip_prefix("version:"))
        .map(|v| v.trim().trim_matches('"').trim_matches('\'').to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "0.1.0".to_owned())
}

/// The values key, and the app name, of a generated product's UI image: a
/// Gearbox chart keeps it under `ui` (`ui.image`, one string), never under an
/// application's name (Gearbox refuses an application called `ui`).
pub const UI_APP: &str = "ui";

/// The generated UI image, when the tree has one: the folder its Dockerfile
/// is in (a FrontX `frontend/`, or a `ui/`), which is also its build context,
/// and the image name the chart's `ui.image` gives it, without its tag.
pub fn ui_image(out: &Path, values_yaml: &str) -> Option<(PathBuf, String)> {
    let dir = ["frontend", "ui"]
        .iter()
        .map(|d| out.join(d))
        .find(|d| d.join("Dockerfile").is_file())?;
    let values: serde_yaml::Value = serde_yaml::from_str(values_yaml).ok()?;
    let image = values.get("ui")?.get("image")?.as_str()?;
    let name = image.split(':').next().unwrap_or(image).trim();
    (!name.is_empty()).then(|| (dir, name.to_owned()))
}

/// A path inside `root`, `rel` resolved without touching the disk; `None`
/// when it would leave `root`.
pub fn inside(root: &Path, rel: &Path) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for c in rel.components() {
        match c {
            std::path::Component::Normal(s) => out.push(s),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if out == root || !out.pop() {
                    return None;
                }
            }
            _ => return None,
        }
    }
    out.starts_with(root).then_some(out)
}

fn run(cmd: &mut Command, what: &str) -> anyhow::Result<String> {
    run_all(cmd, what).map(|(stdout, _)| stdout)
}

/// [`run`], answering what the tool printed to stdout and everything it said,
/// stderr included: gearbox writes its diagnostics there.
fn run_all(cmd: &mut Command, what: &str) -> anyhow::Result<(String, String)> {
    let out = cmd
        .output()
        .with_context(|| format!("{what} could not be started"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if !out.status.success() {
        // The whole output to the container's log; the failure itself carries
        // what went wrong, which the run records as the build's reason.
        eprintln!("{text}");
        bail!("{what} failed: {}", failure_text(&text));
    }
    Ok((String::from_utf8_lossy(&out.stdout).into_owned(), text))
}

/// The lock of the product's own Rust code among the fetched sources: the one
/// `Cargo.lock`, at a source's root or up to two folders below it, that pins a
/// platform crate (`cf-gears-*`) from a registry or a git repository.
///
/// Every source of a build is fetched by `git(...)`, the product's own code
/// included, so the engine cannot tell it by kind. The platform's own lock
/// records its crates with no `source` -- they are its workspace members -- so
/// it never qualifies; a consumer's lock does, and that consumer is the
/// product's code. That lock decides which platform release the build links;
/// the gear sources are read for their descriptions only. `None` when no lock
/// or more than one qualifies: the engine then decides alone.
fn product_lock(roots: &[PathBuf]) -> Option<PathBuf> {
    fn locks(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        let lock = dir.join("Cargo.lock");
        if lock.is_file() {
            out.push(lock);
        }
        if depth == 0 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                !name.starts_with('.') && !matches!(name.as_ref(), "target" | "node_modules")
            })
            .map(|e| e.path())
            .collect();
        dirs.sort();
        for d in dirs {
            locks(&d, depth - 1, out);
        }
    }
    let mut found = Vec::new();
    for root in roots {
        locks(root, 2, &mut found);
    }
    let mut pinning = found
        .into_iter()
        .filter(|lock| std::fs::read_to_string(lock).is_ok_and(|text| pins_platform(&text)));
    let lock = pinning.next()?;
    pinning.next().is_none().then_some(lock)
}

/// Whether a `Cargo.lock` takes some `cf-gears-*` crate from a registry or git:
/// a `[[package]]` entry of that name with a `source`. Cargo writes one key per
/// line, so the entries are read as text.
fn pins_platform(text: &str) -> bool {
    text.split("[[package]]").any(|entry| {
        let mut lines = entry.lines().map(str::trim);
        let named = entry
            .lines()
            .map(str::trim)
            .any(|l| l.starts_with("name = \"cf-gears-"));
        named && lines.any(|l| l.starts_with("source = "))
    })
}

/// What of `gearbox generate`'s output belongs in the build's log: every
/// warning and error and every note on where the gear crates come from
/// (GBX07xx), each with the lines indented under it. The rest -- a whole
/// product's notes on stability and coupling -- would bury them.
fn generate_diagnostics(text: &str) -> String {
    let mut kept = Vec::new();
    let mut keeping = false;
    for line in text.lines() {
        if line.starts_with(char::is_whitespace) {
            if keeping {
                kept.push(line);
            }
        } else {
            keeping =
                line.starts_with("warning") || line.starts_with("error") || line.contains("[GBX07");
            if keeping {
                kept.push(line);
            }
        }
    }
    kept.join("\n")
}

/// The GBX0714 diagnostics that say two copies of a platform crate will link.
/// Such a tree fails to compile minutes later with trait errors that do not
/// name the cause; it is refused here instead.
fn second_copies(diagnostics: &str) -> Vec<&str> {
    diagnostics
        .lines()
        .filter(|l| l.contains("[GBX0714]") && l.contains("two copies"))
        .collect()
}

/// Give the generated workspace the lock of the sources it builds, when it
/// has none of its own: the product code's lock ([`product_lock`]) first, then
/// a source in the repository, else a fetched one. Without it cargo locks
/// every crate to its latest version, and the first build on a cluster mixed
/// two releases of the platform's toolkit crates whose traits no longer met;
/// cargo keeps what the lock names and adds only what it lacks.
///
/// Seeding the platform checkout's lock under a product lock's pins was that
/// same failure again: the checkout's lock knows nothing of the registry
/// crates the product's code takes, so cargo locked them to their latest.
fn seed_lock(
    product: Option<&Path>,
    roots: &[PathBuf],
    repo: &Path,
    out: &Path,
) -> anyhow::Result<()> {
    let target = out.join("Cargo.lock");
    if target.exists() {
        return Ok(());
    }
    if let Some(lock) = product {
        std::fs::copy(lock, &target)
            .with_context(|| format!("{} could not be copied into the tree", lock.display()))?;
        return Ok(());
    }
    let in_repo = |r: &PathBuf| {
        r.canonicalize()
            .map(|c| c.starts_with(repo.canonicalize().unwrap_or_else(|_| repo.to_owned())))
            .unwrap_or(false)
    };
    let own = roots.iter().filter(|r| in_repo(r));
    let fetched = roots.iter().filter(|r| !in_repo(r));
    if let Some(lock) = own
        .chain(fetched)
        .map(|r| r.join("Cargo.lock"))
        .find(|l| l.is_file())
    {
        std::fs::copy(&lock, &target)
            .with_context(|| format!("{} could not be copied into the tree", lock.display()))?;
    }
    Ok(())
}

/// A tool's output reduced to its `error` diagnostics, each with the lines
/// indented under it, or all of it when it names none. gearbox prints every
/// `info` and `warning` before it gives up, and a whole product's of them
/// pushed the one `error` out of the tail a failure keeps.
fn errors_first(text: &str) -> String {
    let mut kept = Vec::new();
    let mut in_error = false;
    for line in text.lines() {
        if line.starts_with(char::is_whitespace) {
            if in_error {
                kept.push(line);
            }
        } else {
            in_error = line.starts_with("error");
            if in_error {
                kept.push(line);
            }
        }
    }
    if kept.is_empty() {
        text.to_owned()
    } else {
        kept.join("\n")
    }
}

/// What a failed tool said, for the build's record: its errors from the
/// first, which name what broke (a gear, a file), or the end of all it said
/// when it names none.
fn failure_text(text: &str) -> String {
    let kept = errors_first(text);
    if kept == text {
        tail(text, FAILURE_CHARS)
    } else {
        head(&kept, FAILURE_CHARS)
    }
}

/// A step's failure as its container's termination message, which the watch
/// records as the build's reason. Without it the kubelet falls back to the
/// log's last 2 KiB, which the tool's own output fills, and the start of the
/// error -- the gear it names -- falls out of it.
pub fn say_failure(e: &anyhow::Error) {
    let text = format!("{e:#}");
    let mut end = text.len().min(4000);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let _ = std::fs::write("/dev/termination-log", &text[..end]);
}

/// The engine's commit in this image: `STUDIO_GEARBOX_REV`, else the file
/// the image's `gearbox` stage writes beside the binary (the record
/// `product::gearbox` reads too; `gearbox --version` does not tell commits
/// apart).
fn engine_revision() -> Option<String> {
    std::env::var("STUDIO_GEARBOX_REV")
        .ok()
        .or_else(|| std::fs::read_to_string("/usr/local/share/gearbox/REVISION").ok())
        .map(|s| s.trim().chars().take(64).collect::<String>())
        .filter(|s| !s.is_empty())
}

fn gearbox() -> String {
    std::env::var("STUDIO_GEARBOX_BIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "gearbox".to_owned())
}

/// `studio-backend build-prepare`: the repository and its gear sources
/// cloned, the profile generated and made buildable, and what to build listed.
#[allow(clippy::too_many_arguments)]
pub fn prepare(
    work: &Path,
    repo_url: &str,
    git_ref: Option<&str>,
    description: &DescriptionFrom<'_>,
    product_file: &str,
    profile: &str,
    own: Option<&str>,
    options: &SourceOptions,
) -> anyhow::Result<()> {
    let username = std::env::var("GIT_USERNAME").unwrap_or_default();
    let password = std::env::var("GIT_PASSWORD").unwrap_or_default();
    if let Some(own) = own {
        let own: super::model::OwnBuild =
            serde_json::from_str(own).context("--own is not a build of the repository's own")?;
        return prepare_own(work, repo_url, (&username, &password), git_ref, &own);
    }
    prepare_as(
        work,
        repo_url,
        (&username, &password),
        git_ref,
        description,
        product_file,
        profile,
        options,
    )
}

/// Where `prepare` takes the product's description from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DescriptionFrom<'a> {
    /// The file as it is in the checkout.
    Checkout,
    /// Only the file, from another ref of the repository: a `product/…`
    /// branch, whose code is not built (ADR-0053 §4).
    Ref(&'a str),
    /// A revision Studio keeps, laid at the product's path over whatever the
    /// checkout holds there (ADR-0053 §2).
    Text {
        revision: Option<i64>,
        text: &'a str,
    },
}

/// Lay the description `from` names at `product_file` in the checkout `repo`.
fn lay_description(
    repo: &Path,
    (username, password): (&str, &str),
    from: &DescriptionFrom<'_>,
    product_file: &str,
) -> anyhow::Result<()> {
    let text = match from {
        DescriptionFrom::Checkout => return Ok(()),
        DescriptionFrom::Ref(r) => {
            let (text, commit) = crate::connectors::sdk::git_checkout::file_at_ref(
                repo,
                username,
                password,
                r,
                product_file,
            )
            .with_context(|| format!("the description could not be read from {r}"))?
            .ok_or_else(|| anyhow!("{r} has no {product_file}"))?;
            println!(
                "the description is {product_file} of {r} at {commit}; the code is the checkout's"
            );
            text
        }
        DescriptionFrom::Text { revision, text } => {
            match revision {
                Some(r) => println!(
                    "the description is revision {r} from Studio; the code is the checkout's"
                ),
                None => println!("the description is Studio's; the code is the checkout's"),
            }
            (*text).to_owned()
        }
    };
    let at = inside(repo, Path::new(product_file))
        .ok_or_else(|| anyhow!("'{product_file}' leaves the repository"))?;
    if let Some(dir) = at.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&at, text).with_context(|| format!("{product_file} could not be written"))
}

/// `build-prepare` for a project built without a product description
/// (ADR-0054 §7): the repository cloned, and its own Dockerfiles and chart
/// listed for `build` and `publish` as a generated tree's would be.
pub fn prepare_own(
    work: &Path,
    repo_url: &str,
    (username, password): (&str, &str),
    git_ref: Option<&str>,
    own: &super::model::OwnBuild,
) -> anyhow::Result<()> {
    let own = super::model::checked_own_build(own.clone()).map_err(|e| anyhow!("{e}"))?;
    let repo = work.join("repo");
    crate::connectors::sdk::git_checkout::clone_or_update_into(
        &repo, repo_url, username, password, git_ref,
    )
    .context("the repository could not be cloned")?;
    let commit = crate::connectors::sdk::git_checkout::head_commit(&repo)
        .ok_or_else(|| anyhow!("the clone has no commit"))?;
    let mut list = String::new();
    let mut named = Vec::new();
    for i in &own.images {
        let dockerfile = repo.join(&i.dockerfile);
        if !dockerfile.is_file() {
            bail!("{} is not in the repository at {commit}", i.dockerfile);
        }
        let folder = dockerfile.parent().unwrap_or(&repo).to_path_buf();
        let filename = dockerfile
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Dockerfile")
            .to_owned();
        let context = if i.context == "." {
            repo.clone()
        } else {
            repo.join(&i.context)
        };
        if !context.is_dir() {
            bail!(
                "the build context {} is not a folder in the repository",
                i.context
            );
        }
        list.push_str(&format!(
            "{} {} {} {} {}\n",
            i.app,
            i.name,
            folder.display(),
            context.display(),
            filename
        ));
        named.push((i.app.clone(), i.name.clone()));
    }
    std::fs::write(work.join("apps"), list)?;
    let short: String = commit.chars().take(12).collect();
    std::fs::write(work.join("tag"), format!("sha-{short}"))?;
    // The commit the images are labelled with (`org.opencontainers.image.revision`).
    std::fs::write(work.join("commit"), &commit)?;
    let chart_dir = repo.join(&own.chart);
    let chart_yaml = std::fs::read_to_string(chart_dir.join("Chart.yaml"))
        .with_context(|| format!("{} has no Chart.yaml", own.chart))?;
    let product = chart_yaml
        .lines()
        .find_map(|l| l.strip_prefix("name:"))
        .map(|n| n.trim().trim_matches('"').trim_matches('\'').to_owned())
        .filter(|n| !n.is_empty())
        .ok_or_else(|| anyhow!("{}/Chart.yaml names no chart", own.chart))?;
    let prepared = Prepared {
        product,
        profile: "own".to_owned(),
        commit,
        lock_hash: None,
        chart_dir: chart_dir.display().to_string(),
        chart_base: chart_base_version(&chart_yaml),
        apps: named,
        sources: Vec::new(),
        infra: Vec::new(),
        description_revision: None,
    };
    std::fs::write(
        work.join("build.json"),
        serde_json::to_vec_pretty(&prepared)?,
    )?;
    name_for_studio(&prepared);
    println!(
        "prepared {} image(s) and chart {} of the repository's own",
        prepared.apps.len(),
        prepared.product
    );
    Ok(())
}

/// [`prepare`] with the repository's credentials given, not read from the
/// environment: the server prepares a Research build in its own process.
#[allow(clippy::too_many_arguments)]
pub fn prepare_as(
    work: &Path,
    repo_url: &str,
    (username, password): (&str, &str),
    git_ref: Option<&str>,
    description: &DescriptionFrom<'_>,
    product_file: &str,
    profile: &str,
    options: &SourceOptions,
) -> anyhow::Result<()> {
    if !super::workflow::is_product_file(product_file) {
        bail!("'{product_file}' is not a product description in the repository");
    }
    let repo = work.join("repo");
    crate::connectors::sdk::git_checkout::clone_or_update_into(
        &repo, repo_url, username, password, git_ref,
    )
    .context("the product's repository could not be cloned")?;
    let commit = crate::connectors::sdk::git_checkout::head_commit(&repo)
        .ok_or_else(|| anyhow!("the clone has no commit"))?;
    lay_description(&repo, (username, password), description, product_file)?;
    let file = repo.join(product_file);
    if options.development {
        let text = std::fs::read_to_string(&file)
            .with_context(|| format!("{product_file} could not be read"))?;
        std::fs::write(&file, development_profile(&text, profile))?;
        println!(
            "profile {profile} is built as a development one (the environment's strictness is dev)"
        );
    }
    // Every source's commit, as fetched: the record of what a build took.
    let mut fetched: Vec<(String, String)> = Vec::new();

    let intent: serde_json::Value = serde_json::from_str(&run(
        Command::new(gearbox())
            .arg("product")
            .arg("--file")
            .arg(&file)
            .args(["--format", "json"]),
        "gearbox product",
    )?)
    .context("gearbox product did not answer JSON")?;
    let product = intent
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("{product_file} names no product id"))?
        .to_owned();

    let sources_dir = repo.join(".gearbox-sources");
    std::fs::create_dir_all(&sources_dir)?;
    let base = Path::new(product_file).parent().unwrap_or(Path::new(""));
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(sources) = intent.get("sources").and_then(|s| s.as_object()) {
        for (id, s) in sources {
            if !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            {
                bail!("source id '{id}' is not a folder name");
            }
            match s.get("kind").and_then(|k| k.as_str()) {
                Some("git") => {
                    let url = s.get("url").and_then(|v| v.as_str()).unwrap_or_default();
                    // A project's own repository is taken at the ref the
                    // server chose -- its branch, or the revision's pinned
                    // commit -- with the repository's credentials (ADR-0060
                    // §3); any other at the `rev` the description names.
                    let chosen = options.ref_of(id);
                    let rev = chosen
                        .or_else(|| s.get("rev").and_then(|v| v.as_str()))
                        .unwrap_or_default();
                    if !url.starts_with("https://") || rev.is_empty() {
                        bail!("source '{id}' is not an https git URL at a revision");
                    }
                    if let Some(r) = chosen {
                        println!("source {id} is the project's repository, taken at {r}");
                    }
                    let dir = sources_dir.join(id);
                    run(
                        Command::new("git").arg("init").arg("-q").arg(&dir),
                        "git init",
                    )?;
                    let mut fetch = Command::new("git");
                    if chosen.is_some() && !password.is_empty() {
                        // The token from the environment, never argv or the URL.
                        fetch
                            .env("GIT_TERMINAL_PROMPT", "0")
                            .env("STUDIO_GIT_TOKEN", password)
                            .args(["-c", "credential.helper="])
                            .arg("-c")
                            .arg(format!(
                                "credential.helper=!f() {{ echo username={username}; echo password=$STUDIO_GIT_TOKEN; }}; f"
                            ));
                    }
                    run(
                        fetch
                            .arg("-C")
                            .arg(&dir)
                            .args(["-c", "core.longpaths=true", "fetch", "-q", "--depth", "1"])
                            .arg(url)
                            .arg(rev),
                        &format!("fetching source '{id}'"),
                    )?;
                    run(
                        Command::new("git").arg("-C").arg(&dir).args([
                            "checkout",
                            "-q",
                            "FETCH_HEAD",
                        ]),
                        &format!("checking out source '{id}'"),
                    )?;
                    if let Some(c) = crate::connectors::sdk::git_checkout::head_commit(&dir) {
                        fetched.push((id.clone(), c));
                    }
                    roots.push(dir);
                }
                Some("path") => {
                    fetched.push((id.clone(), commit.clone()));
                    let at = s.get("at").and_then(|v| v.as_str()).unwrap_or_default();
                    let dir = inside(&repo, &base.join(at))
                        .ok_or_else(|| anyhow!("source '{id}' points outside the repository"))?;
                    if dir.file_name().and_then(|n| n.to_str()) == Some(id.as_str()) {
                        roots.push(dir);
                    } else {
                        #[cfg(unix)]
                        {
                            let link = sources_dir.join(id);
                            let rel = dir
                                .strip_prefix(&repo)
                                .map(|r| Path::new("..").join(r))
                                .unwrap_or(dir.clone());
                            std::os::unix::fs::symlink(&rel, &link)?;
                            roots.push(link);
                        }
                        #[cfg(not(unix))]
                        bail!("source '{id}' needs a link, which this platform cannot make");
                    }
                }
                other => bail!("source '{id}' is of a kind this build does not know ({other:?})"),
            }
        }
    }

    let out = repo.join(".gearbox").join("out");
    let lock = product_lock(&roots);
    let mut generate = Command::new(gearbox());
    generate.arg("generate");
    for r in &roots {
        generate.arg("--root").arg(r);
    }
    generate
        .arg("--product")
        .arg(&file)
        .arg("--profile")
        .arg(profile)
        .arg("--out")
        .arg(&out);
    if let Some(lock) = &lock {
        println!("platform crates at the versions in {}", lock.display());
        generate.arg("--cargo-lock").arg(lock);
    }
    let (_, said) = run_all(&mut generate, "gearbox generate")?;
    let diagnostics = generate_diagnostics(&said);
    if !diagnostics.is_empty() {
        println!("{diagnostics}");
    }
    let mixed = second_copies(&diagnostics);
    if !mixed.is_empty() {
        bail!(
            "the generated workspace would link two copies of a platform crate, and would not \
             compile:\n{}",
            mixed.join("\n")
        );
    }
    seed_lock(lock.as_deref(), &roots, &repo, &out)?;

    // The tree, made buildable (constructorfabric/gearbox#12).
    let docker = out.join("docker");
    let ignore = std::fs::read_to_string(docker.join(".dockerignore")).ok();
    let script = std::fs::read_to_string(docker.join("build.sh"))
        .context("the generated tree has no docker/build.sh: is the profile a kubernetes one?")?;
    let (context_rel, apps) = read_build_script(&script)?;
    // `../../..` from docker/ climbs out of it by design: the context is the
    // common ancestor of the tree and the sources. It must stay in /work.
    let context = inside(
        work,
        docker
            .strip_prefix(work)
            .unwrap_or(&docker)
            .join(&context_rel)
            .as_path(),
    )
    .ok_or_else(|| anyhow!("the build context '{context_rel}' leaves the work folder"))?;
    let mut list = String::new();
    let mut named = Vec::new();
    for (app, image) in &apps {
        let dockerfile = docker.join(app).join("Dockerfile");
        let text = std::fs::read_to_string(&dockerfile)
            .with_context(|| format!("no Dockerfile for {app}"))?;
        std::fs::write(&dockerfile, with_build_tools(&text))?;
        if let Some(ignore) = &ignore {
            std::fs::write(docker.join(app).join("Dockerfile.dockerignore"), ignore)?;
        }
        let name = image.split(':').next().unwrap_or(image).to_owned();
        list.push_str(&format!(
            "{app} {name} {} {}\n",
            docker.join(app).display(),
            context.display()
        ));
        named.push((app.clone(), name));
    }
    let infra = locked_infra(&intent, &roots, &file, profile)?;
    let chart_dir = out.join("helm").join(&product);
    // The product's screens: one image beside the applications, built from
    // the generated frontend's own folder, and named as the chart's `ui`
    // values name it. `docker/build.sh` builds only the Rust applications.
    let values = std::fs::read_to_string(chart_dir.join("values.yaml")).unwrap_or_default();
    if let Some((dir, name)) = ui_image(&out, &values) {
        list.push_str(&format!(
            "{UI_APP} {name} {} {}\n",
            dir.display(),
            dir.display()
        ));
        named.push((UI_APP.to_owned(), name));
    }
    std::fs::write(work.join("apps"), list)?;
    let short: String = commit.chars().take(12).collect();
    std::fs::write(work.join("tag"), format!("sha-{short}"))?;
    // The commit the images are labelled with (`org.opencontainers.image.revision`).
    std::fs::write(work.join("commit"), &commit)?;

    let chart_base = chart_base_version(
        &std::fs::read_to_string(chart_dir.join("Chart.yaml"))
            .context("the generated chart has no Chart.yaml")?,
    );
    let lock_hash = std::fs::read(out.join("product.lock"))
        .ok()
        .map(|b| hex::encode(Sha256::digest(&b)));
    let prepared = Prepared {
        product,
        profile: profile.to_owned(),
        commit,
        lock_hash,
        chart_dir: chart_dir.display().to_string(),
        chart_base,
        apps: named,
        sources: fetched,
        infra,
        description_revision: match description {
            DescriptionFrom::Text { revision, .. } => *revision,
            _ => None,
        },
    };
    std::fs::write(
        work.join("build.json"),
        serde_json::to_vec_pretty(&prepared)?,
    )?;
    name_for_studio(&prepared);
    println!(
        "prepared {} application(s) of {}",
        prepared.apps.len(),
        prepared.product
    );
    Ok(())
}

/// What the lock says of the product's infra services (ADR-0065 §3): asked
/// of `gearbox resolve` only when the description chooses any, since the
/// resolve scans every root again.
fn locked_infra(
    intent: &serde_json::Value,
    roots: &[PathBuf],
    file: &Path,
    profile: &str,
) -> anyhow::Result<Vec<super::infra::LockedService>> {
    let chooses = intent
        .get("infra")
        .and_then(|i| i.as_array())
        .is_some_and(|i| !i.is_empty());
    if !chooses {
        return Ok(Vec::new());
    }
    let mut resolve = Command::new(gearbox());
    resolve.arg("resolve");
    for r in roots {
        resolve.arg("--root").arg(r);
    }
    resolve
        .arg("--product")
        .arg(file)
        .arg("--profile")
        .arg(profile)
        .args(["--format", "json"]);
    let resolved: serde_json::Value = serde_json::from_str(&run(&mut resolve, "gearbox resolve")?)
        .context("gearbox resolve did not answer JSON")?;
    let services = super::infra::locked_services(&resolved).map_err(|e| anyhow!(e))?;
    println!(
        "infra services from the lock: {}",
        services
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
    Ok(services)
}

/// Leave what `prepare` made as its termination message, where Studio reads
/// it to mint the push token for exactly these names (ADR-0062 §2).
fn name_for_studio(prepared: &Prepared) {
    let named = Named {
        product: prepared.product.clone(),
        images: prepared.apps.iter().map(|(_, n)| n.clone()).collect(),
    };
    if let Ok(text) = serde_json::to_string(&named) {
        let _ = std::fs::write("/dev/termination-log", text);
    }
}

/// The digest BuildKit wrote for a pushed image.
pub fn digest_of(metadata: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(metadata)
        .ok()?
        .get("containerimage.digest")?
        .as_str()
        .filter(|d| d.starts_with("sha256:"))
        .map(str::to_owned)
}

/// `studio-backend build-publish`: the chart pushed beside the images, and
/// the manifest left where Studio reads it.
pub fn publish(work: &Path, prefix: &str, registry_config: &Path) -> anyhow::Result<String> {
    let prepared: Prepared = serde_json::from_slice(&std::fs::read(work.join("build.json"))?)?;
    let short: String = prepared.commit.chars().take(12).collect();
    let tag = format!("sha-{short}");
    let mut images = Vec::new();
    for (app, name) in &prepared.apps {
        let meta = std::fs::read_to_string(work.join("meta").join(format!("{app}.json")))
            .with_context(|| format!("{app} was not built"))?;
        let digest = digest_of(&meta).ok_or_else(|| anyhow!("{app} was built without a digest"))?;
        images.push(ManifestImage {
            app: app.clone(),
            image: format!("{prefix}/{name}:{tag}@{digest}"),
        });
    }
    let version = chart_version(
        &prepared.chart_base,
        &prepared.commit,
        prepared.description_revision,
        prepared.lock_hash.as_deref(),
    );
    let charts = work.join("charts");
    std::fs::create_dir_all(&charts)?;
    let home = work.join("helm");
    let helm = |args: &[&str]| -> anyhow::Result<String> {
        run(
            Command::new("helm")
                .args(args)
                .env("HELM_CACHE_HOME", home.join("cache"))
                .env("HELM_CONFIG_HOME", home.join("config"))
                .env("HELM_DATA_HOME", home.join("data")),
            &format!("helm {}", args.first().copied().unwrap_or_default()),
        )
    };
    helm(&[
        "package",
        &prepared.chart_dir,
        "--version",
        &version,
        "--destination",
        &charts.display().to_string(),
    ])?;
    let packaged = charts.join(format!("{}-{version}.tgz", prepared.product));
    let pushed = helm(&[
        "push",
        &packaged.display().to_string(),
        &format!("oci://{prefix}/charts"),
        "--registry-config",
        &registry_config.display().to_string(),
    ])?;
    let manifest = Manifest {
        product: prepared.product.clone(),
        profile: prepared.profile,
        commit: prepared.commit,
        lock_hash: prepared.lock_hash,
        images,
        chart: ManifestChart {
            reference: format!("oci://{prefix}/charts/{}", prepared.product),
            version,
            digest: pushed_digest(&pushed),
        },
        gearbox: engine_revision(),
        sources: prepared.sources,
        infra: prepared.infra,
    };
    let text = serde_json::to_string(&manifest)?;
    // The kubelet keeps a container's termination message (at most 4 KiB):
    // that is how Studio reads what was published without reading logs. One
    // cut short would be read as no manifest, or lose infra services.
    if text.len() > TERMINATION_MESSAGE_BYTES {
        bail!(
            "the build's manifest is {} bytes, over the {TERMINATION_MESSAGE_BYTES} a \
             termination message holds; its infra section has {} service(s)",
            text.len(),
            manifest.infra.len()
        );
    }
    let _ = std::fs::write("/dev/termination-log", &text);
    println!("{text}");
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUILD_SH: &str = "#!/bin/sh\nset -eu\nSCRIPT_DIR=$(CDPATH= cd -- \"$(dirname \"$0\")\" && pwd)\nCONTEXT=$(CDPATH= cd -- \"$SCRIPT_DIR/\"'../../..' && pwd)\nbuild_one() {\n  :\n}\nif [ \"$#\" -eq 0 ]; then\n  build_one api-gateway 'gbx-api-gateway:0.1.0'\n  build_one worker 'gbx-worker:0.1.0'\n  exit 0\nfi\nfor name in \"$@\"; do\n  case \"$name\" in\n    api-gateway) build_one api-gateway 'gbx-api-gateway:0.1.0' ;;\n  esac\ndone\n";

    fn payload() -> BuildPayload {
        BuildPayload {
            build_id: "studio-0123456789ab".into(),
            organization_id: Uuid::nil(),
            project_id: Uuid::nil(),
            connection_id: Uuid::nil(),
            registry_connection_id: Uuid::nil(),
            namespace: "studio-web-dev".into(),
            prefix: "ghcr.io/acme".into(),
            profile: "prod".into(),
            product_file: "products/sample/product.gdl".into(),
            repo: RepoRef {
                tenant: Uuid::nil(),
                connection_id: Uuid::nil(),
                repo: "acme/shop".into(),
                branch: "main".into(),
            },
            git_ref: None,
            builder_image: "ghcr.io/acme/studio-backend:sha-1".into(),
            buildkit_image: BUILDKIT_IMAGE.into(),
            records_in: None,
            description_revision: None,
            description_text: None,
            connections_from: None,
            own: None,
            source_refs: Vec::new(),
            strictness: None,
            builder_registry_connection_id: None,
            build_namespace: Some("studio-web-build".into()),
            pull_registry_connection_id: None,
            labels: vec![(
                "studio.constructor.tech/build".into(),
                "studio-0123456789ab".into(),
            )],
            requested_by: None,
            environment_id: None,
        }
    }

    fn environment(builder: Option<&str>) -> super::super::model::Environment {
        use super::super::model::*;
        let mut e = checked(
            &EnvironmentList::default(),
            None,
            EnvironmentInput {
                name: "dev".into(),
                description: String::new(),
                kind: EnvironmentKind::Kubernetes,
                connection_id: Uuid::nil(),
                research: None,
                registry: "ghcr.io/acme".into(),
                registry_connection_id: None,
                namespace_pattern: None,
                database: DatabaseMode::None,
                database_image: None,
                protected: false,
                promote_from: None,
                projects: None,
                previews: None,
                strictness: None,
                boundaries: Boundaries::default(),
            },
            String::new(),
            "t".into(),
        )
        .unwrap();
        e.boundaries.builder_image = builder.map(str::to_owned);
        e
    }

    const PINNED: &str = "ghcr.io/constructorfabric/studio-web/studio-builder@sha256:1111111111111111111111111111111111111111111111111111111111111111";

    #[test]
    fn a_build_runs_in_a_builder_pinned_by_digest_never_the_servers_image() {
        let platform = builder_from(&environment(None), Some(PINNED), false).unwrap();
        assert_eq!(
            (platform.image.as_str(), platform.from),
            (PINNED, "platform")
        );
        assert!(platform.pinned);
        let mirror = "mirror.acme.example/studio-builder@sha256:2222222222222222222222222222222222222222222222222222222222222222";
        let own = builder_from(&environment(Some(mirror)), Some(PINNED), false).unwrap();
        assert_eq!((own.image.as_str(), own.from), (mirror, "environment"));
        let (code, why) = builder_from(
            &environment(None),
            Some("ghcr.io/x/studio-builder:sha-1"),
            false,
        )
        .unwrap_err();
        assert_eq!(code, BUILDER_NOT_PINNED);
        assert!(why.contains("names no digest"), "{why}");
        let tagged = builder_from(
            &environment(None),
            Some("ghcr.io/x/studio-builder:sha-1"),
            true,
        )
        .unwrap();
        assert!(!tagged.pinned, "a stand that allows a tag gets it, marked");
        assert_eq!(
            builder_from(&environment(None), None, true).unwrap_err().0,
            BUILDER_NOT_PINNED
        );
    }

    #[test]
    fn the_job_runs_in_the_build_namespace_and_pushes_with_its_own_token() {
        let job = job_manifest(&payload(), true);
        let volumes = job
            .pointer("/spec/template/spec/volumes")
            .unwrap()
            .to_string();
        assert!(
            volumes.contains(&push_secret_name("studio-0123456789ab")),
            "{volumes}"
        );
        assert!(
            !volumes.contains(deploy::PULL_SECRET),
            "the pull secret is not the Job's"
        );
        let env = job
            .pointer("/spec/template/spec/initContainers/1/env")
            .unwrap()
            .to_string();
        assert!(
            env.contains("studio.constructor.tech/build=studio-0123456789ab"),
            "{env}"
        );
        assert_eq!(payload().job_namespace(), "studio-web-build");
        let mut p = payload();
        p.builder_registry_connection_id = Some(Uuid::nil());
        let job = job_manifest(&p, true);
        assert_eq!(
            job.pointer("/spec/template/spec/imagePullSecrets/0/name")
                .and_then(|v| v.as_str()),
            Some(builder_secret_name("studio-0123456789ab").as_str())
        );
        assert!(BUILD_SCRIPT.contains("/home/user/.studio-registry/ready"));
    }

    #[test]
    fn the_push_token_is_for_exactly_what_prepare_named() {
        let named = Named {
            product: "shop".into(),
            images: vec!["gbx-api".into(), "gbx-ui".into()],
        };
        assert_eq!(
            push_names("acme/shop", &named).unwrap(),
            [
                "acme/shop/gbx-api",
                "acme/shop/gbx-ui",
                "acme/shop/charts/shop"
            ]
        );
        let bad = Named {
            product: "shop".into(),
            images: vec!["../other/api".into()],
        };
        assert!(push_names("acme/shop", &bad).is_err());
        assert_eq!(registry_path("ghcr.io/acme/shop"), "acme/shop");
    }

    #[test]
    fn a_chart_push_says_its_digest_and_a_source_its_address_without_credentials() {
        let out = "Pushed: ghcr.io/acme/shop/charts/shop:0.1.0\nDigest: sha256:3333333333333333333333333333333333333333333333333333333333333333\n";
        assert_eq!(
            pushed_digest(out).as_deref(),
            Some("sha256:3333333333333333333333333333333333333333333333333333333333333333")
        );
        assert_eq!(pushed_digest("nothing"), None);
        assert_eq!(
            source_url("https://x-access-token:secret@github.com/acme/shop.git"),
            "https://github.com/acme/shop"
        );
        let labels = image_labels("2026-11-04T00:00:00Z", Uuid::nil(), "studio-1", Some(4));
        assert!(
            labels
                .iter()
                .any(|(k, v)| k == "studio.constructor.tech/description-revision" && v == "4")
        );
    }

    #[test]
    fn a_build_takes_each_project_source_at_the_ref_the_server_chose() {
        let mut p = payload();
        p.source_refs = vec![("billing".into(), "feature/x".into())];
        p.strictness = Some("dev".into());
        let job = job_manifest(&p, true);
        let args: Vec<String> = job
            .pointer("/spec/template/spec/initContainers/0/args")
            .and_then(|a| a.as_array())
            .unwrap()
            .iter()
            .filter_map(|a| a.as_str().map(str::to_owned))
            .collect();
        let after = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .and_then(|i| args.get(i + 1))
                .cloned()
        };
        assert_eq!(after("--source-ref").as_deref(), Some("billing=feature/x"));
        assert_eq!(after("--strictness").as_deref(), Some("dev"));
        let options = SourceOptions::parse(&["billing=feature/x".into()], Some("dev")).unwrap();
        assert_eq!(options.ref_of("billing"), Some("feature/x"));
        assert_eq!(options.ref_of("gears-rust"), None);
        assert!(options.development);
        assert!(SourceOptions::parse(&["nope".into()], None).is_err());
        // A payload queued before either is the build it always was.
        let old: BuildPayload = serde_json::from_value({
            let mut v = serde_json::to_value(payload()).unwrap();
            v.as_object_mut().unwrap().remove("source_refs");
            v
        })
        .unwrap();
        assert!(old.source_refs.is_empty() && old.strictness.is_none());
    }

    #[test]
    fn a_dev_strictness_marks_the_built_profile_development() {
        let gdl = "profiles = [\n    embedded(id = \"dev\", development = True),\n    kubernetes(id = \"prod\", discovery = \"static\", database = postgres(host = \"pg\")),\n],";
        let out = development_profile(gdl, "prod");
        assert!(
            out.contains("kubernetes(id = \"prod\", development = True, discovery"),
            "{out}"
        );
        assert_eq!(development_profile(&out, "prod"), out, "once");
        assert_eq!(development_profile(gdl, "dev"), gdl, "already marked");
        assert_eq!(development_profile(gdl, "local"), gdl, "no such profile");
    }

    #[test]
    fn a_watch_queued_before_records_in_still_reads_and_carries_it_on() {
        // A run queued by the release before: no `records_in`.
        let old: WatchPayload = serde_json::from_value(serde_json::json!({
            "build_id": "studio-0123456789ab", "organization_id": Uuid::nil(),
            "project_id": Uuid::nil(), "connection_id": Uuid::nil(),
            "namespace": "studio-web-dev", "job": "studio-build-0123456789ab",
            "repository": "acme/shop", "profile": "prod",
        }))
        .unwrap();
        assert_eq!(old.records_in, None);
        let mut b = payload();
        let tenant = Uuid::from_u128(1);
        b.records_in = Some(tenant);
        let back: BuildPayload = serde_json::from_value(serde_json::to_value(&b).unwrap()).unwrap();
        assert_eq!(back.records_in, Some(tenant));
    }

    fn pod(init: serde_json::Value, main: serde_json::Value) -> Pod {
        serde_json::from_value(serde_json::json!({
            "metadata": { "name": "studio-build-1" },
            "status": { "initContainerStatuses": init, "containerStatuses": main },
        }))
        .unwrap()
    }

    fn done(name: &str) -> serde_json::Value {
        serde_json::json!({ "name": name, "ready": false, "restartCount": 0, "image": "i", "imageID": "",
            "state": { "terminated": { "exitCode": 0 } } })
    }

    fn waiting(name: &str, reason: &str) -> serde_json::Value {
        serde_json::json!({ "name": name, "ready": false, "restartCount": 0, "image": "i", "imageID": "",
            "state": { "waiting": { "reason": reason, "message": "no such image" } } })
    }

    #[test]
    fn the_step_is_the_first_container_that_has_not_ended() {
        let p = pod(
            serde_json::json!([done("prepare"), waiting("build", "PodInitializing")]),
            serde_json::json!([waiting("publish", "PodInitializing")]),
        );
        assert_eq!(current_step(&p).as_deref(), Some("build"));
        let p = pod(
            serde_json::json!([done("prepare"), done("build")]),
            serde_json::json!([waiting("publish", "ContainerCreating")]),
        );
        assert_eq!(current_step(&p).as_deref(), Some("publish"));
        assert_eq!(stuck(&p), None);
    }

    #[test]
    fn each_step_says_whether_it_ran_so_only_a_started_ones_log_is_read() {
        let failed = serde_json::json!({ "name": "prepare", "ready": false, "restartCount": 0,
            "image": "i", "imageID": "", "state": { "terminated": { "exitCode": 1 } } });
        let running = serde_json::json!({ "name": "build", "ready": true, "restartCount": 0,
            "image": "i", "imageID": "", "state": { "running": {} } });
        let p = pod(
            serde_json::json!([failed, waiting("build", "PodInitializing")]),
            serde_json::json!([waiting("publish", "PodInitializing")]),
        );
        assert_eq!(
            steps_of(&p),
            vec![
                ("prepare".to_owned(), "failed"),
                ("build".to_owned(), "waiting"),
                ("publish".to_owned(), "waiting"),
            ]
        );
        let p = pod(
            serde_json::json!([done("prepare"), running]),
            serde_json::json!([waiting("publish", "PodInitializing")]),
        );
        assert_eq!(steps_of(&p)[0], ("prepare".to_owned(), "passed"));
        assert_eq!(steps_of(&p)[1], ("build".to_owned(), "running"));
    }

    #[test]
    fn an_image_that_cannot_be_pulled_fails_the_build_at_once() {
        let p = pod(
            serde_json::json!([waiting("prepare", "ImagePullBackOff")]),
            serde_json::json!([waiting("publish", "PodInitializing")]),
        );
        assert_eq!(
            stuck(&p),
            Some(("prepare".into(), "ImagePullBackOff: no such image".into()))
        );
    }

    #[test]
    fn the_tree_gets_the_lock_of_the_products_own_code_before_a_fetched_ones() {
        let work = std::env::temp_dir().join(format!("studio-seed-lock-{}", Uuid::new_v4()));
        let repo = work.join("repo");
        let own = repo.join("studio-backend");
        let fetched = work.join("sources").join("gears-rust");
        let out = repo.join(".gearbox").join("out");
        for d in [&own, &fetched, &out] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(fetched.join("Cargo.lock"), "fetched").unwrap();
        std::fs::write(own.join("Cargo.lock"), "own").unwrap();

        seed_lock(None, &[fetched.clone(), own.clone()], &repo, &out).unwrap();
        assert_eq!(
            std::fs::read_to_string(out.join("Cargo.lock")).unwrap(),
            "own"
        );

        // A lock the engine wrote is the tree's own, and stays.
        std::fs::write(out.join("Cargo.lock"), "generated").unwrap();
        seed_lock(None, &[own], &repo, &out).unwrap();
        assert_eq!(
            std::fs::read_to_string(out.join("Cargo.lock")).unwrap(),
            "generated"
        );

        std::fs::remove_dir_all(&work).ok();
    }

    const PLATFORM_LOCK: &str = r#"
version = 4

[[package]]
name = "cf-gears-toolkit"
version = "0.10.0"
"#;

    const PRODUCT_LOCK: &str = r#"
version = 4

[[package]]
name = "cf-studio-backend"
version = "0.1.0"

[[package]]
name = "cf-gears-toolkit"
version = "0.10.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
"#;

    #[test]
    fn the_product_codes_lock_is_the_one_that_takes_the_platform_from_outside() {
        // Both sources fetched by git, as a cluster build fetches them: the
        // platform's own lock (its crates are members, no `source`) at the
        // root, the product's two folders down.
        let work = std::env::temp_dir().join(format!("studio-product-lock-{}", Uuid::new_v4()));
        let platform = work.join("gears-rust");
        let product = work.join("studio-backend");
        let crate_dir = product.join("studio-backend");
        for d in [&platform, &crate_dir, &product.join("target").join("x")] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(platform.join("Cargo.lock"), PLATFORM_LOCK).unwrap();
        std::fs::write(crate_dir.join("Cargo.lock"), PRODUCT_LOCK).unwrap();
        // A build folder's lock is no one's decision.
        std::fs::write(
            product.join("target").join("x").join("Cargo.lock"),
            PRODUCT_LOCK,
        )
        .unwrap();

        let roots = [platform.clone(), product.clone()];
        let lock = product_lock(&roots);
        assert_eq!(
            lock.as_deref(),
            Some(crate_dir.join("Cargo.lock").as_path())
        );

        // It is the lock the tree gets, not the platform's.
        let repo = work.join("repo");
        let out = repo.join(".gearbox").join("out");
        std::fs::create_dir_all(&out).unwrap();
        seed_lock(lock.as_deref(), &roots, &repo, &out).unwrap();
        assert_eq!(
            std::fs::read_to_string(out.join("Cargo.lock")).unwrap(),
            PRODUCT_LOCK
        );

        // Two consumers' locks are two decisions: none is chosen.
        std::fs::write(product.join("Cargo.lock"), PRODUCT_LOCK).unwrap();
        assert_eq!(product_lock(&roots), None);

        std::fs::remove_dir_all(&work).ok();
    }

    #[test]
    fn generate_keeps_the_crate_source_notes_and_refuses_two_copies() {
        let said = "info [GBX0323] a.gdl:1: `x` is at preview\n    help: nothing to do\n\
                    info [GBX0713] Cargo.lock:1: 23 gear(s) taken from crates.io\n    help: from source: y\n\
                    warning [GBX0714] Cargo.lock:1: a gear built from source depends by path on \
                    `cf-gears-toolkit` at `/x`, which the build takes from crates.io at 0.10.0: \
                    two copies of it will link\n    help: add the gear\n";
        let kept = generate_diagnostics(said);
        assert!(!kept.contains("GBX0323"), "{kept}");
        assert!(
            kept.contains("GBX0713") && kept.contains("from source: y"),
            "{kept}"
        );
        assert_eq!(second_copies(&kept).len(), 1);
        assert!(second_copies("info [GBX0713] 24 gear(s)").is_empty());
    }

    #[test]
    fn a_failure_keeps_its_errors_however_many_notes_come_before_them() {
        let notes = "info [GBX0517] two plugins share a vendor\n    help: give them priorities\n"
            .repeat(40);
        let text = format!(
            "{notes}error [GBX0511] gear `tenant-resolver` has no implementation\n    \
             help: pick one\nwarning [GBX0315] no gRPC services\nerror: resolution reported errors"
        );
        let kept = errors_first(&text);
        assert_eq!(
            kept,
            "error [GBX0511] gear `tenant-resolver` has no implementation\n    help: pick one\n\
             error: resolution reported errors"
        );
        assert_eq!(errors_first("fatal: no such ref"), "fatal: no such ref");
    }

    #[test]
    fn a_failure_keeps_the_start_of_its_errors_and_the_end_of_a_log() {
        let error = "error [GBX0322] gear `tenant-resolver` carries `#[toolkit::consumes(...)]`";
        let notes = "info [GBX0517] note\n".repeat(40);
        let text = format!("{notes}{error}\n    help: {}", "x".repeat(5000));
        let kept = failure_text(&text);
        assert!(kept.starts_with(error), "{kept}");
        assert_eq!(kept.chars().count(), FAILURE_CHARS + 1);

        let log = format!("{}fatal: no such ref", "y".repeat(5000));
        let kept = failure_text(&log);
        assert!(
            kept.starts_with('…') && kept.ends_with("fatal: no such ref"),
            "{kept}"
        );
    }

    #[test]
    fn the_last_watch_round_comes_after_the_deadline() {
        assert!(u64::from(LAST_WATCH_ROUND) * WATCH_FOR.as_secs() > DEADLINE_SECS as u64);
    }

    #[test]
    fn the_build_script_lists_each_application_once_and_its_context() {
        let (context, apps) = read_build_script(BUILD_SH).unwrap();
        assert_eq!(context, "../../..");
        assert_eq!(
            apps,
            [
                ("api-gateway".to_owned(), "gbx-api-gateway:0.1.0".to_owned()),
                ("worker".to_owned(), "gbx-worker:0.1.0".to_owned()),
            ]
        );
        assert!(read_build_script("no script").is_err());
    }

    #[test]
    fn the_build_stage_gets_its_tools_once() {
        let df = "# GENERATED\nFROM rust:1.97.0-bookworm AS build\nWORKDIR /src\n\nFROM debian:bookworm-slim\n";
        let fixed = with_build_tools(df);
        let lines: Vec<&str> = fixed.lines().collect();
        assert_eq!(lines[1], "FROM rust:1.97.0-bookworm AS build");
        assert!(lines[2].contains("protobuf-compiler libprotobuf-dev cmake"));
        assert_eq!(with_build_tools(&fixed), fixed);
    }

    #[test]
    fn the_generated_ui_is_built_from_its_own_folder_under_the_charts_name() {
        let out = std::env::temp_dir().join(format!("bdb-ui-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&out);
        let values = "ui:\n  image: gbx-shop-frontend:0.1.0\n  pullPolicy: IfNotPresent\n";
        assert_eq!(ui_image(&out, values), None, "no frontend folder");
        std::fs::create_dir_all(out.join("frontend")).unwrap();
        std::fs::write(out.join("frontend").join("Dockerfile"), "FROM x\n").unwrap();
        assert_eq!(
            ui_image(&out, values),
            Some((out.join("frontend"), "gbx-shop-frontend".to_owned()))
        );
        assert_eq!(ui_image(&out, "api: {}\n"), None, "a chart without `ui`");
        let _ = std::fs::remove_dir_all(&out);
    }

    #[test]
    fn a_path_never_leaves_its_root() {
        let root = Path::new("/work/repo");
        assert_eq!(
            inside(root, Path::new("products/sample/../../studio-backend")),
            Some(PathBuf::from("/work/repo/studio-backend"))
        );
        assert_eq!(inside(root, Path::new("../etc")), None);
        assert_eq!(inside(root, Path::new("a/../../b")), None);
    }

    #[test]
    fn two_builds_of_one_commit_publish_their_charts_at_two_versions() {
        let commit = "0123456789abcdef0123456789abcdef01234567";
        let lock = "DEADBEEF00112233445566778899aabbccddeeff00112233445566778899aabb";
        assert_eq!(
            chart_version("0.1.0", commit, None, None),
            "0.1.0-sha.0123456789ab"
        );
        let r4 = chart_version("0.1.0", commit, Some(4), Some(lock));
        let r5 = chart_version("0.1.0", commit, Some(5), Some(lock));
        assert_eq!(r4, "0.1.0-sha.0123456789ab.r4.ldeadbeef");
        assert_ne!(r4, r5, "another description revision, another chart");
        assert_ne!(
            chart_version("0.1.0", commit, None, Some(lock)),
            chart_version("0.1.0", commit, None, Some("aa")),
            "another lock, another chart"
        );
        // SemVer as Helm reads it: pre-release identifiers of [0-9A-Za-z-].
        let pre = r4.split_once('-').unwrap().1;
        assert!(
            pre.split('.')
                .all(|id| !id.is_empty()
                    && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        );
        // A lock that is not hex is not written into the version.
        assert_eq!(
            chart_version("1.0.0", commit, None, Some("x/y")),
            "1.0.0-sha.0123456789ab"
        );
    }

    #[test]
    fn the_chart_version_and_the_digest_are_read_from_what_tools_wrote() {
        assert_eq!(
            chart_base_version("apiVersion: v2\nname: shop\nversion: \"0.1.0\"\n"),
            "0.1.0"
        );
        assert_eq!(chart_base_version("name: x\n"), "0.1.0");
        assert_eq!(
            digest_of(r#"{"containerimage.digest":"sha256:abc","image.name":"x"}"#).as_deref(),
            Some("sha256:abc")
        );
        assert_eq!(digest_of("{}"), None);
    }

    #[test]
    fn a_build_of_the_repositorys_own_tells_prepare_what_to_build() {
        let mut p = payload();
        assert!(
            !job_manifest(&p, true)["spec"]["template"]["spec"]["initContainers"][0]["args"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a == "--own")
        );
        p.own = Some(super::super::model::OwnBuild {
            images: vec![super::super::model::OwnImage {
                app: "hello".into(),
                name: "csharp-hello".into(),
                dockerfile: "Dockerfile".into(),
                context: ".".into(),
                values: Default::default(),
            }],
            chart: "chart/csharp-hello".into(),
        });
        let job = job_manifest(&p, true);
        let args = job["spec"]["template"]["spec"]["initContainers"][0]["args"]
            .as_array()
            .unwrap()
            .clone();
        let at = args.iter().position(|a| a == "--own").unwrap();
        let own: super::super::model::OwnBuild =
            serde_json::from_str(args[at + 1].as_str().unwrap()).unwrap();
        assert_eq!(own, p.own.unwrap());
        assert!(BUILD_SCRIPT.contains("--opt filename=\"${filename:-Dockerfile}\""));
    }

    #[test]
    fn the_job_runs_rootless_buildkit_between_studios_own_steps() {
        let job = with_clone_url(
            job_manifest(&payload(), true),
            "https://github.com/acme/shop.git",
        );
        assert_eq!(job["metadata"]["name"], "studio-build-0123456789ab");
        let spec = &job["spec"]["template"]["spec"];
        assert_eq!(spec["initContainers"][0]["name"], "prepare");
        assert_eq!(
            spec["initContainers"][0]["args"][4],
            "https://github.com/acme/shop.git"
        );
        assert!(
            spec["initContainers"][0]["args"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a == "main")
        );
        let build = &spec["initContainers"][1];
        assert_eq!(build["image"], BUILDKIT_IMAGE);
        assert!(build["securityContext"].get("privileged").is_none());
        assert_eq!(build["securityContext"]["runAsUser"], 1000);
        assert_eq!(spec["containers"][0]["name"], "publish");
        // The push token, never the namespace's pull secret.
        assert_eq!(
            spec["volumes"][2]["secret"]["secretName"],
            push_secret_name("studio-0123456789ab")
        );
        assert_eq!(job["spec"]["backoffLimit"], 0);
        let plain = job_manifest(&payload(), false);
        assert!(
            plain["spec"]["template"]["spec"]["initContainers"][0]["env"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["name"] != "GIT_PASSWORD")
        );
    }

    #[test]
    fn a_product_branch_lends_the_build_only_its_description() {
        assert_eq!(
            code_and_description_refs(Some("product/shop-1a2b3c4d"), "main"),
            ("main".to_owned(), Some("product/shop-1a2b3c4d".to_owned()))
        );
        assert_eq!(
            code_and_description_refs(Some("release/1.2"), "main"),
            ("release/1.2".to_owned(), None)
        );
        assert_eq!(
            code_and_description_refs(None, "main"),
            ("main".to_owned(), None)
        );
        assert_eq!(
            code_and_description_refs(Some("product/"), "main"),
            ("product/".to_owned(), None)
        );
        let mut p = payload();
        p.git_ref = Some("product/shop-1a2b3c4d".into());
        let args: Vec<String> = serde_json::from_value(
            job_manifest(&p, false)["spec"]["template"]["spec"]["initContainers"][0]["args"]
                .clone(),
        )
        .unwrap();
        let after = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .map(|i| args[i + 1].clone())
        };
        assert_eq!(after("--ref").as_deref(), Some("main"));
        assert_eq!(
            after("--description-ref").as_deref(),
            Some("product/shop-1a2b3c4d")
        );
        p.git_ref = None;
        let plain = job_manifest(&p, false);
        assert!(
            !plain["spec"]["template"]["spec"]["initContainers"][0]["args"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a == "--description-ref")
        );
    }

    #[test]
    fn the_job_takes_the_description_from_studio_and_the_code_from_the_base_branch() {
        let mut p = payload();
        p.git_ref = Some("product/shop-1a2b3c4d".into());
        p.description_revision = Some(4);
        p.description_text = Some("product shop {}".into());
        let job = job_manifest(&p, false);
        let prepare = &job["spec"]["template"]["spec"]["initContainers"][0];
        let args: Vec<String> = serde_json::from_value(prepare["args"].clone()).unwrap();
        let after = |flag: &str| {
            args.iter()
                .position(|a| a == flag)
                .map(|i| args[i + 1].clone())
        };
        assert_eq!(after("--ref").as_deref(), Some("main"));
        assert_eq!(after("--description-revision").as_deref(), Some("4"));
        assert_eq!(after("--description-ref"), None);
        assert!(
            prepare["env"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["name"] == DESCRIPTION_ENV && e["value"] == "product shop {}")
        );
        // A watch queued before the revision was carried still reads.
        let w: WatchPayload = serde_json::from_value(serde_json::json!({
            "build_id": "b", "organization_id": Uuid::nil(), "project_id": Uuid::nil(),
            "connection_id": Uuid::nil(), "namespace": "n", "job": "j",
            "repository": "acme/shop", "profile": "prod",
        }))
        .unwrap();
        assert_eq!(w.description_revision, None);
    }

    #[test]
    fn job_and_secret_names_are_dns_labels() {
        assert!(super::super::model::is_dns_label(&job_name(
            "studio-0123456789ab"
        )));
        assert!(super::super::model::is_dns_label(&git_secret_name(
            "studio-0123456789ab"
        )));
        assert!(job_name(&"x".repeat(100)).len() <= 63);
    }
}
