# studio-presence

Who is in Studio right now, and a way to leave them a note.

The design — why presence is heartbeats rather than connections, why a note is
held in memory and refused for somebody offline, the limits and the REST
surface — is
[`docs/design/studio-presence.md`](../../../docs/design/studio-presence.md).
This README is what you need to work in the directory.

## In the assembly

- Gear `studio-presence`, capabilities `[rest]`, no dependencies, no config,
  no database.
- State is per process and per replica, and empties on restart until each
  client's next heartbeat.
- The limits are constants in `registry.rs`: `HEARTBEAT_MS` (30 s),
  `ONLINE_TTL_MS` (three heartbeats), `MAX_LABEL` (120), `MAX_MESSAGE` (1,000),
  `MAX_INBOX` (20).

## Working here

- The registry's rules are unit tests in `registry.rs`, driven by explicit
  timestamps rather than the clock.
