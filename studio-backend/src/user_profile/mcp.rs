//! The person's inbox, as MCP tools (`crate::mcp`): everything that waits
//! for them, and the marks they keep on it.
//!
//! Nothing here stores an item. Each [`Source`] reads one kind of fact
//! through the route the portal reads it from -- deploys waiting for an
//! approval, reviews asked of the person, pull requests whose next move is
//! theirs, their background work that failed -- and says what waits. The
//! marks (done, snoozed) are studio-user's own `me/inbox-marks`, the same the
//! portal's Inbox writes, so an item an agent marks done is gone in the
//! browser too. A kit's source is one more entry in [`SOURCES`].
//!
//! Each item says how to act on it (`act`): the tool to call and its
//! arguments, so an agent goes from the list to the action.

use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::mcp::sdk::{
    Api, Effect, Run, Tool, ToolError, ToolFuture, fill_path, object, required_text,
};

const WORKSPACE_TYPE: &str = "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~";

/// How long a failed run stays in the inbox; past it, `task_run` and the
/// portal's Background work have it.
const RUN_DAYS: i64 = 7;

/// Pages of a listing read at most, so a cursor that never ends cannot hang
/// a tool call.
const MAX_PAGES: usize = 20;

/// Who is asking, and where: the organization and its workspaces, and the ids
/// the person is known by (their Studio profile and their sign-in subject).
#[derive(Clone)]
struct Scope {
    organization_id: String,
    workspaces: Vec<String>,
    me: Vec<String>,
    now: OffsetDateTime,
}

type SourceFuture = Pin<Box<dyn Future<Output = Result<Vec<Value>, ToolError>> + Send>>;

/// One kind of fact that can wait for a person.
struct Source {
    /// `deploy`, `review`, `pull`, `run`: each item's `source`.
    kind: &'static str,
    read: fn(Api, Scope) -> SourceFuture,
}

/// The sources, in the order their items are listed when nothing else orders
/// them.
const SOURCES: &[Source] = &[
    Source {
        kind: "deploy",
        read: deploys,
    },
    Source {
        kind: "review",
        read: reviews,
    },
    Source {
        kind: "pull",
        read: pulls,
    },
    Source {
        kind: "run",
        read: runs,
    },
];

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "inbox",
            description: "Everything that waits for you in one organization, as the portal's \
                Inbox lists it: deploys awaiting approval (`deploy`), reviews somebody asked of \
                you (`review`), open pull requests whose next move is yours (`pull`), and your \
                background work that failed in the last 7 days, an undelivered notification \
                among it (`run`). Each item has a `key`, a `title`, its `project_id` when it has \
                one, and `act`: the tool to call to act on it and its arguments. Items you \
                marked done or snoozed (`inbox_mark`) are left out unless `include_hidden`; \
                `errors` names a source that could not be read.",
            input_schema: || {
                object(
                    json!({
                        "organization_id": { "type": "string",
                            "description": "The organization: the id in the portal's address of it." },
                        "include_hidden": { "type": "boolean",
                            "description": "Also list the items marked done or snoozed, each with its `mark`." }
                    }),
                    &["organization_id"],
                )
            },
            effect: Effect::Read,
            experimental: true,
            run: Run::Custom(inbox),
        },
        Tool {
            name: "inbox_mark",
            description: "Mark one inbox item by its `key` from `inbox`: `done` hides it until \
                its fact changes (a pull request's key carries when it last changed, so new \
                activity is a new item), `snoozed` hides it until `until` (RFC 3339), `open` \
                clears the mark. The mark is yours and shows in the portal too; the fact \
                itself is not changed -- act on it with the tool its `act` names.",
            input_schema: || {
                object(
                    json!({
                        "item_key": { "type": "string", "description": "The item's `key` from `inbox`." },
                        "state": { "type": "string", "enum": ["done", "snoozed", "open"] },
                        "until": { "type": "string", "description": "When a snooze ends, RFC 3339." }
                    }),
                    &["item_key", "state"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Put {
                path: "/studio-user/v1/me/inbox-marks",
                query: &[],
            },
        },
    ]
}

fn inbox(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let organization_id = required_text(&args, "organization_id")?;
        let include_hidden = args
            .get("include_hidden")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let workspaces = workspaces_of(&api, &organization_id).await?;
        let mut me = vec![api.who().to_owned()];
        if let Ok(profile) = api.get("/studio-user/v1/me", &[]).await
            && let Some(id) = profile["id"].as_str()
        {
            me.push(id.to_owned());
        }
        me.retain(|s| !s.is_empty());
        let scope = Scope {
            organization_id,
            workspaces,
            me,
            now: OffsetDateTime::now_utc(),
        };
        let reads = SOURCES.iter().map(|s| (s.read)(api.clone(), scope.clone()));
        let answers = futures_util::future::join_all(reads).await;
        let mut items = Vec::new();
        let mut errors = Vec::new();
        for (source, answer) in SOURCES.iter().zip(answers) {
            match answer {
                Ok(found) => items.extend(found),
                Err(e) => errors.push(json!({ "source": source.kind, "error": e.0 })),
            }
        }
        let marks = api
            .get("/studio-user/v1/me/inbox-marks", &[])
            .await
            .map(|m| m["items"].clone())
            .unwrap_or(Value::Null);
        Ok(merge(items, &marks, scope.now, include_hidden, errors))
    })
}

/// The organization's workspaces, every page of them.
async fn workspaces_of(api: &Api, organization_id: &str) -> Result<Vec<String>, ToolError> {
    let (path, _) = fill_path(
        "/account-management/v1/tenants/{id}/children",
        json!({ "id": organization_id })
            .as_object()
            .cloned()
            .unwrap_or_default(),
    )?;
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut query = vec![("limit".to_owned(), "200".to_owned())];
        if let Some(c) = &cursor {
            query.push(("cursor".to_owned(), c.clone()));
        }
        let page = api.get(&path, &query).await?;
        for t in page["items"].as_array().into_iter().flatten() {
            if t["tenant_type"].as_str() == Some(WORKSPACE_TYPE)
                && let Some(id) = t["id"].as_str()
            {
                out.push(id.to_owned());
            }
        }
        cursor = page["page_info"]["next_cursor"]
            .as_str()
            .filter(|c| !c.is_empty())
            .map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    Ok(out)
}

/// `GET path` with `query`; a route this deployment does not have (404) is
/// a source with nothing to say.
async fn list_or_none(
    api: &Api,
    path: &str,
    query: &[(String, String)],
) -> Result<Value, ToolError> {
    let answer = api.get_answer(path, query).await?;
    match answer.status {
        404 => Ok(json!({ "items": [] })),
        _ if answer.ok() => Ok(answer.body),
        _ => Err(answer.refusal()),
    }
}

fn deploys(api: Api, scope: Scope) -> SourceFuture {
    Box::pin(async move {
        let list = list_or_none(
            &api,
            "/studio-environments/v1/deployments",
            &[("organization_id".to_owned(), scope.organization_id.clone())],
        )
        .await?;
        Ok(deploy_items(&list["items"], &scope.organization_id))
    })
}

fn reviews(api: Api, scope: Scope) -> SourceFuture {
    Box::pin(async move {
        let mut out = Vec::new();
        for ws in &scope.workspaces {
            let list = list_or_none(
                &api,
                "/studio-documents/v1/review-requests",
                &[
                    ("workspace_id".to_owned(), ws.clone()),
                    ("waiting_on".to_owned(), "me".to_owned()),
                ],
            )
            .await?;
            out.extend(review_items(&list["items"]));
        }
        Ok(out)
    })
}

fn pulls(api: Api, scope: Scope) -> SourceFuture {
    Box::pin(async move {
        let mut out = Vec::new();
        for ws in &scope.workspaces {
            let mut offset = 0usize;
            for _ in 0..MAX_PAGES {
                let page = list_or_none(
                    &api,
                    "/studio-artifact-ingest/v1/open-pull-requests",
                    &[
                        ("workspace_id".to_owned(), ws.clone()),
                        ("waiting_on".to_owned(), "me".to_owned()),
                        ("limit".to_owned(), "200".to_owned()),
                        ("offset".to_owned(), offset.to_string()),
                    ],
                )
                .await?;
                let items = page["items"].as_array().cloned().unwrap_or_default();
                out.extend(pull_items(&Value::Array(items.clone())));
                offset += items.len();
                let total = page["total"].as_u64().unwrap_or(0);
                if items.is_empty() || offset as u64 >= total {
                    break;
                }
            }
        }
        Ok(out)
    })
}

fn runs(api: Api, scope: Scope) -> SourceFuture {
    Box::pin(async move {
        let list = list_or_none(
            &api,
            "/studio-tasks/v1/runs",
            &[
                ("state".to_owned(), "failed".to_owned()),
                ("limit".to_owned(), "100".to_owned()),
            ],
        )
        .await?;
        Ok(run_items(&list["items"], &scope.me, scope.now))
    })
}

/* ── The facts as items: pure, so they are tested without a server ── */

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default()
}

fn deploy_items(list: &Value, organization_id: &str) -> Vec<Value> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter(|d| text(d, "state") == "awaiting_approval")
        .map(|d| {
            json!({
                "source": "deploy",
                "key": format!("deploy:{}", text(d, "id")),
                "title": format!(
                    "Approve the deploy of {} to {}",
                    text(d, "project_name"),
                    text(d, "environment_name")
                ),
                "detail": format!("{} asked", text(d, "requested_by_name")),
                "project_id": d["project_id"],
                "at": d["requested_at"],
                "act": {
                    "tool": "deployment_decide",
                    "arguments": {
                        "deployment_id": d["id"],
                        "organization_id": organization_id,
                        "action": "approve | decline (decline needs a reason)"
                    }
                }
            })
        })
        .collect()
}

fn review_items(list: &Value) -> Vec<Value> {
    list.as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            json!({
                "source": "review",
                "key": format!("review:{}", text(r, "id")),
                "title": format!("Review {}", text(r, "title")),
                "detail": format!("{} asked", r["requested_by_name"].as_str().unwrap_or("a colleague")),
                "project_id": r["project_id"],
                "at": r["created_at"],
                "due": r["due_at"],
                "overdue": r["overdue"].as_bool().unwrap_or(false),
                "act": {
                    "tool": "review_verdict",
                    "arguments": {
                        "request_id": r["id"],
                        "project_id": r["project_id"],
                        "verdict": "approved | changes_requested"
                    }
                }
            })
        })
        .collect()
}

fn pull_items(list: &Value) -> Vec<Value> {
    list.as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            json!({
                "source": "pull",
                "key": format!("pr:{}@{}", text(p, "id"), text(p, "updated_at")),
                "title": p["title"],
                "detail": format!("{}#{} · {}", text(p, "repo"), p["number"], text(p, "reason")),
                "project_id": p["project_id"],
                "at": p["updated_at"],
                "waiting": p["waiting"],
                "act": { "open": p["url"] }
            })
        })
        .collect()
}

fn run_items(list: &Value, me: &[String], now: OffsetDateTime) -> Vec<Value> {
    let since = now - time::Duration::days(RUN_DAYS);
    list.as_array()
        .into_iter()
        .flatten()
        .filter(|r| text(r, "state") == "failed")
        .filter(|r| me.is_empty() || me.iter().any(|m| m.as_str() == text(r, "requested_by")))
        .filter(|r| {
            let at = r["finished_at"].as_str().unwrap_or(text(r, "updated_at"));
            OffsetDateTime::parse(at, &Rfc3339).is_ok_and(|t| t >= since)
        })
        .map(|r| {
            let title = if text(r, "task_type") == "notify.deliver" {
                "A notification was not delivered".to_owned()
            } else {
                format!("{} failed", text(r, "task_type"))
            };
            let detail = text(r, "last_error").lines().next().unwrap_or_default();
            let ended = r["finished_at"]
                .as_str()
                .map_or_else(|| r["updated_at"].clone(), |s| json!(s));
            json!({
                "source": "run",
                "key": format!("run:{}@{}", text(r, "id"), text(r, "updated_at")),
                "title": title,
                "detail": detail,
                "at": ended,
                "act": { "tool": "task_run", "arguments": { "id": r["id"] } }
            })
        })
        .collect()
}

/// Whether `mark` hides its item at `now`: done does, a snooze until it
/// runs out, `open` never.
fn hides(mark: &Value, now: OffsetDateTime) -> bool {
    match text(mark, "state") {
        "done" => true,
        "snoozed" => mark["until"]
            .as_str()
            .and_then(|u| OffsetDateTime::parse(u, &Rfc3339).ok())
            .is_some_and(|u| u > now),
        _ => false,
    }
}

/// The items with the marks applied, overdue first and then in source order.
fn merge(
    items: Vec<Value>,
    marks: &Value,
    now: OffsetDateTime,
    include_hidden: bool,
    errors: Vec<Value>,
) -> Value {
    let mut open = Vec::new();
    let mut hidden = 0u32;
    for mut item in items {
        let mark = marks
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| m["item_key"] == item["key"]);
        if let Some(m) = mark.filter(|m| hides(m, now)) {
            hidden += 1;
            if !include_hidden {
                continue;
            }
            item["mark"] = json!({ "state": m["state"], "until": m["until"] });
        }
        open.push(item);
    }
    // Stable: within each half the sources keep their order.
    open.sort_by_key(|i| !i["overdue"].as_bool().unwrap_or(false));
    json!({ "items": open, "hidden": hidden, "errors": errors })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::sdk::request_of;

    fn at(s: &str) -> OffsetDateTime {
        OffsetDateTime::parse(s, &Rfc3339).unwrap()
    }

    #[test]
    fn a_deploy_waiting_for_approval_says_how_to_decide_it() {
        let items = deploy_items(
            &json!([
                { "id": "d1", "state": "awaiting_approval", "project_id": "p", "project_name": "Shop",
                  "environment_name": "prod", "requested_by_name": "Ann", "requested_at": "2026-11-06T10:00:00Z" },
                { "id": "d2", "state": "succeeded" }
            ]),
            "org",
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["key"], "deploy:d1");
        assert_eq!(items[0]["title"], "Approve the deploy of Shop to prod");
        assert_eq!(items[0]["act"]["tool"], "deployment_decide");
        assert_eq!(items[0]["act"]["arguments"]["organization_id"], "org");
    }

    #[test]
    fn a_review_and_a_pull_request_are_keyed_as_the_portal_keys_them() {
        let r = review_items(
            &json!([{ "id": "r1", "title": "PRD", "project_id": "p", "overdue": true }]),
        );
        assert_eq!(r[0]["key"], "review:r1");
        assert_eq!(r[0]["act"]["tool"], "review_verdict");
        let p = pull_items(
            &json!([{ "id": "x", "updated_at": "2026-11-05T00:00:00Z", "title": "Fix",
            "repo": "o/r", "number": 7, "reason": "asked", "url": "https://g/7" }]),
        );
        assert_eq!(p[0]["key"], "pr:x@2026-11-05T00:00:00Z");
        assert_eq!(p[0]["act"]["open"], "https://g/7");
    }

    #[test]
    fn only_the_caller_s_recent_failed_runs_are_in_the_inbox() {
        let now = at("2026-11-06T12:00:00Z");
        let items = run_items(
            &json!([
                { "id": "1", "state": "failed", "task_type": "notify.deliver", "requested_by": "me",
                  "updated_at": "2026-11-06T00:00:00Z", "last_error": "401\nmore" },
                { "id": "2", "state": "failed", "task_type": "x.y", "requested_by": "other",
                  "updated_at": "2026-11-06T00:00:00Z" },
                { "id": "3", "state": "failed", "task_type": "x.y", "requested_by": "me",
                  "updated_at": "2026-11-06T00:00:00Z", "finished_at": "2026-10-01T00:00:00Z" },
                { "id": "4", "state": "succeeded", "task_type": "x.y", "requested_by": "me",
                  "updated_at": "2026-11-06T00:00:00Z" }
            ]),
            &["me".to_owned()],
            now,
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["title"], "A notification was not delivered");
        assert_eq!(items[0]["detail"], "401");
        assert_eq!(items[0]["act"]["tool"], "task_run");
    }

    #[test]
    fn marks_hide_what_is_done_and_what_is_snoozed_until_it_runs_out() {
        let now = at("2026-11-06T12:00:00Z");
        let items = vec![
            json!({ "key": "a" }),
            json!({ "key": "b" }),
            json!({ "key": "c" }),
            json!({ "key": "d", "overdue": true }),
        ];
        let marks = json!([
            { "item_key": "a", "state": "done" },
            { "item_key": "b", "state": "snoozed", "until": "2026-11-07T00:00:00Z" },
            { "item_key": "c", "state": "snoozed", "until": "2026-11-05T00:00:00Z" }
        ]);
        let out = merge(items.clone(), &marks, now, false, vec![]);
        let keys: Vec<&str> = out["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["key"].as_str().unwrap())
            .collect();
        assert_eq!(keys, vec!["d", "c"]);
        assert_eq!(out["hidden"], 2);
        let all = merge(items, &marks, now, true, vec![json!({"source": "pull"})]);
        assert_eq!(all["items"].as_array().unwrap().len(), 4);
        assert_eq!(all["items"][1]["mark"]["state"], "done");
        assert_eq!(all["errors"][0]["source"], "pull");
    }

    #[test]
    fn every_source_has_its_own_kind() {
        let kinds: Vec<&str> = SOURCES.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, vec!["deploy", "review", "pull", "run"]);
    }

    #[test]
    fn a_mark_is_put_as_the_portal_puts_it() {
        let r = request_of(
            &tools(),
            "inbox_mark",
            json!({ "item_key": "deploy:d1", "state": "done" }),
        );
        assert_eq!(r.path, "/studio-user/v1/me/inbox-marks");
        assert_eq!(r.body, json!({ "item_key": "deploy:d1", "state": "done" }));
    }
}
