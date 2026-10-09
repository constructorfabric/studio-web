//! A project's writes go only through a connection its organization owns
//! (`cpt-studio-constraint-connector-own-connections`): the rule answered
//! from a table, the product's write paths asked it.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::json;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::*;
use crate::catalog_graph::MemorySink;
use crate::connectors::sdk::ownership::{
    Holders, NotOwned, Ownership, PLATFORM_ROOT_TENANT, Tree, connection_is_owned,
};

const ROOT: Uuid = PLATFORM_ROOT_TENANT;
const ORG: Uuid = Uuid::from_u128(0x0a6);
const WS: Uuid = Uuid::from_u128(0x0b1);
const P1: Uuid = Uuid::from_u128(0x101);
const OTHER_ORG: Uuid = Uuid::from_u128(0x0a7);

/// Connections by the tenant holding each.
const C_ROOT: Uuid = Uuid::from_u128(0xc1);
const C_ORG: Uuid = Uuid::from_u128(0xc0);
const C_P1: Uuid = Uuid::from_u128(0xc3);
const C_OTHER: Uuid = Uuid::from_u128(0xc4);

/// root -> {ORG -> WS -> P1, OTHER_ORG}, the connections above, and each
/// tenant's organization.
struct Rule;

#[async_trait::async_trait]
impl Tree for Rule {
    async fn parent_of(&self, tenant: Uuid) -> Option<Option<Uuid>> {
        HashMap::from([
            (ROOT, None),
            (ORG, Some(ROOT)),
            (WS, Some(ORG)),
            (P1, Some(WS)),
            (OTHER_ORG, Some(ROOT)),
        ])
        .get(&tenant)
        .copied()
    }
}

fn held_by(connection: Uuid) -> Option<Uuid> {
    HashMap::from([
        (C_ROOT, ROOT),
        (C_ORG, ORG),
        (C_P1, P1),
        (C_OTHER, OTHER_ORG),
    ])
    .get(&connection)
    .copied()
}

#[async_trait::async_trait]
impl Holders for Rule {
    async fn holder_of(&self, _tenant: Uuid, connection_id: Option<Uuid>) -> Option<Uuid> {
        // The default connection is the root's: the case a project with no
        // connection of its own falls into.
        connection_id.map_or(Some(ROOT), held_by)
    }
}

#[async_trait::async_trait]
impl Ownership for Rule {
    async fn ensure_owned(
        &self,
        _ctx: &SecurityContext,
        scope: Uuid,
        tenant: Uuid,
        connection_id: Option<Uuid>,
        _provider: &str,
    ) -> Result<(), NotOwned> {
        let organization = if [P1, WS, ORG].contains(&scope) {
            ORG
        } else {
            scope
        };
        if connection_is_owned(organization, tenant, connection_id, self, self).await {
            Ok(())
        } else {
            Err(NotOwned {
                holder: self
                    .holder_of(tenant, connection_id)
                    .await
                    .unwrap_or(tenant),
                organization,
            })
        }
    }
}

fn service() -> ProductService {
    let service = ProductService::new(
        Arc::new(MemorySink::default()),
        // No connector service: a write the rule lets through fails after
        // it, "connectors service unavailable", and never reaches a host.
        Connectors::new(Arc::new(toolkit::client_hub::ClientHub::new())),
    );
    service.set_ownership(Arc::new(Rule));
    service
}

fn ctx(tenant: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(7))
        .subject_tenant_id(tenant)
        .build()
        .unwrap()
}

fn target(tenant: Uuid, connection: Uuid, repo: &str) -> RepositoryTarget {
    RepositoryTarget {
        tenant,
        connection_id: Some(connection),
        repo: repo.into(),
        base_branch: "main".into(),
    }
}

fn file() -> Vec<super::super::scaffold::ScaffoldFile> {
    vec![super::super::scaffold::ScaffoldFile {
        path: "gears/x/gear.toml".into(),
        content: String::new(),
    }]
}

/// The refusal, when the error is one.
fn refused(e: &anyhow::Error) -> Option<NotOwned> {
    e.downcast_ref::<NotOwned>().copied()
}

/// A project whose stored gear repository is reached through the
/// platform's connection -- recorded on the project, inherited from the
/// root -- has its scaffold and its product.gdl write refused, with whose
/// connection it was; the REST layer answers it 400 CONNECTION_NOT_OWNED.
#[tokio::test]
async fn a_scaffold_into_a_gear_repository_the_root_holds_is_refused() {
    let service = ProductService::new(
        Arc::new(MemorySink::default()),
        Connectors::new(Arc::new(toolkit::client_hub::ClientHub::new())),
    );
    let ctx = ctx(ORG);
    let project = P1.to_string();
    // Recorded before the rule existed: the record itself is not refused
    // here (the REST layer refuses it now), the writes through it are.
    service
        .set_project_repo(
            &ctx,
            &project,
            json!({
                "tenant": P1,
                "connection_id": C_ROOT,
                "repo": "acme/app-gears",
                "branch": "main",
            }),
        )
        .await
        .unwrap();
    service.set_ownership(Arc::new(Rule));

    let picked = service
        .scaffold_target(&ctx, &project, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(picked.origin, TargetOrigin::Project);
    let e = service
        .scaffold_into_target(&ctx, P1, &picked.target, "x", &file(), false)
        .await
        .unwrap_err();
    let refusal = refused(&e).expect("refused for its connection");
    assert_eq!(refusal.holder, ROOT);
    assert_eq!(refusal.organization, ORG);
    assert!(e.to_string().contains("the platform's root"), "{e}");

    let e = service
        .write_to_project_repo(&ctx, &project, None, &file(), "product", None)
        .await
        .unwrap_err();
    assert_eq!(refused(&e).map(|r| r.holder), Some(ROOT));

    let problem = format!(
        "{:?}",
        super::super::rest::write_problem("scaffold failed", &e)
    );
    assert!(problem.contains("CONNECTION_NOT_OWNED"), "{problem}");
}

/// A project with no gear repository writes into its sources: one read
/// through the root's connection (or another organization's, or the root's
/// default) is refused; its own, its organization's are written.
#[tokio::test]
async fn a_scaffold_into_a_source_through_the_roots_connection_is_refused() {
    let service = service();
    let ctx = ctx(ORG);
    // The project found the connection in its (inherited) catalogue: the read
    // starts from the project, the holder is the root.
    for (connection, holder) in [(C_ROOT, ROOT), (C_OTHER, OTHER_ORG)] {
        let e = service
            .scaffold_into_target(
                &ctx,
                P1,
                &target(P1, connection, "acme/app"),
                "x",
                &file(),
                false,
            )
            .await
            .unwrap_err();
        assert_eq!(refused(&e).map(|r| r.holder), Some(holder), "{e}");
    }
    let default = RepositoryTarget {
        connection_id: None,
        ..target(P1, C_ROOT, "acme/app")
    };
    let e = service
        .scaffold_into_target(&ctx, P1, &default, "x", &file(), false)
        .await
        .unwrap_err();
    assert_eq!(refused(&e).map(|r| r.holder), Some(ROOT));

    // Its own and its organization's pass the rule (and then find no
    // connector service here).
    for connection in [C_P1, C_ORG] {
        let e = service
            .scaffold_into_target(
                &ctx,
                P1,
                &target(P1, connection, "acme/app"),
                "x",
                &file(),
                false,
            )
            .await
            .unwrap_err();
        assert!(refused(&e).is_none(), "{e}");
        assert!(e.to_string().contains("connectors service unavailable"));
    }
}

/// The organization's own gear repository, scaffolded into for a project,
/// is allowed; a repository is not created through the root's connection,
/// and nothing is recorded.
#[tokio::test]
async fn the_organizations_own_is_written_and_nothing_is_created_through_the_roots() {
    let service = service();
    let ctx = ctx(ORG);
    let e = service
        .scaffold_into_target(
            &ctx,
            P1,
            &target(ORG, C_ORG, "acme/gears"),
            "x",
            &file(),
            false,
        )
        .await
        .unwrap_err();
    assert!(refused(&e).is_none(), "{e}");

    let project = P1.to_string();
    let e = service
        .create_project_repo(
            &ctx,
            &project,
            P1,
            Some(C_ROOT),
            None,
            false,
            "app-gears",
            true,
        )
        .await
        .unwrap_err();
    assert_eq!(refused(&e).map(|r| r.holder), Some(ROOT));
    assert!(
        service
            .get_project_repo(&ctx, &project)
            .await
            .unwrap()
            .is_none()
    );
}

/// The platform, acting for itself in the root, writes its own repository
/// through the root's connection (publish); a Declare for a project through
/// it is refused.
#[tokio::test]
async fn the_root_writes_its_own_repository_with_its_own_connection() {
    let service = service();
    let text = super::super::port::PullRequestText {
        message: "m".into(),
        title: "t".into(),
        body: "b".into(),
    };
    let platform = target(ROOT, C_ROOT, "platform/gears");
    let e = service
        .write_to_repository(&ctx(ROOT), &platform, "publish/x", &file(), &text)
        .await
        .unwrap_err();
    assert!(refused(&e).is_none(), "{e}");

    let e = service
        .write_to_repository(
            &ctx(P1),
            &target(P1, C_ROOT, "acme/app"),
            "declare/x",
            &file(),
            &text,
        )
        .await
        .unwrap_err();
    assert_eq!(refused(&e).map(|r| r.holder), Some(ROOT));
}
