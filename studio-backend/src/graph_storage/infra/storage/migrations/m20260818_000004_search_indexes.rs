//! Vector and lexical indexes on the node table.
//!
//! Split from the initial migration because both are only meaningful once rows
//! exist, and because they are the two halves hybrid retrieval joins against
//! the graph: an HNSW index for `embedding <=> query`, and a GIN index for
//! `to_tsvector(...) @@ plainto_tsquery(...)`.
//!
//! The GIN index is on the same expression the query uses. A different
//! expression -- a different configuration name, or the column without
//! `to_tsvector` -- silently misses the index rather than failing, so the two
//! are kept side by side here and asserted by the hybrid query's tests.

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// Text-search configuration used for both the index and the query.
///
/// `simple` rather than a language configuration: node text is
/// producer-supplied and not known to be in any one language, so stemming would
/// be guesswork.
pub const FTS_CONFIG: &str = "simple";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();

        db.execute_unprepared(
            "CREATE INDEX IF NOT EXISTS idx_graph_node_embedding \
             ON graph_node USING hnsw (embedding vector_cosine_ops)",
        )
        .await?;

        db.execute_unprepared(&format!(
            "CREATE INDEX IF NOT EXISTS idx_graph_node_fts \
             ON graph_node USING gin (to_tsvector('{FTS_CONFIG}', search_text))"
        ))
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared("DROP INDEX IF EXISTS idx_graph_node_fts")
            .await?;
        db.execute_unprepared("DROP INDEX IF EXISTS idx_graph_node_embedding")
            .await?;
        Ok(())
    }
}
