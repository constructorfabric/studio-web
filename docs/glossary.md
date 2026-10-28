---
artifact: glossary
---

# Glossary

These terms are used with exactly this meaning in every document of the project. Link a term where a document first uses it — to `../glossary.md#member` from a specification under `docs/` — instead of saying again what it means. The names under *Also written as* mean the same thing; use the term, not them, in new text.

<!-- Kept by Constructor Studio from the Glossary tab: one row per term. Edit it here or there. -->

| Term | Definition | Also written as | Not the same as | Source |
|---|---|---|---|---|
| <a id="organization"></a>**Organization** | An account-management tenant that owns members, the shared connection catalogue and the access config. Hidden from navigation in concept v2, not removed. | — | — | — |
| <a id="workspace"></a>**Workspace** | An account-management tenant of type `workspace` under an organization. Concept v2 calls it a root project; the wire keeps `workspace` and `workspace_id` (ADR-0010). | — | — | — |
| <a id="project"></a>**Project** | A tenant nested under a workspace; its attributes are tenant metadata (ADR-0010). | — | — | — |
| <a id="member"></a>**Member** | A person with a membership in an organization, recorded by `studio-user` (ADR-0016). | — | — | — |
| <a id="gear"></a>**Gear** | A CF/Gears module linked into the backend binary and registered at link time through `inventory`. A Studio gear lives in `studio-backend/src/`; a platform gear comes from gears-rust. | — | — | — |
| <a id="plugin"></a>**Plugin** | A gear that implements another gear's plugin contract, for example a connector plugin for `studio-connector` or an AuthZ resolver plugin. | — | — | — |
| <a id="connection"></a>**Connection** | A configured credential for one provider (source host, model provider or chat platform), owned by a tenant; its secret is a credstore reference. | — | — | — |
| <a id="session"></a>**Session** | A running Theia IDE container or Pod for one workspace, managed by `studio-session`. | — | — | — |
| <a id="studio-document"></a>**Studio document** | A document written or uploaded in Studio: a row in `studio_documents` (`studio-documents`) with its text and a type fixed at creation. A project lists its own and, `inherited`, its workspace's. | — | [Project artifact](#project-artifact), a file stored in S3 | — |
| <a id="document-type"></a>**Document type** | A template, section checklist and rules a document is validated against (`studio-documents`). | — | — | — |
| <a id="binding"></a>**Binding** | The record that ties a repository file's knowledge-graph node to a document type, with its detection state and validation report (`studio_document_bindings`). | — | — | — |
| <a id="capability"></a>**Capability** | A key of the capability vocabulary a PRD declares (`domain`, `tenancy`, `auth`, `authz`, `storage`, `connectors`, `facade`, `billing`, `compliance`, `deploy`), from which gears are suggested. The vocabulary translates each key into the contracts that satisfy it. | — | — | — |
| <a id="contract"></a>**Contract** | What the Gearbox engine reports a gear doing for others, so it is checked rather than read from prose: a contract the gear provides (`<gear>/<Trait>@v<N>`, projected from `#[toolkit::provides]`), the GTS spec of an extension point it hosts, or the spec of the point it implements as a plugin. | — | — | — |
| <a id="mapping"></a>**Mapping** | A capability of a specification paired with the gear that covers it, or with nothing (a gap); proposed by the system, decided by a member. | — | — | — |
| <a id="kit"></a>**Kit** | A bundle of templates, prompts and checklists kept in its own Git repository and installed into a project's checkout by `cfs`. | — | — | — |
| <a id="product"></a>**Product** | A `product.gdl` composed from picked gears and resolved by the Gearbox engine. | — | — | — |
| <a id="run"></a>**Run** | One unit of durable background work in `studio-tasks`. | — | — | — |
| <a id="access-config"></a>**Access config** | Per-organization document holding model, roles and grants | — | — | `docs/adr/0019-a-role-narrows-what-a-member-may-do.md:158` |
| <a id="alias"></a>**Alias** | A non-login identifier (kind, external_id) attributed to a user | — | — | `docs/adr/0023-canonical-user-and-identity-mapper.md:83` |
| <a id="batch-run"></a>**Batch run** | Component for task type spec_quality.analyze_batch | — | — | `docs/design/studio-spec-quality.md:197` |
| <a id="component"></a>**Component** | the catalogue entry itself as publishable bytes, changed by its publisher, a kit in Git with a manifest | — | — | `docs/adr/0014-document-types-are-components.md:138` |
| <a id="connection-catalogue"></a>**Connection catalogue** | ConnectorService component owning which connections exist, where tokens are, how a driver call is assembled | — | — | `docs/design/studio-connector.md:213` |
| <a id="desktop-session"></a>**Desktop session** | A second kind of session in studio-session, a lease with an expiry, with no container, gate token, control port or S2S token | — | — | `docs/adr/0027-a-desktop-session-keeps-the-secrets-on-the-server.md:140` |
| <a id="document"></a>**Document** | Authored document stored in studio_documents with its text | — | — | `docs/adr/0037-one-model-for-a-project.md:37` |
| <a id="document-analysis"></a>**Document analysis** | Verdict of a detector on a document or binding | — | — | `docs/design/studio-documents.md:545` |
| <a id="editor-session"></a>**Editor session** | The project's Theia session, reused when one is alive and launched when not. | — | [Editor](../studio-frontend/GLOSSARY.md#editor) | `docs/feature/editor-session.md:52` |
| <a id="event"></a>**Event** | A producer states kind and subject, puts its own vocabulary in payload; the channel assigns seq and at_ms | — | — | `docs/design/studio-events.md:29` |
| <a id="finding"></a>**Finding** | Interpretation of a finished analysis result, with an id. | — | — | `docs/design/studio-spec-quality.md:51` |
| <a id="gearbox-engine"></a>**Gearbox engine** | A tool a desktop session receives. | — | — | `docs/adr/0032-the-desktop-gets-its-tools-as-extensions.md:265` |
| <a id="grant"></a>**Grant** | Role grant to a subject, scoped to org or project | — | — | `docs/adr/0009-roles-over-tenant.md:54` |
| <a id="ide-session"></a>**IDE session** | Theia node backend inside a session container; serves IDE, exposes internal control API, posts events to backend ingress | — | — | `docs/prd/constructor-studio.md:184` |
| <a id="identity"></a>**Identity** | an identity, distinct from the person; proves who you are | — | — | `docs/adr/0018-an-identity-proves-it-is-you-and-decides-nothing-else.md:36` |
| <a id="identity-directory"></a>**Identity directory** | Platform administrator's view of every identity in Studio's Keycloak realm, including those in no organization | — | — | `docs/design/studio-identity-directory.md:28` |
| <a id="identitylink"></a>**IdentityLink** | Link of an external identity (system, external_ref) to a platform user | — | — | `docs/adr/0001-identity-mapping.md:76` |
| <a id="installation"></a>**Installation** | what this tenant actually uses; changed by organization / workspace | — | — | `docs/adr/0014-document-types-are-components.md:139` |
| <a id="invitation"></a>**Invitation** | Stored as rows in an invitation table. | — | — | `docs/adr/0018-an-identity-proves-it-is-you-and-decides-nothing-else.md:372` |
| <a id="keycloak"></a>**Keycloak** | Sign-in, GitHub brokering and user provisioning; criticality p1 | — | — | `docs/prd/constructor-studio.md:888` |
| <a id="login"></a>**Login** | A Keycloak user is a login; a person may have two logins | — | — | `docs/adr/0018-an-identity-proves-it-is-you-and-decides-nothing-else.md:43` |
| <a id="mapping-decision"></a>**Mapping decision** | A member's decisions kept as mapping_decision nodes in the artifact graph | — | — | `docs/adr/0037-one-model-for-a-project.md:51` |
| <a id="membership"></a>**Membership** | cpt-studio-component-user holds the membership that makes somebody the owner. | — | — | `docs/design/studio-organizations.md:34` |
| <a id="owner-grant"></a>**Owner grant** | projection of an active owner membership into the document the PDP evaluates | — | — | `docs/adr/0040-one-owner-for-people-and-membership.md:109` |
| <a id="person"></a>**Person** | A person (identity_user) is the profile — name, e-mail, avatar, locale, UI preferences, last seen — and a merged_into pointer once merged away | — | — | `docs/design/studio-user.md:199` |
| <a id="plan"></a>**Plan** | The plan file kept by the planning team. | — | — | `docs/adr/0033-a-report-is-a-definition-over-a-source.md:134` |
| <a id="platform-administrator"></a>**Platform administrator** | A membership of the platform root and nothing else | — | — | `deploy/README.md:42` |
| <a id="project-artifact"></a>**Project artifact** | User-uploaded or Studio-generated artifact stored in S3 | — | — | `deploy/FILE_STORAGE_S3.md:44` |
| <a id="report-source"></a>**Report source** | One report_source node per report per organization. | — | — | `docs/adr/0033-a-report-is-a-definition-over-a-source.md:79` |
| <a id="repository"></a>**Repository** | the connection's driver bound to one owner/name and ref, opened through connectors::sdk | — | — | `docs/design/studio-connector.md:361` |
| <a id="role"></a>**Role** | Role carried in the access config with grants and scopes | — | — | `docs/adr/0019-a-role-narrows-what-a-member-may-do.md:47` |
| <a id="rollups"></a>**Rollups** | Rollups show what each workspace and project contains. | — | — | `docs/design/studio-organizations.md:43` |
| <a id="schedule"></a>**Schedule** | Domain model entity of background work | — | — | `docs/decomposition/constructor-studio.md:1071` |
| <a id="source"></a>**Source** | A repository source of a workspace, configured in project_sources | — | — | `docs/design/studio-git.md:81` |
| <a id="tenant"></a>**Tenant** | Organization, workspace (tenant_type: workspace) or project, owned by account-management | — | — | `docs/design/constructor-studio.md:277` |
| <a id="user"></a>**User** | The canonical person and profile, role-free, with a Studio-owned id independent of any IdP | — | — | `docs/adr/0023-canonical-user-and-identity-mapper.md:78` |
| <a id="change"></a>**Change** | A unit of delivery (a feature, a fix or a reconfiguration) anchored on one work item, whose contents and stage are derived from the objects linked to it. | — | A change request; a commit | `docs/adr/0047-a-change-is-the-unit-that-walks-the-delivery-stages.md` |
| <a id="work-item"></a>**Work item** | One item of a connected tracker (GitHub or GitLab issue, Jira or YouTrack issue), or a Studio-native one when a project has no tracker. | Issue, ticket | A change, which is derived from it | `docs/adr/0047-a-change-is-the-unit-that-walks-the-delivery-stages.md` |
| <a id="change-request"></a>**Change request** | A proposal to merge a branch, whatever the host calls it. | Pull request, merge request | A change | `docs/adr/0047-a-change-is-the-unit-that-walks-the-delivery-stages.md` |
