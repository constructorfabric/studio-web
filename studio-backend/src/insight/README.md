# studio-insight

The integration seam to **Constructor Insight**
(`github.com/constructorfabric/insight`), a decision-intelligence platform whose
REST API lives under `/api/v1`.

## Why it exists

Insight is a separate product with its own deployment, its own credential and
its own evolving contract. Rather than let each gear that wants it grow its own
HTTP client and its own copy of the base URL, this gear is the assembly's one
place of contact — so when the contract moves, one module changes.

## Two ways in

- **REST** (`/studio-insight/v1/{pull,push,health}`) for the portal and
  out-of-process callers.
- **An in-process `InsightClient`** published to the ClientHub, so another gear
  reaches Insight without a network hop back through our own gateway.

Both cover the same two scenarios: **pull** data from Insight, **push** data to
it.

## Deliberately generic, for now

The surface is `resource + JSON` while Insight finalizes the contract for us.
Typed methods land on the same client once the shapes are pinned — the point of
having the seam is that adding them is a change here and nowhere else.

## REST

| Method + path | Does |
|---|---|
| `POST /pull` | read a resource from Insight |
| `POST /push` | send one to it |
| `GET /health` | is the upstream reachable |

## In the assembly

- Gear `studio-insight`, capabilities `[rest]`, no gear deps.
- Config section `gears.studio-insight`; base URL and key come from the
  environment (`base_url_env`, `api_key_env`), so the credential is never in the
  repository.
- Not configured in every profile — a deployment without an Insight to talk to
  simply omits the section.
