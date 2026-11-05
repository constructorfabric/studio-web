//! Connections, as MCP tools (`crate::mcp`): which a project may read its
//! repositories through, and the repositories each reaches. Nothing here
//! makes or changes a connection; a credential is never answered.

use serde_json::{Map, Value, json};

use crate::mcp::sdk::{
    Api, Effect, Run, Tool, ToolFuture, fill_path, object, optional_text, project_id, required_text,
};

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "project_connections",
            description: "The connections a project can use: its own, or its organization's \
                when it has none of its own. Each with `id` (what a project source names as \
                `connection_id`), provider (github, gitlab, kubernetes, registry, research…), \
                label, account, base URL, scope (`personal`: one person's token) and whether it \
                is the caller's.",
            input_schema: || object(json!({ "project_id": project_id() }), &["project_id"]),
            effect: Effect::Read,
            experimental: false,
            run: Run::Custom(project_connections),
        },
        Tool {
            name: "connection_repositories",
            description: "The repositories a source-host connection reaches, as seen from the \
                project: each with `full_path`, `clone_url` and default branch -- what \
                `project_sources_set` takes. Refused for a connection that lists none (a \
                cluster, a model provider) or whose credential no longer works.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "connection_id": { "type": "string" },
                        "search": { "type": "string", "description": "Only repositories whose name has this." },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                    }),
                    &["project_id", "connection_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Custom(connection_repositories),
        },
    ]
}

fn project_connections(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let tenant = required_text(&args, "project_id")?;
        let list = api
            .get(
                "/studio-connector/v1/connections",
                &[("tenant".to_owned(), tenant)],
            )
            .await?;
        Ok(compact_connections(&list))
    })
}

/// What picking a connection needs; the credential's reference and the
/// provider options stay out.
fn compact_connections(list: &Value) -> Value {
    let items: Vec<Value> = list["items"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|c| {
            json!({
                "id": c["id"],
                "provider": c["provider"],
                "label": c["label"],
                "account": c["account"],
                "base_url": c["base_url"],
                "scope": c["scope"],
                "owner_tenant_id": c["owner_tenant_id"],
                "mine": c["mine"],
            })
        })
        .collect();
    json!({ "total": items.len(), "items": items })
}

fn connection_repositories(api: Api, mut args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let tenant = required_text(&args, "project_id")?;
        let mut query = vec![("tenant".to_owned(), tenant)];
        if let Some(s) = optional_text(&args, "search") {
            query.push(("search".to_owned(), s));
        }
        if let Some(n) = args.get("limit").and_then(Value::as_u64) {
            query.push(("limit".to_owned(), n.to_string()));
        }
        args.retain(|k, _| k == "connection_id");
        let (path, _) = fill_path(
            "/studio-connector/v1/connections/{connection_id}/repositories",
            args,
        )?;
        api.get(&path, &query).await
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connection_is_listed_without_its_credential() {
        let list = json!({"items": [{
            "id": "c1", "provider": "github", "label": "Acme", "account": "bot",
            "base_url": "https://github.com", "scope": "tenant", "owner_tenant_id": "o",
            "secret_ref": "cred://x", "options": {"k": "v"}, "mine": false,
            "created_at_epoch_secs": 1
        }]});
        let out = compact_connections(&list);
        assert_eq!(out["total"], 1);
        assert_eq!(out["items"][0]["id"], "c1");
        assert!(out["items"][0].get("secret_ref").is_none());
        assert!(out.to_string().find("cred://").is_none());
    }
}
