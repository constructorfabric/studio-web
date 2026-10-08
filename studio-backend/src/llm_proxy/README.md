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
  OpenAI connector drivers' key test); do not add a provider HTTP client
  anywhere else.
- Config section `gears.studio-llm-proxy`. The upstream comes from
  `STUDIO_LLM_BASE_URL`, `STUDIO_LLM_MODEL` and `STUDIO_LLM_API_KEY` (or the YAML
  equivalents); unset, the gear boots and in-IDE AI stays off. `providers` lists
  the agents' upstreams and the credstore references of their keys
  (`anthropic-key`, `openai-key` by default), with `models_path` and
  `request_headers` for Studio's own calls.
- The provider routes are mounted only when a credstore client is available.
- Same shape as [`../spec_quality`](../spec_quality): bytes in, bytes out,
  upstream status preserved, credential server-side.
