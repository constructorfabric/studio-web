# Architecture decision records

Every ADR of this repository, in one sequence. Each record follows the MADR
shape of Studio's built-in ADR template (`studio-backend/src/documents/templates/adr.md`):
front matter with `type: adr`, `status` and `date`; an `**ID**` built from the file
name, e.g. `cpt-studio-adr-theia-sessions` for ADR-0003 (ADR-0010 keeps the id it already had,
`cpt-studiofrontend-adr-projects-as-am-tenants`); then Context and Problem
Statement, Considered Options where the record weighed any, Decision Outcome
with its Consequences and, where the record has one, its Confirmation; More
Information for the record's phases, follow-ups and notes; and Traceability to
the [PRD](../prd/constructor-studio.md) and [DESIGN](../design/constructor-studio.md)
ids it bears on. The status in the table is the one each record declares; a
later ADR that retires or amends an earlier one says so under its title.

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](0001-identity-mapping.md) | Identity mapping for external systems — Studio domain gear, not an IdP plugin | proposed | 2026-07-28 |
| [0002](0002-projects-as-resource-groups.md) | Projects — Resource Group-backed in v0.1, domain gear later | accepted | 2026-07-28 |
| [0003](0003-theia-sessions.md) | Per-workspace Theia IDE sessions in containers | accepted | 2026-07-30 |
| [0004](0004-users-onboarding-roles.md) | User onboarding, provisioning, and roles | accepted | 2026-08-03 |
| [0005](0005-projects-domain-gear.md) | Projects — a domain gear (supersedes the v0.1 decision in ADR-0002) | accepted | 2026-08-07 |
| [0006](0006-frontend-rebuild-on-frontx.md) | Rebuild the portal frontend on FrontX | accepted | 2026-08-11 |
| [0007](0007-shell-tokens-as-whole-colours.md) | Shell theme tokens hold whole colours | accepted | 2026-08-18 |
| [0008](0008-simplified-navigation-shell.md) | Simplified navigation shell — overlay drawer, top bar, context slot | accepted | 2026-08-18 |
| [0009](0009-roles-over-tenant.md) | Role-based access is layered over the tenant model | accepted | 2026-08-19 |
| [0010](0010-projects-are-am-tenants.md) | A project is an AM tenant — the client mirrors the retired gear's rules | accepted | 2026-08-23 |
| [0011](0011-authentication-does-not-grant-organization-membership.md) | Authentication does not grant organization membership | accepted | 2026-08-27 |
| [0012](0012-self-service-identity-resolution.md) | Attributing an external identity is self-service, and only a proof of control binds | proposed | 2026-09-07 |
| [0013](0013-types-registry-catalogs-meaning-graph-storage-contracts-storage.md) | The types-registry catalogs meaning, graph-storage contracts storage | proposed | 2026-09-08 |
| [0014](0014-document-types-are-components.md) | A document type is a component, not a GTS type | proposed | 2026-09-08 |
| [0015](0015-a-brokered-login-is-a-proof-of-control.md) | A brokered login is a proof of control, and Keycloak only tells you if you ask | proposed | 2026-09-10 |
| [0016](0016-membership-is-recorded-where-assignment-happens.md) | Membership is recorded where assignment happens, and read where access is decided | proposed | 2026-09-10 |
| [0018](0018-an-identity-proves-it-is-you-and-decides-nothing-else.md) | An identity proves it is you; the person decides everything else | proposed | 2026-09-11 |
| [0019](0019-a-role-narrows-what-a-member-may-do.md) | A role narrows what a member may do, and nothing else | proposed | 2026-09-14 |
| [0020](0020-one-contract-with-the-frontend.md) | One contract with the frontend, enforced rather than agreed | proposed | 2026-09-14 |
| [0021](0021-an-mfe-entry-may-be-a-frame.md) | An MFE entry may be a frame, and its address arrives at runtime | accepted | 2026-09-22 |
| [0022](0022-theia-backend-bridge.md) | Backend-to-backend bridge between studio-backend and the Theia IDE | proposed | 2026-08-24 |
| [0023](0023-canonical-user-and-identity-mapper.md) | A canonical Studio user, its sign-in methods, and the identity mapper | proposed | 2026-09-04 |
| [0024](0024-domain-model-in-graph-storage.md) | The Studio domain model lives in Graph Storage and the type registry | proposed | 2026-09-08 |
| [0025](0025-the-person-is-the-key-not-the-login.md) | The person is the key on the request path, not the login | proposed | 2026-09-10 |
| [0026](0026-studio-events-push-channel.md) | One push channel to the portal, and it is not anyone's protocol | accepted | 2026-09-11 |
| [0027](0027-a-desktop-session-keeps-the-secrets-on-the-server.md) | A desktop Studio is a session on the member's machine, and the secrets stay on the server | accepted | 2026-09-24 |
| [0028](0028-the-address-decides-where-the-shell-is.md) | The address decides where the shell is, and the shell alone writes it | accepted | 2026-09-24 |

ADR-0017 is not on `main`. It is "We own the settings gear for now", written on
the unmerged branch `AndrejK666/settings-follow-the-person`, and ADR-0018 cites
it; the number stays reserved for that record.

## Renumbered records

Until 2026-09-24 ADRs lived in two trees, `docs/adr/` (product and shell
decisions) and `studio-backend/docs/adr/` (backend-domain decisions), and five
numbers were used twice. The two trees are now this one directory. Every number
that was unique across both kept it; in each collision the earlier record kept
the number and the later one moved to the next free number, in date order.
Cross-references in the repository's Markdown were updated to the new numbers.

| Old | New | Record | Was in | Kept the old number |
|---|---|---|---|---|
| ADR-0010 | ADR-0022 | Backend-to-backend bridge between studio-backend and the Theia IDE (2026-08-24) | `docs/adr/` | ADR-0010, a project is an AM tenant (2026-08-23) |
| ADR-0006 | ADR-0023 | A canonical Studio user, its sign-in methods, and the identity mapper (2026-09-04) | `studio-backend/docs/adr/` | ADR-0006, rebuild the portal on FrontX (2026-08-11) |
| ADR-0012 | ADR-0024 | The Studio domain model lives in Graph Storage and the type registry (2026-09-08) | `docs/adr/` | ADR-0012, self-service identity resolution (2026-09-07) |
| ADR-0014 | ADR-0025 | The person is the key on the request path, not the login (2026-09-10) | `studio-backend/docs/adr/` | ADR-0014, a document type is a component (2026-09-08) |
| ADR-0013 | ADR-0026 | One push channel to the portal, and it is not anyone's protocol (2026-09-11) | `docs/adr/` | ADR-0013, the types-registry / graph-storage split (2026-09-08) |

These records moved from `studio-backend/docs/adr/` without a new number:
0001, 0002, 0003, 0005, 0012, 0013, 0014, 0015 and 0016.

Source comments in code and configuration still cite the old numbers where they
mean a renumbered record; read an old `ADR-0010` next to the Theia bridge as
ADR-0022, an old backend `ADR-0006` about the canonical user as ADR-0023, an
old `ADR-0014` about the person resolver as ADR-0025, and an old `ADR-0013`
about the push channel as ADR-0026.
