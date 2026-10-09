//! The two tiers (ADR-0042): the join, the shadowing rule, annotations over
//! platform facts, and who may run the platform's catalogue.

use std::sync::Arc;

use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::*;
use crate::catalog_graph::MemorySink;
use crate::components_catalog::gts;
use crate::components_catalog::service::CatalogService;

const ORG: Uuid = Uuid::from_u128(0x0c31);

fn ctx_in(tenant: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0xad))
        .subject_type("user")
        .subject_tenant_id(tenant)
        .build()
        .expect("security context")
}

fn view(type_id: &str, name: &str) -> CatalogNodeView {
    CatalogNodeView {
        type_id: type_id.to_owned(),
        instance_id: format!("{type_id}{name}"),
        value: json!({ "name": name }),
    }
}

// ── the pure rules ───────────────────────────────────────────────────────────

#[test]
fn the_platform_wins_a_name_it_has_and_the_organizations_copy_is_counted() {
    let joined = join_nodes(
        vec![view(gts::GEAR_TYPE, "cf-gears-ledger")],
        vec![
            view(gts::GEAR_TYPE, "CF-Gears-Ledger"),
            view(gts::GEAR_TYPE, "acme-billing"),
            CatalogNodeView {
                type_id: gts::GEAR_TYPE.to_owned(),
                instance_id: "nameless".to_owned(),
                value: json!({ "title": "no name" }),
            },
        ],
    );
    let listed: Vec<(&str, &str)> = joined
        .nodes
        .iter()
        .map(|n| {
            (
                n.value
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("(none)"),
                n.value["tier"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        listed,
        vec![
            ("cf-gears-ledger", PLATFORM),
            ("acme-billing", ORGANIZATION),
            ("(none)", ORGANIZATION),
        ]
    );
    assert_eq!(joined.shadowed, vec!["CF-Gears-Ledger".to_owned()]);
}

#[test]
fn an_organization_annotates_a_platform_component_and_never_copies_its_facts() {
    let platform = gts::gear_profile_node(
        "cf-gears-ledger",
        json!({
            "gear_name": "cf-gears-ledger",
            "auto": { "coverage": { "n": 80 } },
            "values": { "owner": { "v": "platform team" }, "maturity": { "v": "beta" } },
        }),
    );
    let own = gts::gear_profile_node(
        "cf-gears-ledger",
        json!({
            "gear_name": "cf-gears-ledger",
            // An older copy the organization synced itself: not its to keep.
            "auto": { "coverage": { "n": 10 } },
            "values": { "owner": { "v": "acme payments" } },
        }),
    );
    let mine_only = gts::gear_profile_node(
        "acme-billing",
        json!({ "gear_name": "acme-billing", "auto": { "coverage": { "n": 50 } } }),
    );
    let joined = join_profiles(vec![platform], vec![own, mine_only]);
    assert_eq!(joined.len(), 2);
    let ledger = &joined[0].value;
    assert_eq!(ledger["tier"], PLATFORM);
    assert_eq!(ledger["annotated"], true);
    assert_eq!(ledger["auto"]["coverage"]["n"], 80, "the platform's facts");
    assert_eq!(ledger["values"]["owner"]["v"], "acme payments", "ours over");
    assert_eq!(ledger["values"]["maturity"]["v"], "beta", "theirs kept");
    let billing = &joined[1].value;
    assert_eq!(billing["tier"], ORGANIZATION);
    assert_eq!(billing["auto"]["coverage"]["n"], 50);

    let stored = annotation_of(ledger.clone());
    assert!(stored.get("auto").is_none() && stored.get("uml").is_none());
    assert!(stored.get("tier").is_none() && stored.get("annotated").is_none());
    assert_eq!(stored["values"]["owner"]["v"], "acme payments");
}

#[test]
fn a_source_the_platform_reads_in_the_same_mode_is_shadowed() {
    let source = |repo: &str, mode: &str| RepoSource {
        tenant: ORG,
        connection_id: None,
        repo: repo.to_owned(),
        git_ref: String::new(),
        mode: mode.to_owned(),
    };
    let platform = vec![source("constructorfabric/gears-rust", "gears")];
    assert!(shadowed_by_platform(
        &source("ConstructorFabric/Gears-Rust", "gears"),
        &platform
    ));
    assert!(shadowed_by_platform(
        &source("constructorfabric/gears-rust", ""),
        &platform
    ));
    assert!(!shadowed_by_platform(
        &source("constructorfabric/gears-rust", "kits"),
        &platform
    ));
    assert!(!shadowed_by_platform(
        &source("acme/gears", "gears"),
        &platform
    ));
    assert!(!shadowed_by_platform(
        &source("constructorfabric/gears-rust", "gears"),
        &[]
    ));
}

// ── through the service, on a store that keeps tenants apart ─────────────────

fn service() -> CatalogService {
    CatalogService::new(
        Arc::new(MemorySink::tenant_scoped()),
        "constructorfabric".to_owned(),
        None,
    )
}

async fn seeded() -> CatalogService {
    let svc = service();
    let platform = ctx_in(PLATFORM_TENANT);
    let org = ctx_in(ORG);
    svc.sink
        .upsert(
            &platform,
            &[
                gts::gear_node("cf-gears-ledger", json!({ "name": "cf-gears-ledger" })),
                gts::gear_profile_node(
                    "cf-gears-ledger",
                    json!({ "gear_name": "cf-gears-ledger",
                            "auto": { "coverage": { "n": 80, "b": "80%" } } }),
                ),
            ],
            &[],
        )
        .await
        .unwrap();
    svc.sink
        .upsert(
            &org,
            &[
                // The organization synced gears-rust itself, before the tiers.
                gts::gear_node("cf-gears-ledger", json!({ "name": "cf-gears-ledger" })),
                gts::gear_node("acme-billing", json!({ "name": "acme-billing" })),
            ],
            &[],
        )
        .await
        .unwrap();
    svc
}

#[tokio::test]
async fn an_organizations_catalogue_is_the_platforms_and_its_own() {
    let svc = seeded().await;
    let tiered = svc
        .list_component_nodes_tiered(&ctx_in(ORG))
        .await
        .expect("list");
    let mut listed: Vec<(String, String)> = tiered
        .nodes
        .iter()
        .map(|n| {
            (
                n.value["name"].as_str().unwrap().to_owned(),
                n.value["tier"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    listed.sort();
    assert_eq!(
        listed,
        vec![
            ("acme-billing".to_owned(), ORGANIZATION.to_owned()),
            ("cf-gears-ledger".to_owned(), PLATFORM.to_owned()),
        ]
    );
    assert_eq!(tiered.shadowed, vec!["cf-gears-ledger".to_owned()]);

    // The platform reads its own tier only, and calls it that.
    let own = svc
        .list_component_nodes_tiered(&ctx_in(PLATFORM_TENANT))
        .await
        .expect("list");
    assert_eq!(own.nodes.len(), 1);
    assert_eq!(own.nodes[0].value["tier"], PLATFORM);
    assert!(own.shadowed.is_empty());
}

#[tokio::test]
async fn a_store_that_does_not_keep_tenants_apart_has_nothing_to_join() {
    let svc = CatalogService::new(Arc::new(MemorySink::default()), "k".to_owned(), None);
    let org = ctx_in(ORG);
    svc.sink
        .upsert(
            &org,
            &[gts::gear_node(
                "acme-billing",
                json!({ "name": "acme-billing" }),
            )],
            &[],
        )
        .await
        .unwrap();
    let tiered = svc.list_component_nodes_tiered(&org).await.expect("list");
    assert_eq!(tiered.nodes.len(), 1);
    assert_eq!(tiered.nodes[0].value["tier"], ORGANIZATION);
}

#[tokio::test]
async fn an_organizations_edit_of_a_platform_component_is_its_annotation_only() {
    let svc = seeded().await;
    let org = ctx_in(ORG);
    // What the profile editor sends: the merged profile it showed, edited.
    let saved = svc
        .save_profile(
            &org,
            "cf-gears-ledger",
            json!({ "gear_name": "cf-gears-ledger", "tier": "platform",
                    "auto": { "coverage": { "n": 1 } },
                    "values": { "coverage": { "n": 95, "b": "95%" } } }),
        )
        .await
        .expect("save");
    // Answered as the reader sees it: the platform's facts, ours over them.
    assert_eq!(saved.value["auto"]["coverage"]["n"], 80);
    assert_eq!(saved.value["values"]["coverage"]["n"], 95);

    // Stored in the organization's tenant: the annotation, no facts.
    let stored = svc.sink.list(&org, Some("gear_profile")).await.unwrap();
    assert_eq!(stored.len(), 1);
    assert!(
        stored[0].value.get("auto").is_none(),
        "{:?}",
        stored[0].value
    );
    assert!(stored[0].value.get("tier").is_none());
    // The platform's profile is untouched.
    let platform = svc
        .sink
        .list(&ctx_in(PLATFORM_TENANT), Some("gear_profile"))
        .await
        .unwrap();
    assert_eq!(platform[0].value["auto"]["coverage"]["n"], 80);
    assert!(platform[0].value.get("values").is_none());

    // The values the organization reads: its own over the platform's scan.
    let (resolved, _) = svc.resolved_components(&org).await.expect("values");
    let ledger = resolved
        .iter()
        .find(|c| c.name == "cf-gears-ledger")
        .expect("listed");
    assert_eq!(ledger.tier, PLATFORM);
    assert_eq!(ledger.values["coverage"]["n"], 95);
    // Another organization still reads the platform's facts alone.
    let (other, _) = svc
        .resolved_components(&ctx_in(Uuid::from_u128(0x0bad)))
        .await
        .expect("values");
    let theirs = other.iter().find(|c| c.name == "cf-gears-ledger").unwrap();
    assert_eq!(theirs.values["coverage"]["n"], 80);

    // A component that is the organization's own is stored whole.
    svc.save_profile(
        &org,
        "acme-billing",
        json!({ "auto": { "coverage": { "n": 3 } } }),
    )
    .await
    .expect("save");
    let stored = svc.sink.list(&org, Some("gear_profile")).await.unwrap();
    let billing = stored
        .iter()
        .find(|n| n.value["gear_name"] == "acme-billing")
        .unwrap();
    assert_eq!(billing.value["auto"]["coverage"]["n"], 3);
}

#[tokio::test]
async fn a_type_the_organization_never_marked_falls_back_to_the_platforms_mark() {
    let svc = service();
    let platform = ctx_in(PLATFORM_TENANT);
    let org = ctx_in(ORG);
    const WIDGET: &str = "gts.acme.demo.things.widget.v1~";
    svc.set_type_component(&platform, WIDGET, true)
        .await
        .expect("mark on the platform");
    let marked = |schemas: Vec<crate::components_catalog::field_schema::TypeFieldSchema>| {
        schemas
            .iter()
            .find(|s| s.describes == WIDGET)
            .is_some_and(|s| s.component)
    };
    assert!(marked(svc.list_field_schemas(&org).await.unwrap()));
    // The organization's own mark wins over the platform's.
    svc.set_type_component(&org, WIDGET, false)
        .await
        .expect("unmark in the organization");
    assert!(!marked(svc.list_field_schemas(&org).await.unwrap()));
    assert!(marked(svc.list_field_schemas(&platform).await.unwrap()));
}

#[tokio::test]
async fn the_platforms_sources_are_read_in_the_platforms_tenant_only() {
    let svc = service();
    let platform = ctx_in(PLATFORM_TENANT);
    svc.replace_sources(
        &platform,
        vec![RepoSource {
            tenant: PLATFORM_TENANT,
            connection_id: None,
            repo: "constructorfabric/gears-rust".to_owned(),
            git_ref: String::new(),
            mode: "gears".to_owned(),
        }],
    )
    .await
    .unwrap();
    svc.set_stored_keyword(&platform, Some(" constructorfabric ".to_owned()))
        .await
        .unwrap();
    let sources = svc.platform_sync_sources(&platform).await.expect("sources");
    assert_eq!(sources.repos.len(), 1);
    assert_eq!(sources.crates_io.as_deref(), Some("constructorfabric"));
    assert!(!sources.registry && !sources.platform);
    assert!(svc.platform_sync_sources(&ctx_in(ORG)).await.is_err());
    // An organization's sources are not the platform's.
    assert!(svc.list_sources(&ctx_in(ORG)).await.unwrap().is_empty());
}

// ── who may run the platform's catalogue ─────────────────────────────────────

struct Reader(bool);

#[async_trait::async_trait]
impl crate::user_profile::OrganizationReader for Reader {
    async fn organizations_of(&self, _subject: &str) -> anyhow::Result<Vec<Uuid>> {
        Ok(vec![ORG])
    }
    async fn grant_keys_of(&self, subject: &str) -> anyhow::Result<Vec<String>> {
        Ok(vec![subject.to_owned()])
    }
    async fn is_platform_admin(&self, _subject: &str) -> anyhow::Result<bool> {
        Ok(self.0)
    }
    async fn memberships_of_subject(
        &self,
        _subject: &str,
    ) -> anyhow::Result<Vec<crate::user_profile::SubjectMembership>> {
        Ok(Vec::new())
    }
    fn membership_generation(&self) -> u64 {
        0
    }
}

#[tokio::test]
async fn only_a_platform_administrator_runs_the_platforms_catalogue() {
    use crate::components_catalog::rest::may_run_platform;
    let caller = ctx_in(ORG);
    assert!(may_run_platform(Some(&Reader(true)), &caller).await);
    assert!(!may_run_platform(Some(&Reader(false)), &caller).await);
    // Without studio-user nobody can be shown to be one.
    assert!(!may_run_platform(None, &caller).await);
}

/// An organization's sync does not read what the platform already does:
/// the shadowed sources, and the default crates.io keyword while the
/// platform syncs crates.io. Its own sources and its own keyword stay.
#[test]
fn an_organizations_sync_leaves_to_the_platform_what_the_platform_reads() {
    use crate::components_catalog::service::SyncSources;
    let source = |repo: &str, mode: &str| RepoSource {
        tenant: ORG,
        connection_id: None,
        repo: repo.to_owned(),
        git_ref: String::new(),
        mode: mode.to_owned(),
    };
    let platform = vec![source("constructorfabric/gears-rust", "gears")];
    let sources = || SyncSources {
        crates_io: Some("constructorfabric".to_owned()),
        repos: vec![
            source("ConstructorFabric/gears-rust", ""),
            source("constructorfabric/gears-rust", "kits"),
            source("acme/gears", "gears"),
        ],
        registry: true,
        ..SyncSources::default()
    };

    let mut s = sources();
    let left = leave_to_platform(
        &mut s,
        &platform,
        Some("constructorfabric"),
        "constructorfabric",
    );
    assert_eq!(
        left,
        [
            "ConstructorFabric/gears-rust (gears)",
            "crates.io keyword `constructorfabric`"
        ]
    );
    let kept: Vec<&str> = s.repos.iter().map(|r| r.repo.as_str()).collect();
    assert_eq!(kept, ["constructorfabric/gears-rust", "acme/gears"]);
    assert_eq!(s.crates_io, None);
    assert!(s.registry, "the registry walk is the organization's own");

    // The default keyword stays while the platform syncs no crates.io.
    let mut s = sources();
    let left = leave_to_platform(&mut s, &platform, None, "constructorfabric");
    assert_eq!(left, ["ConstructorFabric/gears-rust (gears)"]);
    assert_eq!(s.crates_io.as_deref(), Some("constructorfabric"));

    // An organization's own keyword is synced, whatever the platform's.
    let mut s = SyncSources {
        crates_io: Some("acme-gears".to_owned()),
        ..sources()
    };
    leave_to_platform(
        &mut s,
        &platform,
        Some("constructorfabric"),
        "constructorfabric",
    );
    assert_eq!(s.crates_io.as_deref(), Some("acme-gears"));

    // The platform's keyword, named by the organization, is the platform's.
    let mut s = SyncSources {
        crates_io: Some("cf-platform".to_owned()),
        ..sources()
    };
    let left = leave_to_platform(&mut s, &[], Some("cf-platform"), "constructorfabric");
    assert_eq!(left, ["crates.io keyword `cf-platform`"]);
    assert_eq!(s.repos.len(), 3, "no platform sources, nothing shadowed");
}

/// The service reads the platform's sources and keyword from the root
/// tenant; nothing is left in the platform's own tenant.
#[tokio::test]
async fn the_service_leaves_to_the_platform_from_its_stored_sources() {
    use crate::components_catalog::service::SyncSources;
    let svc = CatalogService::new(
        Arc::new(MemorySink::tenant_scoped()),
        "constructorfabric".into(),
        None,
    );
    let pctx = ctx_in(PLATFORM_TENANT);
    svc.replace_sources(
        &pctx,
        vec![RepoSource {
            tenant: PLATFORM_TENANT,
            connection_id: None,
            repo: "constructorfabric/gears-rust".into(),
            git_ref: String::new(),
            mode: "gears".into(),
        }],
    )
    .await
    .unwrap();
    svc.set_stored_keyword(&pctx, Some("constructorfabric".into()))
        .await
        .unwrap();
    let mut s = SyncSources {
        crates_io: Some("constructorfabric".into()),
        repos: vec![RepoSource {
            tenant: ORG,
            connection_id: None,
            repo: "constructorfabric/gears-rust".into(),
            git_ref: String::new(),
            mode: "gears".into(),
        }],
        ..SyncSources::default()
    };
    let left = svc.leave_to_platform(&ctx_in(ORG), &mut s).await;
    assert_eq!(left.len(), 2, "{left:?}");
    assert!(s.repos.is_empty());
    assert!(!s.names_a_catalogue_source());
}
