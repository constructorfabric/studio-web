# studio-theia

The backend-to-backend bridge between studio-backend and the Theia node backend
running inside a session (ADR-0022).

The design — why the bridge exists, how a session is found, how the ingress
authenticates by the per-session S2S token, where forwarded events go, the
REST surface — is
[`docs/design/studio-theia.md`](../../../docs/design/studio-theia.md). This
README is what you need to work in the directory.

## In the assembly

- Gear `studio-theia`, capabilities `[rest]`, no declared gear deps
  (`studio-session`'s discovery client and the `studio-events` publisher are
  looked up lazily from the ClientHub).
- Behind the **`theia-bridge`** Cargo feature; dormant unless
  `studio-theia.enabled = true`, and a session carries a control token only
  with `studio-session.theia_control_enabled`.
- Forwarded events go to `studio-events` by default. The
  **`theia-event-broker`** feature (implies `theia-bridge`) swaps that sink for
  the `event-broker` one, whose GTS ids are still placeholders.
- Config section `gears.studio-theia`: `enabled`, `event_ingress_path`,
  `request_timeout_secs`; `control_port` and `s2s_token_env` are read but
  unused.
- Read next: `docs/theia-bridge-architecture.md`,
  `docs/theia-bridge-local-docker.md`, and in the repository root
  `docs/adr/0022-theia-backend-bridge.md` plus `docs/theia-bridge-contract-v1.md`.
