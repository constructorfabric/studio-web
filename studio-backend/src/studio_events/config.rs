//! Configuration for the studio-events channel. All defaults are usable; a
//! deployment only touches these to trade memory for a longer replay window.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct StudioEventsConfig {
    /// Per-tenant broadcast buffer. A subscriber further behind than this
    /// drops frames and recovers by cursor.
    #[serde(default = "default_buffer")]
    pub buffer: usize,
    /// How many events per tenant stay replayable through `?after_seq=`.
    /// Sized for a reconnect, not for history.
    #[serde(default = "default_backlog")]
    pub backlog: usize,
}

fn default_buffer() -> usize {
    256
}

fn default_backlog() -> usize {
    500
}

impl Default for StudioEventsConfig {
    fn default() -> Self {
        Self {
            buffer: default_buffer(),
            backlog: default_backlog(),
        }
    }
}
