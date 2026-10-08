//! studio-assembly — what this backend is made of, said by the backend itself.
//!
//! A diagram of the architecture drawn by hand is out of date the week after
//! it is drawn. This gear answers the same question from the running process:
//! the gears the toolkit registry linked and the order it initialises them in,
//! what each depends on, which are plugins and of what, the commit the binary
//! was built from and the IDE image it launches. The portal's
//! `/architecture/` page draws it.
//!
//! What it reads, and why none of it can drift:
//!
//! * **the gears** — `GearRegistry::discover_and_build()`, the same inventory
//!   walk and topological sort the runtime ran at start. It is run once more
//!   at `init`, which also logs "Gear dependency order resolved (topo)" a
//!   second time; every gear's constructor runs again and the instances are
//!   dropped. The runtime's own registry is not reachable from a gear.
//! * **a Studio gear's purpose** — the first paragraph of section 1.1 of
//!   `docs/design/<gear>.md`, compiled in by `build.rs`;
//! * **the build** — `STUDIO_BUILD_COMMIT`, compiled in by `build.rs` (CI sets
//!   it), and the cargo features;
//! * **the session image** — `studio-session`'s own config section, parsed
//!   with that gear's config type.
//!
//! Nothing secret is in the answer: no config value but the image reference,
//! no tenant data. It still needs a signed-in caller, like every other read.

mod manifest;
mod rest;

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx, GearRegistry};

use crate::studio_session::sdk::StudioSessionConfig;

use manifest::Described;

/// Everything the endpoint answers, fixed at start.
#[derive(Debug)]
pub struct Snapshot {
    pub commit: Option<String>,
    pub features: Vec<String>,
    pub sessions_enabled: bool,
    pub session_image: Option<String>,
    pub gears: Vec<Described>,
}

#[toolkit::gear(name = "studio-assembly", capabilities = [rest])]
#[derive(Default)]
pub struct AssemblyGear {
    snapshot: OnceLock<Arc<Snapshot>>,
}

#[async_trait]
impl Gear for AssemblyGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let registry = GearRegistry::discover_and_build()
            .map_err(|e| anyhow::anyhow!("studio-assembly: the gear registry: {e}"))?;
        let linked: Vec<manifest::Linked> = registry
            .gears()
            .iter()
            .map(|entry| manifest::Linked {
                name: entry.name().to_owned(),
                deps: entry.deps().iter().map(|d| (*d).to_owned()).collect(),
                capabilities: entry
                    .caps()
                    .labels()
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
            })
            .collect();

        // The session gear's own parse of its own section: the image it will
        // actually start, with the same defaults it applies.
        let session: StudioSessionConfig =
            toolkit::gear_config_or_default(ctx.config_provider(), "studio-session")?;

        let snapshot = Snapshot {
            commit: manifest::build_commit(),
            features: manifest::features(),
            sessions_enabled: session.enabled,
            session_image: session.enabled.then(|| session.image.clone()),
            gears: manifest::describe(&linked),
        };
        tracing::info!(
            gears = snapshot.gears.len(),
            commit = snapshot.commit.as_deref().unwrap_or("local build"),
            "studio-assembly: manifest ready"
        );
        self.snapshot
            .set(Arc::new(snapshot))
            .map_err(|_| anyhow::anyhow!("studio-assembly already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl RestApiCapability for AssemblyGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let snapshot = self
            .snapshot
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-assembly not initialized"))?
            .clone();
        Ok(rest::register_routes(router, openapi, snapshot))
    }
}
