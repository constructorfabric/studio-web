//! The product's description, as MCP tools (`crate::mcp`).
//!
//! The description is `product.gdl`, which Studio keeps as numbered
//! revisions (ADR-0053): an agent reads the latest, writes a new one against
//! the revision it read, and is told plainly when somebody saved in between.
//! A component's own description file (`gear.gdl`, `frontx.gdl`) is read from
//! the server's checkout.

use serde_json::{Map, Value, json};

use crate::mcp::sdk::{
    Api, Effect, Run, Tool, ToolError, ToolFuture, fill_path, object, optional_text, project_id,
    required_text,
};

const DESCRIPTION: &str = "/studio-product/v1/product-description";
const REVISIONS: &str = "/studio-product/v1/product-description-revisions";

fn project_only() -> Value {
    object(json!({ "project_id": project_id() }), &["project_id"])
}

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "product_description",
            description: "The project's product description (`product.gdl`) as Studio keeps \
                it: the latest revision's number, full text and `sources_lock` (the source \
                repositories and commits it was made against), who saved it and when, the \
                path it goes to in the repository and where it was last published. \
                `repository_change` says the file on the base branch differs (its text is \
                left out). Pass `revision` as `base_revision` to \
                `product_description_save`. `latest` is null for a project with no \
                description yet.",
            input_schema: project_only,
            effect: Effect::Read,
            experimental: false,
            run: Run::Custom(product_description),
        },
        Tool {
            name: "product_description_revisions",
            description: "The revisions of the project's product description, newest first \
                (at most 200), without their text: number, author, time, hash and where each \
                came from. `product_description_revision` reads one with its text.",
            input_schema: project_only,
            effect: Effect::Read,
            experimental: false,
            run: Run::Get(REVISIONS),
        },
        Tool {
            name: "product_description_revision",
            description: "One revision of the project's product description, with its text \
                and `sources_lock`. 404 when the project has no such revision.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "revision": { "type": "integer", "minimum": 1,
                            "description": "The revision's number, from `product_description_revisions`." }
                    }),
                    &["project_id", "revision"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-product/v1/product-description-revisions/{revision}"),
        },
        Tool {
            name: "product_description_save",
            description: "Save `text` as the project's next product-description revision, \
                made against `base_revision` (the `revision` you read). Answers the new \
                revision's number; `created: false` when the text is the latest's already. \
                When somebody saved a newer revision since your base, nothing is saved and \
                the call fails saying `stale` with the latest revision's number: read it with \
                `product_description`, merge, and save again against it. Nothing goes to the \
                repository. Refused for an empty text or one over 512 KiB. Tell your person \
                what you change first.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "text": { "type": "string", "description": "The whole product.gdl." },
                        "base_revision": { "type": ["integer", "null"], "minimum": 1,
                            "description": "The revision your text was made from; null for a project with none yet." }
                    }),
                    &["project_id", "text"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Custom(product_description_save),
        },
        Tool {
            name: "product_record",
            description: "The product the project is composing: its id, the gears picked, \
                where its description lives, and what the Gearbox engine said of it per \
                deployment profile (`checks.<profile>`: ok, diagnostics, the description's \
                hash it is about). Null before anything is picked.",
            input_schema: project_only,
            effect: Effect::Read,
            experimental: false,
            run: Run::Custom(product_record),
        },
        Tool {
            name: "product_check",
            description: "Ask the Gearbox engine to validate and resolve the product for one \
                deployment profile, from the product record's picked gears (or `gears`): \
                answers `ok`, the engine's `diagnostics`, and the applications and gears it \
                resolved to. It composes the description from the picks; a revision you \
                saved is checked as written with `product_description_check`. The verdict is \
                kept on the product under \
                `checks.<profile>`; nothing else is saved or published. The composed text is \
                left out of the answer.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "product_id": { "type": "string",
                            "description": "The product's kebab-case id, as `product_record` names it." },
                        "profile": { "type": "string",
                            "description": "`dev` (embedded), `local` (self-hosted) or `prod` (kubernetes). Default `dev`." },
                        "gears": { "type": "array", "items": { "type": "string" },
                            "description": "Gears by crate or engine id; absent: the record's picks." }
                    }),
                    &["project_id", "product_id"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Custom(product_check),
        },
        Tool {
            name: "product_description_check",
            description: "Ask the Gearbox engine to validate and resolve a SAVED revision of \
                the project's product description as it is written, for one profile, as a \
                build would lay it down: `revision` (default the latest), `profile` (default \
                `prod`), `strictness: dev` to check it as a development profile. Answers \
                `ok`, the engine's `diagnostics` (GBX codes, file, line, help), and the \
                applications and gears it resolved to. Call it after \
                `product_description_save` and before `build_start`. Saves nothing.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "revision": { "type": "integer", "minimum": 1,
                            "description": "The revision's number; absent: the latest." },
                        "profile": { "type": "string",
                            "description": "A profile id the description declares (`prod`, `dev`). Default `prod`." },
                        "strictness": { "type": "string", "enum": ["dev", "prod"],
                            "description": "`dev`: production rules' findings as warnings." }
                    }),
                    &["project_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Post {
                path: "/studio-product/v1/product-description-checks",
                query: &["project_id"],
            },
        },
        Tool {
            name: "gdl_file",
            description: "A component's description file as the server's checkout holds it: \
                a gear's `gear.gdl` (`gear`: engine id or crate name), or the `.gdl` at `path` \
                (a micro-frontend's `frontx.gdl`, a service's `service.gdl`), from the \
                project's own repository first, then the gear repositories its product reads. \
                Give `gear` or `path`. 404 when none has it.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "gear": { "type": "string" },
                        "path": { "type": "string", "description": "Relative to a repository's root." }
                    }),
                    &["project_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-product/v1/gdl-file"),
        },
    ]
}

fn project_query(args: &Map<String, Value>) -> Result<Vec<(String, String)>, ToolError> {
    Ok(vec![(
        "project_id".to_owned(),
        required_text(args, "project_id")?,
    )])
}

fn product_description(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let got = api.get(DESCRIPTION, &project_query(&args)?).await?;
        Ok(compact_description(got))
    })
}

/// The description with the repository's copy reduced to where it is and
/// its hash: the text the agent works on is the latest revision's.
fn compact_description(mut v: Value) -> Value {
    if let Some(change) = v
        .get_mut("repository_change")
        .and_then(Value::as_object_mut)
    {
        change.remove("text");
    }
    v
}

fn product_description_save(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let query = project_query(&args)?;
        let text = args
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::new("`text` is required"))?;
        let body = json!({
            "text": text,
            "base_revision": args.get("base_revision").cloned().unwrap_or(Value::Null),
        });
        let answer = api.post_answer(REVISIONS, &query, &body).await?;
        if answer.status == 409 {
            return Err(stale(&answer.body));
        }
        if !answer.ok() {
            return Err(answer.refusal());
        }
        Ok(saved(&answer.body))
    })
}

/// A save against a base that is no longer the latest, said so the agent
/// knows what to read and what to save against.
fn stale(conflict: &Value) -> ToolError {
    let latest = &conflict["latest"];
    let n = latest["revision"]
        .as_i64()
        .map_or("?".to_owned(), |n| n.to_string());
    let base = conflict["base_revision"]
        .as_i64()
        .map_or("none".to_owned(), |n| n.to_string());
    ToolError::new(format!(
        "stale: your text was made against revision {base}, but the latest is revision {n} \
         (by {}, at {}). Nothing was saved. Read revision {n} with `product_description`, \
         merge your change into it, and save again with base_revision {n}.",
        latest["author"].as_str().unwrap_or("someone"),
        latest["created_at"].as_str().unwrap_or("an unknown time"),
    ))
}

/// The saved revision without the text the agent just sent.
fn saved(v: &Value) -> Value {
    let r = &v["revision"];
    json!({
        "revision": r["revision"],
        "created": v["created"],
        "sha256": r["sha256"],
        "author": r["author"],
        "created_at": r["created_at"],
    })
}

fn product_record(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let (path, _) = fill_path("/studio-product/v1/projects/{project_id}/product", args)?;
        let got = api.get(&path, &[]).await?;
        Ok(first_record(&got))
    })
}

/// The product record's value, or null when there is none.
fn first_record(list: &Value) -> Value {
    list["nodes"]
        .get(0)
        .map(|n| n["value"].clone())
        .unwrap_or(Value::Null)
}

fn product_check(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let body = check_body(&args)?;
        let (path, _) = fill_path(
            "/studio-product/v1/projects/{project_id}/product/preview",
            args,
        )?;
        let got = api.post(&path, &[], &body).await?;
        Ok(compact_check(got))
    })
}

/// A check, never a save: `write` is not sent.
fn check_body(args: &Map<String, Value>) -> Result<Value, ToolError> {
    let mut body = json!({
        "product_id": required_text(args, "product_id")?,
        "gears": args.get("gears").cloned().unwrap_or_else(|| json!([])),
    });
    if let Some(p) = optional_text(args, "profile") {
        body["profile"] = json!(p);
    }
    Ok(body)
}

fn compact_check(mut v: Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.remove("product_gdl");
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::sdk::{Method, request_of};

    #[test]
    fn reads_go_to_the_routes_the_portal_reads() {
        let all = tools();
        let r = request_of(
            &all,
            "product_description_revision",
            json!({"project_id": "p", "revision": 3}),
        );
        assert_eq!(r.method, Method::Get);
        assert_eq!(r.path, "/studio-product/v1/product-description-revisions/3");
        assert_eq!(r.query, vec![("project_id".to_owned(), "p".to_owned())]);
        let r = request_of(
            &all,
            "gdl_file",
            json!({"project_id": "p", "gear": "api-gateway"}),
        );
        assert_eq!(r.path, "/studio-product/v1/gdl-file");
        assert_eq!(
            r.query,
            vec![
                ("gear".to_owned(), "api-gateway".to_owned()),
                ("project_id".to_owned(), "p".to_owned()),
            ]
        );
    }

    #[test]
    fn a_saved_revision_is_checked_by_its_own_route() {
        let r = request_of(
            &tools(),
            "product_description_check",
            json!({"project_id": "p", "revision": 4, "profile": "prod"}),
        );
        assert_eq!(
            (r.method, r.path.as_str()),
            (
                Method::Post,
                "/studio-product/v1/product-description-checks"
            )
        );
        assert_eq!(r.query, vec![("project_id".to_owned(), "p".to_owned())]);
        assert_eq!(r.body, json!({"revision": 4, "profile": "prod"}));
    }

    #[test]
    fn a_stale_save_names_the_latest_revision_to_save_against() {
        let err = stale(&json!({
            "reason": "DESCRIPTION_REVISION_STALE",
            "base_revision": 4,
            "latest": {"revision": 6, "author": "ann", "created_at": "2026-11-05T10:00:00Z", "text": "x"},
            "yours": "y"
        }));
        assert!(err.0.starts_with("stale: "), "{}", err.0);
        assert!(err.0.contains("revision 4"));
        assert!(err.0.contains("base_revision 6"));
    }

    #[test]
    fn answers_leave_out_the_texts_the_agent_already_has() {
        let d = compact_description(json!({
            "latest": {"revision": 2, "text": "product"},
            "repository_change": {"path": "p.gdl", "branch": "main", "text": "other", "sha256": "h"}
        }));
        assert_eq!(d["latest"]["text"], "product");
        assert_eq!(
            d["repository_change"],
            json!({"path": "p.gdl", "branch": "main", "sha256": "h"})
        );
        let s = saved(
            &json!({"revision": {"revision": 7, "text": "t", "sha256": "h"}, "created": true}),
        );
        assert_eq!(s["revision"], 7);
        assert!(s.get("text").is_none());
        assert_eq!(
            compact_check(json!({"ok": true, "product_gdl": "big"})),
            json!({"ok": true})
        );
        assert_eq!(first_record(&json!({"nodes": []})), Value::Null);
        assert_eq!(
            first_record(&json!({"nodes": [{"value": {"id": "shop"}}]})),
            json!({"id": "shop"})
        );
    }

    #[test]
    fn a_check_never_asks_to_save() {
        let args = json!({"project_id": "p", "product_id": "shop", "profile": "prod"});
        let body = check_body(args.as_object().unwrap()).unwrap();
        assert_eq!(
            body,
            json!({"product_id": "shop", "gears": [], "profile": "prod"})
        );
        assert!(body.get("write").is_none());
    }
}
