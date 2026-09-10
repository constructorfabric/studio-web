# studio-llm-proxy

An OpenAI-compatible endpoint under the Studio gateway, so the AI inside an IDE
session works without ever holding a provider key.

## Why it exists

Theia AI's `ai-openai` provider speaks the OpenAI chat-completions protocol
against any base URL. The obvious way to point it at a real provider is to put
the provider's API key in the IDE container — where it is readable by anything
running in that container, and one `docker inspect` away from anyone who can
reach the daemon.

This gear inverts that. The IDE authenticates with **the user's own Studio
token**, the proxy attaches the server-held provider key on the way out, and
the key never leaves the backend.

## What it does

Forwards verbatim to whatever OpenAI-compatible upstream is configured — there
is no default provider, on purpose: a proxy that silently picks one is a proxy
that silently bills someone. Streaming responses pass through (the `reqwest`
`stream` feature exists for this).

## REST

| Method + path | Does |
|---|---|
| `POST /studio-llm/v1/chat/completions` | the protocol Theia AI speaks; streamed or not |
| `GET /studio-llm/v1/models` | what the upstream offers |
| `GET /studio-llm/v1/client-config` | what the IDE should configure itself with |

## In the assembly

- Gear `studio-llm-proxy`, capabilities `[rest]`, no gear deps.
- Behind the **`llm`** Cargo feature (default on, **off in the release image**
  — see the feature notes in `Cargo.toml`), so a deployment built without it has
  no in-IDE AI.
- Config section `gears.studio-llm-proxy`; upstream host and key from the
  environment.
- Same shape as [`../spec_quality`](../spec_quality): bytes in, bytes out,
  upstream status preserved, credential server-side.
