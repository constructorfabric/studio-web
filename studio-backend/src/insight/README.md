# studio-insight

The integration seam to **Constructor Insight**
(`github.com/constructorfabric/insight`), a decision-intelligence platform whose
REST API is rooted at `/api`.

The design — why there is one seam, the upstream SQL contract, what the
warehouse holds, how components are carved out of repositories, how errors are
mapped, and the REST surface — is
[`docs/design/studio-insight.md`](../../../docs/design/studio-insight.md). This
README is what you need to work in the directory.

## In the assembly

- Gear `studio-insight`, capabilities `[rest]`, no gear deps.
- Config section `gears.studio-insight`; the host is in `config/*.yaml` and the
  key comes from the environment (`api_key_env`, `STUDIO_INSIGHT_API_KEY`), so
  the credential is never in the repository.
- Not configured in every profile — a deployment without an Insight to talk to
  simply omits the section, and every call then answers 503 with the variables
  to set. `GET /studio-insight/v1/health` says whether the wiring answers.
- Another gear reaches Insight in process, not through the gateway:
  `InsightClient` under the ClientHub scope `INSIGHT_INSTANCE_ID`, or the typed
  `port::ComponentDelivery` (what [`../components_catalog`](../components_catalog)
  uses for `/activity`). Both are published in `init`.
- [`docs/insight-quickstart.md`](../../docs/insight-quickstart.md)
  has worked queries with their real answers and how to check the wiring.

## Working here

- `components.rs` builds every SQL statement. A new value interpolated into one
  is validated and passed through `sql_string`, both.
- A new typed operation is a change here and nowhere else; `pull`/`push` stay
  as the escape hatch until it exists.
