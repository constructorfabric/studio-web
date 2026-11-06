# Studio over MCP

Studio's domain model, the requirements its specifications state, the
spec-quality detectors and a project's pipeline -- sources, product
description, infra, build, deploy -- as tools in the agent you already work in: Claude
Code, Codex, Cursor or any other MCP client. It is one more way into Studio,
not a replacement for the portal; what you see and decide in the portal stays
there.

Every call acts as you. The server sends each tool's requests to Studio's own
REST API with your token, so a tool can do exactly what you can do in the
portal and nothing more.

Most tools read or check. The ones that change something (the domain model,
a project's sources, its description, secrets, infra, builds and deploys) are
marked so your agent asks you first. Every change to the domain model is a
model version `domain_model_revert` undoes.

| | |
| --- | --- |
| Endpoint (dev) | `https://studio-dev.cfabric.org/cf/studio-mcp/v1/messages` |
| Transport | Streamable HTTP, JSON answers only (no stream) |
| Protocol | 2025-06-18, also 2025-03-26 and 2024-11-05 |
| Sign-in | OAuth through Studio's Keycloak, or `Authorization: Bearer <token>` |
| Resource metadata | `https://studio-dev.cfabric.org/cf/studio-mcp/v1/oauth-protected-resource` |
| Server | `studio-backend/src/mcp/` (gear `studio-mcp`) |

## 1. Sign in

**By the agent itself (OAuth).** An agent that supports MCP's authorization
needs the URL and the client id `studio-mcp`. Without a token the endpoint answers `401` with
`WWW-Authenticate: Bearer resource_metadata="…/oauth-protected-resource"`; the
metadata names Studio's Keycloak realm, and the agent opens your browser there
and keeps the token itself. In Claude Code that is `/mcp`, then *Authenticate*.

The agent signs in as the realm's client `studio-mcp`: public, with PKCE and a
loopback redirect on any port (`keycloak/realm-studio.json`; on dev it exists).
Give the agent that client id. The realm does not let an agent register a
client of its own (anonymous dynamic client registration answers `403`), so an
agent that only knows how to register cannot sign in and takes a token by hand.

**By hand**, when the agent cannot sign in or the realm does not have the
client yet. The server takes the same access token the portal uses; tokens of
the `studio` realm last one hour.

- *From the portal.* Sign in at `https://studio-dev.cfabric.org`, open the
  browser's developer tools, *Network*, pick any request to `/cf/…`, and copy
  the value after `Bearer ` in its `Authorization` header.
- *With a password*, if your account signs in with one (not GitHub, Google or
  Microsoft):

  ```sh
  export STUDIO_TOKEN=$(curl -s https://studio-dev.cfabric.org/auth/realms/studio/protocol/openid-connect/token \
    -d grant_type=password -d client_id=studio-portal \
    --data-urlencode username=you@example.com --data-urlencode password='…' | jq -r .access_token)
  ```

Keep it in an environment variable, `STUDIO_TOKEN` below, never in a file you
commit. When it expires, tool calls answer `401`: take a new one and restart
the agent's MCP connection.

## 2. Register the server

### Claude Code

With OAuth:

```sh
claude mcp add --transport http --scope user --client-id studio-mcp \
  studio https://studio-dev.cfabric.org/cf/studio-mcp/v1/messages
```

then `/mcp`, *studio*, *Authenticate*. With a token by hand:

```sh
claude mcp add --transport http studio \
  https://studio-dev.cfabric.org/cf/studio-mcp/v1/messages \
  --header "Authorization: Bearer $STUDIO_TOKEN"
```

That writes the token into your user settings. To keep it out of every file,
use a project `.mcp.json`, which expands variables when the server starts:

```json
{
  "mcpServers": {
    "studio": {
      "type": "http",
      "url": "https://studio-dev.cfabric.org/cf/studio-mcp/v1/messages",
      "headers": { "Authorization": "Bearer ${STUDIO_TOKEN}" }
    }
  }
}
```

Check it with `/mcp` inside Claude Code: `studio` is *connected* and lists its
tools.

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.studio]
url = "https://studio-dev.cfabric.org/cf/studio-mcp/v1/messages"
bearer_token_env_var = "STUDIO_TOKEN"
```

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "studio": {
      "url": "https://studio-dev.cfabric.org/cf/studio-mcp/v1/messages",
      "headers": { "Authorization": "Bearer ${env:STUDIO_TOKEN}" }
    }
  }
}
```

### Anything else

POST one JSON-RPC message to the endpoint with the header; the answer is one
JSON body:

```sh
curl -s https://studio-dev.cfabric.org/cf/studio-mcp/v1/messages \
  -H "Authorization: Bearer $STUDIO_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 3. The tools

A project is named by `project_id`: the id in the portal's address of that
project.

| Tool | What it answers |
| --- | --- |
| `domain_model_types` | every type of the domain model, as stored |
| `domain_type` | one type with everything it inherits |
| `domain_type_conformance` | how stored objects measure up against a type |
| `domain_model_query` | a type's objects: filtered, ordered, with relations |
| `domain_model_graph` | the model as a graph of types |
| `project_capabilities` | the capabilities a project's documents need |
| `project_requirements` | the non-functional statements its documents make |
| `project_plan` | the gears that could provide each capability |
| `project_findings` | where the documents and the code disagree |
| `spec_check` | a detector's verdict on the text you send |
| `spec_check_result` | the verdict of a check that took longer than the wait |
| `domain_model_versions` | the model's change history, with version numbers |
| `domain_type_add_field` | *changes the model:* adds a field to a type |
| `domain_type_edit_field` | *changes the model:* renames or retypes a field |
| `domain_type_remove_field` | *changes the model:* removes a field from a type |
| `domain_model_revert` | *changes the model:* restores an earlier version |

**The pipeline.** A project goes from its sources to a running product
without the portal; each step is the REST route the portal calls for it.

| Step | Tool | What it answers or does |
| --- | --- | --- |
| Sources | `project_sources` | the repositories the project is made of |
| | `project_sources_set` | *changes:* replaces the list (only `sources`; the rest of the config is kept) |
| | `project_connections` | the connections the project can read through |
| | `connection_repositories` | the repositories one connection reaches |
| Product | `product_description` | the latest description revision: text, number, `sources_lock` |
| | `product_description_revisions` | the revisions, newest first, without text |
| | `product_description_revision` | one revision with its text |
| | `product_description_save` | *changes:* a new revision against a base; `stale` when someone saved since |
| | `product_record` | the picked gears and the engine's kept checks per profile |
| | `product_check` | the engine's verdict for one profile, composed from the picks |
| | `product_description_check` | the engine's verdict on a saved revision as written, for one profile: GBX diagnostics |
| | `gdl_file` | a component's `gear.gdl`, `frontx.gdl` or `service.gdl` |
| Environments | `deploy_targets` | where the product can deploy, the bindings, the secret keys |
| | `project_environments` | the project's own environments |
| | `deploy_bindings_set` | *changes:* which profile each environment runs |
| | `config_secrets` | the secret keys per environment (never values) |
| | `config_secret_keys` | one environment's keys against what the description and infra services need there: `missing` |
| | `config_secret_set` | *changes:* sets a secret; the value is never echoed back |
| | `config_secret_delete` | *changes:* removes a secret |
| Infra | `infra_services` | the infra services the product runs beside its gears |
| | `infra_services_set` | *changes:* replaces the list |
| | `infra_service_public_url_set` | *changes:* sets or removes one service's `public_url`, keeping the rest |
| | `infra_plan` | what a deploy to one environment does with them |
| | `image_import` | *changes:* copies an external image or chart into the project's path |
| | `image_get` | one image: where, by digest, its state |
| | `project_images` | the project's images and charts |
| Build | `build_plan` | what a build would do and why it would be refused; starts nothing |
| | `build_start` | *changes:* builds in an environment's cluster |
| | `build_list` | the project's builds, newest first, with status and failure |
| | `build_get` | one build: status, lock hash, images, chart, `built_infra` |
| | `build_wait` | waits up to 25 s for a build to end; `done` and its record |
| | `build_log` | a Studio build's steps with the end of each log |
| Deploy | `deploy_request` | *changes:* deploys a build, redeploys, or uninstalls |
| | `deployments` | deployments with state and outcome |
| | `deployment_get` | one deployment: state, outcome, decision |
| | `deployment_wait` | waits up to 25 s for a deployment to settle; `done` and its record |
| | `deployment_decide` | *changes:* approves or declines (organization administrators) |
| | `deployment_status` | the release as its cluster reports it now |
| | `deployment_logs` | the end of each container's log |
| Runs | `task_run` | the background run an import, build or deploy started |

**The inbox.** Everything that waits for you in one organization, as the
portal's Inbox lists it, and how to act on each item.

| Tool | What it answers or does |
| --- | --- |
| `inbox` | deploys awaiting approval, reviews asked of you, pull requests whose next move is yours, your failed background work (an undelivered notification among it); each item's `act` names the tool that answers it |
| `inbox_mark` | *changes:* marks an item done, snoozes it, or opens it again; the portal shows the same marks |
| `review_requests` | a project's or workspace's review requests; `waiting_on: "me"` for yours |
| `review_verdict` | *changes:* approves a review request or asks for changes |

A deploy is answered with `deployment_decide`, a failed run read with
`task_run`, a pull request on its provider. Each kind of item is one source
in `src/user_profile/mcp.rs`; a new kind is one more source there and one in
the portal's `inbox-sources.ts`.

`product_check` composes the description from the picked gears and keeps its
verdict in `product_record`; `product_description_check` checks a revision
already saved, as a build lays it down, and keeps nothing.

**Waiting.** A build takes minutes, a deploy less. `build_wait` and
`deployment_wait` answer as soon as it ends, or after 25 seconds with
`done: false` and the record as it is: call again until `done`. One call
waits no longer because the gateway in front of Studio gives up on a request
after 30 seconds. A deploy `awaiting_approval` counts as settled: nothing
moves it but an administrator's `deployment_decide`.

**Secrets.** `config_secret_keys` names what one environment needs: each
`${NAME}` of the latest description outside every profile (a gear's
configuration) or in the profile the environment runs, and each capability an
infra service leaves to the project. One the database step or an infra
service writes is marked so; `missing` is what a deploy would run without.
Set each with `config_secret_set`: the value goes in through the tool's input
and no tool ever answers it.

Each of these steps has its own route: `GET /studio-environments/v1/builds/{build_id}`,
`GET …/deployments/{deployment_id}`, `GET …/config-secrets` (all with
`?project_id=`) and `POST /studio-product/v1/product-description-checks?project_id=`.

**Changes.** Every tool that changes something (marked *changes* above) is
annotated for your agent (`readOnlyHint: false`, and `destructiveHint` for one
that replaces or removes), so it asks you before calling it, and is marked
experimental. A change to the domain model is a model version with its inverse: `domain_model_versions` shows it
and `domain_model_revert` undoes it. Objects, relations and documents are not
offered for writing: nothing records a version of them, and a specification
changes through your own commit, which people review.

**Experimental** tools say so first in their description. They may change
shape or go away without notice.

**Limits.** `spec_check` is limited to 60 calls an hour per person (setting
`spec_checks_per_hour`), against an agent that checks in a loop. Past it the
tool says when to try again.

The agent reads each tool's own description from `tools/list`; that text is
the reference, and this table only orients you.

**Where text comes from.** `spec_check` checks the text the agent sends, saved
or not, so a draft is checked before you commit it. The `project_*` tools read
the documents Studio holds for the project, its repositories as last synced,
not your working copy.

**A check takes time.** A detector runs from seconds to minutes. `spec_check`
waits up to `wait_seconds` (60 by default, 600 at most); if the detector is not
done by then it answers `running` with the ids to pass to `spec_check_result`.

Things to ask:

- "Check docs/PRD.md with the purpose detector before I commit it."
- "Which fields does the `project` type have, including inherited ones?"
- "What does project `<id>` need that its code does not provide?"

## 4. When something is wrong

| What you see | Why |
| --- | --- |
| `401` when connecting | the token expired or is not sent; check the variable the config reads |
| a tool answers `Studio answered 403: …` | you may not do that in the portal either |
| `Studio answered 503: … is not part of this deployment` | the gear the tool needs is not running here |
| `spec_check` fails with `upstream not configured` | the spec-quality service has no key on this deployment |
| `you have reached the limit of 60 spec_check calls an hour` | the per-person limit; wait the minutes it names |
| the agent's sign-in page says the client is unknown | the agent was not given `--client-id studio-mcp`, or the realm has no such client; see *Sign in* |
| the agent says the authorization server's metadata is not JSON | something in front answers `/.well-known/…` with a page; the portal's nginx returns 404 there |

## 5. Next to Constructor Research's MCP

Constructor Research has an MCP of its own,
[constructor-research-mcp](https://github.com/NRGGIT/constructor-research-mcp):
a local server that uploads a folder to a Research desk, builds its images
and runs them as an application. Both servers can sit in the same agent:

```sh
claude mcp add --scope user constructor-research -- npx -y constructor-research-mcp@latest
```

It needs Node.js 22 or later. On first use the agent calls its `sign_in` tool,
which opens a browser window at Research's sign-in; that session belongs to
the agent, apart from Studio's.

Which one deploys:

| | Studio | Research's MCP |
| --- | --- | --- |
| What | a product of a Studio project, through its environments | any folder with Dockerfiles |
| Where | the organization's clusters or Research, one release ladder (ADR-0056) | a Research desk and project the person names |
| Sign-in to Research | each member's own, made in Studio's *Connections* (ADR-0049) | the agent's own browser session |
| Studio knows of it | yes: environments, releases, logs | no |

So a product goes to Research through Studio. Research's MCP is for
something Studio does not hold, or for a quick run from a laptop when
Studio's deployment cannot reach Research.

Studio's Research path builds and deploys the way Research's MCP found
Research to behave on live runs: names of Dockerfiles, a pause after the
upload, a build error counted when seen twice, a running service changed
stopped, a minute of readiness and restart watching after the start. The
list is in ADR-0049 §6.

## Setting it up on a deployment

| Setting (`gears.studio-mcp.config`) | Variable | Default |
| --- | --- | --- |
| `api_url`: where tools send requests | `STUDIO_MCP_API_URL` | `http://127.0.0.1:8090/cf` |
| `authorization_server`: the issuer in the metadata | `STUDIO_OIDC_ISSUER` (the Helm chart sets it) | empty: no issuer is named, and a token is given by hand (Compose) |
| `public_url`: the endpoint's base as seen from outside | `STUDIO_MCP_PUBLIC_URL` | the request's forwarded host and scheme |
| `spec_checks_per_hour` | | `60` (0: no limit) |

A realm imported before this change has no `studio-mcp` client: the realm
file is read on Keycloak's first boot only. Create it from the definition in
`keycloak/realm-studio.json` (public, standard flow, PKCE S256, redirects
`http://127.0.0.1/*` and `http://localhost/*`, the `tenant-id` mapper), with
the admin from the `studio-web-keycloak-admin` Secret:

```sh
# the client's JSON, from the repository
python -c "import json;r=json.load(open('keycloak/realm-studio.json',encoding='utf-8'));print(json.dumps(next(c for c in r['clients'] if c['clientId']=='studio-mcp')))" > mcp-client.json
NS=studio-dev; K="kubectl -n $NS"
U=$($K get secret studio-web-keycloak-admin -o jsonpath='{.data.username}' | base64 -d)
P=$($K get secret studio-web-keycloak-admin -o jsonpath='{.data.password}' | base64 -d)
$K exec -i deploy/studio-studio-web-keycloak -- env U="$U" P="$P" sh -c '
  cat > /tmp/c.json; K=/opt/keycloak/bin/kcadm.sh; C="--config /tmp/kc"
  $K config credentials $C --server http://localhost:8080/auth --realm master --user "$U" --password "$P"
  $K create clients $C -r studio -f /tmp/c.json; rm -f /tmp/c.json /tmp/kc' < mcp-client.json
```

Dev has it (created 2026-11-03). A redirect to `127.0.0.1` or `localhost` on
any port is accepted; any other host is refused.

The portal's nginx answers `/.well-known/` with 404 rather than the portal's
page, because an MCP client asks
`/.well-known/oauth-authorization-server/auth/realms/studio` on the portal's
host before Keycloak's own discovery document.

Every tool call is logged as `studio-mcp: tool call` with the tool, the
caller's subject id, whether it answered and how long it took; the requests a
tool made appear in the metrics of the routes they reached.

## Adding a tool

A tool lives with the gear whose routes it calls, in that gear's `mcp.rs`
(`src/domain_model/mcp.rs` is the pattern), and is listed in
`crate::mcp::tools()`. It is a route and a description: `Run::Get` and
`Run::Post`, `Run::Put`, `Run::Patch` and `Run::Delete` send the arguments to one route; `Run::Custom` is for more than one
request, as `spec_check` submits and then waits. Write the description for the
agent: what the tool answers, when to call it, what it does not do. That text
is all the agent knows about it. Set `effect` to what the call does to Studio,
and mark a tool that changes anything `experimental` (a test holds that).
