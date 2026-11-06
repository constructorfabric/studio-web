//! Reviews of a project's documents, as MCP tools (`crate::mcp`): the
//! requests that wait for the caller, and the verdict that answers one. The
//! inbox (`user_profile/mcp.rs`) lists them beside everything else that
//! waits; these act on them.

use serde_json::json;

use crate::mcp::sdk::{Effect, Run, Tool, object, project_id};

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "review_requests",
            description: "A project's or a workspace's review requests, newest first: each \
                with its document (`title`, `version`), its reviewers and where each stands, \
                the required reviewers still awaited (`outstanding`) and whether it is past \
                its due date (`overdue`). `waiting_on: \"me\"` keeps the open requests that \
                still wait for your verdict. Give `project_id` or `workspace_id`.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "workspace_id": { "type": "string", "description": "Every project of this workspace instead of one project." },
                        "subject_id": { "type": "string", "description": "Only this document's requests." },
                        "waiting_on": { "type": "string", "enum": ["me"] }
                    }),
                    &[],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-documents/v1/review-requests"),
        },
        Tool {
            name: "review_verdict",
            description: "Give your verdict on a review request you were asked to review: \
                `approved` or `changes_requested`, with an optional `note`; `security: true` \
                marks the changes asked for as a security concern, which holds the stage at \
                any maturity. A verdict is never edited: a later one is another record and the \
                latest counts. You must be one of the request's reviewers. Ask your person \
                first: the verdict is theirs and is kept on the record.",
            input_schema: || {
                object(
                    json!({
                        "request_id": { "type": "string", "description": "The review request's id (an `inbox` item's `act`, or `review_requests`)." },
                        "project_id": project_id(),
                        "verdict": { "type": "string", "enum": ["approved", "changes_requested"] },
                        "security": { "type": "boolean" },
                        "note": { "type": "string" }
                    }),
                    &["request_id", "project_id", "verdict"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Post {
                path: "/studio-documents/v1/review-requests/{request_id}/approvals",
                query: &[],
            },
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::sdk::{Method, request_of};

    #[test]
    fn the_requests_waiting_on_the_caller_are_read_with_the_query() {
        let r = request_of(
            &tools(),
            "review_requests",
            json!({ "workspace_id": "w", "waiting_on": "me" }),
        );
        assert_eq!(r.method, Method::Get);
        assert_eq!(r.path, "/studio-documents/v1/review-requests");
        assert_eq!(
            r.query,
            vec![
                ("waiting_on".to_owned(), "me".to_owned()),
                ("workspace_id".to_owned(), "w".to_owned()),
            ]
        );
    }

    #[test]
    fn a_verdict_names_the_request_in_the_path_and_the_rest_in_the_body() {
        let r = request_of(
            &tools(),
            "review_verdict",
            json!({ "request_id": "r1", "project_id": "p", "verdict": "approved" }),
        );
        assert_eq!(r.method, Method::Post);
        assert_eq!(r.path, "/studio-documents/v1/review-requests/r1/approvals");
        assert_eq!(r.body, json!({ "project_id": "p", "verdict": "approved" }));
    }
}
