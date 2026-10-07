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
                crate::tasks::service::NewRun {
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
