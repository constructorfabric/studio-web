//! Constructor Studio Backend — the Studio backend server assembled from CF/Gears.
//!
//! Modeled after `gears-rust/apps/cf-gears-example-server`. All gear logic
//! lives in the linked gear crates (see `registered_gears.rs`); this binary
//! only loads layered config and hands control to `toolkit::bootstrap`.

mod access_config; // the Studio access-config document: one shape, one reader, one writer
mod artifact_ingest; // pull issues/PRs from a connector source into the graph as GTS nodes
mod components_catalog; // connector to crates.io: catalogue our published gears + versions in the graph
mod connectors; // source connectors: driver plugins + tenant connection catalogue
mod credstore_pg; // persistent credstore value store (issue #66)
mod database_bootstrap; // config-discovered PostgreSQL provisioning + migrations
mod documents; // document management: types + templates + section-checklist validation
mod domain_model; // store the Studio domain model as GTS types in the graph; create/extend objects
mod gts_audit; // `gts-audit`: diff the live registries against that inventory (ADR-0013)
mod gts_inventory; // every GTS document the assembly registers, built offline for the drift test
mod identity_directory; // platform-admin view of assigned and unassigned Keycloak identities
mod insight; // integration seam to Constructor Insight (external decision-intelligence service)
mod kit_registry; // Git-backed kit catalogue + project-scoped desired installations
// keycloak-idp-plugin is the official cf-gears-keycloak-idp-plugin (linked in
// registered_gears.rs). The former in-crate implementation was removed once the
// official plugin went green — see docs/keycloak-idp-migration.md.
#[cfg(feature = "llm")]
mod llm_proxy; // OpenAI-compatible LLM proxy for Theia AI in IDE sessions (llm feature)
mod notify; // studio-notify: durable delivery queue for notifications (toolkit-db outbox)
mod organizations; // studio-organizations: a person creates an organization and owns it (ADR-0018)
mod pagination; // one ?offset=&limit= contract + total for every list endpoint
mod registered_gears;
mod scheduler; // studio-scheduler: cron/interval schedules that enqueue into studio-tasks
mod secrets_bootstrap; // self-heal for config-seeded credstore secrets at boot
mod spec_quality; // studio-spec-quality: authenticated wrapper over the external spec-quality detector service
mod studio_authz_plugin; // Studio PDP: the AuthZ resolver plugin (ADR-0006)
mod studio_session; // Studio's own gear: per-workspace Theia IDE containers
#[cfg(feature = "theia-bridge")]
mod studio_theia; // ADR-0010: backend-to-backend bridge to the Theia node backend (opt-in)
mod tasks; // studio-tasks: durable background runs (queue + history + cancel)
#[cfg(test)]
mod test_env; // one lock for the process environment, shared by every test that sets a variable
#[cfg(test)]
mod test_pg; // one PostgreSQL for the whole test process, shared by the suites that keep tables
mod user_profile; // studio-user: canonical user + profile + sign-in methods (identity mapper)

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use mimalloc::MiMalloc;
use toolkit::bootstrap::{
    AppConfig, dump_effective_gears_config_yaml, list_gear_names, run_migrate, run_server,
};

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

/// Constructor Studio backend server (CF/Gears assembly).
#[derive(Parser)]
#[command(name = "studio-backend")]
#[command(about = "Constructor Studio backend — CF/Gears assembly (account-management demo)")]
#[command(version = env!("CARGO_PKG_VERSION"))]
struct Cli {
    /// Path to configuration file (default: config/dev.yaml conventions apply)
    #[arg(short, long)]
    config: Option<PathBuf>,

    /// Print effective configuration (YAML) and exit
    #[arg(long)]
    print_config: bool,

    /// List all configured gear names and exit
    #[arg(long)]
    list_gears: bool,

    /// Dump effective per-gear configuration (YAML) and exit
    #[arg(long)]
    dump_gears_config: bool,

    /// Log verbosity level (-v debug, -vv trace)
    #[arg(short, long, action = clap::ArgAction::Count)]
    verbose: u8,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the server (default)
    Run,
    /// Run database migrations and exit
    Migrate,
    /// Discover configured PostgreSQL gear databases, create only missing ones, then migrate
    Bootstrap {
        /// Perform changes. Without this flag, print the database plan only.
        #[arg(long)]
        apply: bool,
    },
    /// Print every GTS document this assembly registers (JSON) and exit.
    ///
    /// Built from the code alone — no config, no database, no registry, no
    /// listener. Regenerates `docs/gts-types.json`, which `cargo test`
    /// drift-checks (see `gts_inventory`).
    GtsTypes,
    /// Audit a running deployment: diff both live registries against the
    /// inventory this binary would register, and exit non-zero on any
    /// disagreement (ADR-0013 §6.3).
    GtsAudit {
        /// Deployment base URL **including the route prefix**, e.g.
        /// `http://127.0.0.1:8090/cf` for `config/dev.yaml`.
        #[arg(long)]
        base_url: String,
        /// Bearer token — both list endpoints are authenticated (dev.yaml:
        /// `studio-admin-token`).
        #[arg(long)]
        token: Option<String>,
        /// Tenant for the graph-storage read (`X-Tenant-ID`). Graph types are
        /// registered per tenant, so this is part of the question.
        #[arg(long)]
        tenant: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    // Emitted from the code alone, so it runs before the config is loaded: an
    // offline emit has to work in a checkout with no deployment profile, and
    // its output must not depend on which profile was passed.
    if matches!(cli.command, Some(Commands::GtsTypes)) {
        print!("{}", gts_inventory::to_pretty_json()?);
        return Ok(());
    }

    // Same reason: the audit talks HTTP to a deployment that is already
    // running, so it needs this binary's inventory and a URL, never a profile.
    if let Some(Commands::GtsAudit {
        base_url,
        token,
        tenant,
    }) = &cli.command
    {
        return gts_audit::run(&gts_audit::Target {
            base_url: base_url.clone(),
            token: token.clone(),
            tenant: tenant.clone(),
        })
        .await;
    }

    // rustls 0.23 carries both crypto providers in this tree (aws-lc-rs from
    // credstore/TLS, ring from file-storage/pingora). rustls refuses to pick
    // a process default when more than one is compiled in, and the kube client
    // (studio-session's Kubernetes driver) builds its TLS config off that
    // default — so without this the first API call panics. Pin aws-lc-rs, the
    // provider the rest of the stack already uses; a no-op if one is set.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    // Layered config: defaults -> YAML (env-expanded, #65) -> env (APP__*)
    // -> CLI overrides.
    let mut config = load_config(cli.config.as_ref())?;
    config.apply_cli_overrides(cli.verbose);

    if cli.print_config {
        println!("Effective configuration:\n{}", config.to_yaml()?);
        return Ok(());
    }

    if cli.list_gears {
        let gears = list_gear_names(&config);
        println!("Configured gears ({}):", gears.len());
        for gear in gears {
            println!("  - {gear}");
        }
        return Ok(());
    }

    if cli.dump_gears_config {
        println!("{}", dump_effective_gears_config_yaml(&config)?);
        return Ok(());
    }

    match cli.command.unwrap_or(Commands::Run) {
        Commands::Run => run_server(config).await,
        Commands::Migrate => run_migrate(config).await,
        Commands::Bootstrap { apply } => database_bootstrap::run(config, apply).await,
        // Both handled above, before the config was loaded.
        Commands::GtsTypes | Commands::GtsAudit { .. } => Ok(()),
    }
}

/// Load the config file with `${VAR}` / `${VAR:-default}` pre-expansion (#65).
///
/// The toolkit loader reads the YAML verbatim; only database DSNs were ever
/// expanded (toolkit-db wires `var_expand` into the DB layer, not into the
/// loader). Every other placeholder — the OIDC trusted issuer, the
/// file-storage signing seed, the keycloak-idp and mini-chat secrets —
/// travelled into the runtime as a literal `${...}` string, which is exactly
/// what a Kubernetes deployment feeds through Secret-backed env vars.
///
/// Expansion is strict on purpose: a `${VAR}` with no `:-default` whose
/// variable is unset fails the boot NAMING the variable, instead of limping
/// along with a literal that surfaces later as "invalid issuer" three layers
/// deep. Set-but-empty is a value like any other. Comments count too — a
/// `${VAR}`-shaped example in a comment is expanded (or rejected) like
/// everything else, so config comments must spell placeholders differently.
fn load_config(config_path: Option<&PathBuf>) -> Result<AppConfig> {
    let Some(path) = config_path else {
        return AppConfig::load_or_default(None);
    };
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("config file is not readable: {}", path.display()))?;
    let expanded = toolkit_utils::var_expand::expand_env_vars(&raw).map_err(|e| {
        anyhow::anyhow!(
            "{}: {e}; every ${{VAR}} in the config must be set in the environment \
             (write ${{VAR:-default}} for an optional one)",
            path.display()
        )
    })?;
    if expanded == raw {
        // Nothing to expand — hand the loader the original file.
        return AppConfig::load_or_default(Some(path));
    }
    // The loader only accepts a path, so the expanded text takes a detour
    // through a private temp file. It now contains secrets: created 0600
    // (unix), never overwriting an existing file, and removed as soon as the
    // loader has read it.
    let tmp = std::env::temp_dir().join(format!(
        "studio-backend-config-{}-{:x}.yaml",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    ));
    write_private(&tmp, &expanded)?;
    let loaded = AppConfig::load_or_default(Some(&tmp));
    let _ = std::fs::remove_file(&tmp);
    loaded
}

/// Create `path` exclusively (no follow-through to an existing file) and as
/// private as the platform allows, then write `contents` into it.
fn write_private(path: &Path, contents: &str) -> Result<()> {
    use std::io::Write;

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(path)
        .with_context(|| format!("create expanded config {}", path.display()))?;
    file.write_all(contents.as_bytes())
        .with_context(|| format!("write expanded config {}", path.display()))
}

#[cfg(test)]
mod config_expansion_tests {
    //! What matters: every shipped profile expands cleanly given the
    //! variables its deployment provides, no placeholder survives expansion
    //! (a `${VAR}`-shaped comment would), and a missing required variable
    //! fails naming itself. The tests share the process environment, so they
    //! serialize on a lock instead of racing over `set_var`/`remove_var`.

    use std::sync::{Mutex, MutexGuard};

    use toolkit_utils::var_expand::expand_env_vars;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn lock() -> MutexGuard<'static, ()> {
        // A test that panicked while holding the lock has already failed;
        // the environment it leaves behind is still fine for the others.
        ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    const PROFILES: [(&str, &str); 5] = [
        ("dev.yaml", include_str!("../config/dev.yaml")),
        ("docker.yaml", include_str!("../config/docker.yaml")),
        ("oidc.yaml", include_str!("../config/oidc.yaml")),
        ("postgres.yaml", include_str!("../config/postgres.yaml")),
        ("k8s.yaml", include_str!("../config/k8s.yaml")),
    ];

    /// The union of no-default placeholders across the profiles — what the
    /// Helm chart (k8s) and docker-compose (docker/oidc/postgres) provide.
    const REQUIRED: [&str; 11] = [
        "STUDIO_PG_HOST",
        "STUDIO_PG_USER",
        "STUDIO_PG_PASSWORD",
        "STUDIO_PG_DBNAME",
        "STUDIO_OIDC_ISSUER",
        "STUDIO_FS_SIGNING_SEED",
        "STUDIO_IDP_ADMIN_BASE_URL",
        "STUDIO_IDP_ADMIN_SECRET",
        "STUDIO_SESSION_ENABLED",
        "STUDIO_SESSION_IMAGE",
        "STUDIO_SESSION_GATEWAY_URL",
    ];

    #[test]
    fn every_profile_expands_with_its_deployment_variables_set() {
        let _guard = lock();
        for name in REQUIRED {
            // SAFETY: process-global env mutation, serialized by ENV_LOCK.
            unsafe { std::env::set_var(name, "test-value") };
        }
        for (name, text) in PROFILES {
            let expanded =
                expand_env_vars(text).unwrap_or_else(|e| panic!("{name} must expand: {e}"));
            assert!(
                !expanded.contains("${"),
                "{name}: a placeholder survived expansion — if it is a comment, \
                 spell it without the dollar-brace shape"
            );
        }
    }

    #[test]
    fn a_missing_required_variable_fails_naming_it() {
        let _guard = lock();
        // SAFETY: process-global env mutation, serialized by ENV_LOCK.
        unsafe { std::env::remove_var("STUDIO_OIDC_ISSUER") };
        for name in REQUIRED {
            if name != "STUDIO_OIDC_ISSUER" {
                // SAFETY: as above.
                unsafe { std::env::set_var(name, "test-value") };
            }
        }
        let (profile, text) = PROFILES[4];
        assert_eq!(profile, "k8s.yaml");
        let err = expand_env_vars(text).expect_err("k8s.yaml requires the OIDC issuer");
        assert!(
            err.to_string().contains("STUDIO_OIDC_ISSUER"),
            "the failure must name the missing variable, got: {err}"
        );
    }
}

#[cfg(test)]
mod operation_docs_tests {
    //! Every REST operation this assembly registers must arrive at `/cf/docs`
    //! describing itself.
    //!
    //! A `summary` is a label; a `description` is the sentence that says what
    //! comes back and what it means. Fifty-five operations shipped without one
    //! because nothing asked for it — the omission is invisible in review, and
    //! only shows up as an empty panel in the API browser months later.
    //!
    //! The scan is textual, like the profile scan in [`crate::gts_inventory`]:
    //! building the real OpenAPI document offline would mean constructing every
    //! gear's service first. It reads the `OperationBuilder` chains in the
    //! sources, which is the same place a reviewer would look.

    /// Every `rest.rs` in the crate, embedded so the test needs no cwd.
    ///
    /// A module missing from this list is simply not checked, so add the entry
    /// with the module: [`every_rest_module_is_listed`] catches the common way
    /// of forgetting, but it cannot see a module nobody mentioned anywhere.
    const REST_MODULES: [(&str, &str); 16] = [
        ("artifact_ingest", include_str!("artifact_ingest/rest.rs")),
        (
            "components_catalog",
            include_str!("components_catalog/rest.rs"),
        ),
        ("connectors", include_str!("connectors/rest.rs")),
        ("documents", include_str!("documents/rest.rs")),
        ("domain_model", include_str!("domain_model/rest.rs")),
        (
            "identity_directory",
            include_str!("identity_directory/rest.rs"),
        ),
        ("insight", include_str!("insight/rest.rs")),
        ("kit_registry", include_str!("kit_registry/rest.rs")),
        ("llm_proxy", include_str!("llm_proxy/rest.rs")),
        ("notify", include_str!("notify/rest.rs")),
        ("scheduler", include_str!("scheduler/rest.rs")),
        ("spec_quality", include_str!("spec_quality/rest.rs")),
        ("studio_session", include_str!("studio_session/rest.rs")),
        ("studio_theia", include_str!("studio_theia/rest.rs")),
        ("tasks", include_str!("tasks/rest.rs")),
        ("user_profile", include_str!("user_profile/rest.rs")),
    ];

    /// One `OperationBuilder::…().register(…)` chain, as text.
    struct Chain<'a> {
        operation_id: String,
        body: &'a str,
    }

    /// Split a source file into the operation chains it registers.
    ///
    /// A chain starts at `OperationBuilder::` and ends at the `.register(` that
    /// closes it — the same shape every one of these files is written in. A
    /// file that stops following it reads as zero chains, which
    /// [`every_rest_module_registers_something`] refuses.
    fn chains(source: &str) -> Vec<Chain<'_>> {
        let mut out = Vec::new();
        let mut rest = source;
        while let Some(start) = rest.find("OperationBuilder::") {
            let tail = &rest[start..];
            let Some(end) = tail.find(".register(") else {
                break;
            };
            let body = &tail[..end];
            out.push(Chain {
                operation_id: operation_id_of(body),
                body,
            });
            rest = &tail[end + ".register(".len()..];
        }
        out
    }

    /// The chain's `operation_id`, or the route when it is built at runtime
    /// (studio-theia formats one) — either way something a failure can name.
    fn operation_id_of(body: &str) -> String {
        let quoted = |after: &str| -> Option<String> {
            let at = body.find(after)? + after.len();
            let tail = &body[at..];
            let open = tail.find('"')? + 1;
            let close = tail[open..].find('"')?;
            Some(tail[open..open + close].to_string())
        };
        quoted(".operation_id(")
            .or_else(|| quoted("OperationBuilder::"))
            .unwrap_or_else(|| "<unnamed operation>".to_string())
    }

    #[test]
    fn every_operation_describes_itself() {
        let mut undocumented = Vec::new();
        for (module, source) in REST_MODULES {
            for chain in chains(source) {
                if !chain.body.contains(".description(") {
                    undocumented.push(format!("{module}: {}", chain.operation_id));
                }
            }
        }
        assert!(
            undocumented.is_empty(),
            "these operations reach /cf/docs with no description — add one \
             between .summary() and .tag(), saying what comes back and what it \
             means:\n  {}",
            undocumented.join("\n  ")
        );
    }

    /// A summary is not a description restated. Both exist because they answer
    /// different questions, and a `description` that only repeats the summary
    /// leaves the panel as empty as before.
    #[test]
    fn a_description_says_more_than_its_summary() {
        for (module, source) in REST_MODULES {
            for chain in chains(source) {
                let (Some(summary), Some(description)) = (
                    chain.body.find(".summary("),
                    chain.body.find(".description("),
                ) else {
                    continue;
                };
                let summary_text = &chain.body[summary..description];
                let description_text = &chain.body[description..];
                assert!(
                    description_text.len() > summary_text.len(),
                    "{module}: {} has a description no longer than its summary",
                    chain.operation_id
                );
            }
        }
    }

    #[test]
    fn every_rest_module_registers_something() {
        for (module, source) in REST_MODULES {
            assert!(
                !chains(source).is_empty(),
                "{module}/rest.rs parsed as zero operations — if these files no \
                 longer end a chain with `.register(`, teach `chains` the new \
                 shape, or this gate silently passes everything"
            );
        }
    }

    /// The list above is hand-written. `include_str!` already refuses a path
    /// that does not exist, so what is left to check is the other direction:
    /// that every name in it is still a module of this crate, and that none is
    /// listed twice.
    ///
    /// It cannot prove nothing is *missing* — a new gear whose `rest.rs` nobody
    /// added here goes unchecked, the same trade-off `PROFILES` makes in
    /// [`crate::gts_inventory`]. Adding the entry is part of adding the gear.
    #[test]
    fn every_listed_module_is_a_module_of_this_crate() {
        let source = include_str!("main.rs");
        let mut seen = std::collections::BTreeSet::new();
        for (module, _) in REST_MODULES {
            assert!(
                source
                    .lines()
                    .any(|l| l.trim_start().starts_with(&format!("mod {module};"))),
                "REST_MODULES names `{module}`, which main.rs does not declare"
            );
            assert!(seen.insert(module), "REST_MODULES lists `{module}` twice");
        }
    }
}
