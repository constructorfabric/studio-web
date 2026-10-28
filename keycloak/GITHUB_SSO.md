# GitHub SSO through Keycloak

Constructor Studio uses the existing `studio` Keycloak realm as an identity
broker. GitHub is the external identity provider; Studio itself continues to
consume the same OIDC issuer and does not receive or store GitHub OAuth tokens.

Access is restricted to active members of the GitHub organization
`constructorfabric`. The custom Keycloak GitHub provider calls
`GET /user/memberships/orgs/constructorfabric` during every OAuth login, before
the broker can create or link a user. Only a `200` response whose membership
state is `active` is accepted. Pending memberships, missing memberships,
insufficient OAuth scopes, organization-blocked OAuth Apps, and GitHub API
failures are denied. The provider does not store the GitHub access token.

## Who may sign in: `requireOrganization`

Signing in proves who a person is and grants nothing (ADR-0051 §1), so whether
the organization check runs is the installation's policy, set on the `github`
identity provider's config:

| Setting | Effect |
| --- | --- |
| `requireOrganization` absent or `"true"` | The membership check above runs on every login. This is the default, so no installation opens by accident. |
| `requireOrganization: "true"`, `organization` blank | Every GitHub login fails. A mistyped organization must not mean "everybody". |
| `requireOrganization: "false"` | No membership call is made; any GitHub account signs in, as with Keycloak's stock GitHub broker. `organization` is ignored. |

Only the exact string `false` (any case) turns the check off; any other value
keeps it on. dev and test keep it on with `organization: constructorfabric`,
as `realm-studio.json` sets. A cloud installation, which admits any verified
identity, sets `"requireOrganization": "false"` in its environment realm (or
switches **Require GitHub organization membership** off in the Admin Console
under Identity providers > github). Either way, a newly admitted person has no
organization membership; Studio decides that, not Keycloak.

## OAuth Apps

Create a separate organization-owned GitHub OAuth App for each environment.
An organization owner or a user with administrative access to the organization
must perform this step.

| Environment | Homepage URL | Authorization callback URL |
| --- | --- | --- |
| dev | `https://studio-dev.cfabric.org` | `https://studio-dev.cfabric.org/auth/realms/studio/broker/github/endpoint` |
| test | `https://studio-test.cfabric.org` | `https://studio-test.cfabric.org/auth/realms/studio/broker/github/endpoint` |

Suggested names are `Constructor Studio Dev` and `Constructor Studio Test`.
The Keycloak provider requests only `user:email read:org`: email is needed for
the local Keycloak identity and `read:org` is needed to see private organization
membership. No repository scope is requested.

If the organization restricts OAuth App access, an organization owner must
approve both applications for `constructorfabric`.

## Kubernetes credentials

Never commit the OAuth client secret or put it into a Helm values file. Store
the client ID and secret in an environment-local Kubernetes Secret mounted by
Keycloak's files-plaintext vault. Keycloak resolves `${vault.github-client-id}`
and `${vault.github-client-secret}` from the files named below.

The following PowerShell keeps entered values out of command history:

```powershell
$githubClientId = Read-Host "GitHub OAuth Client ID"
$githubClientSecretSecure = Read-Host "GitHub OAuth Client Secret" -AsSecureString
$githubClientSecret = [Net.NetworkCredential]::new("", $githubClientSecretSecure).Password

kubectl -n studio-dev create secret generic studio-web-keycloak-vault `
  --from-literal=studio_github-client-id="$githubClientId" `
  --from-literal=studio_github-client-secret="$githubClientSecret" `
  --dry-run=client -o yaml | kubectl apply -f -

Remove-Variable githubClientSecret, githubClientSecretSecure, githubClientId
```

Repeat for `studio-test` using that environment's independent OAuth App and
namespace. Restrict read access to this Secret to the Keycloak deployment and
the namespace-scoped infrastructure deployer.

## Build and rollout

1. Merge the Keycloak extension and realm changes.
2. Publish an immutable `infra-v*` release. The infrastructure build compiles
   and tests the restricted GitHub provider before producing
   `cf-studio-keycloak`.
3. Create `studio-web-keycloak-vault` in the target namespace.
4. Update the environment's `studio-web-keycloak-realm` from
   `keycloak/realm-studio.json`. Realm startup import is only effective for a
   new realm; for an existing realm, use Keycloak Admin Console partial import
   with `keycloak/github-sso-partial-import.json` and select **Overwrite**.
5. Run **Deploy Infra** for dev with the new `infra-v*` tag.
6. Test an active organization member and a non-member account before promoting
   the same immutable image to test.

## Expected identity

On first successful login Keycloak creates and links a realm user whose
username comes from the GitHub login and whose email comes from GitHub's primary
email endpoint. The `github-tenant-id` mapper assigns the sandbox tenant
`00000000-0000-0000-0000-000000000002`; the root admin remains in tenant
`00000000-0000-0000-0000-000000000001`.

Removing a person from `constructorfabric` blocks their next GitHub login. It
does not delete their Keycloak record, which preserves audit references.

## Google and Microsoft

`realm-studio.json` defines the `google` and `microsoft` brokers next to
`github`, disabled. Their client credentials come from the same vault Secret
as GitHub's, by the same `${vault.<key>}` references:

| Broker | Vault references | Keys in `studio-web-keycloak-vault` |
| --- | --- | --- |
| `google` | `${vault.google-client-id}`, `${vault.google-client-secret}` | `studio_google-client-id`, `studio_google-client-secret` |
| `microsoft` | `${vault.microsoft-client-id}`, `${vault.microsoft-client-secret}` | `studio_microsoft-client-id`, `studio_microsoft-client-secret` |

There is no chart switch for a broker: an installation enables one in its own
realm, which is the environment-local `studio-web-keycloak-realm` Secret.

1. Register an OAuth client with the provider (a Google Cloud OAuth client, or
   a Microsoft Entra app registration). The redirect URI is
   `https://<studio host>/auth/realms/studio/broker/<alias>/endpoint`, with
   `<alias>` `google` or `microsoft`.
2. Add both keys to `studio-web-keycloak-vault`, as for GitHub above. Pass
   every key the Secret should keep: `kubectl create secret ... | kubectl
   apply` replaces the whole Secret, so leaving out the GitHub keys removes
   them.
3. Set `"enabled": true` on the broker in the environment's realm JSON and
   apply it: on a new realm through the startup import, on an existing one
   through Admin Console partial import, or by switching the broker on in
   Identity providers.

A brokered user gets the sandbox tenant through the broker's `*-tenant-id`
mapper, exactly as a GitHub user does, and no organization membership.
