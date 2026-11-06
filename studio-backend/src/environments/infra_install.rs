//! The run's part of a product's infra services (ADR-0064 §5): before the
//! release, each service's own secrets are made once and kept in credstore,
//! what it provides is written there as the release's configuration
//! secrets, and the service is installed -- from its ready chart, or from
//! the chart generated from its passport -- unless the database step makes
//! it or a shared place runs it.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, anyhow};
use toolkit::client_hub::ClientHub;

use super::{DeployPayload, HELM_TIMEOUT, PULL_SECRET, Scratch, helm};
use crate::connectors::sdk::{ClusterAccess, RegistryAccess, same_registry};
use crate::environments::infra::{self, InfraInstall, Install};
use crate::environments::model;
use crate::tasks::sdk::TaskContext;

/// A new secret value: 64 hex characters.
fn new_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// The arguments that install one infra service's chart as its own release.
pub(super) fn install_args(
    name: &str,
    chart: &str,
    p: &DeployPayload,
    kubeconfig: &Path,
    version: Option<&str>,
    values: Option<&Path>,
    registry_config: Option<&Path>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "upgrade".into(),
        "--install".into(),
        name.into(),
        chart.into(),
        "--namespace".into(),
        p.namespace.clone(),
        "--kubeconfig".into(),
        kubeconfig.display().to_string(),
        "--wait".into(),
        "--timeout".into(),
        HELM_TIMEOUT.into(),
        "--history-max".into(),
        "5".into(),
    ];
    if let Some(v) = version {
        args.extend(["--version".into(), v.into()]);
    }
    if let Some(v) = values {
        args.extend(["--values".into(), v.display().to_string()]);
    }
    if let Some(c) = registry_config {
        args.extend(["--registry-config".into(), c.display().to_string()]);
    }
    args
}

type Store = Arc<dyn credstore_sdk::CredStoreClientV1>;

/// The value kept under `reference`, if any.
async fn kept(
    credstore: &Store,
    ctx: &toolkit_security::SecurityContext,
    reference: &str,
) -> anyhow::Result<Option<String>> {
    let sref = credstore_sdk::SecretRef::new(reference)
        .map_err(|e| anyhow!("bad secret reference {reference}: {e}"))?;
    let Some(v) = credstore
        .get(ctx, &sref)
        .await
        .map_err(|e| anyhow!("credstore: {e}"))?
    else {
        return Ok(None);
    };
    String::from_utf8(v.value.as_bytes().to_vec())
        .map(Some)
        .map_err(|_| anyhow!("{reference} is not text"))
}

/// Keep `value` under `reference`: replace it, or create it.
async fn keep(
    credstore: &Store,
    ctx: &toolkit_security::SecurityContext,
    reference: &str,
    value: &str,
) -> anyhow::Result<()> {
    let sref = credstore_sdk::SecretRef::new(reference)
        .map_err(|e| anyhow!("bad secret reference {reference}: {e}"))?;
    let bytes = value.as_bytes().to_vec();
    if credstore
        .put(
            ctx,
            &sref,
            credstore_sdk::SecretValue::new(bytes.clone()),
            credstore_sdk::SharingMode::Tenant,
            credstore_sdk::WritePrecondition::Exists,
        )
        .await
        .is_err()
    {
        credstore
            .create(
                ctx,
                &sref,
                credstore_sdk::SecretValue::new(bytes),
                credstore_sdk::SharingMode::Tenant,
            )
            .await
            .map_err(|e| anyhow!("credstore: {reference} could not be kept: {e}"))?;
    }
    Ok(())
}

/// `i`'s own secrets: each one kept from an earlier deploy, else made now
/// and kept, so a restart or the next deploy finds the same password.
async fn own_secrets(
    credstore: &Store,
    ctx: &toolkit_security::SecurityContext,
    p: &DeployPayload,
    i: &InfraInstall,
) -> anyhow::Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for key in &i.service.passport.secrets {
        let reference = model::config_secret_ref(
            p.project_id,
            p.environment_id,
            &infra::secret_key(i.service.name(), key),
        );
        let value = match kept(credstore, ctx, &reference).await? {
            Some(v) => v,
            None => {
                let v = new_secret();
                keep(credstore, ctx, &reference, &v).await?;
                v
            }
        };
        out.insert(key.clone(), value);
    }
    // What its files read as `{env.KEY}`: the project's configuration
    // secret KEY there, made and kept once when none is set, so the realm's
    // client and the gear that reads `${KEY}` hold the same value.
    let one = std::slice::from_ref(i);
    for key in infra::file_variables(one) {
        let reference = model::config_secret_ref(p.project_id, p.environment_id, &key);
        let value = match kept(credstore, ctx, &reference).await? {
            Some(v) => v,
            None => {
                let v = new_secret();
                keep(credstore, ctx, &reference, &v).await?;
                v
            }
        };
        out.insert(infra::env_slot(&key), value);
    }
    Ok(out)
}

/// Write a generated chart's files under `dir`.
fn write_chart(dir: &Path, files: Vec<(String, String)>) -> anyhow::Result<()> {
    for (path, body) in files {
        let file = dir.join(&path);
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("cannot make {}", parent.display()))?;
        }
        std::fs::write(&file, body).with_context(|| format!("cannot write {}", file.display()))?;
    }
    Ok(())
}

/// Bring every infra service of the run's payload.
pub(super) async fn bring(
    hub: &Arc<ClientHub>,
    ctx: &TaskContext,
    access: &ClusterAccess,
    registry: Option<&RegistryAccess>,
    p: &DeployPayload,
) -> anyhow::Result<()> {
    let credstore: Store = hub
        .get::<dyn credstore_sdk::CredStoreClientV1>()
        .map_err(|_| anyhow!("credstore is not available in this deployment"))?;
    let scratch = Scratch::new()?;
    let kubeconfig = scratch.write("infra-kubeconfig", access.kubeconfig_yaml().as_bytes())?;
    let mut registry_config = None;
    for i in &p.infra {
        let name = i.service.name();
        if i.install == Install::Database {
            ctx.progress(format!(
                "{name}: the database step makes the product's server with its image"
            ))
            .await;
            continue;
        }
        let secrets = if i.install == Install::Shared {
            BTreeMap::new()
        } else {
            own_secrets(&credstore, &ctx.security, p, i).await?
        };
        let values = infra::provided_values(&i.service, i.shared.as_ref(), &p.namespace, &secrets)
            .map_err(|e| anyhow!("{name}: {e}"))?;
        for (variable, value) in &values {
            let reference = model::config_secret_ref(p.project_id, p.environment_id, variable);
            keep(&credstore, &ctx.security, &reference, value).await?;
        }
        match i.install {
            Install::Database => {}
            Install::Shared => {
                ctx.progress(format!(
                    "{name}: the organization's shared place, {} value(s) for the product",
                    values.len()
                ))
                .await;
            }
            Install::Generated => {
                let image = i.service.image.as_deref().ok_or_else(|| {
                    anyhow!("INFRA_IMAGE_NOT_IMPORTED: {name} has no image in the project's path")
                })?;
                let files = infra::generated_chart(
                    &i.service,
                    image,
                    &p.namespace,
                    &secrets,
                    p.registry_connection_id.map(|_| PULL_SECRET),
                    i.ingress.as_ref(),
                )
                .map_err(|e| anyhow!("{name}: {e}"))?;
                if let Some(url) = i.ingress.as_ref().and(i.service.public_url.as_deref()) {
                    ctx.progress(format!("{name}: an Ingress routes {url} to it"))
                        .await;
                }
                let dir = scratch.path().join("infra").join(name);
                write_chart(&dir, files)?;
                ctx.progress(format!(
                    "helm upgrade --install {name} (generated from its passport) into {}",
                    p.namespace
                ))
                .await;
                let chart = dir.display().to_string();
                helm(
                    &scratch,
                    install_args(name, &chart, p, &kubeconfig, None, None, None),
                    &ctx.cancel,
                )
                .await
                .with_context(|| format!("the infra service {name} could not be installed"))?;
            }
            Install::Chart => {
                let reference = i.service.chart_ref.as_deref().unwrap_or_default();
                let version = i.service.chart_version.as_deref();
                let registry = registry.ok_or_else(|| {
                    anyhow!(
                        "{name}'s chart is pulled with the environment's registry, and it has none"
                    )
                })?;
                same_registry(registry, reference)?;
                if registry_config.is_none() {
                    registry_config = Some(scratch.write(
                        "infra-registry.json",
                        registry.docker_config_json().as_bytes(),
                    )?);
                }
                let chart_values = infra::chart_values(&i.service, &p.namespace, &secrets)
                    .map_err(|e| anyhow!("{name}: {e}"))?;
                let values_file = scratch.write(
                    &format!("infra-{name}-values.json"),
                    serde_json::to_string(&chart_values)?.as_bytes(),
                )?;
                ctx.progress(format!(
                    "helm upgrade --install {name} from {reference} into {}",
                    p.namespace
                ))
                .await;
                helm(
                    &scratch,
                    install_args(
                        name,
                        reference,
                        p,
                        &kubeconfig,
                        version,
                        Some(&values_file),
                        registry_config.as_deref(),
                    ),
                    &ctx.cancel,
                )
                .await
                .with_context(|| format!("the infra service {name} could not be installed"))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_infra_service_is_its_own_release_in_the_products_namespace() {
        let mut p = super::super::tests::payload();
        p.namespace = "shop-dev".into();
        let args = install_args(
            "keycloak",
            "oci://r.example/acme/shop/mirror/charts/keycloak",
            &p,
            Path::new("/s/k"),
            Some("24.4.0"),
            Some(Path::new("/s/v.json")),
            Some(Path::new("/s/r.json")),
        );
        let joined = args.join(" ");
        assert!(
            joined.starts_with(
                "upgrade --install keycloak oci://r.example/acme/shop/mirror/charts/keycloak \
                 --namespace shop-dev"
            ),
            "{joined}"
        );
        assert!(joined.contains("--version 24.4.0"));
        assert!(joined.contains("--values /s/v.json"));
        assert!(joined.contains("--registry-config /s/r.json"));
        assert!(joined.contains("--wait"));
    }

    #[test]
    fn a_generated_chart_is_written_as_files() {
        let dir = std::env::temp_dir().join(format!("infra-chart-{}", uuid::Uuid::new_v4()));
        write_chart(
            &dir,
            vec![
                ("Chart.yaml".into(), "name: x\n".into()),
                ("templates/a.yaml".into(), "kind: Service\n".into()),
            ],
        )
        .unwrap();
        assert!(dir.join("templates/a.yaml").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
