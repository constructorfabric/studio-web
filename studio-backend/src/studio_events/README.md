# studio-events

The assembly's one push channel to the portal: an SSE stream per tenant, and a
replay page by cursor.

The design — why the channel is domain-neutral, why the sequence and the
window are rows, how an event gets from a producer to a browser on any
replica, the routes and the two tables — is
[`docs/design/studio-events.md`](../../../docs/design/studio-events.md). The
vocabulary producers publish is
[`docs/events-catalog.md`](../../../docs/events-catalog.md). This README is
what you need to work in the directory.

## In the assembly

- Gear `studio-events`, capabilities `[rest, db, stateful]`, no deps.
- Config section `gears.studio-events`: `buffer` (256), `backlog` (500),
  `queue` (1024), `poll_ms` (500). All defaults are usable.
- Database `studio_events`, pool `max_conns: 2`. Without a `database:` block
  the gear stands down: no publisher is registered and both routes answer 503.
- Producers resolve `dyn StudioEventPublisher` from the ClientHub per event,
  never in `init`. A new `kind` or `subject_type` goes into the events catalog
  in the same PR.

## Tests

`store_tests.rs` runs against the shared test PostgreSQL (`crate::test_pg`),
so it needs Docker: `cargo test -- studio_events`.
