//! Identity service: the canonical user, its sign-in methods and aliases, and
//! the mapper that turns a token subject into a stable Studio user id.
//!
//! All identity nodes live in one shared partition — the platform root tenant —
//! so a person is a single entity across every organization. Every graph call
//! therefore runs under a root-scoped [`SecurityContext`] derived from the
//! caller, regardless of which organization the caller is acting in.
//!
//! Like the catalog it prefers the real graph-storage gear and falls back to an
//! in-memory store when the `graph` feature is off, so the mapper still works
//! in a graph-less profile.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::gts::{self, GtsEdge, GtsNode};

/// The shared partition every identity node lives in. Account Management seeds
/// this tenant (id 1) as the platform root.
pub const PLATFORM_ROOT_TENANT_ID: Uuid = Uuid::from_u128(1);

/// Confidence of an alias attribution. `suggested` is a hypothesis and must
/// never grant anything; only `confirmed` is trusted.
pub const ALIAS_CONFIRMED: &str = "confirmed";
pub const ALIAS_SUGGESTED: &str = "suggested";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

// ── Views ───────────────────────────────────────────────────────────────────

/// The canonical user profile, role-free.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct UserProfile {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(default)]
    pub created_at_epoch_ms: i64,
    #[serde(default)]
    pub updated_at_epoch_ms: i64,
    /// Set when this user was merged into another; reads should follow it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_into: Option<String>,
}

/// A sign-in method resolved to a user.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LoginView {
    pub provider: String,
    pub subject: String,
    pub user_id: String,
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub linked_at_epoch_ms: i64,
}

/// A patch to a profile; `None` fields are left untouched.
#[derive(Clone, Debug, Default)]
pub struct ProfilePatch {
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub locale: Option<String>,
}

/// Outcome of a merge.
#[derive(Clone, Copy, Debug, Default)]
pub struct MergeResult {
    pub logins_moved: usize,
    pub aliases_moved: usize,
}

// ── Sink ────────────────────────────────────────────────────────────────────

/// Where identity nodes and edges are written and read. Two implementations:
/// the real graph-storage gear, and an in-memory fallback.
#[async_trait]
pub(crate) trait IdentitySink: Send + Sync {
    async fn register_types(&self, ctx: &SecurityContext) -> Result<()>;
    async fn upsert(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
        edges: &[GtsEdge],
    ) -> Result<()>;
    async fn node(&self, ctx: &SecurityContext, node_key: &str) -> Result<Option<GtsNode>>;
    async fn list(&self, ctx: &SecurityContext, type_id: &'static str) -> Result<Vec<GtsNode>>;
}

/// In-memory store, keyed by instance id so a re-touch upserts. Resets on
/// restart — acceptable only for the graph-less dev profile.
#[derive(Default)]
pub(crate) struct MemorySink {
    nodes: Mutex<HashMap<String, GtsNode>>,
}

#[async_trait]
impl IdentitySink for MemorySink {
    async fn register_types(&self, _ctx: &SecurityContext) -> Result<()> {
        Ok(())
    }

    async fn upsert(
        &self,
        _ctx: &SecurityContext,
        nodes: &[GtsNode],
        _edges: &[GtsEdge],
    ) -> Result<()> {
        let mut map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("identity store lock poisoned"))?;
        for n in nodes {
            map.insert(n.instance_id.clone(), n.clone());
        }
        Ok(())
    }

    async fn node(&self, _ctx: &SecurityContext, node_key: &str) -> Result<Option<GtsNode>> {
        let map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("identity store lock poisoned"))?;
        Ok(map.get(node_key).cloned())
    }

    async fn list(&self, _ctx: &SecurityContext, type_id: &'static str) -> Result<Vec<GtsNode>> {
        let map = self
            .nodes
            .lock()
            .map_err(|_| anyhow!("identity store lock poisoned"))?;
        Ok(map
            .values()
            .filter(|n| n.type_id == type_id)
            .cloned()
            .collect())
    }
}

/// The real graph-storage backend. Behind the `graph` feature (the gear is).
#[cfg(feature = "graph")]
pub(crate) struct GraphSink {
    client: Arc<dyn crate::graph_storage::sdk::GraphStorageClientV1>,
}

#[cfg(feature = "graph")]
impl GraphSink {
    pub(crate) fn new(client: Arc<dyn crate::graph_storage::sdk::GraphStorageClientV1>) -> Self {
        Self { client }
    }
}

/// Human name for a node, from its payload.
#[cfg(feature = "graph")]
fn node_name(value: &Value) -> String {
    for key in ["display_name", "name", "id"] {
        if let Some(s) = value.get(key).and_then(Value::as_str) {
            return s.to_string();
        }
    }
    String::new()
}

/// Free text for lexical search over a person: name, email, and any handles.
#[cfg(feature = "graph")]
fn search_text(value: &Value) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for key in [
        "display_name",
        "name",
        "email",
        "subject",
        "external_id",
        "provider",
    ] {
        if let Some(s) = value.get(key).and_then(Value::as_str) {
            parts.push(s.to_string());
        }
    }
    let joined = parts.join(" ");
    if joined.trim().is_empty() {
        None
    } else {
        Some(joined)
    }
}

#[cfg(feature = "graph")]
#[async_trait]
impl IdentitySink for GraphSink {
    async fn register_types(&self, ctx: &SecurityContext) -> Result<()> {
        for t in gts::ALL_NODE_TYPES {
            self.client
                .register_type(ctx, &gts::graph_type_id(t), "node", None)
                .await
                .map_err(|e| anyhow!("register type {t}: {e}"))?;
        }
        for t in gts::ALL_EDGE_TYPES {
            self.client
                .register_type(ctx, &gts::graph_type_id(t), "edge", None)
                .await
                .map_err(|e| anyhow!("register edge type {t}: {e}"))?;
        }
        Ok(())
    }

    async fn upsert(
        &self,
        ctx: &SecurityContext,
        nodes: &[GtsNode],
        edges: &[GtsEdge],
    ) -> Result<()> {
        use crate::graph_storage::sdk::{EdgeInput, NodeInput};
        if nodes.is_empty() && edges.is_empty() {
            return Ok(());
        }
        let node_inputs: Vec<NodeInput> = nodes
            .iter()
            .map(|n| NodeInput {
                node_key: n.instance_id.clone(),
                type_id: gts::graph_type_id(n.type_id),
                name: node_name(&n.value),
                search_text: search_text(&n.value),
                payload: Some(n.value.clone()),
                embedding: None,
            })
            .collect();
        let edge_inputs: Vec<EdgeInput> = edges
            .iter()
            .map(|e| EdgeInput {
                type_id: gts::graph_type_id(e.type_id),
                from: e.from.clone(),
                to: e.to.clone(),
                payload: None,
            })
            .collect();
        self.client
            .ingest(ctx, &node_inputs, &edge_inputs)
            .await
            .map_err(|e| anyhow!("graph-storage ingest: {e}"))?;
        Ok(())
    }

    async fn node(&self, ctx: &SecurityContext, node_key: &str) -> Result<Option<GtsNode>> {
        let view = self
            .client
            .node_by_key(ctx, node_key, true)
            .await
            .map_err(|e| anyhow!("graph-storage node_by_key: {e}"))?;
        Ok(view.map(|v| GtsNode {
            type_id: gts::our_type_from_graph(&v.type_id).unwrap_or(gts::USER_TYPE),
            instance_id: v.node_key,
            value: v.payload.unwrap_or_else(|| json!({})),
        }))
    }

    async fn list(&self, ctx: &SecurityContext, type_id: &'static str) -> Result<Vec<GtsNode>> {
        const PAGE: u32 = 500;
        let graph_type = gts::graph_type_id(type_id);
        let mut out: Vec<GtsNode> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = self
                .client
                .list_nodes(ctx, Some(&graph_type), cursor.as_deref(), PAGE, true)
                .await
                .map_err(|e| anyhow!("graph-storage list_nodes: {e}"))?;
            for view in page.items {
                out.push(GtsNode {
                    type_id,
                    instance_id: view.node_key,
                    value: view.payload.unwrap_or_else(|| json!({})),
                });
            }
            match page.next_cursor {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }
        Ok(out)
    }
}

// ── Service ─────────────────────────────────────────────────────────────────

pub struct IdentityService {
    sink: Arc<dyn IdentitySink>,
}

impl IdentityService {
    pub(crate) fn new(sink: Arc<dyn IdentitySink>) -> Self {
        Self { sink }
    }

    pub async fn register_types(&self, caller: &SecurityContext) -> Result<()> {
        self.sink.register_types(&self.root_ctx(caller)).await
    }

    /// A root-scoped context derived from the caller: same identity and token,
    /// but pinned to the platform root tenant so all identity nodes co-locate.
    fn root_ctx(&self, caller: &SecurityContext) -> SecurityContext {
        // A system context in the platform root tenant. The in-process
        // graph-storage client scopes purely by `subject_tenant_id`, so the
        // caller's identity is carried for audit but no token forwarding is
        // needed to reach the shared identity partition.
        SecurityContext::builder()
            .subject_id(caller.subject_id())
            .subject_type("service")
            .subject_tenant_id(PLATFORM_ROOT_TENANT_ID)
            .build()
            .unwrap_or_else(|_| SecurityContext::anonymous())
    }

    /// Resolve `(provider, subject)` to a canonical user id, provisioning a new
    /// user the first time an identity is seen (JIT). Seed values fill the fresh
    /// profile; on an already-known login they are ignored.
    pub async fn resolve_or_provision(
        &self,
        caller: &SecurityContext,
        provider: &str,
        subject: &str,
        seed_display: Option<&str>,
        seed_email: Option<&str>,
        verified: bool,
    ) -> Result<String> {
        let root = self.root_ctx(caller);
        let login_key = gts::login_instance_id(provider, subject);
        if let Some(node) = self.sink.node(&root, &login_key).await?
            && let Some(uid) = node.value.get("user_id").and_then(Value::as_str)
        {
            return Ok(uid.to_string());
        }

        let user_id = Uuid::new_v4().to_string();
        let now = now_ms();
        let mut profile = json!({
            "id": user_id,
            "created_at_epoch_ms": now,
            "updated_at_epoch_ms": now,
        });
        if let Some(name) = seed_display.map(str::trim).filter(|s| !s.is_empty()) {
            profile["display_name"] = json!(name);
            profile["name"] = json!(name);
        } else {
            profile["name"] = json!(user_id);
        }
        if let Some(email) = seed_email.map(str::trim).filter(|s| !s.is_empty()) {
            profile["email"] = json!(email);
        }

        let user = gts::user_node(&user_id, profile);
        let login = gts::login_node(
            provider,
            subject,
            json!({
                "provider": provider,
                "subject": subject,
                "user_id": user_id,
                "verified": verified,
                "linked_at_epoch_ms": now,
            }),
        );
        let edge = GtsEdge {
            type_id: gts::REL_HAS_LOGIN,
            from: user_id.clone(),
            to: login.instance_id.clone(),
        };
        self.sink.upsert(&root, &[user, login], &[edge]).await?;
        Ok(user_id)
    }

    /// Read a profile by user id, following a merge pointer if present. The
    /// walk is bounded so a corrupt cyclic pointer cannot loop forever.
    pub async fn get_profile(
        &self,
        caller: &SecurityContext,
        user_id: &str,
    ) -> Result<Option<UserProfile>> {
        let root = self.root_ctx(caller);
        let mut current = user_id.to_string();
        for _ in 0..8 {
            let Some(node) = self.sink.node(&root, &current).await? else {
                return Ok(None);
            };
            let profile: UserProfile = serde_json::from_value(node.value)
                .map_err(|e| anyhow!("decode user profile: {e}"))?;
            match profile.merged_into.as_deref() {
                Some(into) if into != current => current = into.to_string(),
                _ => return Ok(Some(profile)),
            }
        }
        Err(anyhow!("merge chain too deep or cyclic for user {user_id}"))
    }

    /// Apply a patch to a profile and return the updated view.
    pub async fn update_profile(
        &self,
        caller: &SecurityContext,
        user_id: &str,
        patch: ProfilePatch,
    ) -> Result<UserProfile> {
        let root = self.root_ctx(caller);
        let node = self
            .sink
            .node(&root, user_id)
            .await?
            .ok_or_else(|| anyhow!("user {user_id} does not exist"))?;
        let mut value = node.value;
        let obj = value
            .as_object_mut()
            .ok_or_else(|| anyhow!("user node is not an object"))?;
        if let Some(v) = patch.display_name {
            obj.insert("display_name".into(), json!(v.trim()));
            obj.insert("name".into(), json!(v.trim()));
        }
        if let Some(v) = patch.email {
            obj.insert("email".into(), json!(v.trim()));
        }
        if let Some(v) = patch.avatar_url {
            obj.insert("avatar_url".into(), json!(v.trim()));
        }
        if let Some(v) = patch.locale {
            obj.insert("locale".into(), json!(v.trim()));
        }
        obj.insert("updated_at_epoch_ms".into(), json!(now_ms()));
        let updated: UserProfile = serde_json::from_value(value.clone())
            .map_err(|e| anyhow!("decode updated profile: {e}"))?;
        let user = gts::user_node(user_id, value);
        self.sink.upsert(&root, &[user], &[]).await?;
        Ok(updated)
    }

    /// Every sign-in method that resolves to this user.
    pub async fn list_logins(
        &self,
        caller: &SecurityContext,
        user_id: &str,
    ) -> Result<Vec<LoginView>> {
        let root = self.root_ctx(caller);
        let mut out = Vec::new();
        for node in self.sink.list(&root, gts::LOGIN_TYPE).await? {
            if node.value.get("user_id").and_then(Value::as_str) == Some(user_id)
                && let Ok(view) = serde_json::from_value::<LoginView>(node.value)
            {
                out.push(view);
            }
        }
        Ok(out)
    }

    /// Bind another sign-in method to an existing user. Refuses if the login is
    /// already bound to a *different* user — merging those is an explicit
    /// operation, not a silent rebind. The verified-only auto-link policy is
    /// enforced by the caller; this records the decision it made.
    pub async fn link_login(
        &self,
        caller: &SecurityContext,
        user_id: &str,
        provider: &str,
        subject: &str,
        verified: bool,
    ) -> Result<()> {
        let root = self.root_ctx(caller);
        let login_key = gts::login_instance_id(provider, subject);
        if let Some(existing) = self.sink.node(&root, &login_key).await?
            && let Some(bound) = existing.value.get("user_id").and_then(Value::as_str)
            && bound != user_id
        {
            return Err(anyhow!(
                "login {provider}:{subject} is already bound to another user; merge instead"
            ));
        }
        if self.sink.node(&root, user_id).await?.is_none() {
            return Err(anyhow!("user {user_id} does not exist"));
        }
        let login = gts::login_node(
            provider,
            subject,
            json!({
                "provider": provider,
                "subject": subject,
                "user_id": user_id,
                "verified": verified,
                "linked_at_epoch_ms": now_ms(),
            }),
        );
        let edge = GtsEdge {
            type_id: gts::REL_HAS_LOGIN,
            from: user_id.to_string(),
            to: login.instance_id.clone(),
        };
        self.sink.upsert(&root, &[login], &[edge]).await?;
        Ok(())
    }

    /// Attribute a non-login external identifier to a user. `suggested`
    /// attributions are hypotheses and never grant anything.
    pub async fn add_alias(
        &self,
        caller: &SecurityContext,
        user_id: &str,
        kind: &str,
        external_id: &str,
        confidence: &str,
    ) -> Result<()> {
        let root = self.root_ctx(caller);
        if self.sink.node(&root, user_id).await?.is_none() {
            return Err(anyhow!("user {user_id} does not exist"));
        }
        let confidence = if confidence == ALIAS_CONFIRMED {
            ALIAS_CONFIRMED
        } else {
            ALIAS_SUGGESTED
        };
        let alias = gts::alias_node(
            kind,
            external_id,
            json!({
                "kind": kind,
                "external_id": external_id,
                "user_id": user_id,
                "confidence": confidence,
                "added_at_epoch_ms": now_ms(),
            }),
        );
        let edge = GtsEdge {
            type_id: gts::REL_HAS_ALIAS,
            from: user_id.to_string(),
            to: alias.instance_id.clone(),
        };
        self.sink.upsert(&root, &[alias], &[edge]).await?;
        Ok(())
    }

    /// Merge `from_user` into `into_user`: repoint every login and alias, then
    /// tombstone the source with a `merged_into` pointer so reads follow it.
    pub async fn merge(
        &self,
        caller: &SecurityContext,
        from_user: &str,
        into_user: &str,
    ) -> Result<MergeResult> {
        if from_user == into_user {
            return Err(anyhow!("cannot merge a user into itself"));
        }
        let root = self.root_ctx(caller);
        if self.sink.node(&root, into_user).await?.is_none() {
            return Err(anyhow!("target user {into_user} does not exist"));
        }
        let source = self
            .sink
            .node(&root, from_user)
            .await?
            .ok_or_else(|| anyhow!("source user {from_user} does not exist"))?;

        let mut nodes: Vec<GtsNode> = Vec::new();
        let mut edges: Vec<GtsEdge> = Vec::new();
        let mut result = MergeResult::default();

        for mut login in self.sink.list(&root, gts::LOGIN_TYPE).await? {
            if login.value.get("user_id").and_then(Value::as_str) != Some(from_user) {
                continue;
            }
            login.value["user_id"] = json!(into_user);
            edges.push(GtsEdge {
                type_id: gts::REL_HAS_LOGIN,
                from: into_user.to_string(),
                to: login.instance_id.clone(),
            });
            nodes.push(login);
            result.logins_moved += 1;
        }
        for mut alias in self.sink.list(&root, gts::ALIAS_TYPE).await? {
            if alias.value.get("user_id").and_then(Value::as_str) != Some(from_user) {
                continue;
            }
            alias.value["user_id"] = json!(into_user);
            edges.push(GtsEdge {
                type_id: gts::REL_HAS_ALIAS,
                from: into_user.to_string(),
                to: alias.instance_id.clone(),
            });
            nodes.push(alias);
            result.aliases_moved += 1;
        }

        let mut tombstone = source.value;
        if let Some(obj) = tombstone.as_object_mut() {
            obj.insert("merged_into".into(), json!(into_user));
            obj.insert("updated_at_epoch_ms".into(), json!(now_ms()));
        }
        nodes.push(gts::user_node(from_user, tombstone));

        self.sink.upsert(&root, &nodes, &edges).await?;
        Ok(result)
    }
}
