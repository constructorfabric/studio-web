//! Where a project's product runs, as MCP tools (`crate::mcp`): its
//! environments, the secrets of its configuration there, its infra services,
//! the images imported into its path, the builds Studio runs and the deploys
//! of them, up to the approval and what the cluster reports.
//!
//! A build and a deploy are started here and followed with the reads, or
//! waited on with `build_wait` and `deployment_wait` up to a timeout. A
//! deploy to a protected environment waits for an organization
//! administrator's decision, which `deployment_decide` gives as the caller,
//! so only an administrator's agent can give it.

use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::mcp::sdk::{
    Api, Effect, Run, Tool, ToolError, ToolFuture, fill_path, object, optional_text, pause,
    project_id, required_text,
};

const ENVIRONMENTS: &str = "/studio-environments/v1";

/// How long `build_wait` and `deployment_wait` wait at most in one call:
/// inside the api-gateway's request timeout, 30 s and fixed
/// (`config/k8s.yaml`), which the MCP route is behind like any other. A build
/// takes minutes; past the wait the agent gets the record as it is and calls
/// again.
const MAX_WAIT_SECS: u64 = 25;
const DEFAULT_WAIT_SECS: u64 = MAX_WAIT_SECS;
/// The gateway's timeout, with room for the last read after the wait.
const _: () = assert!(MAX_WAIT_SECS + 5 <= 30);
const BUILD_POLL: Duration = Duration::from_secs(5);
const DEPLOY_POLL: Duration = Duration::from_secs(5);

fn project_only() -> Value {
    object(json!({ "project_id": project_id() }), &["project_id"])
}

fn environment_id(what: &str) -> Value {
    json!({ "type": "string", "description": what })
}

/// What `build_plan` and `build_start` take: the body of `POST /builds`.
fn build_input() -> Value {
    object(
        json!({
            "project_id": project_id(),
            "environment_id": environment_id("The environment whose cluster builds it and whose registry gets it."),
            "profile": { "type": "string", "description": "The `kubernetes` profile it builds; absent, the one the project binds to the environment, else `prod`." },
            "product_file": { "type": "string",
                "description": "The description's path in the repository; default where the product record says." },
            "ref": { "type": "string", "description": "A branch, tag or commit; the repository's branch when absent." }
        }),
        &["project_id", "environment_id"],
    )
}

pub fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: "deploy_targets",
            description: "Where the project's product can be deployed: the environments that \
                take its deploys (the organization's and its own), each with the namespace its \
                release gets, the profile each environment runs (`bindings`), and the secret \
                keys of its configuration per environment (keys only, never values). Start \
                here to pick an `environment_id`.",
            input_schema: project_only,
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-environments/v1/targets"),
        },
        Tool {
            name: "project_environments",
            description: "The environments the project keeps itself (not the organization's), \
                and the organization's clusters it may put one on.",
            input_schema: project_only,
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-environments/v1/project-environments"),
        },
        Tool {
            name: "deploy_bindings_set",
            description: "Bind the product's kubernetes profiles to environments: the WHOLE \
                list replaces the current one (read it from `deploy_targets` first), each \
                environment at most once. A binding grants nothing: every deploy is still \
                checked against its environment. Ask your person first.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "items": { "type": "array", "items": {
                            "type": "object",
                            "properties": {
                                "environment_id": { "type": "string" },
                                "profile": { "type": "string" },
                                "values": { "type": "object", "description": "Chart values for the release there." }
                            },
                            "required": ["environment_id", "profile"]
                        } }
                    }),
                    &["project_id", "items"],
                )
            },
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Put {
                path: "/studio-environments/v1/bindings",
                query: &["project_id"],
            },
        },
        Tool {
            name: "config_secrets",
            description: "The secret keys of the project's configuration, per environment, \
                optionally of one environment: keys only, a value is never returned. A deploy \
                writes them into the release's `<release>-config` secret.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "environment_id": environment_id("Only this environment's keys.")
                    }),
                    &["project_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Custom(config_secrets),
        },
        Tool {
            name: "config_secret_keys",
            description: "One environment's configuration secrets against what the product \
                needs there: `keys` set (names only, a value is never returned), and \
                `needed`, each with what needs it (`description`, `profile <id>`, `infra \
                <service>`), what gives it otherwise (`database`, `infra <service>`) and \
                whether it is set. `missing` is what a deploy there would run without: set \
                each with `config_secret_set`. Read from the latest description revision \
                (each `${NAME}` outside every profile or in the profile the environment runs) \
                and the infra services.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "environment_id": environment_id("The environment.")
                    }),
                    &["project_id", "environment_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-environments/v1/config-secrets"),
        },
        Tool {
            name: "config_secret_set",
            description: "Set a SECRET of the project's configuration in one environment: \
                `key` is an environment-variable name (SMTP_PASSWORD), `value` its value. The \
                value is a secret: it is kept in credstore and never echoed back, by this tool \
                or any other; the answer names the key only. Replaces an existing value. Takes \
                effect at the next deploy there. A key `APP__GEARS__<GEAR>__CONFIG__<FIELD>` \
                replaces that gear's config field: refused (CONFIG_SECRET_SHADOWED_BY_DESCRIPTION, \
                CONFIG_SECRET_CONFLICTS_WITH_DESCRIPTION) when the product description already \
                sets the field; set the `${VAR}` it reads instead. Never invent a value: ask \
                your person for it, and do not put it in your own messages or files.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "environment_id": environment_id("The environment."),
                        "key": { "type": "string", "pattern": "^[A-Za-z_][A-Za-z0-9_]*$" },
                        "value": { "type": "string", "description": "The secret value; never returned." }
                    }),
                    &["project_id", "environment_id", "key", "value"],
                )
            },
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Put {
                path: "/studio-environments/v1/config-secrets/{key}",
                query: &["project_id", "environment_id"],
            },
        },
        Tool {
            name: "config_secret_delete",
            description: "Remove a secret of the project's configuration in one environment. \
                The next deploy there writes the release's configuration without it. Ask your \
                person first.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "environment_id": environment_id("The environment."),
                        "key": { "type": "string" }
                    }),
                    &["project_id", "environment_id", "key"],
                )
            },
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Delete("/studio-environments/v1/config-secrets/{key}"),
        },
        Tool {
            name: "infra_services",
            description: "The third-party services the project's product runs beside its gears \
                (PostgreSQL, Keycloak; ADR-0064): each with its passport from the catalogue, \
                the image or ready chart imported into the project's path, and where people \
                reach it. At most 20.",
            input_schema: project_only,
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-environments/v1/infra-services"),
        },
        Tool {
            name: "infra_services_set",
            description: "Set the project's infra services: the WHOLE list replaces the current \
                one (read it with `infra_services` first and send it back changed). Each \
                passport is checked (ports, secrets, `provides` templates); two services may \
                not provide the same capability. An image must be in the organization's \
                registry: bring an external one in with `image_import` first. Ask your person \
                first.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "items": { "type": "array", "maxItems": 20, "items": { "type": "object",
                            "description": "{passport, image?, chart_ref?, chart_version?, chart_values?, public_url?}, as `infra_services` answers them." } }
                    }),
                    &["project_id", "items"],
                )
            },
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Put {
                path: "/studio-environments/v1/infra-services",
                query: &["project_id"],
            },
        },
        Tool {
            name: "infra_plan",
            description: "What a deploy to one environment does with the project's infra \
                services, checked before the deploy: how each comes (`database`, `chart`, \
                `generated` or `shared`), from which image or chart, the variables it gives \
                the product, `refusal_code` a deploy would be refused with now \
                (INFRA_PUBLIC_URL_MISSING, INFRA_ISSUER_NOT_HTTPS, ...) and `warnings` it goes \
                on with (INFRA_ISSUER_UNREACHABLE_IN_CLUSTER: pods cannot reach the issuer). \
                `configuration` lists the environment's configuration secrets that set a \
                gear's config field the product description also sets: \
                CONFIG_SECRET_SHADOWED_BY_DESCRIPTION (the description wins; the secret is \
                not given to the release) or CONFIG_SECRET_CONFLICTS_WITH_DESCRIPTION (an \
                install is refused until one goes). Call it before `deploy_request`.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "environment_id": environment_id("The environment.")
                    }),
                    &["project_id", "environment_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-environments/v1/environments/{environment_id}/infra-plan"),
        },
        Tool {
            name: "infra_keycloak_realm",
            description: "The Keycloak realm the project's Keycloak infra service imports at \
                start, made from its passport and the latest product description: a public \
                client for the portal, a confidential one for the backend, and a \
                service-account client for every gear whose config has \
                `client_credentials.client_id` (mini-chat), its secret the `${VAR}` that gear \
                reads (filled at deploy from the environment's configuration secret VAR, made \
                once when none is set). Every confidential client carries a hardcoded \
                `tenant_id` claim of the root tenant. Nothing is written: put `content` at \
                `path` in the service's `files` and add `args` to its `args` with \
                `infra_services_set`. `notes` says what it could not wire.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "name": { "type": "string", "description": "The infra service: `keycloak`." },
                        "portal_url": { "type": "string", "description": "The product's portal address, for redirects." }
                    }),
                    &["project_id", "name"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-environments/v1/infra-services/{name}/keycloak-realm"),
        },
        Tool {
            name: "infra_service_public_url_set",
            description: "Set where people reach one of the project's infra services \
                (`public_url`, e.g. a Keycloak issuer's `https://id.acme.example`), or remove \
                it with null; the rest of the list is kept as it is. A generated chart routes \
                that address with an Ingress, and a `{public_url}` in what the service \
                provides needs one (`INFRA_PUBLIC_URL_MISSING` in `infra_plan` otherwise). \
                Answers the service as saved. Ask your person first.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "service": { "type": "string",
                            "description": "The service's name, as its passport gives it (`keycloak`)." },
                        "public_url": { "type": ["string", "null"],
                            "description": "An `https://` or `http://` address; null removes it." }
                    }),
                    &["project_id", "service", "public_url"],
                )
            },
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Custom(infra_public_url_set),
        },
        Tool {
            name: "image_import",
            description: "Copy an external image or chart (`docker.io/library/postgres:16`, \
                with a tag or a digest) by digest into the project's own path of an \
                environment's registry, under `mirror/<name>`: a deploy takes only images in \
                the organization's registry. Answers at once with `image_id` and `run_id`; \
                follow it with `image_get` (its `state`) or `task_run`.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "environment_id": environment_id("The environment whose registry gets it."),
                        "source": { "type": "string" },
                        "name": { "type": "string", "description": "The name under mirror/; default the source's last segment." },
                        "kind": { "type": "string", "enum": ["image", "chart"] }
                    }),
                    &["project_id", "environment_id", "source"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Post {
                path: "/studio-environments/v1/images/imports",
                query: &["project_id"],
            },
        },
        Tool {
            name: "image_get",
            description: "One image or chart the project has in a registry: where it is, by \
                digest, where it came from (a build or an import), its `state`, and whether it \
                is pinned. Follows an `image_import`.",
            input_schema: || {
                object(
                    json!({ "project_id": project_id(), "image_id": { "type": "string" } }),
                    &["project_id", "image_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-environments/v1/images/{image_id}"),
        },
        Tool {
            name: "project_images",
            description: "The images and charts the project put in registries, newest first, \
                filtered by environment, application, kind, state or the build that made them; \
                paged by offset and limit.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "environment_id": { "type": "string" },
                        "app": { "type": "string" },
                        "kind": { "type": "string", "enum": ["image", "chart"] },
                        "state": { "type": "string" },
                        "build_id": { "type": "string" },
                        "offset": { "type": "integer", "minimum": 0 },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                    }),
                    &["project_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-environments/v1/images"),
        },
        Tool {
            name: "build_plan",
            description: "What a build with these arguments would do, without starting it: the \
                sources with their refs and connections, the description revision, the \
                registry paths, the namespaces, the builder image and Gearbox version -- and \
                `refusal`, the code and reason `build_start` would be refused with now. Call \
                it before `build_start` and fix what `refusal` names.",
            input_schema: build_input,
            effect: Effect::Read,
            experimental: false,
            run: Run::Post {
                path: "/studio-environments/v1/builds/plan",
                query: &["project_id"],
            },
        },
        Tool {
            name: "build_start",
            description: "Build the product in an environment's cluster: Studio clones the \
                sources, generates the profile with Gearbox, builds the images and pushes them \
                and the chart to the environment's registry. Answers at once with `build_id`; \
                follow it with `build_get` (status, failure) and `build_log` (steps). A passed \
                build is what `deploy_request` deploys. Refused with the same reason \
                `build_plan` gives.",
            input_schema: build_input,
            effect: Effect::Write,
            experimental: true,
            run: Run::Post {
                path: "/studio-environments/v1/builds",
                query: &["project_id"],
            },
        },
        Tool {
            name: "build_get",
            description: "One of the project's builds by `build_id`, whoever ran it: `status` \
                (running, passed, failed, cancelled), `failure` and `failure_step`, product, \
                profile, commit, `lock_hash`, the images and chart it published, where Studio \
                ran it and with what, and `built_infra`, the infra services its lock resolved, \
                which a deploy of it runs. Kept after the build's pod is gone, unlike \
                `build_log`. To wait for it to end, `build_wait`.",
            input_schema: || {
                object(
                    json!({ "project_id": project_id(), "build_id": { "type": "string" } }),
                    &["project_id", "build_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-environments/v1/builds/{build_id}"),
        },
        Tool {
            name: "build_wait",
            description: "Wait until a build ends (passed, failed or cancelled), up to \
                `timeout_seconds` (25, the most one call may wait), and answer `done` with \
                the build's record as `build_get` gives it. Not ended by then: `done: false` \
                and the record as it is; call again until `done`. A build takes minutes. A \
                build just started may not be recorded for a few seconds; the wait covers \
                that. Use it instead of polling from a shell.",
            input_schema: || wait_input("build_id"),
            effect: Effect::Read,
            experimental: false,
            run: Run::Custom(build_wait),
        },
        Tool {
            name: "build_log",
            description: "A build Studio runs, step by step (prepare, build, publish): whether \
                each waits, runs, passed or failed, and the last lines it wrote, read from its \
                pod now. 404 once the pod is gone, a day after the build ended; `build_get` \
                still has its status and failure.",
            input_schema: || {
                object(
                    json!({ "project_id": project_id(), "build_id": { "type": "string" } }),
                    &["project_id", "build_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-environments/v1/builds/{build_id}/log"),
        },
        Tool {
            name: "deploy_request",
            description: "Ask to deploy to an environment: a passed build (`build`), an \
                earlier deployment again (`redeploy_of`: a rollback or a promotion), or an \
                uninstall (`action: uninstall` with `product` and `profile`). With `preview`, \
                into a namespace of its own that expires. Answers the deployment record: \
                `queued`, or `awaiting_approval` for a protected environment, which an \
                organization administrator decides (`deployment_decide`), and `warnings` it \
                goes on with (CONFIG_SECRET_SHADOWED_BY_DESCRIPTION, \
                INFRA_ISSUER_UNREACHABLE_IN_CLUSTER). Refused with \
                CONFIG_SECRET_CONFLICTS_WITH_DESCRIPTION, INFRA_ISSUER_NOT_HTTPS and the other \
                codes `infra_plan` shows first. Follow it with `deployment_get`. Ask your \
                person first.",
            input_schema: || {
                object(
                    json!({
                        "project_id": project_id(),
                        "environment_id": environment_id("The environment to deploy to."),
                        "build": { "type": "string", "description": "A passed build's id." },
                        "redeploy_of": { "type": "string", "description": "An earlier deployment's id." },
                        "action": { "type": "string", "enum": ["install", "uninstall"] },
                        "product": { "type": "string", "description": "The release; needed for an uninstall." },
                        "profile": { "type": "string", "description": "The kubernetes profile; needed for an uninstall." },
                        "preview": { "type": "object", "properties": {
                            "name": { "type": "string" },
                            "ttl_hours": { "type": "integer", "minimum": 1 } } }
                    }),
                    &["project_id", "environment_id"],
                )
            },
            effect: Effect::Write,
            experimental: true,
            run: Run::Custom(deploy_request),
        },
        Tool {
            name: "deployments",
            description: "Deployments, newest first, each with its `state` (awaiting_approval, \
                declined, queued, running, succeeded, failed, cancelled), `outcome`, the build \
                and images it installs, and who asked and decided. Filter by project or \
                environment; an organization's when neither is given.",
            input_schema: || {
                object(
                    json!({
                        "project_id": { "type": "string" },
                        "environment_id": { "type": "string" },
                        "organization_id": { "type": "string" }
                    }),
                    &[],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-environments/v1/deployments"),
        },
        Tool {
            name: "deployment_get",
            description: "One deployment of the project as Studio records it: its `state` \
                (with where its run has got to), `outcome` (why it failed), the build and \
                images it installs, the run that installs it, and the decision on it. What \
                the cluster reports now is `deployment_status`; to wait for it to settle, \
                `deployment_wait`.",
            input_schema: || {
                object(
                    json!({ "project_id": project_id(), "deployment_id": { "type": "string" } }),
                    &["project_id", "deployment_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-environments/v1/deployments/{deployment_id}"),
        },
        Tool {
            name: "deployment_wait",
            description: "Wait until a deployment settles, up to `timeout_seconds` (25, the \
                most one call may wait), and answer `done` with its record as \
                `deployment_get` gives it: settled is succeeded, failed, cancelled or \
                declined, and also `awaiting_approval`, which nothing changes until an \
                organization administrator decides (`deployment_decide`). Not settled by \
                then: `done: false` and the record as it is; call again until `done`. Use it \
                instead of polling from a shell.",
            input_schema: || wait_input("deployment_id"),
            effect: Effect::Read,
            experimental: false,
            run: Run::Custom(deployment_wait),
        },
        Tool {
            name: "deployment_decide",
            description: "Approve or decline a deploy `awaiting_approval` to a protected \
                environment. Organization administrators only: anyone else is refused 403. \
                Approving queues it; declining needs a `reason`. Who decided, when and why is \
                kept. Ask your person first.",
            input_schema: || {
                object(
                    json!({
                        "deployment_id": { "type": "string" },
                        "action": { "type": "string", "enum": ["approve", "decline"] },
                        "reason": { "type": "string" },
                        "organization_id": { "type": "string" }
                    }),
                    &["deployment_id", "action"],
                )
            },
            effect: Effect::Destructive,
            experimental: true,
            run: Run::Post {
                path: "/studio-environments/v1/deployments/{deployment_id}/decisions",
                query: &["organization_id"],
            },
        },
        Tool {
            name: "deployment_status",
            description: "A deployed release as its cluster reports it now: the record, each \
                workload's ready of desired replicas and images, the hosts its ingresses answer \
                on, and the containers that cannot start with why.",
            input_schema: || {
                object(
                    json!({ "deployment_id": { "type": "string" }, "organization_id": { "type": "string" } }),
                    &["deployment_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-environments/v1/deployments/{deployment_id}/status"),
        },
        Tool {
            name: "deployment_logs",
            description: "The end of each container's log of a deployed release, read from its \
                cluster now (200 lines unless `lines` says, at most 2000); for a container that \
                restarted, also the run before.",
            input_schema: || {
                object(
                    json!({
                        "deployment_id": { "type": "string" },
                        "organization_id": { "type": "string" },
                        "lines": { "type": "integer", "minimum": 1, "maximum": 2000 }
                    }),
                    &["deployment_id"],
                )
            },
            effect: Effect::Read,
            experimental: false,
            run: Run::Get("/studio-environments/v1/deployments/{deployment_id}/logs"),
        },
    ]
}

fn config_secrets(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let project = required_text(&args, "project_id")?;
        let targets = api
            .get(
                &format!("{ENVIRONMENTS}/targets"),
                &[("project_id".to_owned(), project)],
            )
            .await?;
        Ok(secrets_of(
            &targets,
            optional_text(&args, "environment_id").as_deref(),
        ))
    })
}

/// The secret keys the targets name, of one environment when it is given.
fn secrets_of(targets: &Value, environment: Option<&str>) -> Value {
    let items: Vec<Value> = targets["secrets"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|s| environment.is_none_or(|e| s["environment_id"].as_str() == Some(e)))
        .cloned()
        .collect();
    json!({ "total": items.len(), "items": items })
}

fn deploy_request(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let (query, body) = deploy_body(args)?;
        api.post(&format!("{ENVIRONMENTS}/deployments"), &query, &body)
            .await
    })
}

/// The deploy as the portal asks for it: `profile` and `product` empty
/// unless given, which the server fills from the build or the binding.
fn deploy_body(mut args: Map<String, Value>) -> Result<(Vec<(String, String)>, Value), ToolError> {
    let project = required_text(&args, "project_id")?;
    required_text(&args, "environment_id")?;
    args.remove("project_id");
    for key in ["profile", "product"] {
        if !args.get(key).is_some_and(Value::is_string) {
            args.insert(key.to_owned(), json!(""));
        }
    }
    Ok((
        vec![("project_id".to_owned(), project)],
        Value::Object(args),
    ))
}

/// What `build_wait` and `deployment_wait` take: the project, the id and
/// how long to wait.
fn wait_input(id: &str) -> Value {
    let mut properties = json!({
        "project_id": project_id(),
        "timeout_seconds": { "type": "integer", "minimum": 0, "maximum": MAX_WAIT_SECS,
            "description": "How long to wait, in seconds. Default and most 25." }
    });
    properties[id] = json!({ "type": "string" });
    object(properties, &["project_id", id])
}

/// The wait asked for, within the bounds.
fn wait_of(args: &Map<String, Value>) -> Duration {
    Duration::from_secs(
        args.get("timeout_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_WAIT_SECS)
            .min(MAX_WAIT_SECS),
    )
}

/// A build's record says it ended.
fn build_ended(build: &Value) -> bool {
    matches!(
        build["status"].as_str(),
        Some("passed" | "failed" | "cancelled")
    )
}

/// A deployment's record says it settled: it ended, or it waits on a
/// person's decision, which no wait changes.
fn deployment_settled(deployment: &Value) -> bool {
    matches!(
        deployment["state"].as_str(),
        Some("succeeded" | "failed" | "cancelled" | "declined" | "awaiting_approval")
    )
}

/// A wait's answer: whether it is done, how long it took, the record.
fn waited(done: bool, started: Instant, key: &str, record: Value) -> Value {
    let mut out = json!({ "done": done, "waited_seconds": started.elapsed().as_secs() });
    out[key] = record;
    out
}

/// What a wait reads, and how.
struct Wait {
    path: String,
    query: Vec<(String, String)>,
    wait: Duration,
    poll: Duration,
    /// The answer's key for the record: `build`, `deployment`.
    key: &'static str,
    settled: fn(&Value) -> bool,
}

impl Wait {
    /// `template`'s `{id_name}` filled with the argument of that name, for
    /// the project the arguments name.
    fn of(
        args: &Map<String, Value>,
        template: &str,
        id_name: &str,
        poll: Duration,
        key: &'static str,
        settled: fn(&Value) -> bool,
    ) -> Result<Self, ToolError> {
        let project = required_text(args, "project_id")?;
        let id = required_text(args, id_name)?;
        let (path, _) = fill_path(template, Map::from_iter([(id_name.to_owned(), json!(id))]))?;
        Ok(Self {
            path,
            query: vec![("project_id".to_owned(), project)],
            wait: wait_of(args),
            poll,
            key,
            settled,
        })
    }

    /// Read the record until it settles or the wait is up. A 404 is a
    /// record not written yet (a build just started): read again, and
    /// answer the refusal only if it is still not there at the end.
    async fn run(self, api: &Api) -> Result<Value, ToolError> {
        let started = Instant::now();
        let deadline = started + self.wait;
        loop {
            let answer = api.get_answer(&self.path, &self.query).await?;
            let record = match answer.status {
                404 => None,
                _ if answer.ok() => Some(answer.body.clone()),
                _ => return Err(answer.refusal()),
            };
            let now = Instant::now();
            match record {
                Some(r) if (self.settled)(&r) => return Ok(waited(true, started, self.key, r)),
                Some(r) if now >= deadline => return Ok(waited(false, started, self.key, r)),
                None if now >= deadline => return Err(answer.refusal()),
                _ => pause(self.poll.min(deadline.saturating_duration_since(now))).await,
            }
        }
    }
}

fn build_wait(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        Wait::of(
            &args,
            "/studio-environments/v1/builds/{build_id}",
            "build_id",
            BUILD_POLL,
            "build",
            build_ended,
        )?
        .run(&api)
        .await
    })
}

fn deployment_wait(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        Wait::of(
            &args,
            "/studio-environments/v1/deployments/{deployment_id}",
            "deployment_id",
            DEPLOY_POLL,
            "deployment",
            deployment_settled,
        )?
        .run(&api)
        .await
    })
}

/// `items` (the project's infra services, as listed) with `service`'s
/// `public_url` set to `url`, null removing it; the service as changed.
fn with_public_url(items: &mut Value, service: &str, url: Value) -> Result<Value, ToolError> {
    let list = items
        .as_array_mut()
        .ok_or_else(|| ToolError::new("Studio answered no list of infra services"))?;
    let names: Vec<String> = list
        .iter()
        .filter_map(|i| i["passport"]["name"].as_str().map(str::to_owned))
        .collect();
    let item = list
        .iter_mut()
        .find(|i| i["passport"]["name"].as_str() == Some(service))
        .ok_or_else(|| {
            ToolError::new(format!(
                "the project has no infra service {service}; it has: {}",
                if names.is_empty() {
                    "none".to_owned()
                } else {
                    names.join(", ")
                }
            ))
        })?;
    item["public_url"] = url;
    Ok(item.clone())
}

fn infra_public_url_set(api: Api, args: Map<String, Value>) -> ToolFuture {
    Box::pin(async move {
        let project = required_text(&args, "project_id")?;
        let service = required_text(&args, "service")?;
        let url = match args.get("public_url") {
            Some(Value::String(u)) if !u.trim().is_empty() => json!(u.trim()),
            Some(Value::Null) => Value::Null,
            _ => {
                return Err(ToolError::new(
                    "`public_url` is an address, or null to remove it",
                ));
            }
        };
        let path = format!("{ENVIRONMENTS}/infra-services");
        let query = [("project_id".to_owned(), project)];
        let mut items = api.get(&path, &query).await?["items"].take();
        with_public_url(&mut items, &service, url)?;
        let saved = api.put(&path, &query, &json!({ "items": items })).await?;
        saved["items"]
            .as_array()
            .and_then(|l| {
                l.iter()
                    .find(|i| i["passport"]["name"].as_str() == Some(service.as_str()))
            })
            .cloned()
            .ok_or_else(|| ToolError::new(format!("Studio saved no infra service {service}")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::sdk::{Method, request_of};

    fn q(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn a_secret_goes_in_the_body_and_the_key_in_the_path() {
        let r = request_of(
            &tools(),
            "config_secret_set",
            json!({"project_id": "p", "environment_id": "e", "key": "SMTP_PASSWORD", "value": "s3cret"}),
        );
        assert_eq!(r.method, Method::Put);
        assert_eq!(
            r.path,
            "/studio-environments/v1/config-secrets/SMTP_PASSWORD"
        );
        assert_eq!(r.query, q(&[("environment_id", "e"), ("project_id", "p")]));
        assert_eq!(r.body, json!({"value": "s3cret"}));
        let r = request_of(
            &tools(),
            "config_secret_delete",
            json!({"project_id": "p", "environment_id": "e", "key": "K"}),
        );
        assert_eq!(r.method, Method::Delete);
        assert_eq!(r.query, q(&[("environment_id", "e"), ("project_id", "p")]));
    }

    #[test]
    fn builds_infra_and_decisions_reach_their_routes() {
        let all = tools();
        let build = json!({"project_id": "p", "environment_id": "e", "ref": "main"});
        let r = request_of(&all, "build_start", build.clone());
        assert_eq!(
            (r.method, r.path.as_str()),
            (Method::Post, "/studio-environments/v1/builds")
        );
        assert_eq!(r.query, q(&[("project_id", "p")]));
        assert_eq!(r.body, json!({"environment_id": "e", "ref": "main"}));
        let r = request_of(&all, "build_plan", build);
        assert_eq!(r.path, "/studio-environments/v1/builds/plan");
        let r = request_of(
            &all,
            "infra_plan",
            json!({"project_id": "p", "environment_id": "e"}),
        );
        assert_eq!(r.path, "/studio-environments/v1/environments/e/infra-plan");
        assert_eq!(r.query, q(&[("project_id", "p")]));
        let r = request_of(
            &all,
            "infra_keycloak_realm",
            json!({"project_id": "p", "name": "keycloak", "portal_url": "https://shop.example"}),
        );
        assert_eq!(
            (r.method, r.path.as_str()),
            (
                Method::Get,
                "/studio-environments/v1/infra-services/keycloak/keycloak-realm"
            )
        );
        assert_eq!(
            r.query,
            q(&[("portal_url", "https://shop.example"), ("project_id", "p")])
        );
        let r = request_of(
            &all,
            "infra_services_set",
            json!({"project_id": "p", "items": []}),
        );
        assert_eq!(
            (r.method, r.body.clone()),
            (Method::Put, json!({"items": []}))
        );
        let r = request_of(
            &all,
            "deployment_decide",
            json!({"deployment_id": "d", "action": "decline", "reason": "no", "organization_id": "o"}),
        );
        assert_eq!(r.path, "/studio-environments/v1/deployments/d/decisions");
        assert_eq!(r.query, q(&[("organization_id", "o")]));
        assert_eq!(r.body, json!({"action": "decline", "reason": "no"}));
        let r = request_of(
            &all,
            "image_import",
            json!({"project_id": "p", "environment_id": "e", "source": "docker.io/library/postgres:16"}),
        );
        assert_eq!(r.path, "/studio-environments/v1/images/imports");
        assert_eq!(
            r.body,
            json!({"environment_id": "e", "source": "docker.io/library/postgres:16"})
        );
    }

    #[test]
    fn a_deploy_of_a_build_is_sent_as_the_portal_sends_it() {
        let args = json!({"project_id": "p", "environment_id": "e", "build": "b-1"});
        let (query, body) = deploy_body(args.as_object().cloned().unwrap()).unwrap();
        assert_eq!(query, q(&[("project_id", "p")]));
        assert_eq!(
            body,
            json!({"environment_id": "e", "build": "b-1", "profile": "", "product": ""})
        );
        let none = json!({"project_id": "p"});
        assert!(deploy_body(none.as_object().cloned().unwrap()).is_err());
    }

    #[test]
    fn secret_keys_are_filtered_by_environment() {
        let targets = json!({"secrets": [
            {"environment_id": "a", "key": "X"}, {"environment_id": "b", "key": "Y"}
        ]});
        assert_eq!(
            secrets_of(&targets, Some("b"))["items"],
            json!([{"environment_id": "b", "key": "Y"}])
        );
        assert_eq!(secrets_of(&targets, None)["total"], 2);
        assert_eq!(secrets_of(&json!({}), None)["total"], 0);
    }

    #[test]
    fn one_build_and_one_deployment_are_read_by_their_own_routes() {
        let all = tools();
        let r = request_of(
            &all,
            "build_get",
            json!({"project_id": "p", "build_id": "studio-1"}),
        );
        assert_eq!(
            (r.method, r.path.as_str()),
            (Method::Get, "/studio-environments/v1/builds/studio-1")
        );
        assert_eq!(r.query, q(&[("project_id", "p")]));
        let r = request_of(
            &all,
            "deployment_get",
            json!({"project_id": "p", "deployment_id": "d"}),
        );
        assert_eq!(r.path, "/studio-environments/v1/deployments/d");
        assert_eq!(r.query, q(&[("project_id", "p")]));
        let r = request_of(
            &all,
            "config_secret_keys",
            json!({"project_id": "p", "environment_id": "e"}),
        );
        assert_eq!(
            (r.method, r.path.as_str()),
            (Method::Get, "/studio-environments/v1/config-secrets")
        );
        assert_eq!(r.query, q(&[("environment_id", "e"), ("project_id", "p")]));
        assert_eq!(r.body, Value::Null);
    }

    #[test]
    fn a_wait_ends_on_an_end_and_on_a_decision_to_make() {
        for s in ["passed", "failed", "cancelled"] {
            assert!(build_ended(&json!({ "status": s })), "{s}");
        }
        assert!(!build_ended(&json!({"status": "running"})));
        assert!(!build_ended(&json!({})));
        for s in [
            "succeeded",
            "failed",
            "cancelled",
            "declined",
            "awaiting_approval",
        ] {
            assert!(deployment_settled(&json!({ "state": s })), "{s}");
        }
        for s in ["queued", "running"] {
            assert!(!deployment_settled(&json!({ "state": s })), "{s}");
        }
        let args = |v: Value| v.as_object().cloned().unwrap();
        assert_eq!(wait_of(&args(json!({}))), Duration::from_secs(25));
        assert_eq!(
            wait_of(&args(json!({"timeout_seconds": 9999}))),
            Duration::from_secs(25)
        );
        let w = Wait::of(
            &args(json!({"project_id": "p", "build_id": "a/b", "timeout_seconds": 0})),
            "/studio-environments/v1/builds/{build_id}",
            "build_id",
            BUILD_POLL,
            "build",
            build_ended,
        )
        .unwrap();
        assert_eq!(w.path, "/studio-environments/v1/builds/a%2Fb");
        assert_eq!(w.query, q(&[("project_id", "p")]));
        assert_eq!(w.wait, Duration::ZERO);
        assert!(
            Wait::of(
                &args(json!({"project_id": "p"})),
                "/x/{build_id}",
                "build_id",
                BUILD_POLL,
                "build",
                build_ended,
            )
            .is_err()
        );
        let answer = waited(true, Instant::now(), "build", json!({"status": "passed"}));
        assert_eq!(answer["done"], true);
        assert_eq!(answer["build"]["status"], "passed");
    }

    #[test]
    fn a_public_url_is_set_on_its_service_and_the_rest_kept() {
        let mut items = json!([
            {"passport": {"name": "postgres"}, "image": "x"},
            {"passport": {"name": "keycloak"}, "public_url": null}
        ]);
        let changed = with_public_url(&mut items, "keycloak", json!("https://id.acme")).unwrap();
        assert_eq!(changed["public_url"], "https://id.acme");
        assert_eq!(items[1]["public_url"], "https://id.acme");
        assert_eq!(
            items[0],
            json!({"passport": {"name": "postgres"}, "image": "x"})
        );
        with_public_url(&mut items, "keycloak", Value::Null).unwrap();
        assert!(items[1]["public_url"].is_null());
        let err = with_public_url(&mut items, "redis", Value::Null).unwrap_err();
        assert!(err.0.contains("postgres, keycloak"), "{}", err.0);
    }
}
