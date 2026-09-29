//! The [`ComponentDelivery`] seam, over the same SQL the REST surface runs.
//!
//! Deliberately thin. Every rule about what a component IS lives in
//! [`super::components`], and every rule about what a catalogue's gears MEAN
//! lives in the gear that owns the catalogue. This is the piece in between:
//! build the query, run it, read the rows back as types the caller can use
//! without knowing that ClickHouse was involved.

use std::sync::Arc;

use async_trait::async_trait;

use super::client::InsightClient;
use super::components::{
    Bucket, ComponentMatch, ComponentPoint, ComponentQuery, ComponentQueryInput, ComponentRow,
    ComponentSpec, PullRequestRow,
};
use super::port::{
    ComponentDelivery, DeliveryPage, DeliveryPoint, DeliveryQuery, DeliveryTotals, PullRequestPage,
    PullRequestTotals,
};

pub struct InsightDelivery {
    client: Arc<dyn InsightClient>,
}

impl InsightDelivery {
    pub fn new(client: Arc<dyn InsightClient>) -> Self {
        Self { client }
    }

    /// The validated query, or the reason it is not one.
    ///
    /// `include_other: false` throughout: the caller asked about ITS gears, and
    /// a row for everything else in the repository would be a number nobody can
    /// attribute. The REST surface keeps the remainder because a person reading
    /// a repository should see the gap; a catalogue joining rows to gears has
    /// nothing to join it to.
    fn build(query: &DeliveryQuery) -> anyhow::Result<ComponentQuery> {
        let components = query
            .components
            .iter()
            .map(|(key, segment)| ComponentSpec {
                key: key.clone(),
                matcher: matcher_for(segment),
            })
            .collect();
        ComponentQuery::new(ComponentQueryInput {
            repository: query.repository.clone(),
            from: query.from.clone(),
            to: query.to.clone(),
            depth: None,
            components,
            include_other: false,
            limit: query.limit,
        })
        .map_err(|detail| anyhow::anyhow!("{detail}"))
    }
}

#[async_trait]
impl ComponentDelivery for InsightDelivery {
    async fn metrics(&self, query: &DeliveryQuery) -> anyhow::Result<DeliveryPage> {
        let built = Self::build(query)?;
        let page = self.client.query(&built.to_sql()).await?;

        // The window is a constant of the query and travels on every row, so an
        // empty result still has to answer "over what period?" — fall back to
        // what was asked for, which is then the only window anybody named.
        let mut out = DeliveryPage {
            from: query.from.clone().unwrap_or_default(),
            to: query.to.clone().unwrap_or_default(),
            truncated: page.truncated,
            ..DeliveryPage::default()
        };
        for row in page.rows {
            let row: ComponentRow = serde_json::from_value(row)?;
            out.from = row.range_from;
            out.to = row.range_to;
            out.totals.push(DeliveryTotals {
                component: row.component,
                commits: row.commits,
                files_changed: row.files_changed,
                lines_added: row.lines_added,
                lines_removed: row.lines_removed,
                authors: row.authors,
            });
        }

        // The trend follows the totals rather than running beside them: it is
        // restricted to the components the ranking kept, so a chart over a big
        // repository cannot quietly become a query over all of it.
        if !out.totals.is_empty() {
            let keys: Vec<String> = out.totals.iter().map(|t| t.component.clone()).collect();
            let trend = self
                .client
                .query(&built.to_trend_sql(Bucket::Week, &keys))
                .await?;
            out.truncated = out.truncated || trend.truncated;
            for row in trend.rows {
                let p: ComponentPoint = serde_json::from_value(row)?;
                out.series.push(DeliveryPoint {
                    component: p.component,
                    date: p.bucket_date,
                    commits: p.commits,
                    lines_added: p.lines_added,
                    lines_removed: p.lines_removed,
                });
            }
        }
        Ok(out)
    }

    async fn pull_requests(&self, query: &DeliveryQuery) -> anyhow::Result<PullRequestPage> {
        let built = Self::build(query)?;
        let page = self.client.query(&built.to_pull_request_sql()).await?;
        let mut out = PullRequestPage {
            truncated: page.truncated,
            totals: Vec::with_capacity(page.rows.len()),
        };
        for row in page.rows {
            let row: PullRequestRow = serde_json::from_value(row)?;
            out.totals.push(PullRequestTotals {
                component: row.component,
                open: row.open,
                merged: row.merged,
                closed: row.closed,
                total: row.total,
                merged_cycle_hours: row.merged_cycle_hours,
                authors: row.authors,
            });
        }
        Ok(out)
    }
}

/// How one catalogue entry is matched against file paths.
///
/// A bare directory name (`api-gateway`) matches wherever it appears, which is
/// what the catalogue has when all it knows is a crate name. A path
/// (`gears/bss/ledger`, `packages/ui-kit`) is what a repository scan read, and
/// it is matched as the prefix it is: a directory name that happens to recur
/// elsewhere in the repository then cannot borrow another tree's churn, and a
/// FrontX package, whose npm name (`@gears-frontx/ui-kit`) is not a directory
/// at all, can be measured.
fn matcher_for(segment: &str) -> ComponentMatch {
    if segment.contains('/') {
        let path = segment.trim_start_matches('/');
        let path = if path.ends_with('/') {
            path.to_string()
        } else {
            format!("{path}/")
        };
        ComponentMatch::Prefix(path)
    } else {
        ComponentMatch::Segment(segment.to_string())
    }
}

#[cfg(test)]
mod matcher_tests {
    use super::*;

    #[test]
    fn a_directory_name_is_a_segment_and_a_path_is_a_prefix() {
        assert!(
            matches!(matcher_for("api-gateway"), ComponentMatch::Segment(s) if s == "api-gateway")
        );
        assert!(
            matches!(matcher_for("gears/bss/ledger"), ComponentMatch::Prefix(p) if p == "gears/bss/ledger/")
        );
        assert!(
            matches!(matcher_for("packages/ui-kit/"), ComponentMatch::Prefix(p) if p == "packages/ui-kit/")
        );
    }
}
