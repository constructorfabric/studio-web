# Portal API pages

One page per resource the portal talks to. This is rule F3 of
[`docs/api-conventions.md`](../../docs/api-conventions.md); the reasoning is
[ADR-0020](../../docs/adr/0020-one-contract-with-the-frontend.md).

## What these pages are for

The OpenAPI at `/cf/docs` already says what an endpoint takes and returns, and
once types are generated from it a screen will not read it by hand at all. What
it cannot say is the part that costs an afternoon: that a run can finish before
your stream is open, that a capability has to be read before a button is
offered, that a progress event carries only what that transition set. That is
what a page here is for.

So the schema is not the content. The content is: which service, what it
exposes, a working example per use case, and **Traps**.

## The shape

[`studio-events.md`](studio-events.md) is the template. In order:

1. **One sentence** on what the resource is and why a screen touches it, with a
   link to the ADR that decided it.
2. **The service** — where it is registered, how to get it out of
   `apiRegistry`, and a table of its members with one line each.
3. **The types** a caller sees, as the `interface` the screen actually imports,
   with the fields that are conditional called out.
4. **One section per use case**, each with a `tsx` example that compiles as
   written. Not a fragment — the imports, the hook, the narrowing.
5. **Traps** — the behaviour that is correct, documented and still surprising.
   Written as you hit them; this section only grows.

## The pages

| Resource | Service | Page |
| --- | --- | --- |
| studio-events | `StudioEventsApiService` | [studio-events.md](studio-events.md) |
| studio-organizations | `OrganizationsApiService` | — |
| studio-user | `AccountsApiService` | — |
| studio-identity | `IdentityApiService` | — |
| studio-documents | `DocumentsApiService` | — |
| studio-connector | `ConnectorsApiService` | — |
| studio-artifact-ingest | `ArtifactIngestApiService` | — |

A dash is a page that has not been written yet, not a resource that does not
need one. A service that gains a second consumer gets its page in that PR —
the second consumer is the moment the knowledge stops being one person's.
