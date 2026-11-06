//! The domain model as MCP tools (`crate::mcp`).
//!
//! Reads, and the model edits the gear records as versions: a field added,
//! changed or removed is one version with its inverse, so whatever an agent
//! does to the model, `domain_model_revert` undoes. Objects and relations are
//! not offered for writing, because nothing records a version of them.

use serde_json::json;

use crate::mcp::sdk::{Effect, Run, Tool, object};

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "domain_model_types",
            description: "Every type of the domain model with its fields and relations, as \
                stored. Most fields live on base types: a type lists what it declares and \
                names what it `extends`. To see one type with everything it inherits, call \
                `domain_type`. Large: call it once and keep the answer.",
            input_schema: || object(json!({}), &[]),
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-domain-model/v1/types"),
        },
        Tool {
            name: "domain_type",
            description: "One domain type as it actually is: every field, its own and \
                inherited (each marked with where it comes from), and every relation it or \
                its bases take part in. Use it before writing code or a spec that names the \
                type's fields.",
            input_schema: || {
                object(
                    json!({ "id": { "type": "string",
                        "description": "The type: an ontology id such as `project`, or a node type id." } }),
                    &["id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-domain-model/v1/types/{id}"),
        },
        Tool {
            name: "domain_type_conformance",
            description: "How the objects already stored measure up against a type as it is \
                now: how many conform, which fields are missing or wrongly shaped, and which \
                fields they carry that the type no longer declares. Call it after a model \
                change to see what it does to existing data.",
            input_schema: || {
                object(
                    json!({ "id": { "type": "string", "description": "The type, as for `domain_type`." } }),
                    &["id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-domain-model/v1/types/{id}/conformance"),
        },
        Tool {
            name: "domain_model_query",
            description: "Read the objects of one type: filtered with `where` (Hasura-style: \
                `{\"status\": {\"_eq\": \"active\"}}`, operators _eq _neq _gt _gte _lt _lte _in \
                _nin _contains _is_null, combined with _and _or _not), ordered, projected to \
                `fields`, with declared relations followed through `include` up to three \
                levels. A field or relation the type does not have is refused with the list \
                of what it has. Experimental: the shape may change.",
            input_schema: || {
                object(
                    json!({
                        "type": { "type": "string", "description": "The type to read, as for `domain_type`." },
                        "project_id": { "type": "string", "description": "Only this project's objects." },
                        "where": { "type": "object" },
                        "order_by": { "type": "array", "items": { "type": "object",
                            "properties": { "field": { "type": "string" },
                                "direction": { "type": "string", "enum": ["asc", "desc"] } } } },
                        "fields": { "type": "array", "items": { "type": "string" } },
                        "include": { "type": "object",
                            "description": "Relation name to {where, order_by, fields, limit, include}." },
                        "offset": { "type": "integer", "minimum": 0 },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                    }),
                    &["type"],
                )
            },
            effect: Effect::Read,
            experimental: true,
            run: Run::Post {
                path: "/studio-domain-model/v1/query",
                query: &[],
            },
        },
        Tool {
            name: "domain_model_graph",
            description: "The model as a graph, as last synced into Graph Storage: object \
                types and their inherits/declares edges. For how the types connect; the \
                fields themselves are in `domain_type`.",
            input_schema: || object(json!({}), &[]),
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-domain-model/v1/model/graph"),
        },
        Tool {
            name: "domain_model_versions",
            description: "The model's change history, newest first: each version's number, \
                who made it and when, a one-line summary, and the patch with its inverse. \
                The number is what `domain_model_revert` takes.",
            input_schema: || object(json!({}), &[]),
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-domain-model/v1/model/versions"),
        },
        Tool {
            name: "domain_type_add_field",
            description: "Add a field to a domain type the model defines. Recorded as a model \
                version, so `domain_model_revert` undoes it. Tell your person what you are \
                adding before you call it: the model is shared by everyone in the organization.",
            input_schema: || {
                object(
                    json!({
                        "id": { "type": "string", "description": "The type, as for `domain_type`." },
                        "name": { "type": "string", "description": "The new field's name." },
                        "type": { "type": "string",
                            "description": "A domain-model type expression: `string`, `integer`, `EntityId`, …" },
                        "description": { "type": "string" },
                        "required": { "type": "boolean" }
                    }),
                    &["id", "name", "type"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Post {
                path: "/studio-domain-model/v1/types/{id}/fields",
                query: &[],
            },
        },
        Tool {
            name: "domain_type_edit_field",
            description: "Rename a field a type declares, change its type, its description, or \
                whether it is required. A rename also moves the stored objects onto the new \
                name unless `migrate` is false. Only the type's own fields: an inherited one \
                is edited on the base that declares it (`domain_type` says which). Recorded \
                as a model version; ask your person first.",
            input_schema: || {
                object(
                    json!({
                        "id": { "type": "string", "description": "The type, as for `domain_type`." },
                        "name": { "type": "string", "description": "The field to change." },
                        "rename_to": { "type": "string" },
                        "type": { "type": "string" },
                        "description": { "type": "string" },
                        "required": { "type": "boolean" },
                        "migrate": { "type": "boolean", "description": "Move stored objects on a rename. Default true." }
                    }),
                    &["id", "name"],
                )
            },
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Patch("/studio-domain-model/v1/types/{id}/fields/{name}"),
        },
        Tool {
            name: "domain_type_remove_field",
            description: "Remove a field from a type's definition. Stored objects keep what \
                they hold under it; `domain_type_conformance` then reports it as undeclared. \
                Recorded as a model version; ask your person first.",
            input_schema: || {
                object(
                    json!({
                        "id": { "type": "string", "description": "The type, as for `domain_type`." },
                        "name": { "type": "string", "description": "The field to remove." }
                    }),
                    &["id", "name"],
                )
            },
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Delete("/studio-domain-model/v1/types/{id}/fields/{name}"),
        },
        Tool {
            name: "domain_model_revert",
            description: "Restore the model to an earlier version from `domain_model_versions`, \
                by applying the inverse of every change since. The revert is a new version \
                itself, so it can be reverted too. Refused when a change in the range has no \
                inverse (an import of a whole model). Ask your person first.",
            input_schema: || {
                object(
                    json!({ "to": { "type": "integer", "minimum": 0,
                        "description": "The version to restore." } }),
                    &["to"],
                )
            },
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Post {
                path: "/studio-domain-model/v1/model/revert",
                query: &[],
            },
        },
    ]
}
