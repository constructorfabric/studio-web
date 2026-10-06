# What Studio asks of the platform

Studio is built on gears it does not own. When one of them cannot express
something Studio needs, the request is written down here, against the release
Studio runs, with what Studio does in the meantime. These documents are kept
current: when an ask is answered, released or dropped, its status says so, and
the workaround it names is removed from the code.

| Document | Asks of | What it holds |
|---|---|---|
| [graph-storage-requests.md](graph-storage-requests.md) | graph-storage | What the gear cannot express — payload filters, counts, offsets, typed updates — and the workarounds, among them `studio_artifact_index` (item 5) |
| [account-management-requests.md](account-management-requests.md) | account-management | What Studio needs from tenants, memberships and roles (cited by ADR-0019) |
| [gears-rust-issues.md](gears-rust-issues.md) | gears-rust | Issue drafts found while building the backend, with their status after the gears team's replies |
| [spec-quality-issues.md](spec-quality-issues.md) | the spec-quality service | Issue drafts found while wiring the detectors into Studio |

A request that has been sent and closed, and is only history, moves to
[`../inbox/`](../inbox/README.md).
