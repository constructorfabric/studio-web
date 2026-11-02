//! MCP over JSON-RPC 2.0: the handshake, the tool list, a tool call.
//!
//! Only the server half of what an agent needs to call tools is here. There
//! are no resources, prompts, sampling or server-sent requests, so a POST is
//! always answered with one JSON body and never with a stream.

use serde_json::{Map, Value, json};

use super::sdk::{self, Api, Tool};

/// The protocol versions this server speaks, newest first. An agent asking for
/// one of them gets it; any other is answered with the newest, and the agent
/// decides whether it can go on (MCP's version negotiation).
pub const VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "Constructor Studio: a project's domain model, the requirements and \
capabilities its specifications state, and the spec-quality detectors. Every call acts as the \
person whose token this is, with exactly what they may do in the Studio portal. A project is \
named by `project_id`, the id in the portal's address of that project. Text you send is checked \
as you send it: nothing is read from your disk or your repository.";

/// JSON-RPC error codes this server answers with.
mod code {
    pub const PARSE: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
}

/// The answer to one HTTP POST body: `None` when it held only notifications
/// and responses, which MCP answers with 202 and no body.
pub async fn handle_body(body: &[u8], tools: &[Tool], api: &Api) -> Option<Value> {
    let parsed: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(e) => return Some(error(Value::Null, code::PARSE, &format!("not JSON: {e}"))),
    };
    match parsed {
        // A batch (2025-03-26 and older). Each message answered on its own.
        Value::Array(messages) => {
            let mut out = Vec::new();
            for message in messages {
                if let Some(answer) = handle(message, tools, api).await {
                    out.push(answer);
                }
            }
            (!out.is_empty()).then_some(Value::Array(out))
        }
        message => handle(message, tools, api).await,
    }
}

/// One JSON-RPC message. A notification or a response (no `method` and an
/// `id`, from an agent answering a request we never send) gets no answer.
pub async fn handle(message: Value, tools: &[Tool], api: &Api) -> Option<Value> {
    let Value::Object(message) = message else {
        return Some(error(
            Value::Null,
            code::INVALID_REQUEST,
            "a message is an object",
        ));
    };
    let id = message.get("id").cloned();
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return id.is_none().then(|| {
            error(
                Value::Null,
                code::INVALID_REQUEST,
                "a request names its method",
            )
        });
    };
    // No id: a notification (`notifications/initialized`, a cancel). Nothing
    // this server does is cancellable mid-call, so each is only acknowledged.
    let id = id?;
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => result(id, initialize(&params)),
        "ping" => result(id, json!({})),
        "tools/list" => result(id, json!({ "tools": list(tools) })),
        "tools/call" => match call(&params, tools, api).await {
            Ok(answer) => result(id, answer),
            Err(why) => error(id, code::INVALID_PARAMS, &why),
        },
        other => error(
            id,
            code::METHOD_NOT_FOUND,
            &format!("`{other}` is not served here: this server has tools only"),
        ),
    })
}

fn initialize(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str);
    let version = asked
        .filter(|v| VERSIONS.contains(v))
        .unwrap_or(VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "studio-mcp", "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    })
}

fn list(tools: &[Tool]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": (t.input_schema)(),
            })
        })
        .collect()
}

/// A tool call. A tool that does not exist, or arguments that are not an
/// object, is a protocol error; anything the tool itself refuses is its
/// result, marked `isError`, so the agent reads why and can try again.
async fn call(params: &Value, tools: &[Tool], api: &Api) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or("`name` is required")?;
    let tool = tools
        .iter()
        .find(|t| t.name == name)
        .ok_or_else(|| format!("no tool `{name}`; `tools/list` names them"))?;
    let args = match params.get("arguments") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(args)) => args.clone(),
        Some(_) => return Err("`arguments` is an object".to_owned()),
    };
    Ok(match sdk::call(tool, api.clone(), args).await {
        Ok(answer) => json!({
            "content": [{ "type": "text", "text": text(&answer) }],
            "isError": false,
        }),
        Err(why) => json!({
            "content": [{ "type": "text", "text": why.0 }],
            "isError": true,
        }),
    })
}

/// An answer as the text an agent reads: JSON, indented, since that is what a
/// model reads best; a plain string as itself.
fn text(answer: &Value) -> String {
    match answer {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    }
}

fn result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::super::sdk::{Run, ToolError, ToolFuture, object};
    use super::*;

    fn echo(_api: Api, args: Map<String, Value>) -> ToolFuture {
        Box::pin(async move {
            match args.get("fail") {
                Some(_) => Err(ToolError::new("refused")),
                None => Ok(Value::Object(args)),
            }
        })
    }

    fn tools() -> Vec<Tool> {
        vec![Tool {
            name: "echo",
            description: "Answers with its arguments.",
            input_schema: || object(json!({}), &[]),
            run: Run::Custom(echo),
        }]
    }

    fn api() -> Api {
        Api::new(reqwest::Client::new(), "http://127.0.0.1:1/cf", None)
    }

    async fn ask(message: Value) -> Option<Value> {
        handle_body(message.to_string().as_bytes(), &tools(), &api()).await
    }

    #[tokio::test]
    async fn the_handshake_agrees_on_a_version_it_speaks() {
        let answer = ask(json!({"jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"protocolVersion":"2025-03-26","capabilities":{}}}))
        .await
        .unwrap();
        assert_eq!(answer["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(
            answer["result"]["capabilities"]["tools"]["listChanged"],
            false
        );

        let newer = ask(json!({"jsonrpc":"2.0","id":2,"method":"initialize",
            "params":{"protocolVersion":"2099-01-01"}}))
        .await
        .unwrap();
        assert_eq!(newer["result"]["protocolVersion"], VERSIONS[0]);
    }

    #[tokio::test]
    async fn a_notification_gets_no_answer() {
        assert_eq!(
            ask(json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await,
            None
        );
    }

    #[tokio::test]
    async fn the_list_carries_each_tools_schema() {
        let answer = ask(json!({"jsonrpc":"2.0","id":"a","method":"tools/list"}))
            .await
            .unwrap();
        assert_eq!(answer["id"], "a");
        assert_eq!(answer["result"]["tools"][0]["name"], "echo");
        assert_eq!(
            answer["result"]["tools"][0]["inputSchema"]["type"],
            "object"
        );
    }

    #[tokio::test]
    async fn a_refusal_is_the_tools_result_and_an_unknown_tool_is_a_protocol_error() {
        let ok = ask(json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
            "params":{"name":"echo","arguments":{"x":1}}}))
        .await
        .unwrap();
        assert_eq!(ok["result"]["isError"], false);
        assert!(
            ok["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("\"x\": 1")
        );

        let refused = ask(json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
            "params":{"name":"echo","arguments":{"fail":true}}}))
        .await
        .unwrap();
        assert_eq!(refused["result"]["isError"], true);
        assert_eq!(refused["result"]["content"][0]["text"], "refused");

        let unknown = ask(json!({"jsonrpc":"2.0","id":3,"method":"tools/call",
            "params":{"name":"nope"}}))
        .await
        .unwrap();
        assert_eq!(unknown["error"]["code"], code::INVALID_PARAMS);
    }

    #[tokio::test]
    async fn what_is_not_json_or_not_served_is_said() {
        let bad = handle_body(b"{", &tools(), &api()).await.unwrap();
        assert_eq!(bad["error"]["code"], code::PARSE);
        let other = ask(json!({"jsonrpc":"2.0","id":1,"method":"resources/list"}))
            .await
            .unwrap();
        assert_eq!(other["error"]["code"], code::METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn a_batch_is_answered_message_by_message() {
        let answer = ask(json!([
            {"jsonrpc":"2.0","id":1,"method":"ping"},
            {"jsonrpc":"2.0","method":"notifications/initialized"},
        ]))
        .await
        .unwrap();
        assert_eq!(answer.as_array().unwrap().len(), 1);
    }
}
