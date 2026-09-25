//! studio-artifact-ingest — pull issues, pull requests and files from a
//! connector source into the graph as typed GTS nodes.
//!
//! Three channels feed the artifact graph: the connector API (issues, pull
//! requests) and files. Files are read from the studio-session workspace
//! checkout when the IDE has already cloned the repo (one shared clone,
//! `STUDIO_WORKSPACES_ROOT`); otherwise from our own shallow clone
//! (`STUDIO_ARTIFACT_WORKDIR`, opt-in), otherwise the connector tree API
//! (metadata only). Entities are normalized to `gts.cf.studio.artifact.*`
//! instances with deterministic ids and upserted into a graph store (an
//! in-memory store, readable back by the portal, until the real
//! `hypothesis/graph-storage` adapter lands).

mod activity;
pub(crate) mod clone;
mod comment_threads;
mod entity;
mod graph;
#[cfg(feature = "graph")]
pub(crate) mod graph_backend;
pub(crate) mod gts;
mod index;
mod ingest_task;
mod migrations;
pub mod port;
mod rest;
mod service;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use credstore_sdk::CredStoreClientV1;
use file_parser_sdk::FileParserClientV1;
use toolkit::api::OpenApiRegistry;
use toolkit::client_hub::ClientScope;
use toolkit::contracts::{DatabaseCapability, RestApiCapability};
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

use crate::connectors::driver::ConnectorDriver;
use graph::InMemoryGraphStore;
use service::IngestService;

#[toolkit::gear(
    name = "studio-artifact-ingest",
    deps = [types_registry, credstore],
    capabilities = [db, rest]
)]
#[derive(Default)]
pub struct StudioArtifactIngestGear {
    /// `None` inside the `OnceLock` = booted without a driver → routes 503.
    service: std::sync::OnceLock<Option<Arc<IngestService>>>,
    /// The artifact index (see [`index`]). `None` = no database configured,
    /// and every listing reads the graph as it did before the index existed.
    index: std::sync::OnceLock<Option<Arc<index::ArtifactIndex>>>,
}

#[async_trait]
impl Gear for StudioArtifactIngestGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        // Register the artifact GTS type schemas (idempotent — same documents
        // every boot). The rest of the wiring — drivers, credstore, and the
        // graph store — is resolved in the REST phase, where every gear is
        // initialized: the graph-storage client must not be fetched in `init`,
        // which has no ordering guarantee against the graph-storage gear.
        let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
        let results = registry.register(gts::type_schemas()).await?;
        RegisterResult::ensure_all_ok(&results)?;
        info!("studio-artifact-ingest: types registered");

        // The index is optional in the same way studio-events' log is: without
        // a `database:` section nothing is lost but speed, so the gear says so
        // and carries on reading the graph.
        let index = match ctx.db_required() {
            Ok(db) => {
                info!(
                    "studio-artifact-ingest: artifact index enabled — scoped listings read Postgres"
                );
                Some(Arc::new(index::ArtifactIndex::new(db.db())))
            }
            Err(e) => {
                warn!(
                    "studio-artifact-ingest: no database configured — no artifact index, every \
                     listing walks the graph. Add a `database:` section (server + dbname) to \
                     enable it: {e}"
                );
                None
            }
        };
        let _ = self.index.set(index);
        Ok(())
    }
}

impl DatabaseCapability for StudioArtifactIngestGear {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        migrations::Migrator::migrations()
    }
}

/// Resolve the artifact graph store. Prefers the real graph-storage gear (when
/// the `graph` feature is on and its client is published); otherwise the
/// in-memory fallback so the pipeline still runs and the portal still shows
/// what was ingested.
fn build_graph_store(ctx: &GearCtx) -> Arc<dyn graph::GraphStore> {
    #[cfg(feature = "graph")]
    {
        match ctx
            .client_hub()
            .get::<dyn graph_storage_sdk::GraphStorageClientV1>()
        {
            Ok(client) => {
                info!(
                    "studio-artifact-ingest: using the graph-storage gear as the artifact graph store"
                );
                return Arc::new(graph_backend::GraphStorageBackend::new(client));
            }
            Err(e) => warn!(
                error = %e,
                "studio-artifact-ingest: graph-storage client unavailable — using the in-memory store"
            ),
        }
    }
    let _ = ctx;
    Arc::new(InMemoryGraphStore::default())
}

/// A directory path from an env var, `~`-expanded, or `None` if unset/empty.
fn resolve_dir(env: &str) -> Option<PathBuf> {
    let raw = std::env::var(env).ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(rest) = raw.strip_prefix("~/")
        && let Ok(home) = std::env::var("HOME")
    {
        return Some(PathBuf::from(home).join(rest));
    }
    Some(PathBuf::from(raw))
}

/// `$HOME/<rel>`, or `None` when `$HOME` is unset.
fn resolve_home_relative(rel: &str) -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join(rel))
}

#[async_trait]
impl RestApiCapability for StudioArtifactIngestGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        // Resolve the source connector drivers by the same ClientHub ids the
        // connector gear uses. A provider whose plugin is not linked is skipped.
        let mut drivers: HashMap<String, Arc<dyn ConnectorDriver>> = HashMap::new();
        for id in crate::connectors::source_driver_ids() {
            if let Ok(d) = ctx
                .client_hub()
                .get_scoped::<dyn ConnectorDriver>(&ClientScope::gts_id(id))
            {
                drivers.insert(d.provider().to_string(), d);
            }
        }

        let service = if drivers.is_empty() {
            warn!(
                "studio-artifact-ingest: no connector driver plugins registered — \
                 /sync will answer 503"
            );
            None
        } else {
            let credstore = ctx.client_hub().get::<dyn CredStoreClientV1>()?;
            let graph = build_graph_store(ctx);
            let graph: Arc<dyn graph::GraphStore> = match self.index.get().cloned().flatten() {
                Some(index) => Arc::new(index::IndexedGraphStore::new(graph, index)),
                None => graph,
            };

            // Preferred file source: the studio-session workspaces root. When
            // the IDE has cloned a repo into `{root}/{workspace_id}/{repo_dir}`,
            // ingest reads that same checkout — one shared clone. Mirrors the
            // session gear's default (`~/.cf-studio-workspaces`).
            let workspaces_root = resolve_dir("STUDIO_WORKSPACES_ROOT")
                .or_else(|| resolve_home_relative(".cf-studio-workspaces"));
            if let Some(r) = &workspaces_root {
                info!(dir = %r.display(), "studio-artifact-ingest: reading files from the session workspaces root when present");
            }

            // Optional fallback: our own shallow clone volume (off unless
            // STUDIO_ARTIFACT_WORKDIR is set).
            let work_root = match resolve_dir("STUDIO_ARTIFACT_WORKDIR") {
                Some(path) => match std::fs::create_dir_all(&path) {
                    Ok(()) => {
                        info!(dir = %path.display(), "studio-artifact-ingest: fallback own-clone volume enabled");
                        Some(path)
                    }
                    Err(e) => {
                        warn!(dir = %path.display(), error = %e, "studio-artifact-ingest: fallback work dir not usable");
                        None
                    }
                },
                None => None,
            };

            // File-parser gear: extracts text from binary documents (PDF/docx/…)
            // so their content is indexed for search. Optional — when the gear
            // is not linked/available, binary files stay metadata-only.
            let file_parser = match ctx.client_hub().get::<dyn FileParserClientV1>() {
                Ok(c) => {
                    info!(
                        "studio-artifact-ingest: file-parser gear wired — binary documents will be text-extracted"
                    );
                    Some(c)
                }
                Err(e) => {
                    warn!(error = %e, "studio-artifact-ingest: file-parser unavailable — binary documents stay metadata-only");
                    None
                }
            };

            // studio-documents, if this deployment runs it. Resolved here, in
            // the REST phase, where every gear has initialized — the same
            // reason the graph client is not fetched in `init`. Absent is a
            // normal state: the gear stands down without a database, and a
            // repository then syncs without being classified.
            let classifier = match ctx
                .client_hub()
                .get::<dyn crate::documents::port::DocumentClassifier>()
            {
                Ok(c) => {
                    info!(
                        "studio-artifact-ingest: studio-documents wired — a sync decides what every file it reads is"
                    );
                    Some(c)
                }
                Err(e) => {
                    warn!(error = %e, "studio-artifact-ingest: studio-documents unavailable — files stay unclassified");
                    None
                }
            };

            Some(Arc::new(IngestService::new(
                credstore,
                drivers,
                graph,
                file_parser,
                classifier,
                workspaces_root,
                work_root,
            )))
        };

        // A sync is an `artifact.ingest` run on studio-tasks — durable,
        // cancellable, retried with backoff. Registered here because the
        // service it needs is built here, and refused loudly if something else
        // has claimed the task type.
        if let Some(service) = &service {
            crate::tasks::registry::register(Arc::new(ingest_task::IngestTask::new(Arc::clone(
                service,
            ))))?;
        }

        // Offer the checkout to whoever owns the documents in it.
        //
        // The documents gear knows which files are specs and what type each is;
        // what it has never had is their text, because nobody stores it: the
        // graph keeps an excerpt and a binding keeps a path. Without this the
        // only thing that could join the two was the browser, which read the
        // files out through REST and posted them back to be analysed.
        if let Some(service) = &service {
            ctx.client_hub()
                .register::<dyn port::RepoFileReader>(service.clone());
            // The portfolio's finding count, for whoever composes the rollup.
            ctx.client_hub()
                .register::<dyn port::ArtifactCounter>(service.clone());
            // The ingested files, for the gear that decides what each one is.
            ctx.client_hub()
                .register::<dyn port::ArtifactFiles>(service.clone());
        }

        // Retain for the process lifetime; the router also owns a clone.
        let _ = self.service.set(service.clone());
        Ok(rest::register_routes(
            router,
            openapi,
            service,
            ctx.client_hub(),
        ))
    }
}
