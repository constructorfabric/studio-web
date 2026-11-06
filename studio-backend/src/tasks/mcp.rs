//! Background runs, as an MCP tool (`crate::mcp`): what happened to the run
//! an image import, a build or a deploy started.

use serde_json::json;

use crate::mcp::sdk::{Effect, Run, Tool, object};

pub fn tools() -> Vec<Tool> {
    vec![Tool {
        name: "task_run",
        description: "One background run by the `run_id` an action answered with (an image \
            import, a build start, a deploy): its `state` (queued, running, succeeded, failed, \
            cancelled), the phase it last reported, its result and `last_error`.",
        input_schema: || {
            object(
                json!({
                    "id": { "type": "string", "description": "The run's id (`run_id`)." },
                    "tenant": { "type": "string", "description": "The tenant the run is in, when it is not the caller's (a project's id)." }
                }),
                &["id"],
            )
        },
        effect: Effect::Read,
        experimental: false,
        run: Run::Get("/studio-tasks/v1/runs/{id}"),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::sdk::request_of;

    #[test]
    fn a_run_is_read_by_its_id() {
        let r = request_of(&tools(), "task_run", json!({"id": "r-1", "tenant": "p"}));
        assert_eq!(r.path, "/studio-tasks/v1/runs/r-1");
        assert_eq!(r.query, vec![("tenant".to_owned(), "p".to_owned())]);
    }
}
