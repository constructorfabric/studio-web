//! GTS identifiers, type schemas and node/edge model for the identity graph.
//!
//! Distinct from the tenant graphs: these nodes model *people* and the ways
//! they sign in, and they live in one shared partition (the platform root
//! tenant) so a person is one entity across every organization. Instance ids
//! are deterministic (uuid5 of a stable key) for logins and aliases so a
//! re-touch upserts rather than duplicates; the `user` node key is the user's
//! own freshly-minted id, independent of any identity provider.

use serde_json::{Value, json};
use uuid::Uuid;

/// Fixed namespace for uuid5 instance ids (identity graph). Distinct from the
/// catalog and artifact namespaces so a key never collides across domains.
const INSTANCE_NS: Uuid = Uuid::from_u128(0xcf57_0000_0000_4000_8000_0000_0000_0003);

/// A person: the canonical user Studio owns. Carries the profile and survives
/// identity-provider changes. Role is deliberately *not* here — role is a
/// property of membership in an organization, not of the person.
pub const USER_TYPE: &str = "gts.cf.studio.identity.user.v1~";
/// A way to sign in that resolves to a user: `(provider, subject)` → user.
pub const LOGIN_TYPE: &str = "gts.cf.studio.identity.login.v1~";
/// A non-login external identifier attributed to a user (commit author, chat
/// handle, external system id). Confidence marks confirmed vs suggested.
pub const ALIAS_TYPE: &str = "gts.cf.studio.identity.alias.v1~";

/// Every identity node type, for registering and enumerating.
pub const ALL_NODE_TYPES: [&str; 3] = [USER_TYPE, LOGIN_TYPE, ALIAS_TYPE];

/// user → login — a sign-in method that resolves to this user.
pub const REL_HAS_LOGIN: &str = "gts.cf.studio.identity.rel.has_login.v1~";
/// user → alias — an external identifier attributed to this user.
pub const REL_HAS_ALIAS: &str = "gts.cf.studio.identity.rel.has_alias.v1~";

/// Every identity relation type, for registering in the graph.
pub const ALL_EDGE_TYPES: [&str; 2] = [REL_HAS_LOGIN, REL_HAS_ALIAS];

/// A GTS node to persist: type id, instance id, and payload.
#[derive(Debug, Clone)]
pub struct GtsNode {
    pub type_id: &'static str,
    pub instance_id: String,
    pub value: Value,
}

/// A GTS edge to persist: type id and endpoint instance ids.
#[derive(Debug, Clone)]
pub struct GtsEdge {
    pub type_id: &'static str,
    pub from: String,
    pub to: String,
}

/// The type id the graph-storage gear stores this type under. The gear keeps
/// its own type table and its ids omit the `gts.` scheme token, so we strip it
/// (same convention as the catalog and artifact graphs).
pub fn graph_type_id(our_type: &str) -> String {
    our_type
        .strip_prefix("gts.")
        .unwrap_or(our_type)
        .to_string()
}

/// Reverse of [`graph_type_id`]: map a graph-storage type id back to our
/// `&'static` constant so a node read back keeps its typed identity.
pub fn our_type_from_graph(graph_type: &str) -> Option<&'static str> {
    ALL_NODE_TYPES
        .into_iter()
        .find(|t| graph_type_id(t) == graph_type)
}

/// GTS type schemas registered at gear init (free-form `type: object`, same
/// shape the studio types use, so registration never trips the narrowing check).
pub fn type_schemas() -> Vec<Value> {
    [
        (
            USER_TYPE,
            "User",
            "A canonical person Studio owns; carries the profile, role-free.",
        ),
        (
            LOGIN_TYPE,
            "Login",
            "A sign-in method (provider, subject) that resolves to a user.",
        ),
        (
            ALIAS_TYPE,
            "Alias",
            "A non-login external identifier attributed to a user.",
        ),
    ]
    .into_iter()
    .map(|(id, title, description)| {
        json!({
            "$id": format!("gts://{id}"),
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": title,
            "description": description,
            "type": "object",
        })
    })
    .collect()
}

/// Deterministic instance id from a stable composite key.
fn anon_id(parts: &[&str]) -> String {
    Uuid::new_v5(&INSTANCE_NS, parts.join("|").as_bytes()).to_string()
}

/// The node key of a login, keyed on `(provider, subject)` so the same sign-in
/// always maps to the same node — that is what makes resolve idempotent.
pub fn login_instance_id(provider: &str, subject: &str) -> String {
    anon_id(&["login", provider, subject])
}

/// The node key of an alias, keyed on `(kind, external_id)`.
pub fn alias_instance_id(kind: &str, external_id: &str) -> String {
    anon_id(&["alias", kind, external_id])
}

/// Build a `user` node payload. Role lives in organization membership, never
/// here; this is only what is true about the person.
pub fn user_node(user_id: &str, value: Value) -> GtsNode {
    GtsNode {
        type_id: USER_TYPE,
        instance_id: user_id.to_string(),
        value,
    }
}

/// Build a `login` node and the `has_login` edge from its user.
pub fn login_node(provider: &str, subject: &str, value: Value) -> GtsNode {
    GtsNode {
        type_id: LOGIN_TYPE,
        instance_id: login_instance_id(provider, subject),
        value,
    }
}

/// Build an `alias` node.
pub fn alias_node(kind: &str, external_id: &str, value: Value) -> GtsNode {
    GtsNode {
        type_id: ALIAS_TYPE,
        instance_id: alias_instance_id(kind, external_id),
        value,
    }
}
