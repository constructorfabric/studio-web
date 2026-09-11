//! Wire shapes: what a subscriber receives.
//!
//! One type serves both transports — an SSE frame and an element of the
//! catch-up page — so a client parses the same JSON whether it arrived live or
//! was replayed after a reconnect.

use serde_json::Value;

/// One event as it goes over the wire.
///
/// Sent as an **unnamed** SSE frame (`data:` only, no `event:` line): the
/// frontx SSE protocol binds `onmessage`, which never fires for named frames,
/// so the discriminator has to live inside the JSON. That is what `kind` is.
#[derive(Debug, Clone)]
#[toolkit_macros::api_dto(response)]
pub struct StudioEventDto {
    /// Monotonic per-process cursor. A client remembers the last one it saw
    /// and replays the gap with `?after_seq=` after a reconnect.
    pub seq: i64,
    /// Milliseconds since the Unix epoch (`new Date(at_ms)` in the browser).
    /// Epoch millis rather than RFC 3339 so no timezone or format negotiation
    /// is involved on a channel whose whole point is being cheap to parse.
    pub at_ms: i64,
    /// What happened: `task.running`, `task.succeeded`, …
    pub kind: String,
    /// What it happened to: `task`, `repository`, …
    pub subject_type: String,
    /// The subject's id.
    pub subject_id: String,
    /// The gear that observed it.
    pub source: String,
    /// Type-specific detail, verbatim from the producer.
    #[schema(value_type = Object)]
    pub payload: Value,
}

/// A page of replayed events, newest last.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct StudioEventPage {
    /// Events with `seq` greater than the requested cursor, in order.
    pub events: Vec<StudioEventDto>,
    /// The highest `seq` this tenant has produced, whether or not it is in
    /// `events`. A client that is further behind than the retained window sees
    /// `latest_seq` jump past the last element and knows it lost events.
    pub latest_seq: i64,
}
