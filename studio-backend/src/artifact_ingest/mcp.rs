//! A project's builds, as MCP tools (`crate::mcp`).
//!
//! Every build is recorded here, whoever ran it: Studio in an environment's
//! cluster (`build_start`), a CI workflow, or a desktop. These read the
//! records: status, failure, images and chart. One build by its id, with the
//! infra services its lock resolved, is `build_get`, and the steps of a build
//! Studio runs, read from its pod, are `build_log` (both environments).

use serde_json::{Map, Value, json};

use crate::mcp::sdk::{Api, Effect, Run, Tool, ToolFuture, object, project_id, required_text};

const NODES: &str = "/studio-artifact-ingest/v1/nodes";
/// The most builds one read lists.
const MAX_BUILDS: u64 = 200;
const DEFAULT_BUILDS: u64 = 20;

pub fn tools() -> Vec<Tool> {
    vec![Tool {
        name: "build_list",
        description: "The project's builds, newest first: each with `build_id`, `status` \
                (running, passed, failed), `failure` and the stage it failed in, where it ran, \
                the product, commit, images and published chart. A passed build's `build_id` \
                is what `deploy_request` deploys.",
        input_schema: || {
            object(
                json!({
                    "project_id": project_id(),
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_BUILDS,
                        "description": "How many, newest first. Default 20." }
                }),
                &["project_id"],
            )
        },
        effect: Effect::Read,
        experimental: false,
        run: Run::Custom(build_list),
    }]
}

fn builds_query(project: String, limit: u64) -> Vec<(String, String)> {
    vec![
        ("type".to_owned(), "build".to_owned()),
        ("scope".to_owned(), project),
        ("sort".to_owned(), "updated".to_owned()),
        ("limit".to_owned(), limit.to_string()),
    ]
}

/// The records of a node page: their values.
fn records(page: &Value) -> Vec<Value> {
    page["nodes"]
        .as_array()
        .map(|nodes| nodes.iter().map(|n| n["value"].clone()).collect())
        .unwrap_or_default()
}

fn build_list(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let project = required_text(&args, "project_id")?;
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_BUILDS)
            .clamp(1, MAX_BUILDS);
        let page = api.get(NODES, &builds_query(project, limit)).await?;
        let items = records(&page);
        Ok(json!({ "total": page["total"], "items": items }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_are_read_as_the_project_s_build_nodes_newest_first() {
        let q = builds_query("p".to_owned(), 5);
        assert!(q.contains(&("type".to_owned(), "build".to_owned())));
        assert!(q.contains(&("scope".to_owned(), "p".to_owned())));
        assert!(q.contains(&("sort".to_owned(), "updated".to_owned())));
        assert!(q.contains(&("limit".to_owned(), "5".to_owned())));
    }

    #[test]
    fn a_build_is_its_node_s_value() {
        let page = json!({"total": 2, "nodes": [
            {"type_id": "t", "instance_id": "i1", "value": {"build_id": "b1", "status": "passed"}},
            {"type_id": "t", "instance_id": "i2", "value": {"build_id": "b2", "status": "failed"}}
        ]});
        let all = records(&page);
        assert_eq!(all.len(), 2);
        let found = all.iter().find(|b| b["build_id"] == "b2").unwrap();
        assert_eq!(found["status"], "failed");
        assert!(records(&json!({})).is_empty());
    }
}
