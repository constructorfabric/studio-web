//! The organization's gear repository over REST (ADR-0042 §2): who may
//! change it, what a refusal says, and "Create a gear" into it.

use std::sync::Mutex;

use axum::response::IntoResponse;

use super::*;
use crate::catalog_graph::MemorySink;
use crate::components_catalog::registry::gear_repository_scope_refusal;
use crate::product::port::{
    DeclarationFile, GearScaffolds, NewGear, RepositoryTarget, ScaffoldFailure, ScaffoldOutcome,
};

const ORG: Uuid = Uuid::from_u128(0x0a6);
const ADMIN: u128 = 7;
const MEMBER: u128 = 8;

/// A fake studio-user: grants the registry privilege to one subject.
struct Authority(Uuid);

#[async_trait::async_trait]
impl crate::user_profile::OrgAuthority for Authority {
    async fn may_administer(&self, ctx: &SecurityContext, _org: Uuid, privilege: &str) -> bool {
        privilege == REGISTRY_PRIVILEGE && ctx.subject_id() == self.0
    }
    async fn may_dispose(&self, _ctx: &SecurityContext, _org: Uuid) -> bool {
        false
    }
}

/// A fake studio-product: records where it was asked to write.
#[derive(Default)]
struct Scaffolds {
    asked: Mutex<Vec<(Uuid, RepositoryTarget, NewGear)>>,
}

#[async_trait::async_trait]
impl GearScaffolds for Scaffolds {
    async fn scaffold_into(
        &self,
        ctx: &SecurityContext,
        target: &RepositoryTarget,
        gear: &NewGear,
    ) -> Result<ScaffoldOutcome, ScaffoldFailure> {
        self.asked
            .lock()
            .unwrap()
            .push((ctx.subject_tenant_id(), target.clone(), gear.clone()));
        Ok(ScaffoldOutcome {
            branch: format!("scaffold/{}", gear.slug),
            commit_sha: if gear.dry_run {
                String::new()
            } else {
                "c0ffee".into()
            },
            pr_url: (!gear.dry_run && gear.open_pr).then(|| "https://example/pr/1".to_owned()),
            files: vec![DeclarationFile {
                path: format!("gears/{}/gear.toml", gear.slug),
                content: "[gear]".into(),
            }],
        })
    }
}

struct Rig {
    catalog: Catalog,
    scaffolds: Arc<Scaffolds>,
}

fn rig() -> Rig {
    let hub = Arc::new(ClientHub::new());
    hub.register_scoped::<dyn crate::user_profile::OrgAuthority>(
        ClientScope::gts_id(crate::user_profile::IDENTITY_INSTANCE_ID),
        Arc::new(Authority(Uuid::from_u128(ADMIN))),
    );
    let scaffolds = Arc::new(Scaffolds::default());
    hub.register::<dyn GearScaffolds>(scaffolds.clone());
    let service = Arc::new(CatalogService::new(
        Arc::new(MemorySink::default()),
        "k".to_string(),
        None,
    ));
    Rig {
        catalog: Catalog::new(service, hub, None),
        scaffolds,
    }
}

fn caller(id: u128) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(id))
        .subject_tenant_id(ORG)
        .build()
        .unwrap()
}

fn status(e: CanonicalError) -> StatusCode {
    e.into_response().status()
}

fn stored() -> GearRepository {
    GearRepository {
        tenant: ORG,
        connection_id: Uuid::from_u128(0xc0),
        repo: "acme/gears".into(),
        branch: "trunk".into(),
        connection_label: Some("Acme GitHub".into()),
        set_by: Some("u7".into()),
        set_at: Some("2026-10-09T10:00:00Z".into()),
    }
}

fn scaffold_body(dry_run: Option<bool>) -> RegistryScaffoldRequest {
    RegistryScaffoldRequest {
        slug: "billing".into(),
        problem: Some("Bill the customers.".into()),
        capabilities: Some(vec!["billing".into()]),
        gear_kind: None,
        plugin_host: None,
        plugin_spec: None,
        parent_dir: None,
        app_title: None,
        open_pr: None,
        dry_run,
    }
}

#[tokio::test]
async fn every_member_reads_the_setting_and_only_an_administrator_may_manage_it() {
    let r = rig();
    let Json(none) = get_gear_repository(OrgCtx(caller(MEMBER)), Extension(r.catalog.clone()))
        .await
        .unwrap();
    assert!(none.gear_repository.is_none());
    assert!(!none.may_manage, "a member may not");

    r.catalog
        .service
        .store_gear_repository(&caller(ADMIN), Some(stored()))
        .await
        .unwrap();
    let Json(set) = get_gear_repository(OrgCtx(caller(ADMIN)), Extension(r.catalog.clone()))
        .await
        .unwrap();
    let repo = set.gear_repository.expect("set");
    assert_eq!(repo.repo, "acme/gears");
    assert_eq!(repo.branch, "trunk");
    assert_eq!(repo.connection_label.as_deref(), Some("Acme GitHub"));
    assert!(set.may_manage, "the administrator may");

    // A member is refused every change, and nothing changes.
    let put = set_gear_repository(
        OrgCtx(caller(MEMBER)),
        Extension(r.catalog.clone()),
        Json(SetGearRepositoryRequest {
            connection_id: Uuid::from_u128(1),
            repo: "acme/other".into(),
            branch: None,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(status(put), StatusCode::FORBIDDEN);
    let del = delete_gear_repository(OrgCtx(caller(MEMBER)), Extension(r.catalog.clone()))
        .await
        .unwrap_err();
    assert_eq!(status(del), StatusCode::FORBIDDEN);
    let create = create_gear_repository(
        OrgCtx(caller(MEMBER)),
        Extension(r.catalog.clone()),
        Json(CreateGearRepositoryRequest {
            connection_id: Uuid::from_u128(1),
            name: "gears".into(),
            owner: None,
            is_org: None,
            private: None,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(status(create), StatusCode::FORBIDDEN);
    assert_eq!(
        r.catalog
            .service
            .gear_repository(&caller(MEMBER))
            .await
            .unwrap(),
        Some(stored())
    );

    // The administrator removes it; the setting reads back empty.
    let Json(removed) = delete_gear_repository(OrgCtx(caller(ADMIN)), Extension(r.catalog.clone()))
        .await
        .unwrap();
    assert!(removed.gear_repository.is_none());
    assert_eq!(
        r.catalog
            .service
            .gear_repository(&caller(ADMIN))
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn the_setting_round_trips_beside_the_other_registry_settings() {
    let r = rig();
    let svc = &r.catalog.service;
    let ctx = caller(ADMIN);
    svc.set_excluded_projects(&ctx, vec![Uuid::from_u128(3)])
        .await
        .unwrap();
    svc.store_gear_repository(&ctx, Some(stored()))
        .await
        .unwrap();
    assert_eq!(svc.gear_repository(&ctx).await.unwrap(), Some(stored()));
    assert_eq!(
        svc.excluded_projects(&ctx).await.unwrap(),
        vec![Uuid::from_u128(3)],
        "setting the gear repository keeps the excluded projects"
    );
    svc.set_excluded_projects(&ctx, Vec::new()).await.unwrap();
    assert_eq!(
        svc.gear_repository(&ctx).await.unwrap(),
        Some(stored()),
        "and the other way round"
    );
    svc.store_gear_repository(&ctx, None).await.unwrap();
    assert_eq!(svc.gear_repository(&ctx).await.unwrap(), None);
}

#[tokio::test]
async fn a_scaffold_into_the_organizations_repository_is_an_administrators_and_needs_one() {
    let r = rig();
    let refused = scaffold_organization_gear(
        OrgCtx(caller(MEMBER)),
        Extension(r.catalog.clone()),
        Json(scaffold_body(None)),
    )
    .await
    .unwrap_err();
    assert_eq!(status(refused), StatusCode::FORBIDDEN);

    let none = scaffold_organization_gear(
        OrgCtx(caller(ADMIN)),
        Extension(r.catalog.clone()),
        Json(scaffold_body(None)),
    )
    .await
    .unwrap_err();
    assert_eq!(
        status(none),
        StatusCode::BAD_REQUEST,
        "no gear repository is a failed precondition"
    );
    assert!(r.scaffolds.asked.lock().unwrap().is_empty());

    r.catalog
        .service
        .store_gear_repository(&caller(ADMIN), Some(stored()))
        .await
        .unwrap();
    let Json(done) = scaffold_organization_gear(
        OrgCtx(caller(ADMIN)),
        Extension(r.catalog.clone()),
        Json(scaffold_body(None)),
    )
    .await
    .unwrap();
    assert_eq!(done.repo, "acme/gears");
    assert_eq!(done.branch, "scaffold/billing");
    assert_eq!(done.pr_url.as_deref(), Some("https://example/pr/1"));
    assert!(!done.dry_run);
    assert_eq!(done.files[0].path, "gears/billing/gear.toml");
    let asked = r.scaffolds.asked.lock().unwrap();
    let (tenant, target, gear) = &asked[0];
    assert_eq!(*tenant, ORG, "written as the organization");
    assert_eq!(target.repo, "acme/gears");
    assert_eq!(target.base_branch, "trunk");
    assert_eq!(target.connection_id, Some(Uuid::from_u128(0xc0)));
    assert!(gear.open_pr, "a pull request by default");
    assert_eq!(gear.capabilities, ["billing"]);
    assert_eq!(gear.problem.as_deref(), Some("Bill the customers."));
}

#[tokio::test]
async fn a_dry_run_answers_the_files_and_says_so() {
    let r = rig();
    r.catalog
        .service
        .store_gear_repository(&caller(ADMIN), Some(stored()))
        .await
        .unwrap();
    let Json(done) = scaffold_organization_gear(
        OrgCtx(caller(ADMIN)),
        Extension(r.catalog.clone()),
        Json(scaffold_body(Some(true))),
    )
    .await
    .unwrap();
    assert!(done.dry_run);
    assert!(done.commit_sha.is_empty());
    assert!(done.pr_url.is_none());
}

#[test]
fn a_refused_gear_repository_names_the_field_and_why() {
    let shared = GearRepositoryError::NotShared {
        scope: "personal".into(),
        hint: gear_repository_scope_refusal("personal").unwrap(),
    };
    let text = shared.to_string();
    assert!(text.contains("personal-scoped"), "{text}");
    assert!(text.contains("background read cannot use"), "{text}");
    assert_eq!(
        status(gear_repository_problem(&shared)),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        status(gear_repository_problem(&GearRepositoryError::InvalidRepo(
            "x".into()
        ))),
        StatusCode::BAD_REQUEST
    );
}

/// A table of connections, a probe that answers as told, and a record of
/// what was read and created.
struct Access {
    connections: Vec<(Uuid, crate::components_catalog::registry::FoundConnection)>,
    unreadable: Option<String>,
    probed: Mutex<Vec<(String, String)>>,
    created: Mutex<Vec<String>>,
}

impl Access {
    fn with(connections: Vec<(u128, Uuid, &str)>) -> Self {
        Self {
            connections: connections
                .into_iter()
                .map(|(id, tenant, scope)| {
                    (
                        Uuid::from_u128(id),
                        crate::components_catalog::registry::FoundConnection {
                            tenant,
                            scope: scope.to_owned(),
                            label: format!("conn {id}"),
                            provider: "github".to_owned(),
                        },
                    )
                })
                .collect(),
            unreadable: None,
            probed: Mutex::new(Vec::new()),
            created: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait::async_trait]
impl crate::components_catalog::registry::GearRepositoryAccess for Access {
    async fn connection(
        &self,
        _ctx: &SecurityContext,
        _org: Uuid,
        id: Uuid,
    ) -> Option<crate::components_catalog::registry::FoundConnection> {
        self.connections
            .iter()
            .find(|(c, _)| *c == id)
            .map(|(_, f)| f.clone())
    }

    async fn probe(
        &self,
        _ctx: &SecurityContext,
        _connection: &crate::components_catalog::registry::FoundConnection,
        _connection_id: Uuid,
        repo: &str,
        branch: &str,
    ) -> anyhow::Result<()> {
        self.probed
            .lock()
            .unwrap()
            .push((repo.to_owned(), branch.to_owned()));
        match &self.unreadable {
            Some(e) => Err(anyhow::anyhow!("{e}")),
            None => Ok(()),
        }
    }

    async fn create(
        &self,
        _ctx: &SecurityContext,
        _connection: &crate::components_catalog::registry::FoundConnection,
        _connection_id: Uuid,
        owner: Option<&str>,
        _is_org: bool,
        name: &str,
        _private: bool,
    ) -> anyhow::Result<(String, String)> {
        let full = format!("{}/{name}", owner.unwrap_or("acme"));
        self.created.lock().unwrap().push(full.clone());
        Ok((full, "main".to_owned()))
    }
}

const ROOT: Uuid = crate::components_catalog::tiers::PLATFORM_TENANT;

fn input(connection: u128, repo: &str) -> GearRepositoryInput {
    GearRepositoryInput {
        connection_id: Uuid::from_u128(connection),
        repo: repo.into(),
        branch: Some("trunk".into()),
    }
}

/// The security finding: an organization administrator naming the
/// platform's root connection -- which the organization sees, because
/// connections are inherited downwards -- would have had Declare it, the
/// scaffold and create write with the platform's token.
#[tokio::test]
async fn the_platforms_connection_never_serves_an_organizations_gear_repository() {
    let r = rig();
    let svc = &r.catalog.service;
    let ctx = caller(ADMIN);
    let access = Access::with(vec![
        (0xc0, ORG, "organization"),
        (0xc1, ROOT, "organization"),
    ]);

    let refused = svc
        .set_gear_repository(&ctx, &input(0xc1, "acme/gears"), None, &access)
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(refused, GearRepositoryError::NotOwned { tenant: ROOT });
    assert!(
        refused.to_string().contains("not to the organization"),
        "{refused}"
    );
    let problem = format!("{:?}", gear_repository_problem(&refused));
    assert!(problem.contains("CONNECTION_NOT_OWNED"), "{problem}");
    assert!(access.probed.lock().unwrap().is_empty(), "not even read");
    assert_eq!(svc.gear_repository(&ctx).await.unwrap(), None);

    // Create checks it before anything is created.
    let refused = svc
        .create_gear_repository(
            &ctx,
            Uuid::from_u128(0xc1),
            None,
            false,
            "gears",
            true,
            None,
            &access,
        )
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(refused, GearRepositoryError::NotOwned { tenant: ROOT });
    assert!(access.created.lock().unwrap().is_empty());

    // The organization's own connection serves.
    let set = svc
        .set_gear_repository(&ctx, &input(0xc0, "acme/gears"), Some("u7".into()), &access)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(set.tenant, ORG);
    assert_eq!(
        access.probed.lock().unwrap().as_slice(),
        [("acme/gears".to_owned(), "trunk".to_owned())],
        "read at its branch before it was stored"
    );
    assert_eq!(svc.gear_repository(&ctx).await.unwrap(), Some(set));
    let created = svc
        .create_gear_repository(
            &ctx,
            Uuid::from_u128(0xc0),
            None,
            false,
            "more-gears",
            true,
            None,
            &access,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(created.repo, "acme/more-gears");
    assert_eq!(created.tenant, ORG);
}

/// A setting stored before the check, naming the root's connection, is not
/// read or written through: the scaffold finds no gear repository.
#[tokio::test]
async fn a_stored_setting_on_the_platforms_connection_is_ignored() {
    let r = rig();
    let ctx = caller(ADMIN);
    r.catalog
        .service
        .store_gear_repository(
            &ctx,
            Some(GearRepository {
                tenant: ROOT,
                ..stored()
            }),
        )
        .await
        .unwrap();
    assert_eq!(r.catalog.service.gear_repository(&ctx).await.unwrap(), None);
    let Json(state) = get_gear_repository(OrgCtx(caller(MEMBER)), Extension(r.catalog.clone()))
        .await
        .unwrap();
    assert!(state.gear_repository.is_none());
    let refused = scaffold_organization_gear(
        OrgCtx(ctx),
        Extension(r.catalog.clone()),
        Json(scaffold_body(None)),
    )
    .await
    .unwrap_err();
    assert_eq!(status(refused), StatusCode::BAD_REQUEST);
    assert!(
        r.scaffolds.asked.lock().unwrap().is_empty(),
        "nothing written"
    );
}

#[tokio::test]
async fn a_gear_repository_that_cannot_be_read_is_refused_with_the_providers_error() {
    let r = rig();
    let svc = &r.catalog.service;
    let ctx = caller(ADMIN);
    let mut access = Access::with(vec![(0xc0, ORG, "organization")]);
    access.unreadable = Some("GitHub 404 Not Found: No commit found for the ref trunk".into());
    let refused = svc
        .set_gear_repository(&ctx, &input(0xc0, "acme/gears"), None, &access)
        .await
        .unwrap()
        .unwrap_err();
    let GearRepositoryError::Unreadable {
        repo,
        branch,
        error,
    } = &refused
    else {
        panic!("{refused:?}");
    };
    assert_eq!((repo.as_str(), branch.as_str()), ("acme/gears", "trunk"));
    assert!(error.contains("No commit found"), "{error}");
    assert!(
        refused.to_string().contains("could not be read"),
        "{refused}"
    );
    let problem = gear_repository_problem(&refused);
    assert!(
        format!("{problem:?}").contains("GEAR_REPOSITORY_UNREADABLE"),
        "{problem:?}"
    );
    assert_eq!(status(problem), StatusCode::BAD_REQUEST);
    assert_eq!(svc.gear_repository(&ctx).await.unwrap(), None, "not stored");
}

/// The organization's scaffold has no App Spec: the gear is the
/// organization's, so its manifest names it.
#[tokio::test]
async fn a_scaffold_names_the_organization_when_the_request_names_no_app() {
    let r = rig();
    r.catalog
        .service
        .store_gear_repository(&caller(ADMIN), Some(stored()))
        .await
        .unwrap();
    let Json(_) = scaffold_organization_gear(
        OrgCtx(caller(ADMIN)),
        Extension(r.catalog.clone()),
        Json(scaffold_body(Some(true))),
    )
    .await
    .unwrap();
    let mut named = scaffold_body(Some(true));
    named.app_title = Some("Billing suite".into());
    let Json(_) = scaffold_organization_gear(
        OrgCtx(caller(ADMIN)),
        Extension(r.catalog.clone()),
        Json(named),
    )
    .await
    .unwrap();
    let asked = r.scaffolds.asked.lock().unwrap();
    // No account management here: the organization's fallback name.
    assert_eq!(asked[0].2.app_title.as_deref(), Some("Organization"));
    assert_eq!(asked[1].2.app_title.as_deref(), Some("Billing suite"));
}
