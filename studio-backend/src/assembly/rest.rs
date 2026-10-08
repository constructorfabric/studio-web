//! `GET /studio-assembly/v1/manifest` — the one operation of this gear.

use std::sync::Arc;

use axum::{Extension, Router};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};

use super::Snapshot;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// What this backend was built from.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AssemblyBuildDto {
    /// The commit CI built the binary from (full SHA). Null for a local build,
    /// which has no commit worth naming: its tree may not be one.
    pub commit: Option<String>,
    /// The cargo features that decide what is linked (`llm`, `graph`,
    /// `theia-bridge`, `theia-event-broker`). A release image builds without
    /// `llm`, which is why it has no `studio-llm-proxy`.
    pub features: Vec<String>,
}

/// One gear linked into this process.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AssemblyGearDto {
    pub name: String,
    /// `studio`: written in this repository. `platform`: a gears-rust crate.
    pub origin: String,
    /// `system` (the platform's runtime), `plugin` (an implementation another
    /// gear selects) or `gear`.
    pub role: String,
    /// For a plugin, the gear whose extension point it fills — read off the
    /// plugin's name, so null when the name does not say (the IdP plugins of
    /// account-management).
    pub extends: Option<String>,
    /// The gears this one declares it needs; they start before it.
    pub depends_on: Vec<String>,
    /// For a Studio gear, the other Studio gears it uses, read from its code
    /// at build time. The toolkit's `depends_on` cannot name them: it lists
    /// crates, and every Studio gear lives in one crate.
    pub uses: Vec<AssemblyUseDto>,
    /// The toolkit registry's labels: `rest`, `db`, `stateful`, `system`,
    /// `rest_host`, `grpc`, `grpc_hub`.
    pub capabilities: Vec<String>,
    /// Position in the order the runtime starts gears, from 0. A gear always
    /// comes after everything in `depends_on`.
    pub order: u32,
    /// What the gear is for: the first paragraph of its design, for a Studio
    /// gear that has one. Plain text.
    pub purpose: Option<String>,
    /// Repository path of that design (`docs/design/<name>.md`), to be read at
    /// `build.commit`.
    pub design_doc: Option<String>,
}

/// One Studio gear another one uses.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AssemblyUseDto {
    pub gear: String,
    /// `port`: through the other gear's `port` or `sdk` module, as intended.
    /// `surface`: an item its `mod.rs` exports at the top. `internal`: one of
    /// its private modules, a boundary to fix. The worst of the ways used.
    pub via: String,
    /// The first segment of each name used there, e.g. `registry`, `TaskQueue`.
    pub items: Vec<String>,
}

/// The backend as it is running: its build and its gears.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AssemblyManifestDto {
    pub build: AssemblyBuildDto,
    /// Whether this backend starts IDE sessions at all.
    pub sessions_enabled: bool,
    /// The IDE image a session is started from, as configured. Null when
    /// sessions are off.
    pub session_image: Option<String>,
    /// Every linked gear, in start order.
    pub gears: Vec<AssemblyGearDto>,
}

fn manifest_of(snapshot: &Snapshot) -> AssemblyManifestDto {
    AssemblyManifestDto {
        build: AssemblyBuildDto {
            commit: snapshot.commit.clone(),
            features: snapshot.features.clone(),
        },
        sessions_enabled: snapshot.sessions_enabled,
        session_image: snapshot.session_image.clone(),
        gears: snapshot
            .gears
            .iter()
            .map(|g| AssemblyGearDto {
                name: g.name.clone(),
                origin: g.origin.as_str().to_owned(),
                role: g.role.as_str().to_owned(),
                extends: g.extends.clone(),
                depends_on: g.depends_on.clone(),
                uses: g
                    .uses
                    .iter()
                    .map(|u| AssemblyUseDto {
                        gear: u.gear.clone(),
                        via: u.via.to_owned(),
                        items: u.items.clone(),
                    })
                    .collect(),
                capabilities: g.capabilities.clone(),
                order: g.order,
                purpose: g.purpose.clone(),
                design_doc: g.design_doc.clone(),
            })
            .collect(),
    }
}

async fn get_manifest(
    Extension(snapshot): Extension<Arc<Snapshot>>,
) -> ApiResult<JsonBody<AssemblyManifestDto>> {
    Ok(Json(manifest_of(&snapshot)))
}

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    snapshot: Arc<Snapshot>,
) -> Router {
    OperationBuilder::get("/studio-assembly/v1/manifest")
        .operation_id("studio_assembly.get_manifest")
        .summary("What this backend is: the commit it was built from and every gear in it")
        .description(
            "Read from the running process, not from a document: the gears the \
             toolkit registry linked, in the order it starts them, with their \
             dependencies, whether each is Studio's or the platform's, which \
             are plugins and of what, and a Studio gear's purpose from its \
             design. Also the build commit (null for a local build), the cargo \
             features and the IDE session image. Fixed at start, so two calls \
             to one process always agree. Which REST paths a gear serves is in \
             /openapi.json, under the gear's name.",
        )
        .tag("StudioAssembly")
        .authenticated()
        .require_license_features::<License>([])
        .handler(get_manifest)
        .json_response_with_schema::<AssemblyManifestDto>(
            openapi,
            StatusCode::OK,
            "The build and the gears",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(snapshot))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly::manifest::{Linked, describe};

    #[test]
    fn the_answer_carries_every_gear_in_start_order() {
        let gears = describe(&[
            Linked {
                name: "types-registry".into(),
                deps: vec![],
                capabilities: vec!["system".into()],
            },
            Linked {
                name: "studio-presence".into(),
                deps: vec![],
                capabilities: vec!["rest".into()],
            },
        ]);
        let dto = manifest_of(&Snapshot {
            commit: Some("abc".into()),
            features: vec!["graph".into()],
            sessions_enabled: false,
            session_image: None,
            gears,
        });
        let json = serde_json::to_value(&dto).expect("serializes");
        assert_eq!(json["build"]["commit"], "abc");
        assert_eq!(json["gears"][0]["name"], "types-registry");
        assert_eq!(json["gears"][0]["role"], "system");
        assert_eq!(json["gears"][1]["origin"], "studio");
        assert_eq!(json["gears"][1]["order"], 1);
        assert!(
            json["gears"][1]["purpose"]
                .as_str()
                .is_some_and(|p| p.contains("Studio")),
            "studio-presence's purpose comes from its design: {}",
            json["gears"][1]["purpose"]
        );
        assert_eq!(
            json["gears"][1]["design_doc"],
            "docs/design/studio-presence.md"
        );
    }
}
