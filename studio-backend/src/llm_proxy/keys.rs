//! Whose key a call to a model provider goes out on.
//!
//! A person's, always: Studio holds no key of its own for the agents or the
//! IDE's chat. For provider `P` and a caller, in this order:
//!
//! 1. the caller's **profile key** -- the credstore secret under `P`'s
//!    reference (`anthropic-key`, `openai-key`), accepted only when it is
//!    *private*, i.e. the caller's own. Credstore answers a secret shared with
//!    the tenant when the caller keeps none, and such a value (the key once
//!    seeded from the environment is one) is ignored;
//! 2. the caller's **personal** AI connection of `P`;
//! 3. a **workspace** AI connection of `P`, when the request names a workspace
//!    -- and only after the caller has been shown to reach it;
//! 4. an **organization** AI connection of `P`.
//!
//! Steps 2-4 are the connector gear's ([`ConnectorService::model_key_for`]):
//! it owns the catalogue and reads each token as the caller, so a connection
//! the caller may not read is skipped.
//!
//! [`ConnectorService::model_key_for`]: crate::connectors::sdk::ConnectorService::model_key_for

use std::sync::Arc;

use async_trait::async_trait;
use credstore_sdk::{CredStoreClientV1, SecretRef, SharingMode};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::providers::{KeySource, ProviderConfig};
use crate::connectors::sdk::Connectors;

/// The caller's own key, from their profile.
#[async_trait]
pub trait ProfileKeys: Send + Sync {
    async fn own_key(
        &self,
        ctx: &SecurityContext,
        secret_ref: &str,
    ) -> anyhow::Result<Option<String>>;
}

/// A key from an AI connection the caller reaches.
#[async_trait]
pub trait ConnectionKeys: Send + Sync {
    /// `provider` is the connector's provider id, which is the proxy's
    /// provider name (`anthropic`, `openai`).
    async fn connection_key(
        &self,
        ctx: &SecurityContext,
        workspace: Option<Uuid>,
        provider: &str,
    ) -> Option<String>;
}

/// A profile secret's value, when it is the caller's own.
///
/// Private is the only sharing mode a profile writes. A tenant or shared
/// value under the same reference is somebody else's key -- the one a
/// deployment used to seed from its environment, still sitting in an existing
/// database -- and never stands in for the caller's.
pub fn own_value(sharing: SharingMode, value: &[u8]) -> Option<String> {
    if sharing != SharingMode::Private {
        return None;
    }
    let value = std::str::from_utf8(value).ok()?.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

/// Credstore, asked as the caller.
pub struct CredstoreProfile(pub Arc<dyn CredStoreClientV1>);

#[async_trait]
impl ProfileKeys for CredstoreProfile {
    async fn own_key(
        &self,
        ctx: &SecurityContext,
        secret_ref: &str,
    ) -> anyhow::Result<Option<String>> {
        let key =
            SecretRef::new(secret_ref).map_err(|e| anyhow::anyhow!("bad secret reference: {e}"))?;
        let secret = self
            .0
            .get(ctx, &key)
            .await
            .map_err(|e| anyhow::anyhow!("credstore: {e}"))?;
        Ok(secret.and_then(|s| own_value(s.sharing, s.value.as_bytes())))
    }
}

/// The connector gear, resolved from the ClientHub when used: an assembly
/// without it simply has no connection keys.
pub struct ConnectorKeys(pub Connectors);

#[async_trait]
impl ConnectionKeys for ConnectorKeys {
    async fn connection_key(
        &self,
        ctx: &SecurityContext,
        workspace: Option<Uuid>,
        provider: &str,
    ) -> Option<String> {
        self.0.get()?.model_key_for(ctx, workspace, provider).await
    }
}

/// The resolution order above, behind [`KeySource`].
pub struct PeopleKeys {
    /// `None` without a credstore: no profile to read.
    pub profile: Option<Arc<dyn ProfileKeys>>,
    pub connections: Arc<dyn ConnectionKeys>,
}

#[async_trait]
impl KeySource for PeopleKeys {
    async fn key_for(
        &self,
        ctx: &SecurityContext,
        provider: &ProviderConfig,
        workspace: Option<Uuid>,
    ) -> anyhow::Result<Option<String>> {
        if let Some(profile) = &self.profile {
            match profile.own_key(ctx, &provider.secret_ref).await {
                Ok(Some(key)) => return Ok(Some(key)),
                Ok(None) => {}
                // A profile that cannot be read is no reason to refuse a key
                // a connection can give.
                Err(error) => tracing::warn!(
                    provider = %provider.name,
                    %error,
                    "studio-llm-proxy: the caller's profile key could not be read"
                ),
            }
        }
        Ok(self
            .connections
            .connection_key(ctx, workspace, &provider.name)
            .await)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::llm_proxy::providers::default_providers;

    fn person() -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(0x7A5))
            .subject_type("user")
            .subject_tenant_id(Uuid::from_u128(1))
            .build()
            .expect("security context")
    }

    /// Only the caller's own (private) value is a profile key.
    #[test]
    fn a_shared_credstore_value_is_not_a_profile_key() {
        for (sharing, value, expected) in [
            (SharingMode::Private, "sk-mine", Some("sk-mine")),
            (SharingMode::Private, "  sk-mine \n", Some("sk-mine")),
            (SharingMode::Private, "   ", None),
            (SharingMode::Tenant, "gsk-seeded-from-env", None),
            (SharingMode::Shared, "gsk-seeded-from-env", None),
        ] {
            assert_eq!(
                own_value(sharing, value.as_bytes()).as_deref(),
                expected,
                "{sharing:?} {value:?}"
            );
        }
        assert_eq!(own_value(SharingMode::Private, &[0xff, 0xfe]), None);
    }

    enum Profile {
        Key(&'static str),
        None,
        Broken,
    }

    #[async_trait]
    impl ProfileKeys for Profile {
        async fn own_key(&self, _: &SecurityContext, _: &str) -> anyhow::Result<Option<String>> {
            match self {
                Profile::Key(k) => Ok(Some((*k).to_owned())),
                Profile::None => Ok(None),
                Profile::Broken => anyhow::bail!("credstore is down"),
            }
        }
    }

    /// Connection keys by (workspace named, provider).
    struct Connections(HashMap<(Option<Uuid>, &'static str), &'static str>);

    #[async_trait]
    impl ConnectionKeys for Connections {
        async fn connection_key(
            &self,
            _: &SecurityContext,
            workspace: Option<Uuid>,
            provider: &str,
        ) -> Option<String> {
            self.0
                .iter()
                .find(|((w, p), _)| *w == workspace && *p == provider)
                .map(|(_, k)| (*k).to_owned())
        }
    }

    /// The profile key wins; a connection answers only when there is none (or
    /// it cannot be read); with neither there is no key.
    #[tokio::test]
    async fn the_profile_key_wins_then_the_connections_answer() {
        let ws = Uuid::from_u128(0xD2);
        let anthropic = &default_providers()[0];
        assert_eq!(anthropic.name, "anthropic");
        let connected = || Connections(HashMap::from([((Some(ws), "anthropic"), "sk-conn")]));
        for (profile, connections, workspace, expected) in [
            (
                Profile::Key("sk-own"),
                connected(),
                Some(ws),
                Some("sk-own"),
            ),
            (Profile::None, connected(), Some(ws), Some("sk-conn")),
            (Profile::Broken, connected(), Some(ws), Some("sk-conn")),
            (Profile::None, connected(), None, None),
            (Profile::None, Connections(HashMap::new()), Some(ws), None),
        ] {
            let keys = PeopleKeys {
                profile: Some(Arc::new(profile)),
                connections: Arc::new(connections),
            };
            assert_eq!(
                keys.key_for(&person(), anthropic, workspace)
                    .await
                    .unwrap()
                    .as_deref(),
                expected
            );
        }
        // No credstore at all: the connections are still asked.
        let keys = PeopleKeys {
            profile: None,
            connections: Arc::new(connected()),
        };
        assert_eq!(
            keys.key_for(&person(), anthropic, Some(ws))
                .await
                .unwrap()
                .as_deref(),
            Some("sk-conn")
        );
    }
}
