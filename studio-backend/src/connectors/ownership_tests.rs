//! Whose connection a tenant may use: the tree as a table.

use std::collections::HashMap;

use uuid::Uuid;

use super::*;

const ROOT: Uuid = PLATFORM_ROOT_TENANT;
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

/// Connections by id, with the tenant holding each; `None` reads the
/// default one, held where the second field says.
struct Held(HashMap<Uuid, Uuid>, Option<Uuid>);

#[async_trait::async_trait]
impl Holders for Held {
    async fn holder_of(&self, _tenant: Uuid, connection_id: Option<Uuid>) -> Option<Uuid> {
        match connection_id {
            Some(id) => self.0.get(&id).copied(),
            None => self.1,
        }
    }
}

#[tokio::test]
async fn only_the_organization_and_what_is_below_it_are_within_it() {
    let tree = tree();
    let p: &dyn Tree = &tree;
    for t in [ORG, WS, P1] {
        assert!(within(ORG, t, p).await, "{t} is the organization's");
    }
    assert!(
        !within(ORG, ROOT, p).await,
        "the platform's root is above it"
    );
    assert!(!within(ORG, OTHER_ORG, p).await, "another organization");
    assert!(
        !within(ORG, OTHER_WS, p).await,
        "below another organization"
    );
    assert!(
        !within(ORG, Uuid::from_u128(0x7e), p).await,
        "a tenant whose ancestry cannot be read is not the organization's"
    );
    // The platform's own catalogue is synced in the root: there the root is
    // the organization, and its connections are its own.
    assert!(within(ROOT, ROOT, p).await);
    assert!(within(ROOT, ORG, p).await);
}

/// A project uses its own, its workspace's and its organization's
/// connections; one the root or another organization holds is refused, and
/// so is a default the root holds. The root, for itself, uses its own.
#[tokio::test]
async fn a_connection_is_used_only_by_the_organization_that_holds_it() {
    let tree = tree();
    let held = Held(
        HashMap::from([
            (Uuid::from_u128(0xc0), ORG),
            (Uuid::from_u128(0xc1), ROOT),
            (Uuid::from_u128(0xc2), WS),
            (Uuid::from_u128(0xc3), P1),
            (Uuid::from_u128(0xc4), OTHER_ORG),
        ]),
        Some(ROOT),
    );
    let owned = |org, tenant, id: Option<u128>| {
        connection_is_owned(org, tenant, id.map(Uuid::from_u128), &held, &tree)
    };
    assert!(owned(ORG, P1, Some(0xc0)).await, "the organization's");
    assert!(owned(ORG, P1, Some(0xc2)).await, "the workspace's");
    assert!(owned(ORG, P1, Some(0xc3)).await, "the project's own");
    assert!(!owned(ORG, P1, Some(0xc1)).await, "inherited from the root");
    assert!(!owned(ORG, P1, Some(0xc4)).await, "another organization's");
    assert!(!owned(ORG, P1, None).await, "a default the root holds");
    assert!(!owned(ORG, ROOT, Some(0xc0)).await, "a use from the root");
    assert!(
        owned(ORG, P1, Some(0xff)).await,
        "a connection that cannot be found fails on its own"
    );
    assert!(owned(ROOT, ROOT, Some(0xc1)).await, "the root for itself");
    assert!(owned(ROOT, ROOT, None).await, "the root's default");
}

#[test]
fn a_refusal_says_whose_connection_it_was_and_what_to_do() {
    let refused = NotOwned {
        holder: ROOT,
        organization: ORG,
    }
    .to_string();
    assert!(refused.contains("the platform's root"), "{refused}");
    assert!(refused.contains("organization-scope connection of your own"));
    let other = NotOwned {
        holder: OTHER_ORG,
        organization: ORG,
    }
    .to_string();
    assert!(other.contains(&OTHER_ORG.to_string()), "{other}");
}
