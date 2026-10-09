//! What the catalogue offers another gear about the roadmap: the reports gear
//! (`crate::reports`) reads the board through here and nothing else.
//!
//! The catalogue owns reading a board, because a board is a source of
//! component facts -- a gear's stage, ETA and who waits for it show on its
//! card whether or not anyone draws a report. What a report is, where its
//! plan lives and how it is laid out belong to the reports gear. Between the
//! two there are three questions, and this trait is exactly those.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Map, Value};
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_security::SecurityContext;
use uuid::Uuid;

pub use super::roadmap::{RoadmapFields, RoadmapSource as BoardSource};
pub use super::service::UnreadBoard;
use super::service::{CatalogCounts, CatalogService, SyncSources};

/// The boards a finished `catalog.sync` run could not read, from its result.
pub fn unread_boards(result: &Value) -> Vec<UnreadBoard> {
    serde_json::from_value::<CatalogCounts>(result.clone())
        .map(|c| c.boards_unread)
        .unwrap_or_default()
}

/// One catalogued component's reconciled values.
#[derive(Clone, Debug)]
pub struct ComponentValues {
    pub name: String,
    pub category: String,
    pub values: Map<String, Value>,
}

#[async_trait]
pub trait RoadmapCatalog: Send + Sync {
    /// The gears every board plans, as the last sync that read each board
    /// stored them (`roadmap_item` payloads).
    async fn planned(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<Value>>;

    /// Every catalogued component, with its values reconciled -- not the
    /// planned gears listed as components, which `planned` already answers.
    async fn components(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<ComponentValues>>;

    /// Queue a sync of one board: a `catalog.sync` run, the same a person
    /// starts from the Components page. Answers the run's id.
    async fn sync_board(&self, ctx: &SecurityContext, board: BoardSource) -> anyhow::Result<Uuid>;
}

/// The catalogue's answer to [`RoadmapCatalog`].
pub struct CatalogRoadmaps {
    service: Arc<CatalogService>,
    hub: Arc<ClientHub>,
}

impl CatalogRoadmaps {
    pub fn new(service: Arc<CatalogService>, hub: Arc<ClientHub>) -> Self {
        Self { service, hub }
    }
}

/// The run a board sync is: one board, nothing else read.
pub fn board_sync_payload(board: BoardSource) -> anyhow::Result<Value> {
    Ok(serde_json::to_value(SyncSources {
        crates_io: None,
        repos: Vec::new(),
        roadmaps: vec![board],
        registry: false,
        platform: false,
    })?)
}

#[async_trait]
impl RoadmapCatalog for CatalogRoadmaps {
    async fn planned(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<Value>> {
        self.service.list_planned(ctx).await
    }

    async fn components(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<ComponentValues>> {
        let (resolved, _) = self.service.resolved_components(ctx).await?;
        Ok(resolved
            .into_iter()
            .filter(|c| !c.planned)
            .map(|c| ComponentValues {
                name: c.name,
                category: c.category,
                values: c.values,
            })
            .collect())
    }

    async fn sync_board(&self, ctx: &SecurityContext, board: BoardSource) -> anyhow::Result<Uuid> {
        // Resolved per call, like the REST route does: this gear must not care
        // whether studio-tasks initialized first.
        let queue = self
            .hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
            .map_err(|_| anyhow::anyhow!("catalog syncs are not available in this deployment (studio-tasks has no database configured)"))?;
        let tenant = board.tenant;
        queue
            .enqueue(
                ctx,
                crate::tasks::sdk::NewRun {
                    tenant,
                    task_type: super::sync_task::TASK_TYPE,
                    payload: board_sync_payload(board)?,
                    // The same partition as a sync from the Components page:
                    // two writers of one catalogue queue behind each other.
                    partition_key: Some("catalog"),
                    idempotency_key: None,
                    coalesce_queued: true,
                    notify_workspace_id: None,
                },
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn a_board_sync_reads_the_board_and_nothing_else() {
        let board = BoardSource {
            tenant: Uuid::from_u128(1),
            connection_id: Some(Uuid::from_u128(2)),
            owner: "constructorfabric".into(),
            number: 48,
            consumers: BTreeMap::from([("A".to_string(), "Acronis".to_string())]),
            fields: RoadmapFields::default(),
            roots: vec!["constructorfabric/gears-rust#3342".into()],
        };
        let payload = board_sync_payload(board).expect("payload");
        let back: SyncSources = serde_json::from_value(payload).expect("a catalog sync");
        assert!(back.crates_io.is_none());
        assert!(back.repos.is_empty());
        assert_eq!(back.roadmaps.len(), 1);
        assert_eq!(back.roadmaps[0].number, 48);
        assert_eq!(
            back.roadmaps[0].roots,
            vec!["constructorfabric/gears-rust#3342"]
        );
    }
}

// ── What the spec-mapping gear reads ─────────────────────────────────────────

/// The tiers a component comes from (ADR-0042): every node
/// [`ComponentCatalog::components`] answers carries one as `tier`.
pub use super::tiers::{
    ORGANIZATION as TIER_ORGANIZATION, PLATFORM as TIER_PLATFORM, PROJECT as TIER_PROJECT,
};

/// One change the Gearbox engine would make to a set of gears.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineChange {
    /// Crate name.
    pub gear: String,
    pub added: bool,
    pub reason: String,
}

/// What the catalogue offers the spec-mapping gear (`crate::spec_mapping`): the
/// components a specification is matched against, and the code a project is
/// made of. The rules of the matching live in that gear; the facts here.
#[async_trait]
pub trait ComponentCatalog: Send + Sync {
    /// Every catalogued component's node, and the profiles by the gear they
    /// describe (`gear_name`). In the context's tenant, which the caller has
    /// already scoped to the organization on screen, joined with the
    /// platform's tier: each node marked `tier` (`platform` or
    /// `organization`), an organization node the platform shadows left out.
    async fn components(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<(Vec<Value>, Map<String, Value>)>;

    /// The project's code: the repository read, and the crate names every
    /// `Cargo.toml` in it depends on. `None` when there is no code to read.
    async fn project_dependencies(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<(String, std::collections::BTreeSet<String>)>>;

    /// The gears the project's own code declares -- a `gear.toml` or
    /// `gear.gdl` directory, or `#[toolkit::gear(name = ...)]` in its Rust
    /// source -- read from the same repositories as
    /// [`Self::project_dependencies`], in the shape of [`Self::components`]:
    /// nodes marked `origin: "project"` with their repository `path`, and
    /// profiles by gear name. Empty when the project has no code to read.
    async fn project_gears(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<(Vec<Value>, Map<String, Value>)>;

    /// What the Gearbox engine would add to `gears` for them to resolve, and
    /// what it says cannot run. `None` when no engine is configured.
    async fn engine_completion(
        &self,
        gears: &[String],
    ) -> Option<anyhow::Result<Vec<EngineChange>>>;
}

/// The catalogue's answer to [`ComponentCatalog`].
pub struct CatalogComponents {
    service: Arc<CatalogService>,
    gearbox: Option<Arc<crate::product::sdk::Gearbox>>,
}

impl CatalogComponents {
    pub fn new(
        service: Arc<CatalogService>,
        gearbox: Option<Arc<crate::product::sdk::Gearbox>>,
    ) -> Self {
        Self { service, gearbox }
    }
}

/// Gear profiles keyed by the gear they describe.
///
/// A profile names its gear `gear_name` (`gts::gear_profile_node`); keying by
/// `name` -- which no profile has -- left the map empty, so the composer never
/// saw a gear's build state or what the Gearbox engine knows about it, and
/// every suggestion read `undescribed`.
pub fn profiles_by_gear(values: impl IntoIterator<Item = Value>) -> Map<String, Value> {
    let mut profiles = Map::new();
    for value in values {
        if let Some(name) = value.get("gear_name").and_then(Value::as_str) {
            profiles.insert(name.to_owned(), value);
        }
    }
    profiles
}

#[async_trait]
impl ComponentCatalog for CatalogComponents {
    async fn components(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<(Vec<Value>, Map<String, Value>)> {
        let (nodes, _truncated) = self.service.list_component_nodes(ctx).await?;
        let profiles = self.service.list_profiles(ctx).await?;
        Ok((
            nodes.into_iter().map(|n| n.value).collect(),
            profiles_by_gear(profiles.into_iter().map(|n| n.value)),
        ))
    }

    async fn project_dependencies(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<(String, std::collections::BTreeSet<String>)>> {
        self.service.project_dependencies(ctx, project_id).await
    }

    async fn project_gears(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<(Vec<Value>, Map<String, Value>)> {
        let gears = self.service.project_gears(ctx, project_id).await?;
        Ok(super::project_gears::catalogue_shape(&gears))
    }

    async fn engine_completion(
        &self,
        gears: &[String],
    ) -> Option<anyhow::Result<Vec<EngineChange>>> {
        let gearbox = self.gearbox.as_ref()?;
        Some(
            gearbox
                .complete(gears, &crate::product::sdk::GearConfig::new())
                .await
                .map(|done| {
                    done.changes
                        .into_iter()
                        .map(|c| EngineChange {
                            gear: c.gear,
                            added: c.added,
                            reason: c.reason,
                        })
                        .collect()
                }),
        )
    }
}

#[cfg(test)]
mod profiles_by_gear_tests {
    use super::profiles_by_gear;
    use serde_json::json;

    /// The shape the sync writes, read back the way the composer needs it.
    #[test]
    fn a_profile_is_found_by_the_gear_it_describes() {
        let map = profiles_by_gear([
            json!({ "gear_name": "cf-gears-api-gateway", "auto": { "gdl_runs": { "s": "good" } } }),
            json!({ "auto": {} }),
        ]);
        assert_eq!(map.len(), 1);
        assert_eq!(map["cf-gears-api-gateway"]["auto"]["gdl_runs"]["s"], "good");
    }
}

// ── The organization's registry (ADR-0041) ───────────────────────────────────

pub use super::registry::{RegistryEntry, STATE_DEPRECATED, STATE_MERGED, STATE_REJECTED};

/// Whether the registry still offers an entry to build with. A `rejected`
/// entry is not a gear by the organization's decision, and a `merged` one is
/// another entry under an old name; a `deprecated` one is still offered, with
/// its state, so a screen can say what replaces it.
pub fn offered(state: &str) -> bool {
    state != STATE_REJECTED && state != STATE_MERGED
}

/// What the catalogue offers another gear about the organization's registry:
/// its components, wherever they are declared, and where each was found.
/// Read by spec-mapping for a project's own gears, and asked by studio-git to
/// look again after a push.
#[async_trait]
pub trait Registry: Send + Sync {
    /// Every entry of the organization `org`, with its occurrences. The
    /// caller has already shown that `ctx` reaches `org` (`OrgCtx` does).
    async fn entries(&self, ctx: &SecurityContext, org: Uuid)
    -> anyhow::Result<Vec<RegistryEntry>>;

    /// The entries found in one project of the context's organization.
    async fn project_entries(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
    ) -> anyhow::Result<Vec<RegistryEntry>>;

    /// Queue a walk of the named projects of `org` (all of them when none is
    /// named). Answers the run's id.
    async fn queue_refresh(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project_ids: &[Uuid],
    ) -> anyhow::Result<Uuid>;

    /// The organization `org`'s gear repository (ADR-0042 §2), when it set
    /// one: where "Create a gear" writes for a project without a gear
    /// repository of its own. The caller has already shown that `ctx`
    /// reaches `org`.
    async fn gear_repository(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
    ) -> anyhow::Result<Option<GearRepository>>;
}

/// The organization's gear repository: the connection's tenant, the
/// connection, `owner/name` and the branch new gears go back to.
pub use super::registry::GearRepository;

/// The catalogue's answer to [`Registry`].
pub struct CatalogRegistry {
    service: Arc<CatalogService>,
    hub: Arc<ClientHub>,
}

impl CatalogRegistry {
    pub fn new(service: Arc<CatalogService>, hub: Arc<ClientHub>) -> Self {
        Self { service, hub }
    }
}

#[async_trait]
impl Registry for CatalogRegistry {
    async fn entries(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
    ) -> anyhow::Result<Vec<RegistryEntry>> {
        if org == ctx.subject_tenant_id() {
            return self.service.registry_entries(ctx).await;
        }
        let acting = crate::org_scope::acting_in(ctx, org)
            .map_err(|e| anyhow::anyhow!("acting in organization {org}: {e}"))?;
        self.service.registry_entries(&acting).await
    }

    async fn project_entries(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
    ) -> anyhow::Result<Vec<RegistryEntry>> {
        Ok(super::registry::filter_entries(
            self.entries(ctx, ctx.subject_tenant_id()).await?,
            None,
            Some(project_id),
            None,
        ))
    }

    async fn queue_refresh(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        project_ids: &[Uuid],
    ) -> anyhow::Result<Uuid> {
        let queue = super::registry_task::queue(&self.hub)?;
        super::registry_task::enqueue(
            queue.as_ref(),
            ctx,
            org,
            &super::registry_task::RegistryPayload {
                organization_id: None,
                project_ids: project_ids.to_vec(),
            },
        )
        .await
    }

    async fn gear_repository(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
    ) -> anyhow::Result<Option<GearRepository>> {
        if org == ctx.subject_tenant_id() {
            return self.service.gear_repository(ctx).await;
        }
        let acting = crate::org_scope::acting_in(ctx, org)
            .map_err(|e| anyhow::anyhow!("acting in organization {org}: {e}"))?;
        self.service.gear_repository(&acting).await
    }
}

/// A project's own gears as the registry knows them, in the shape
/// [`ComponentCatalog::project_gears`] answers: one per entry found in the
/// project (where it is declared there, else where it was detected: a
/// candidate), entries not [`offered`] left out. Empty
/// when the registry has found nothing in the project yet -- the caller
/// then reads the repositories itself.
pub fn project_gears_of(
    entries: &[RegistryEntry],
    project_id: Uuid,
) -> (Vec<Value>, Map<String, Value>) {
    let mut gears: Vec<super::project_gears::LocalGear> = Vec::new();
    for entry in entries.iter().filter(|e| offered(&e.entry.state)) {
        // Where the project declares it, else where a detector found it: a
        // candidate is offered too, as "could become a gear" (its
        // `registry_state` says which).
        let here = || {
            entry
                .occurrences
                .iter()
                .filter(|o| o.project_id == Some(project_id))
        };
        let Some(found) = here().find(|o| !o.detected()).or_else(|| here().next()) else {
            continue;
        };
        if !gears
            .iter()
            .any(|g| g.name.eq_ignore_ascii_case(&entry.entry.name))
        {
            gears.push(found.local_gear());
        }
    }
    super::project_gears::catalogue_shape(&gears)
}
