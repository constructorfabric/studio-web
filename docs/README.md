# Documentation

This directory holds the specifications of Constructor Studio Web in the layout
Constructor Studio's own document pipeline reads (`docs/<type>/<slug>.md`, see
[documents-from-a-repository.md](documents-from-a-repository.md)), plus the
notes, contracts and runbooks that are not specifications.

## Specifications

Each file starts with front matter that declares its type (`type: prd`,
`design`, `decomposition`, `feature` or `adr`) and follows the section layout of
that type's built-in template in `studio-backend/src/documents/templates/`, so it
is classified and validated without guessing. The documents are tied together
by `cpt-` ids: the PRD defines actors, requirements and use cases; the design
defines principles, constraints, components, interfaces and tables and cites
the requirements; the decomposition defines one entry per feature area and
cites both; each feature spec cites its entry and requirements; each ADR
defines its own id and cites what it bears on. Every id is defined once.
[`scripts/check-docs.mjs`](../scripts/check-docs.mjs) checks all of this, as well as
that every link resolves and every document is listed here; CI runs it.

| Directory | Type | What is in it |
|---|---|---|
| [`prd/`](prd/) | PRD | [Constructor Studio](prd/constructor-studio.md): the problem, users, requirements and capabilities of the product. Built from [`PRODUCT.md`](../PRODUCT.md), which stays the product brief. |
| [`design/`](design/) | Design | [Constructor Studio](design/constructor-studio.md): the architecture — backend gears, portal, IDE session, storage, interfaces. |
| [`decomposition/`](decomposition/) | Decomposition | [Constructor Studio](decomposition/constructor-studio.md): which gears and packages cover which capability, the features, and what comes next. |
| [`feature/`](feature/) | Feature | One spec per portal feature: [shell levels](feature/shell-levels.md), [workspaces in scope](feature/workspace-scope.md), [the organization's workspaces](feature/workspaces-screen.md), [organization overview](feature/organization-overview.md), [create a project](feature/project-create.md), [connect a source](feature/connection-create.md), [project artifacts](feature/project-artifacts.md), [the organization's people](feature/organization-people.md), [the editor's session](feature/editor-session.md), [the editor's bridge](feature/editor-bridge.md). Moved from `studio-frontend/docs/sdlc/FEATURE/`. |
| [`adr/`](adr/README.md) | ADR | Every architecture decision record in one sequence, with the index and the table of renumbered records. |

## Not specifications

These documents are contracts, notes, reports and runbooks. They are read by
people and linked from the specifications, but they are not written against a
document type and should be marked "Not a doc" when Studio ingests the
repository.

**Contracts and catalogues** — the rules the code is held to:

- [api-conventions.md](api-conventions.md) — the REST and event contract (ADR-0020).
- [errors-catalog.md](errors-catalog.md) — the canonical error categories.
- [events-catalog.md](events-catalog.md) — the `studio-events` vocabulary.
- [theia-bridge-contract-v1.md](theia-bridge-contract-v1.md) — the wire surface of the Theia bridge (ADR-0022).

**Notes and explanations:**

- [documents-from-a-repository.md](documents-from-a-repository.md) — how documents already in a repository are classified and validated.
- [backend-handover.md](backend-handover.md) — how the backend works, for someone taking it over.
- [frontend-handover-hardcode.md](frontend-handover-hardcode.md) — what the prototype knows that the contract does not tell it.
- [concept-v2-project-is-the-unit.md](concept-v2-project-is-the-unit.md) — an exploration, not accepted.
- [domain-alignment.md](domain-alignment.md) — the portal against the Studio product domain model.
- [roadmap-alignment.md](roadmap-alignment.md) — the Q3 roadmap against what the prototype has de-risked.
- [gear-intelligence-sync.md](gear-intelligence-sync.md) — importing delivery evidence for the gear catalogue.
- [kit-registry-prototype.md](kit-registry-prototype.md) — the kit registry's prototype slice.
- [rendered-markdown-diff.md](rendered-markdown-diff.md) — two versions of a document rendered side by side: where it opens from, how it compares, how other extensions call it.
- [spec-findings.md](spec-findings.md) — a proposal: what Studio reports about a specification, where in the text, and what a person can do with it.
- [desktop-studio.md](desktop-studio.md) — the desktop Studio: how it works and how to run it (ADR-0027).
- [desktop-release-notes.md](desktop-release-notes.md) — what a member notices in each desktop release, and what does not work yet.
- [sharing-documents-without-git.md](sharing-documents-without-git.md) — *Share with the team*, saves that change only what was edited, and why the assistant panel no longer opens on its own.

**Runbooks:**

- [desktop-contributing.md](desktop-contributing.md) — the rules for changing the desktop Studio.
- [deploy-k8s-cicd.md](deploy-k8s-cicd.md) — an earlier Kubernetes and CI/CD proposal; the current procedure is [`deploy/README.md`](../deploy/README.md) and [`deploy/PIPELINES.md`](../deploy/PIPELINES.md).
- [verifying-the-collaboration-work.md](verifying-the-collaboration-work.md) — how to check the collaborative editing work end to end.

Elsewhere in the repository, the READMEs (the root, `studio-backend/`, each gear
under `studio-backend/src/`, `theia/` and its packages, `deploy/`, `keycloak/`),
`studio-backend/docs/` (handovers, reports, upstream requests and pull-request
drafts), `studio-frontend/docs/`, `PRODUCT.md` and `TASKS.md` are likewise not
specifications.
