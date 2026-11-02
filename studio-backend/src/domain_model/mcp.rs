//! The domain model as MCP tools (`crate::mcp`). Reads only: a write through
//! an agent waits for the model's changes to be proposals a person accepts.

use serde_json::json;

use crate::mcp::sdk::{Run, Tool, object};

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "domain_model_types",
            description: "Every type of the domain model with its fields and relations, as \
                stored. Most fields live on base types: a type lists what it declares and \
                names what it `extends`. To see one type with everything it inherits, call \
                `domain_type`. Large: call it once and keep the answer.",
            input_schema: || object(json!({}), &[]),
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
            run: Run::Get("/studio-domain-model/v1/model/graph"),
        },
    ]
}
