//! What a project's specifications need, as MCP tools (`crate::mcp`).
//!
//! These read the project's documents as Studio holds them, from its
//! repositories' last sync, not from the agent's working copy.

use serde_json::{Value, json};

use crate::mcp::sdk::{Run, Tool, object};

fn project_only() -> Value {
    object(
        json!({ "project_id": { "type": "string",
            "description": "The project: the id in the portal's address of that project." } }),
        &["project_id"],
    )
}

fn project_in_organization() -> Value {
    object(
        json!({
            "project_id": { "type": "string",
                "description": "The project: the id in the portal's address of that project." },
            "organization_id": { "type": "string",
                "description": "The organization whose catalogue to match against; the caller's own when absent." }
        }),
        &["project_id"],
    )
}

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "project_capabilities",
            description: "The capabilities a project's specification documents need, each with \
                the documents that ask for it. Read from the documents Studio holds for the \
                project (its repositories as last synced), not from your working copy.",
            input_schema: project_only,
            run: Run::Get("/studio-spec-mapping/v1/capabilities"),
        },
        Tool {
            name: "project_requirements",
            description: "Every non-functional, operational and deployment statement a \
                project's documents make, line by line, with the document each comes from. \
                These are what the deployment profile answers, not what gears answer.",
            input_schema: project_only,
            run: Run::Get("/studio-spec-mapping/v1/requirements"),
        },
        Tool {
            name: "project_plan",
            description: "For each capability the project's documents need: the gears that \
                could provide it, gears the Gearbox engine reports as providing one of its \
                contracts first, then gears whose descriptions mention its terms, each with \
                the passage it cites. Decisions members recorded rank a gear first (confirmed) \
                or last (rejected). Also the deployment profile the documents point to.",
            input_schema: project_in_organization,
            run: Run::Get("/studio-spec-mapping/v1/plan"),
        },
        Tool {
            name: "project_findings",
            description: "Where a project's documents and its code disagree: a capability the \
                documents need that no component in the code provides (`product.missing`, \
                with what could), and a gear a member confirmed that the code does not depend \
                on (`product.decided_not_built`). Each finding names the document and the \
                requirement that asks. Empty when the project has no code to compare.",
            input_schema: project_in_organization,
            run: Run::Get("/studio-spec-mapping/v1/findings"),
        },
    ]
}
