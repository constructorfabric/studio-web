# The error contract

What the backend answers with when a call does not succeed, and what a screen is
allowed to read from it. The companion to [`events-catalog.md`](events-catalog.md):
that one is the vocabulary of announcements, this one the vocabulary of refusals.

Every failing response in this assembly is
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`,
produced by `toolkit-canonical-errors`. No gear writes its own error body — rule
[B5](api-conventions.md).

```http
HTTP/1.1 401 Unauthorized
content-type: application/problem+json
x-request-id: 74TP-bn2lkDhrMcp_7Qj9

{
  "type": "gts://gts.cf.core.errors.err.v1~cf.core.err.unauthenticated.v1~",
  "title": "Unauthenticated",
  "status": 401,
  "detail": "Authentication required",
  "instance": "/studio-tasks/v1/runs",
  "trace_id": "74TP-bn2lkDhrMcp_7Qj9",
  "context": { "reason": "MISSING_BEARER" }
}
```

## The fields

| Field | Always present | What it is for |
| --- | --- | --- |
| `type` | yes | The **stable identity** of the failure, as a GTS URI. This is what a client branches on. |
| `title` | yes | The category's fixed English name. Not a sentence and not localised. |
| `status` | yes | The HTTP status, repeated in the body. |
| `detail` | yes | The backend's own sentence about this occurrence. The thing to show a person. |
| `instance` | usually | The path that failed, without the `/cf` prefix. |
| `trace_id` | usually | Matches the `x-request-id` header. The handle for support. |
| `context` | yes | Category-specific, and the only part whose shape varies. `{}` when the category carries nothing. |

## Branch on `type`, never on `status`

The status code does not identify the failure, because the mapping is not
one-to-one:

* `400` is `invalid_argument` **or** `failed_precondition` **or** `out_of_range`
* `409` is `already_exists` **or** `aborted`
* `500` is `internal` **or** `unknown` **or** `data_loss`

"Did this fail because the thing is missing, or because I may not see it?" is
`not_found` versus `permission_denied` — two different statuses, so that one
happens to work. "Did this fail because my input is malformed, or because the
resource is in the wrong state?" is one status and two very different screens.
A client that reads `status` alone cannot tell them apart, and will eventually
tell somebody to fix their input when the answer is "publish it first".

## The categories

Sixteen, fixed by `toolkit-canonical-errors`, and a gear picks one rather than
inventing anything. `type` is `gts://gts.cf.core.errors.err.v1~cf.core.err.<name>.v1~`.

| `<name>` | HTTP | `context` | When |
| --- | ---: | --- | --- |
| `invalid_argument` | 400 | one of `{field_violations[]}`, `{format}`, `{constraint}` | The request itself is wrong, independent of any state. |
| `failed_precondition` | 400 | `{violations[]}` — each `{type_, subject, description}` | The request is well-formed but the system is in the wrong state for it. |
| `out_of_range` | 400 | `{field_violations[]}` | A value is outside its allowed range — paging past the end, a bad window. |
| `unauthenticated` | 401 | `{reason?}` | No credential, or one that did not verify. |
| `permission_denied` | 403 | `{reason}` | Authenticated, and still not allowed. |
| `not_found` | 404 | `{}` | Also the answer when a caller may not know the thing exists. |
| `already_exists` | 409 | `{}` | A create whose identity is taken. |
| `aborted` | 409 | `{reason}` | A concurrency conflict — a lost write, a failed CAS. Retrying may work. |
| `resource_exhausted` | 429 | `{violations[]}` — each `{subject, description, retry_after_seconds?}` | A quota or a rate limit. |
| `cancelled` | 499 | `{}` | The caller went away. |
| `unknown` | 500 | `{description}` | An error that could not be categorised. |
| `internal` | 500 | `{description}` | A defect. Nothing the caller did causes this. |
| `data_loss` | 500 | `{}` | Unrecoverable corruption. |
| `unimplemented` | 501 | `{}` | The route exists, this operation does not do that yet. |
| `service_unavailable` | 503 | `{retry_after_seconds?}` | A dependency is down. Retryable. |
| `deadline_exceeded` | 504 | `{}` | Upstream ran out of time. |

`field_violations[]` entries are `{field, description, reason}`: `field` is the
path to the offending member, `description` is the sentence, `reason` is a stable
machine-readable token.

## Rules for a screen

**Show `detail`.** It is the backend's own sentence and it is the only field
written for a person. `title` alone is the name of a category — showing it is how
a reader ends up with "Failed Precondition" and no idea what to do.

**Read `context` where the category puts the answer there.** Two categories
carry the reason somewhere other than `detail`: `failed_precondition` says
"Operation precondition not met" in `detail` and the reason in
`context.violations[].description`, and `invalid_argument` may put it in
`context.constraint`. A screen that ignores `context` on those two shows a
person the name of a category instead of the answer.

**Show `trace_id` when the category is a defect** — `internal`, `unknown`,
`data_loss`, `service_unavailable`, `deadline_exceeded`. Nothing the person does
will fix those, and the id is what makes the report actionable.

**Do not parse `detail`.** It is prose and it changes. Anything a screen
branches on is `type`, or a named field of `context`.

**A `401` is the session, not the screen.** It is handled once, centrally, by
dropping the session — never by each caller.

## Adding one

A new category is not ours to add: the sixteen come from
`toolkit-canonical-errors` and adding a seventeenth is an upstream change.

What a gear does add is `context`, and that is a contract too. A new field in a
`context` shape that a screen is expected to read lands in this file in the same
PR. A field nobody may read does not need to be here — but then no screen may
read it either.
