//! Whose connection an organization reads through: the tree as a table.

use std::collections::HashMap;

use uuid::Uuid;

use super::*;
use crate::components_catalog::roadmap::{RoadmapFields, RoadmapSource};
use crate::components_catalog::tiers::PLATFORM_TENANT;

const ROOT: Uuid = PLATFORM_TENANT;
const ORG: Uuid = Uuid::from_u128(0x0a6);
const WS: Uuid = Uuid::from_u128(0x0b1);
const P1: Uuid = Uuid::from_u128(0x101);
const OTHER_ORG: Uuid = Uuid::from_u128(0x0a7);
const OTHER_WS: Uuid = Uuid::from_u128(0x0b2);

/// Each tenant's parent; one not listed cannot be read.
struct Table(HashMap<Uuid, Option<Uuid>>);

#[async_trait::async_trait]
impl Tree for Table {
    async fn parent_of(&self, tenant: Uuid) -> Option<Option<Uuid>> {
        self.0.get(&tenant).copied()
    }
}

/// root -> {ORG -> WS -> P1, OTHER_ORG -> OTHER_WS}.
fn tree() -> Table {
    Table(HashMap::from([
        (ROOT, None),
        (ORG, Some(ROOT)),
        (WS, Some(ORG)),
        (P1, Some(WS)),
        (OTHER_ORG, Some(ROOT)),
        (OTHER_WS, Some(OTHER_ORG)),
    ]))
}

fn repo(tenant: Uuid, name: &str) -> ProjectRepo {
    ProjectRepo {
        tenant,
        holder: tenant,
        connection_id: Some(Uuid::from_u128(0xc0)),
        repo: name.to_owned(),
        branch: "main".to_owned(),
        owned: false,
    }
}

fn source(tenant: Uuid, connection: Option<u128>, name: &str) -> RepoSource {
    RepoSource {
        tenant,
        connection_id: connection.map(Uuid::from_u128),
        repo: name.to_owned(),
        git_ref: String::new(),
        mode: "gears".to_owned(),
    }
}

fn board(tenant: Uuid, connection: Option<u128>, number: u32) -> RoadmapSource {
    RoadmapSource {
        tenant,
        connection_id: connection.map(Uuid::from_u128),
        owner: "acme".to_owned(),
        number,
        consumers: Default::default(),
        fields: RoadmapFields::default(),
        roots: Vec::new(),
    }
}

/// Connections by id, with the tenant holding each; `None` reads the
/// default one, held where the second field says.
struct Held<'a>(&'a HashMap<Uuid, Uuid>, Option<Uuid>);

#[async_trait::async_trait]
impl Holders for Held<'_> {
    async fn holder_of(&self, _tenant: Uuid, connection_id: Option<Uuid>) -> Option<Uuid> {
        match connection_id {
            Some(id) => self.0.get(&id).copied(),
            None => self.1,
        }
    }
}

/// The rule is the connectors' (`connectors::ownership`, tested there); the
/// catalogue reaches it through the sdk, the same answer.
#[tokio::test]
async fn the_catalogue_asks_the_connectors_rule() {
    let tree = tree();
    let p: &dyn Tree = &tree;
    assert!(within(ORG, P1, p).await);
    assert!(!within(ORG, ROOT, p).await);
    assert!(within(ROOT, ROOT, p).await);
    assert_eq!(
        ROOT,
        crate::connectors::sdk::ownership::PLATFORM_ROOT_TENANT
    );
}

/// A project without a catalogue of its own lists the root's connections as
/// if they were its own: the read starts from the project, but the
/// connection's holder is the root, and that is what is asked.
#[tokio::test]
async fn a_connection_inherited_into_the_project_is_still_the_roots() {
    let tree = tree();
    let mut inherited = repo(P1, "acme/inherited");
    inherited.holder = ROOT;
    let (owned, refused) = split_owned(ORG, vec![inherited], &tree).await;
    assert!(owned.is_empty());
    assert_eq!(refused.len(), 1);
    assert!(
        refused[0]
            .error
            .as_deref()
            .unwrap()
            .contains("the platform's root")
    );
}

/// The walk reads an organization's project only through a connection the
/// organization owns. One the project found by walking up to the platform's
/// root is not read, and the project's status says why and what to do.
#[tokio::test]
async fn a_project_read_through_the_platforms_connection_is_refused_and_reported() {
    let tree = tree();
    let (owned, refused) = split_owned(
        ORG,
        vec![
            repo(ROOT, "acme/private-app"),
            repo(P1, "acme/app"),
            repo(WS, "acme/lib"),
            repo(OTHER_ORG, "other/app"),
        ],
        &tree,
    )
    .await;
    let read: Vec<&str> = owned.iter().map(|r| r.repo.as_str()).collect();
    assert_eq!(read, ["acme/app", "acme/lib"]);
    assert_eq!(refused.len(), 2);
    let root = &refused[0];
    assert_eq!(root.repo, "acme/private-app");
    assert_eq!(root.status, "failed");
    assert_eq!(root.components, 0);
    assert!(
        root.error
            .as_deref()
            .unwrap()
            .contains("the platform's root"),
        "{root:?}"
    );
    assert_eq!(root.hint.as_deref(), Some(NOT_OWNED_HINT));
    assert!(NOT_OWNED_HINT.contains("organization-scope connection of your own"));
    assert!(
        refused[1]
            .error
            .as_deref()
            .unwrap()
            .contains(&OTHER_ORG.to_string()),
        "{:?}",
        refused[1]
    );
    // The project's status carries them as the page reads it.
    let status = crate::components_catalog::registry::ProjectWalk {
        project_id: P1,
        repos: refused,
        ..Default::default()
    };
    let json = serde_json::to_value(&status).unwrap();
    assert_eq!(json["repos"][0]["status"], "failed");
    assert_eq!(json["repos"][0]["hint"], NOT_OWNED_HINT);
}

/// An organization's sync reads no source whose connection is not its own:
/// one naming the root, one naming the organization but resolving to a
/// connection the root holds, one taking a default the root holds, and a
/// board likewise. What it owns is read.
#[tokio::test]
async fn an_organizations_sync_reads_only_through_its_own_connections() {
    let tree = tree();
    let held = HashMap::from([
        (Uuid::from_u128(0xc0), ORG),
        (Uuid::from_u128(0xc1), ROOT),
        (Uuid::from_u128(0xc2), WS),
    ]);
    let mut sources = SyncSources {
        repos: vec![
            source(ORG, Some(0xc0), "acme/gears"),
            source(ROOT, Some(0xc1), "root/named"),
            source(ORG, Some(0xc1), "root/inherited"),
            source(WS, Some(0xc2), "acme/ws-gears"),
            source(ORG, None, "root/default"),
        ],
        roadmaps: vec![board(ORG, Some(0xc0), 1), board(ORG, Some(0xc1), 2)],
        ..SyncSources::default()
    };
    let refused = retain_owned_sources(ORG, &mut sources, &Held(&held, Some(ROOT)), &tree).await;
    assert_eq!(
        refused,
        ["root/named", "root/inherited", "root/default", "acme/2"]
    );
    let kept: Vec<&str> = sources.repos.iter().map(|s| s.repo.as_str()).collect();
    assert_eq!(kept, ["acme/gears", "acme/ws-gears"]);
    assert_eq!(sources.roadmaps.len(), 1);
    assert_eq!(sources.roadmaps[0].number, 1);

    // A default the organization holds is its own.
    let mut sources = SyncSources {
        repos: vec![source(ORG, None, "acme/default")],
        ..SyncSources::default()
    };
    let refused = retain_owned_sources(ORG, &mut sources, &Held(&held, Some(ORG)), &tree).await;
    assert!(refused.is_empty());
    assert_eq!(sources.repos.len(), 1);
}

/// The platform's own sync, in the root, reads with the root's connections
/// by design.
#[tokio::test]
async fn the_platforms_sync_still_reads_with_the_roots_connections() {
    let tree = tree();
    let held = HashMap::from([(Uuid::from_u128(0xc1), ROOT)]);
    let mut sources = SyncSources {
        repos: vec![
            source(ROOT, Some(0xc1), "platform/gears"),
            source(ROOT, None, "platform/default"),
        ],
        roadmaps: vec![board(ROOT, Some(0xc1), 7)],
        ..SyncSources::default()
    };
    let refused = retain_owned_sources(ROOT, &mut sources, &Held(&held, Some(ROOT)), &tree).await;
    assert!(refused.is_empty(), "{refused:?}");
    assert_eq!(sources.repos.len(), 2);
    assert_eq!(sources.roadmaps.len(), 1);
}

/// A source an organization stores or syncs names a tenant within it; the
/// nil id is the organization; the root or another organization is refused.
#[tokio::test]
async fn a_source_naming_a_tenant_outside_the_organization_is_refused() {
    let tree = tree();
    let p: &dyn Tree = &tree;
    assert_eq!(source_tenant(ORG, Uuid::nil(), p).await, Ok(ORG));
    assert_eq!(source_tenant(ORG, ORG, p).await, Ok(ORG));
    assert_eq!(source_tenant(ORG, WS, p).await, Ok(WS));
    assert_eq!(source_tenant(ORG, ROOT, p).await, Err(ROOT));
    assert_eq!(source_tenant(ORG, OTHER_ORG, p).await, Err(OTHER_ORG));
    let defaulted = owned_source(ORG, source(Uuid::nil(), None, "acme/gears"), p)
        .await
        .unwrap();
    assert_eq!(defaulted.tenant, ORG);
    assert_eq!(
        owned_source(ORG, source(ROOT, Some(0xc1), "root/gears"), p)
            .await
            .unwrap_err(),
        ROOT
    );
}
