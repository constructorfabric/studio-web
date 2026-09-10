# studio-spec-quality

A thin, authenticated wrapper over the external spec-quality service — the
detector API that judges whether a specification is any good.

## Why it exists

The upstream service analyses specification documents with four asynchronous
detectors:

| Detector | Asks |
|---|---|
| `bloat` | is this duplicated across documents |
| `purpose` | what role does each section play, and does the document meet its purpose gate |
| `leak` | does foreign content belong here |
| `traceability` | do the identifiers form a graph, or has the thread drifted |

It authenticates with **its own** shared secret. Handing that secret to every
caller would mean handing it to the browser. So this gear exposes the same
endpoints under the Studio gateway and forwards verbatim, attaching the
server-held key: callers authenticate with their normal Studio token and the
spec-quality key never leaves the backend.

## Deliberately stateless

Bytes in, bytes out; upstream status and content-type preserved. The upstream
is asynchronous — submit returns `202 TaskCreated`, then you poll
`GET /v1/tasks/{id}` — and the wrapper forwards both halves rather than
tracking anything, so the caller drives the task lifecycle and this gear has
nothing to lose on a restart.

Same shape as [`../llm_proxy`](../llm_proxy).

## REST

| Method + path | Does |
|---|---|
| `POST /analyze/{bloat\|purpose\|leak\|traceability}` | submit a document set to one detector |
| `GET /tasks/{task_id}` | poll one submission |
| `GET /tasks` | recent submissions |
| `GET /health`, `GET /status` | is the upstream up, and what it reports about itself |

Note the route prefix is `/cf/spec-quality/v1/…`, not `/cf/studio-spec-quality/…`.

## In the assembly

- Gear `studio-spec-quality`, capabilities `[rest]`, no gear deps.
- Config section `gears.studio-spec-quality`; `base_url` and the key come from
  the environment.
- The documents it judges are [`../documents`](../documents)'.
