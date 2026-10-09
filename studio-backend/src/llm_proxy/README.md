# studio-llm-proxy

An OpenAI-compatible endpoint under the Studio gateway, so the AI inside an IDE
session works without ever holding a provider key.

The design — why the key stays on the server, the OpenAI-compatible half for
Theia AI and the provider half for the agents, what is forwarded and what is
not, the REST surface — is
[`docs/design/studio-llm-proxy.md`](../../../docs/design/studio-llm-proxy.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-llm-proxy`, capabilities `[rest]`, deps `credstore`.
- Linked into **every build**, the release included — not behind the `llm`
  feature (ADR-0039).
- Studio's one way out to a model provider. Another gear that needs a provider
  takes `port::ModelProviders` from the ClientHub (today: the Anthropic and
  OpenAI connector drivers' key test, and the component registry's
  suggestions through `complete`, on the caller's key); do not add a provider HTTP client
  anywhere else.
- No Studio key and no server upstream. Every call goes out on the caller's
  key (`keys.rs`): their private profile key (`anthropic-key`, `openai-key`;
  a shared value under the same reference is ignored), else their personal AI
  connection, else the workspace's (workspace routes only), else the
  organization's — the last three from the connector gear's
  `ConnectorService::model_key_for` via `connectors::sdk`.
- Workspace routes (`/studio-llm/v1/workspaces/{workspace_id}/…`) check
  membership first (`studio_session::sdk::TenantMembership`, account-management
  resolved per use): a stranger gets 404 and no key is looked for.
- Config section `gears.studio-llm-proxy`: `providers` only — base URL,
  profile-key reference, `key_header`, `models_path` and `request_headers`
  for Studio's own calls, and `chat_model` / `chat_path` /
  `developer_message_settings` for the IDE's chat (defaults: Anthropic
  `claude-sonnet-5-5`, then OpenAI `gpt-4.1-mini`).
- Same shape as [`../spec_quality`](../spec_quality): bytes in, bytes out,
  upstream status preserved, credential server-side.
