//! Constructor Studio Backend — the Studio backend server assembled from CF/Gears.
//!
//! Modeled after `gears-rust/apps/cf-gears-example-server`. All gear logic
//! lives in the linked gear crates (see `registered_gears.rs`); this binary
//! only loads layered config and hands control to `toolkit::bootstrap`.

mod connectors; // source connectors: driver plugins + tenant connection catalogue
mod credstore_pg; // persistent credstore value store (issue #66)
mod keycloak_idp_plugin; // real user provisioning via Keycloak Admin API (ADR-0004)
#[cfg(feature = "llm")]
mod llm_proxy; // OpenAI-compatible LLM proxy for Theia AI in IDE sessions (llm feature)
mod project; // projects: two creation shapes, stages, lifecycle (ADR-0005)
mod registered_gears;
mod secrets_bootstrap; // self-heal for config-seeded credstore secrets at boot
mod studio_authz_plugin; // Studio PDP: the AuthZ resolver plugin (ADR-0006)
mod studio_session; // Studio's own gear: per-workspace Theia IDE containers

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
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

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
    const REQUIRED: [&str; 10] = [
        "STUDIO_PG_HOST",
        "STUDIO_PG_USER",
        "STUDIO_PG_PASSWORD",
        "STUDIO_PG_DBNAME",
        "STUDIO_OIDC_ISSUER",
        "STUDIO_FS_SIGNING_SEED",
        "STUDIO_ADMIN_TOKEN",
        // Interim static-authn test users (INFRA-3767): k8s.yaml feeds these
        // from the studio-web-test-users Secret, so they are no-default too.
        "STUDIO_TEST_USER_1_TOKEN",
        "STUDIO_TEST_USER_2_TOKEN",
        "STUDIO_TEST_USER_3_TOKEN",
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
