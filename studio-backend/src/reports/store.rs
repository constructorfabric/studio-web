//! Where report sources are kept: graph-storage, one node per report per
//! organization; in memory when the build has no graph.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::source::ReportSource;

#[async_trait]
pub trait ReportStore: Send + Sync {
    /// The organization's source for a report, if it saved one.
    async fn get(
        &self,
        ctx: &SecurityContext,
        report: &str,
    ) -> anyhow::Result<Option<ReportSource>>;
    async fn put(&self, ctx: &SecurityContext, source: &ReportSource) -> anyhow::Result<()>;
    /// Drop the organization's source for a report: what a move into the
    /// domain model does to the copy it moved from.
    async fn delete(&self, _ctx: &SecurityContext, _report: &str) -> anyhow::Result<()> {
        Ok(())
    }
}

/// Per tenant, per report. What a build without graph-storage keeps, and what
/// the tests run on.
#[derive(Default)]
pub struct MemoryStore {
    sources: Mutex<HashMap<(Uuid, String), ReportSource>>,
}

#[async_trait]
impl ReportStore for MemoryStore {
    async fn get(
        &self,
        ctx: &SecurityContext,
        report: &str,
    ) -> anyhow::Result<Option<ReportSource>> {
        let map = self
            .sources
            .lock()
            .map_err(|_| anyhow::anyhow!("report store poisoned"))?;
        Ok(map
            .get(&(ctx.subject_tenant_id(), report.to_string()))
            .cloned())
    }

    async fn delete(&self, ctx: &SecurityContext, report: &str) -> anyhow::Result<()> {
        self.sources
            .lock()
            .map_err(|_| anyhow::anyhow!("report store poisoned"))?
            .remove(&(ctx.subject_tenant_id(), report.to_string()));
        Ok(())
    }

    async fn put(&self, ctx: &SecurityContext, source: &ReportSource) -> anyhow::Result<()> {
        let mut map = self
            .sources
            .lock()
            .map_err(|_| anyhow::anyhow!("report store poisoned"))?;
        map.insert(
            (ctx.subject_tenant_id(), source.report.clone()),
            source.clone(),
        );
        Ok(())
    }
}

#[cfg(feature = "graph")]
pub use graph::GraphStore;

/// Report sources as domain objects (ADR-0051 §8a, `storage.sources`): one
/// `report-source` object per organization and report, kept by this gear. A
/// source the model has not seen is read from `legacy` once and copied in.
pub struct ModelStore {
    legacy: std::sync::Arc<dyn ReportStore>,
    port: PortSource,
    /// `storage.sources` set back: the model's copy returns to `legacy`.
    returning: bool,
}

enum PortSource {
    Hub(std::sync::Arc<toolkit::client_hub::ClientHub>),
    #[cfg(test)]
    Fixed(std::sync::Arc<dyn crate::domain_model::port::DomainObjects>),
}

const SOURCE_ENTITY: &str = "report-source";

impl ModelStore {
    pub fn new(
        legacy: std::sync::Arc<dyn ReportStore>,
        hub: std::sync::Arc<toolkit::client_hub::ClientHub>,
    ) -> Self {
        Self {
            legacy,
            port: PortSource::Hub(hub),
            returning: false,
        }
    }

    /// The old store, with a source the model holds moved back on first read.
    pub fn returning(
        legacy: std::sync::Arc<dyn ReportStore>,
        hub: std::sync::Arc<toolkit::client_hub::ClientHub>,
    ) -> Self {
        Self {
            returning: true,
            ..Self::new(legacy, hub)
        }
    }

    async fn back_to_legacy(&self, ctx: &SecurityContext, report: &str) {
        let Some(port) = self.port() else {
            return;
        };
        let id = Self::object_id(ctx.subject_tenant_id(), report);
        let result = async {
            let (found, _) = port
                .query(ctx, serde_json::json!({"type": SOURCE_ENTITY, "where": {"id": {"_eq": id}}, "limit": 1}))
                .await?;
            let Some(o) = found.into_iter().next() else {
                return anyhow::Ok(());
            };
            let mut v = o.payload;
            if let Some(m) = v.as_object_mut() {
                for f in ["report_tenant", "name", "_scope"] {
                    m.remove(f);
                }
            }
            self.legacy.put(ctx, &unpack(v)?).await?;
            port.remove_objects(ctx, SOURCE_ENTITY, vec![id.clone()]).await?;
            anyhow::Ok(())
        }
        .await;
        if let Err(e) = result {
            tracing::warn!(report, error = %e, "studio-reports: a source could not move back yet");
        }
    }

    #[cfg(test)]
    pub fn with_port(
        legacy: std::sync::Arc<dyn ReportStore>,
        port: std::sync::Arc<dyn crate::domain_model::port::DomainObjects>,
    ) -> Self {
        Self {
            legacy,
            port: PortSource::Fixed(port),
            returning: false,
        }
    }

    fn port(&self) -> Option<std::sync::Arc<dyn crate::domain_model::port::DomainObjects>> {
        match &self.port {
            PortSource::Hub(hub) => hub
                .get::<dyn crate::domain_model::port::DomainObjects>()
                .ok(),
            #[cfg(test)]
            PortSource::Fixed(port) => Some(std::sync::Arc::clone(port)),
        }
    }

    fn need() -> crate::domain_model::port::TypeNeed {
        let f = |n: &str, t: &str| (n.to_owned(), t.to_owned(), String::new());
        crate::domain_model::port::TypeNeed {
            id: SOURCE_ENTITY.to_owned(),
            name: "Report Source".to_owned(),
            description: "Where an organization's report reads from: its connection, plan file, board, and the plan as last read.".to_owned(),
            extends: Some("record".to_owned()),
            bucket: Some("operations".to_owned()),
            fields: vec![
                f("report", "string"),
                f("report_tenant", "string"),
                f("connection_id", "string?"),
                f("plan_file", "string?"),
                f("board", "string?"),
                f("snapshot", "JSON?"),
            ],
            relations: Vec::new(),
            held_by: Some("studio-reports".to_owned()),
            searchable: false,
        }
    }

    fn object_id(tenant: Uuid, report: &str) -> String {
        format!("{SOURCE_ENTITY}:{tenant}:{report}")
    }

    async fn write(
        &self,
        ctx: &SecurityContext,
        port: &dyn crate::domain_model::port::DomainObjects,
        source: &ReportSource,
    ) -> anyhow::Result<()> {
        let tenant = ctx.subject_tenant_id();
        let mut payload = pack(source)?;
        payload["report_tenant"] = serde_json::json!(tenant);
        payload["name"] = serde_json::json!(source.report);
        port.put_objects(
            ctx,
            SOURCE_ENTITY,
            vec![crate::domain_model::port::OwnedObject {
                id: Self::object_id(tenant, &source.report),
                scope: String::new(),
                payload,
            }],
        )
        .await?;
        Ok(())
    }
}

#[async_trait]
impl ReportStore for ModelStore {
    async fn get(
        &self,
        ctx: &SecurityContext,
        report: &str,
    ) -> anyhow::Result<Option<ReportSource>> {
        if self.returning {
            self.back_to_legacy(ctx, report).await;
            return self.legacy.get(ctx, report).await;
        }
        let Some(port) = self.port() else {
            return self.legacy.get(ctx, report).await;
        };
        port.ensure_type(ctx, &Self::need()).await?;
        let id = Self::object_id(ctx.subject_tenant_id(), report);
        let (found, _) = port
            .query(
                ctx,
                serde_json::json!({"type": SOURCE_ENTITY, "where": {"id": {"_eq": id}}, "limit": 1}),
            )
            .await?;
        if let Some(o) = found.into_iter().next() {
            let mut v = o.payload;
            if let Some(m) = v.as_object_mut() {
                for f in ["report_tenant", "name", "_scope"] {
                    m.remove(f);
                }
            }
            return Ok(Some(unpack(v)?));
        }
        let Some(old) = self.legacy.get(ctx, report).await? else {
            return Ok(None);
        };
        self.write(ctx, port.as_ref(), &old).await?;
        // Held once: the old store's copy goes.
        if let Err(e) = self.legacy.delete(ctx, report).await {
            tracing::warn!(report, error = %e, "studio-reports: the old store's copy of a moved source stays");
        }
        Ok(Some(old))
    }

    async fn put(&self, ctx: &SecurityContext, source: &ReportSource) -> anyhow::Result<()> {
        if self.returning {
            self.back_to_legacy(ctx, &source.report).await;
            return self.legacy.put(ctx, source).await;
        }
        let Some(port) = self.port() else {
            return self.legacy.put(ctx, source).await;
        };
        port.ensure_type(ctx, &Self::need()).await?;
        self.write(ctx, port.as_ref(), source).await
    }
}

/// A source as a node payload: the plan's text deflated and base64'd, so a
/// plan many times larger than graph-storage's 64 KB payload cap still fits.
pub fn pack(source: &ReportSource) -> anyhow::Result<serde_json::Value> {
    use base64::Engine as _;
    use std::io::Write as _;
    let mut v = serde_json::to_value(source)?;
    if let Some(snap) = v
        .get_mut("snapshot")
        .and_then(serde_json::Value::as_object_mut)
        && let Some(serde_json::Value::String(text)) = snap.remove("text")
    {
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
        enc.write_all(text.as_bytes())?;
        let packed = base64::engine::general_purpose::STANDARD.encode(enc.finish()?);
        snap.insert("text_deflate".into(), serde_json::Value::String(packed));
    }
    Ok(v)
}

/// A node payload back as a source; a payload written before compression
/// reads too.
pub fn unpack(mut v: serde_json::Value) -> anyhow::Result<ReportSource> {
    use base64::Engine as _;
    use std::io::Read as _;
    if let Some(snap) = v
        .get_mut("snapshot")
        .and_then(serde_json::Value::as_object_mut)
        && let Some(serde_json::Value::String(packed)) = snap.remove("text_deflate")
    {
        let bytes = base64::engine::general_purpose::STANDARD.decode(packed)?;
        let mut text = String::new();
        flate2::read::DeflateDecoder::new(bytes.as_slice()).read_to_string(&mut text)?;
        snap.insert("text".into(), serde_json::Value::String(text));
    }
    Ok(serde_json::from_value(v)?)
}

#[cfg(feature = "graph")]
mod graph {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use anyhow::anyhow;
    use async_trait::async_trait;
    use graph_storage_sdk::GraphStorageClientV1;
    use serde_json::Value;
    use toolkit_security::SecurityContext;

    use super::super::gts;
    use super::super::source::ReportSource;
    use super::ReportStore;

    pub struct GraphStore {
        client: Arc<dyn GraphStorageClientV1>,
        registered: AtomicBool,
    }

    impl GraphStore {
        pub fn new(client: Arc<dyn GraphStorageClientV1>) -> Self {
            Self {
                client,
                registered: AtomicBool::new(false),
            }
        }

        /// Once per process: registering is idempotent, and cheap only the
        /// first time.
        async fn ensure_types(&self, ctx: &SecurityContext) -> anyhow::Result<()> {
            use graph_storage_sdk::models::TypeRegistration;
            if self.registered.load(Ordering::Acquire) {
                return Ok(());
            }
            let batch: Vec<TypeRegistration> = gts::graph_node_type_schemas()
                .into_iter()
                .map(|schema| TypeRegistration {
                    type_id: schema
                        .get("$id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .trim_start_matches("gts://")
                        .to_string(),
                    schema,
                })
                .collect();
            self.client.register_types(ctx, batch).await.map_err(|e| {
                anyhow!("register report types: {}", crate::graph_error::explain(&e))
            })?;
            self.registered.store(true, Ordering::Release);
            Ok(())
        }
    }

    #[async_trait]
    impl ReportStore for GraphStore {
        async fn get(
            &self,
            ctx: &SecurityContext,
            report: &str,
        ) -> anyhow::Result<Option<ReportSource>> {
            use toolkit_odata::ODataQuery;
            self.ensure_types(ctx).await?;
            let key = gts::source_key(report);
            // A handful of reports per organization: one page holds them all.
            let page = self
                .client
                .project_nodes(
                    ctx,
                    &[gts::graph_type_id()],
                    ODataQuery::default().with_limit(200),
                )
                .await
                .map_err(|e| anyhow!("graph-storage projection: {e}"))?;
            let Some(row) = page.items.into_iter().find(|r| r.node_key == key) else {
                return Ok(None);
            };
            let Some(payload) = row.payload else {
                return Ok(None);
            };
            Ok(Some(super::unpack(payload)?))
        }

        async fn delete(&self, ctx: &SecurityContext, report: &str) -> anyhow::Result<()> {
            match self.client.delete_node(ctx, &gts::source_key(report)).await {
                Ok(_) | Err(toolkit_canonical_errors::CanonicalError::NotFound { .. }) => Ok(()),
                Err(e) => Err(anyhow!("graph-storage delete: {e}")),
            }
        }

        async fn put(&self, ctx: &SecurityContext, source: &ReportSource) -> anyhow::Result<()> {
            use crate::artifact_ingest::sdk::without_nul;
            use graph_storage_sdk::models::{IngestOptions, IngestRequest, NodeSpec};
            self.ensure_types(ctx).await?;
            let node = NodeSpec {
                node_key: gts::source_key(&source.report),
                type_id: gts::graph_type_id(),
                name: Some(source.report.clone()),
                payload: Some(without_nul(super::pack(source)?)),
                expected_version: None,
            };
            self.client
                .ingest(
                    ctx,
                    IngestRequest {
                        nodes: vec![node],
                        edges: Vec::new(),
                        options: IngestOptions {
                            create_phantoms: Some(false),
                            report_per_item: false,
                            embed: Some(false),
                        },
                        replace_scope: None,
                        idempotency_key: None,
                    },
                )
                .await
                .map_err(|e| {
                    anyhow!("graph-storage ingest: {}", crate::graph_error::explain(&e))
                })?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(tenant: u128) -> SecurityContext {
        crate::reports::test_ctx(tenant)
    }

    #[tokio::test]
    async fn a_source_moves_into_the_model_once_and_is_the_gears() {
        let legacy = std::sync::Arc::new(MemoryStore::default());
        let old = ReportSource {
            report: "roadmap".into(),
            board: Some("acme/7".into()),
            ..ReportSource::default()
        };
        legacy.put(&ctx(1), &old).await.unwrap();
        let port = crate::domain_model::port::in_memory();
        let store = ModelStore::with_port(legacy.clone(), std::sync::Arc::clone(&port));
        assert_eq!(
            store.get(&ctx(1), "roadmap").await.unwrap(),
            Some(old.clone())
        );

        let newer = ReportSource {
            board: Some("acme/8".into()),
            ..old.clone()
        };
        store.put(&ctx(1), &newer).await.unwrap();
        assert_eq!(store.get(&ctx(1), "roadmap").await.unwrap(), Some(newer));
        assert_eq!(
            legacy.get(&ctx(1), "roadmap").await.unwrap(),
            None,
            "the old store's copy is gone once moved"
        );
        assert_eq!(
            store.get(&ctx(2), "roadmap").await.unwrap(),
            None,
            "another organization's is not this one's"
        );
        let refused = port
            .upsert(
                &ctx(1),
                "report-source",
                "forged",
                serde_json::json!({"report": "x"}),
            )
            .await
            .unwrap_err();
        assert!(
            refused.to_string().contains("kept by studio-reports"),
            "{refused}"
        );
    }

    #[test]
    fn a_plan_is_kept_compressed_and_reads_back_whole() {
        use crate::reports::source::PlanSnapshot;
        // A plan the size the planning team's grows to, and then some.
        let text: String = (0..3000)
            .map(|i| format!("  user{i}: {{ team: t{}, power: 0.5 }}\n", i % 7))
            .collect();
        let s = ReportSource {
            report: "roadmap".into(),
            snapshot: Some(PlanSnapshot {
                text: text.clone(),
                from: "upload".into(),
                sha: None,
                read_at: "t".into(),
                ..PlanSnapshot::default()
            }),
            ..ReportSource::default()
        };
        let packed = pack(&s).expect("packed");
        let size = serde_json::to_string(&packed).unwrap().len();
        assert!(text.len() > 100_000, "the plan is {} bytes", text.len());
        assert!(size < 65_536, "the payload is {size} bytes");
        assert!(packed.pointer("/snapshot/text").is_none());
        assert_eq!(unpack(packed).expect("unpacked"), s);
        // Written before compression: still reads.
        let old = serde_json::to_value(&s).unwrap();
        assert_eq!(unpack(old).unwrap(), s);
        // An upload is never kept as such.
        let with_upload = ReportSource {
            plan_yaml: Some("a: 1".into()),
            ..s.clone()
        };
        assert!(pack(&with_upload).unwrap().get("plan_yaml").is_none());
    }

    #[tokio::test]
    async fn a_source_is_the_organizations_and_the_reports() {
        let store = MemoryStore::default();
        assert!(store.get(&ctx(1), "roadmap").await.unwrap().is_none());
        let s = ReportSource {
            report: "roadmap".into(),
            board: Some("o/48".into()),
            ..ReportSource::default()
        };
        store.put(&ctx(1), &s).await.unwrap();
        assert_eq!(
            store.get(&ctx(1), "roadmap").await.unwrap(),
            Some(s.clone())
        );
        // Another organization does not see it, nor does another report.
        assert!(store.get(&ctx(2), "roadmap").await.unwrap().is_none());
        assert!(store.get(&ctx(1), "other").await.unwrap().is_none());
        // A second put replaces the first.
        let s2 = ReportSource {
            board: Some("o/49".into()),
            ..s
        };
        store.put(&ctx(1), &s2).await.unwrap();
        assert_eq!(
            store
                .get(&ctx(1), "roadmap")
                .await
                .unwrap()
                .and_then(|s| s.board),
            Some("o/49".into())
        );
    }
}
