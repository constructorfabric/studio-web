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
- Behind the **`llm`** Cargo feature (default on, **off in the release image**
  — see the feature notes in `Cargo.toml`), so a deployment built without it has
  no in-IDE AI.
- Config section `gears.studio-llm-proxy`. The upstream comes from
  `STUDIO_LLM_BASE_URL`, `STUDIO_LLM_MODEL` and `STUDIO_LLM_API_KEY` (or the YAML
  equivalents); unset, the gear boots and in-IDE AI stays off. `providers` lists
  the agents' upstreams and the credstore references of their keys
  (`anthropic-key`, `openai-key` by default).
- The provider routes are mounted only when a credstore client is available.
- Same shape as [`../spec_quality`](../spec_quality): bytes in, bytes out,
  upstream status preserved, credential server-side.
