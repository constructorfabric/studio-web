//! The in-process fan-out: one channel per tenant, plus a short replay window.
//!
//! Two properties matter more than throughput here:
//!
//! * **Tenant isolation is structural.** Each tenant gets its own broadcaster,
//!   so a subscriber cannot receive another tenant's event even if a filter is
//!   forgotten somewhere downstream. Filtering one shared stream would make
//!   that a code-review property instead of a type-level one.
//! * **A reconnect must not lose events.** Every tenant keeps the last
//!   `backlog` events so a client that reconnects replays the gap by cursor
//!   instead of guessing. The window is deliberately small: this is a
//!   reconnect patch, not an event store.
//!
//! State is per-process and resets on restart, exactly like the task
//! registries that feed it. When the platform's `event-broker` gear lands,
//! this type becomes the bridge between a broker subscription and the same two
//! endpoints, and the wire contract does not change.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use toolkit::SseBroadcaster;
use uuid::Uuid;

use super::api::{StudioEvent, StudioEventPublisher};
use super::dto::StudioEventDto;

/// One tenant's live channel and its replay window.
struct TenantChannel {
    live: SseBroadcaster<StudioEventDto>,
    backlog: VecDeque<StudioEventDto>,
    /// Last cursor handed out for this tenant. Per-tenant rather than global
    /// so a client's cursor is dense and no tenant can infer another's volume.
    latest_seq: i64,
}

/// Fan-out hub. Registered in the ClientHub as `dyn StudioEventPublisher` and
/// carried by the REST routes as the subscription side.
pub struct StudioEventHub {
    tenants: Mutex<HashMap<Uuid, TenantChannel>>,
    /// Broadcast buffer per tenant. A subscriber that falls this far behind
    /// drops frames (tokio's broadcast semantics) — and then recovers by
    /// cursor, which is why the backlog exists.
    buffer: usize,
    /// How many events per tenant stay replayable.
    backlog: usize,
}

impl StudioEventHub {
    pub fn new(buffer: usize, backlog: usize) -> Self {
        Self {
            tenants: Mutex::new(HashMap::new()),
            buffer: buffer.max(1),
            backlog: backlog.max(1),
        }
    }

    /// The tenant's live channel, created on first use.
    pub fn channel(&self, tenant_id: Uuid) -> SseBroadcaster<StudioEventDto> {
        let mut tenants = self.lock();
        tenants
            .entry(tenant_id)
            .or_insert_with(|| TenantChannel {
                live: SseBroadcaster::new(self.buffer),
                backlog: VecDeque::new(),
                latest_seq: 0,
            })
            .live
            .clone()
    }

    /// Everything after `after_seq`, oldest first, plus the tenant's current
    /// high-water mark so a client can tell whether it fell out of the window.
    pub fn since(
        &self,
        tenant_id: Uuid,
        after_seq: i64,
        limit: usize,
    ) -> (Vec<StudioEventDto>, i64) {
        let tenants = self.lock();
        let Some(channel) = tenants.get(&tenant_id) else {
            return (Vec::new(), 0);
        };
        let events = channel
            .backlog
            .iter()
            .filter(|e| e.seq > after_seq)
            .take(limit)
            .cloned()
            .collect();
        (events, channel.latest_seq)
    }

    /// Poisoned-lock recovery: a panic while holding this lock would otherwise
    /// take the whole channel down for the rest of the process, and the state
    /// behind it is a best-effort cache, not a ledger.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Uuid, TenantChannel>> {
        self.tenants
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl StudioEventPublisher for StudioEventHub {
    fn publish(&self, event: StudioEvent) {
        let at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);

        // Assign the cursor, record it for replay, and take a handle to send
        // on — all inside one short critical section, the send itself outside
        // it (broadcasting never blocks, but the lock has no business being
        // held across it).
        let (live, dto) = {
            let mut tenants = self.lock();
            let channel = tenants
                .entry(event.tenant_id)
                .or_insert_with(|| TenantChannel {
                    live: SseBroadcaster::new(self.buffer),
                    backlog: VecDeque::new(),
                    latest_seq: 0,
                });
            channel.latest_seq += 1;
            let dto = StudioEventDto {
                seq: channel.latest_seq,
                at_ms,
                kind: event.kind,
                subject_type: event.subject_type,
                subject_id: event.subject_id,
                source: event.source,
                payload: event.payload,
            };
            channel.backlog.push_back(dto.clone());
            while channel.backlog.len() > self.backlog {
                channel.backlog.pop_front();
            }
            (channel.live.clone(), dto)
        };

        live.send(dto);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use serde_json::json;

    fn event(tenant: Uuid, kind: &str) -> StudioEvent {
        StudioEvent::new(tenant, kind, "task", "t-1", "test").with_payload(json!({ "ok": true }))
    }

    #[test]
    fn cursor_is_per_tenant_and_since_returns_only_what_is_newer() {
        let hub = StudioEventHub::new(8, 8);
        let tenant = Uuid::new_v4();
        for kind in ["task.queued", "task.running", "task.succeeded"] {
            hub.publish(event(tenant, kind));
        }

        let (all, latest) = hub.since(tenant, 0, 10);
        assert_eq!(latest, 3);
        assert_eq!(
            all.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![1, 2, 3],
            "cursors are dense and ordered"
        );

        let (tail, _) = hub.since(tenant, 2, 10);
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].kind, "task.succeeded");
    }

    #[test]
    fn one_tenants_events_are_invisible_to_another() {
        let hub = StudioEventHub::new(8, 8);
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        hub.publish(event(a, "task.queued"));
        hub.publish(event(a, "task.succeeded"));

        let (theirs, latest) = hub.since(b, 0, 10);
        assert!(theirs.is_empty(), "b sees nothing a published");
        assert_eq!(latest, 0, "and cannot infer a's volume from the cursor");

        hub.publish(event(b, "task.queued"));
        let (theirs, latest) = hub.since(b, 0, 10);
        assert_eq!(theirs.len(), 1);
        assert_eq!(latest, 1, "b's own cursor starts at 1, not after a's");
    }

    #[test]
    fn the_replay_window_is_bounded_but_the_high_water_mark_is_not() {
        let hub = StudioEventHub::new(8, 3);
        let tenant = Uuid::new_v4();
        for _ in 0..10 {
            hub.publish(event(tenant, "task.progress"));
        }

        let (retained, latest) = hub.since(tenant, 0, 100);
        assert_eq!(retained.len(), 3, "only the window is kept");
        assert_eq!(
            retained.first().map(|e| e.seq),
            Some(8),
            "and it is the newest end of it"
        );
        // A client whose cursor is older than the window sees `latest_seq` run
        // past the last event it got — that is how it learns it fell behind.
        assert_eq!(latest, 10);
    }

    #[tokio::test]
    async fn a_subscriber_receives_what_is_published_for_its_tenant() {
        let hub = StudioEventHub::new(8, 8);
        let tenant = Uuid::new_v4();
        // Subscribe first: the broadcaster only delivers what is sent after.
        let mut stream = Box::pin(hub.channel(tenant).subscribe_stream());

        hub.publish(event(tenant, "task.succeeded"));

        let received = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
            .await
            .expect("an event should arrive on the live channel")
            .expect("the stream should not end");
        assert_eq!(received.kind, "task.succeeded");
        assert_eq!(received.seq, 1);
    }
}
