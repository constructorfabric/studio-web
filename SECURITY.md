# Security Policy

This repository follows the Constructor Fabric
[organization security policy](https://github.com/constructorfabric/governance/blob/main/SECURITY.md).
This page adds what is specific to Constructor Studio Web.

## Reporting a vulnerability

**Do not report a vulnerability in a public issue, pull request, discussion or
Discord channel.**

Report it privately through
[GitHub private vulnerability reporting](https://github.com/constructorfabric/studio-web/security/advisories/new).
If the issue spans several repositories — for example, a flaw in a
[Gears](https://github.com/constructorfabric/gears-rust) gear that Studio Web
also exposes — email
[contact@constructorfabric.org](mailto:contact@constructorfabric.org) instead, or
report it in each affected repository.

Please include the component, the commit, image or release tag you found it on
(`sha-<commit>`, `v*`, `desktop-v*`), steps to reproduce, and the impact as you see it. The
[organization policy](https://github.com/constructorfabric/governance/blob/main/SECURITY.md#what-to-include)
lists everything that helps.

We acknowledge a report within a few business days, keep you informed until
it is fixed, and credit you in the advisory unless you prefer otherwise. Please
keep the details private until a fix is released.

## Supported versions

| Version | Supported |
|---|---|
| `main` and the images built from it (`edge`, `sha-<commit>`) | Yes |
| The latest `v*` release | Yes |
| The latest desktop Studio release (`desktop-v*`) | Yes |
| Older releases | No — upgrade to the latest release |

## What is in scope

Studio Web runs other people's code and holds their credentials, so these
matter most:

- **Isolation between organizations, projects and people** — reading or
  changing another tenant's data, documents, settings or files.
- **Identity** — signing in as someone else, or an identity that grants access
  it should not ([ADR-0018](docs/adr/0018-an-identity-proves-it-is-you-and-decides-nothing-else.md),
  [ADR-0025](docs/adr/0025-the-person-is-the-key-not-the-login.md)).
- **Roles** — a member doing what their role does not allow
  ([ADR-0019](docs/adr/0019-a-role-narrows-what-a-member-may-do.md)).
- **Stored credentials** — Git tokens, connector secrets and LLM keys leaving
  the server, or reaching another person
  ([ADR-0027](docs/adr/0027-a-desktop-session-keeps-the-secrets-on-the-server.md)).
- **IDE sessions** — escaping a session, reaching another session, or reaching
  the cluster or host from one.

Out of scope: the development credentials published in this repository
(`admin` / `studio`, the local Keycloak and PostgreSQL passwords, the dev TLS
certificate), which exist only for a local Compose stack, and findings that
need an already compromised host or cluster administrator.

## Handling secrets in this repository

- Never commit real keys, tokens, passwords, kubeconfigs or private
  certificates, and never commit `.env`.
- Shared environments read their secrets from GitHub Environments and
  Kubernetes Secrets; the contract is in [`deploy/README.md`](deploy/README.md).
- CI deploys with a namespace-scoped `studio-deployer` kubeconfig, never a
  cluster-admin one.
- A secret committed by mistake is leaked: rotate it first, then remove it from
  the history.
