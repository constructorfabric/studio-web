//! Where forwarded Theia events go after the ingress authenticates them.
//!
//! The ingress is transport; the sink is policy. [`StudioEventsSink`] is the
//! default: it republishes onto the assembly's own `studio-events` channel, so
//! the portal sees Theia activity through the same stream as everything else.
//! `EventBrokerEventSink` (behind the `theia-event-broker` feature) plugs in
//! here without touching the ingress: it takes an `EventBrokerApi` from
//! ClientHub and republishes each event as a typed event, tenant-scoped by the
//! reverse-resolved identity.

use async_trait::async_trait;
use uuid::Uuid;

/// One event forwarded from a Theia container's `StudioRuntimeClient`.
///
/// `payload` is the callback argument verbatim (an operation event, an audit
/// entry, a repositories list, …); `kind` says which.
#[derive(Debug, Clone)]
pub struct TheiaForwardedEvent {
    /// Trusted tenant, recovered from the S2S control token — NOT from the
    /// request body. The forwarder envelope's `workspaceId` is advisory.
    pub tenant_id: Uuid,
    /// Trusted workspace the session belongs to (from the control token).
    pub workspace_id: Uuid,
    /// The live session the token resolved to: a container session, or a
    /// desktop session's lease (ADR-0027 phase 4).
    pub session_id: Uuid,
    /// Which runtime `session_id` is: `container` or `desktop`.
    pub runtime: &'static str,
    /// Event kind: `operation` | `audit` | `repositories-changed` |
    /// `workspace-snapshot-changed` | `workspace-activity`.
    pub kind: String,
    /// Monotonic sequence for the ordered kinds (`operation`, `audit`).
    pub sequence: Option<i64>,
    /// The verbatim callback payload.
    pub payload: serde_json::Value,
}

/// Consumer of forwarded Theia events. Republish to `event-broker`, feed the
/// artifact graph, notify — one policy per implementation.
#[async_trait]
pub trait TheiaEventSink: Send + Sync {
    async fn accept(&self, event: TheiaForwardedEvent);
}

/// The forwarded kinds [`StudioEventsSink`] republishes, as `theia.<kind>`.
///
/// Each is a row in `docs/events-catalog.md` (the test below holds the two
/// together). A kind the bridge sends that is not here is traced and dropped:
/// a consumer may rely only on what the catalogue lists, so a new one is added
/// here and there in the same PR, not discovered on the stream.
#[cfg_attr(feature = "theia-event-broker", allow(dead_code))]
const REPUBLISHED_KINDS: &[&str] = &[
    "operation",
    "audit",
    "repositories-changed",
    "workspace-snapshot-changed",
    "workspace-activity",
];

/// Default sink: republish onto the `studio-events` channel, so a forwarded
/// Theia event reaches the portal like any other studio event.
///
/// The bridge's vocabulary stops here. Downstream the event is just
/// `theia.<kind>` about a **workspace**, with everything Theia-specific —
/// session id, sequence, the raw callback argument — inside `payload`. That is
/// what keeps one producer's protocol out of the contract every consumer has
/// to live with.
///
/// The publisher is resolved lazily rather than at construction: gear init
/// order is not guaranteed, and with no channel available this degrades to the
/// structured trace it has always emitted.
// The broker sink replaces this one under `theia-event-broker`
// (`gear.rs` picks by feature), which leaves it unconstructed there.
#[cfg_attr(feature = "theia-event-broker", allow(dead_code))]
pub struct StudioEventsSink {
    hub: std::sync::Arc<toolkit::client_hub::ClientHub>,
}

#[cfg_attr(feature = "theia-event-broker", allow(dead_code))]
impl StudioEventsSink {
    pub fn new(hub: std::sync::Arc<toolkit::client_hub::ClientHub>) -> Self {
        Self { hub }
    }
}

#[async_trait]
impl TheiaEventSink for StudioEventsSink {
    async fn accept(&self, event: TheiaForwardedEvent) {
        tracing::info!(
            kind = %event.kind,
            tenant = %event.tenant_id,
            workspace = %event.workspace_id,
            session = %event.session_id,
            sequence = ?event.sequence,
            payload_bytes = event.payload.to_string().len(),
            "studio-theia: received forwarded Theia event"
        );
        if !REPUBLISHED_KINDS.contains(&event.kind.as_str()) {
            tracing::warn!(
                kind = %event.kind,
                "studio-theia: not republished, the kind is not in docs/events-catalog.md"
            );
            return;
        }
        let Ok(events) = self
            .hub
            .get::<dyn crate::studio_events::StudioEventPublisher>()
        else {
            return; // no channel in this assembly — the trace above is the record
        };
        events.publish(
            crate::studio_events::StudioEvent::new(
                event.tenant_id,
                format!("theia.{}", event.kind),
                "workspace",
                event.workspace_id.to_string(),
                "studio-theia",
            )
            .with_payload(serde_json::json!({
                "workspace_id": event.workspace_id,
                "session_id": event.session_id,
                "runtime": event.runtime,
                "sequence": event.sequence,
                "event": event.payload,
            })),
        );
    }
}

/// Real sink: republish forwarded Theia events onto the `event-broker` gear.
///
/// Gated behind `theia-event-broker`. NOTE: this compiles the SDK wiring, but a
/// publish only succeeds once (a) the broker is linked with a storage backend
/// and (b) the topic + event-type schema below are registered in the broker's
/// types-registry. The GTS ids are PLACEHOLDERS — confirm the final names with
/// the platform team before registering.
#[cfg(feature = "theia-event-broker")]
mod broker {
    use std::borrow::Cow;
    use std::collections::HashMap;
    use std::sync::Arc;

    use async_trait::async_trait;
    use event_broker_sdk::{
        DirectDeduplication, EventBrokerApi, Producer, ProducerIdentity, TypedEvent,
    };
    use serde::{Deserialize, Serialize};
    use tokio::sync::RwLock;
    use toolkit::client_hub::ClientHub;
    use toolkit_security::SecurityContext;
    use uuid::Uuid;

    use super::{TheiaEventSink, TheiaForwardedEvent};

    // GTS identifiers — PLACEHOLDERS pending registration in the broker.
    const EB_TOPIC: &str = "gts.cf.core.events.topic.v1~studio.theia.forwarded.v1";
    const EB_TYPE_ID: &str = "gts.cf.core.events.event_type.v1~studio.theia.forwarded.v1";
    const EB_SUBJECT_TYPE: &str = "gts.cf.core.events.subject.v1~studio.workspace.v1";
    const CLIENT_AGENT: &str = concat!("studio-theia/", env!("CARGO_PKG_VERSION"));
    // Stable service subject for the bridge's producer identity (placeholder):
    // the producer acts as the studio-theia service, not as any one session.
    const STUDIO_THEIA_SUBJECT: Uuid = Uuid::from_u128(0x0ad00010_0000_4000_8000_000000000001);

    /// The typed event the bridge republishes: the verbatim Theia callback
    /// (`event`) plus the trusted coordinates the ingress reverse-resolved.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct TheiaForwardedTypedEvent {
        tenant_id: Uuid,
        workspace_id: Uuid,
        session_id: Uuid,
        kind: String,
        sequence: Option<i64>,
        event: serde_json::Value,
    }

    // event-broker-sdk 0.2.6 moved the topic and the partition key out of the
    // producer and into the event type's GTS traits: the type registered as
    // `EB_TYPE_ID` names its topic (`EB_TOPIC`) and keys partitions on the
    // subject -- the workspace -- which keeps a workspace's events in order.
    // Both identifiers are still placeholders pending that registration.
    impl TypedEvent for TheiaForwardedTypedEvent {
        const TYPE_ID: &'static str = EB_TYPE_ID;
        const SUBJECT_TYPE: &'static str = EB_SUBJECT_TYPE;
        const SOURCE: &'static str = "studio-theia";

        fn subject(&self) -> Cow<'_, str> {
            Cow::Owned(self.workspace_id.to_string())
        }

        fn tenant_id(&self) -> Option<Uuid> {
            Some(self.tenant_id)
        }
    }

    /// Republishes forwarded Theia events onto `event-broker`, tenant-scoped by
    /// the reverse-resolved identity. Producers are prepared lazily and cached
    /// per tenant: `prepare_all` registers the producer and validates the
    /// event-type schema against the topic, so it must not run per event.
    pub struct EventBrokerEventSink {
        hub: Arc<ClientHub>,
        producers: RwLock<HashMap<Uuid, Arc<Producer>>>,
    }

    impl EventBrokerEventSink {
        pub fn new(hub: Arc<ClientHub>) -> Self {
            Self {
                hub,
                producers: RwLock::new(HashMap::new()),
            }
        }

        /// Get-or-prepare the cached producer for one tenant. `None` when the
        /// broker client is not yet in ClientHub or `prepare_all` fails (both
        /// logged); the event is then dropped best-effort.
        async fn producer_for(&self, tenant_id: Uuid) -> Option<Arc<Producer>> {
            if let Some(existing) = self.producers.read().await.get(&tenant_id) {
                return Some(existing.clone());
            }
            let broker = self.hub.try_get::<dyn EventBrokerApi>()?;
            // The reverse-resolved tenant is the authority; the subject is the
            // bridge service. Broker authorization of this identity for the
            // topic is an integration-time concern.
            let ctx = SecurityContext::builder()
                .subject_id(STUDIO_THEIA_SUBJECT)
                .subject_type("studio-theia")
                .subject_tenant_id(tenant_id)
                .build()
                .ok()?;
            let prepared = Producer::builder()
                .broker(broker)
                .security_context(ctx)
                .identity(
                    ProducerIdentity::new()
                        .source("studio-theia")
                        .client_agent(CLIENT_AGENT),
                )
                .deduplication(DirectDeduplication::stateless())
                .topics([EB_TOPIC])
                .event_type_patterns([EB_TYPE_ID])
                .prepare_all()
                .await;
            let producer = match prepared {
                Ok(producer) => Arc::new(producer),
                Err(error) => {
                    tracing::warn!(
                        %error,
                        tenant = %tenant_id,
                        "studio-theia: event-broker producer prepare failed"
                    );
                    return None;
                }
            };
            self.producers
                .write()
                .await
                .insert(tenant_id, producer.clone());
            Some(producer)
        }
    }

    #[async_trait]
    impl TheiaEventSink for EventBrokerEventSink {
        async fn accept(&self, event: TheiaForwardedEvent) {
            let Some(producer) = self.producer_for(event.tenant_id).await else {
                return; // broker unavailable / prepare failed — already logged
            };
            let typed = TheiaForwardedTypedEvent {
                tenant_id: event.tenant_id,
                workspace_id: event.workspace_id,
                session_id: event.session_id,
                kind: event.kind,
                sequence: event.sequence,
                event: event.payload,
            };
            match producer.publish(typed).await {
                Ok(outcome) => {
                    tracing::debug!(?outcome, "studio-theia: event published to broker")
                }
                Err(error) => {
                    tracing::warn!(%error, "studio-theia: event-broker publish failed")
                }
            }
        }
    }
}

#[cfg(feature = "theia-event-broker")]
pub use broker::EventBrokerEventSink;

#[cfg(test)]
mod tests {
    use super::REPUBLISHED_KINDS;

    /// The `theia.*` kinds the sink republishes are the ones the events
    /// catalogue lists, no more and no fewer.
    #[test]
    fn the_republished_kinds_are_the_ones_the_catalogue_lists() {
        let published: std::collections::BTreeSet<String> = REPUBLISHED_KINDS
            .iter()
            .map(|kind| format!("theia.{kind}"))
            .collect();
        assert_eq!(
            published,
            crate::api_contract::events::documented_kinds("theia."),
            "docs/events-catalog.md and the Theia sink disagree on the `theia.*` kinds"
        );
    }
}
