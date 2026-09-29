# Contributing to the desktop Studio

The rules for changing the desktop Studio — `theia/electron-app` and the
desktop half of `theia/studio`. [desktop-studio.md](desktop-studio.md) is how it
works and how to run it; [ADR-0027](adr/0027-a-desktop-session-keeps-the-secrets-on-the-server.md)
is why. Read both first.

## The rules

### 1. One IDE, two hosts: the web session must not notice

`theia/studio` and `theia/product-ext` run unchanged in the portal's session
(`browser-app`) and on the desktop (`electron-app`). A desktop change that alters
the web session is a regression, however small.

- Branch on the host by what the IDE backend says — `studio-desktop/status`
  answering `enabled` — never by `process.versions.electron`, `isElectron`, a
  build flag or the URL. One bundle is tested for both.
- Desktop-only code lives in `desktop-*` files: `browser/desktop-studio-widget.tsx`,
  `browser/desktop-projects.ts`, `node/desktop-*.ts`, `common/desktop-*.ts`.
  Shared widgets stay host-agnostic and reach Studio through
  `StudioApi.fetch('/<gear>/v1/...')`.
- A shared widget that needs something only the desktop lacks gets it from the
  desktop's `/studio-api` proxy, not from a desktop branch inside the widget.
- The backend's `DesktopStudioContribution` mounts its routes only when a Studio
  is configured. Keep it that way: no `/studio-desktop/*` or `/studio-api`
  route may exist in a session.

### 2. No secret on the member's machine

What ADR-0027 decided, and what review checks first:

- The Studio token lives in the IDE backend's memory. It never reaches the
  frontend, a file, a log line, a URL, or `.git/config`.
- `git` asks the token broker through the credential helper; what is written
  into a clone is the helper's path, never a credential.
- The only files the desktop writes are the member's choice of Studio
  (`~/ConstructorStudio/settings.json`) and the clones. A new file needs a line
  in desktop-studio.md saying what it holds and why it is not a secret.
- A source host's token stays in credstore; the desktop clones through
  `studio-git`, which attaches it server-side.

### 3. Follow the portal, do not re-derive it

The desktop shows the same Studio the portal shows. When the two could
disagree, the portal is right and the desktop copies it:

- **Who may see what** comes from where the portal gets it. Organizations are
  the member's `studio-user` memberships (`/me/memberships`), not the tenant the
  token names; the platform administrator walks the root
  (`studio-frontend/src-app/app/effects/appContextEffects.ts`). Lists are
  `account-management` children filtered by `tenant_type`.
- **The words** are the portal's: a *project* is the tenant of type
  `workspace` (concept v2); organizations are named only where there is a
  choice. Wire names (`workspace_id`, `project_id`) stay as the API spells them.
- Before building a desktop mechanism, look for the portal's. Name the file you
  followed in the PR.

### 4. Fix the contract where it lives

If the desktop needs an endpoint, a field or a clearer error, change the gear in
`studio-backend` — with its OpenAPI and tests — rather than working around it in
the desktop proxy or by parsing an error's text. A workaround that has to stay
is written down in desktop-studio.md's **Known limits**.

### 5. Every failure says what the member can do

The member has no portal open and no logs in front of them.

- Tell *no data* from *no access*: "this project has no sources yet — add a
  repository in the portal" is not "you cannot see this project".
- An empty list is a state with its own message, never a blank view.
- Errors name the Studio they came from when there is more than one.
- Log the desktop's own steps with the `[studio-desktop]` prefix, without
  tokens or codes.

### 6. Layout and tests

The `theia/AGENTS.md` rules apply: shared contracts in `src/common`, UI in
`src/browser`, file system, processes and Studio calls in `src/node`, bindings in
the Inversify modules, disposal for everything that listens.

Keep the logic out of the widget. What decides — which Studio, which projects,
which message — is a plain function next to it with a jest test
(`desktop-projects.ts`, `missingSourcesMessage`), so it is testable without
Electron or a Studio.

## Before opening the PR

1. **Compile and test `theia/studio`.** Without a host toolchain, in the session
   image:

   ```bash
   docker run -d --name desk-verify --user root --entrypoint sleep cf-studio-theia:local infinity
   docker exec desk-verify rm -rf /app/studio/src      # the image's own sources may be another branch's
   docker cp theia/studio/src desk-verify:/app/studio/src
   docker exec desk-verify sh -c 'cd /app/studio && npx tsc -p . --noEmit && npx jest --config configs/jest.config.ts'
   docker rm -f desk-verify
   ```

   Judge the run against `main`'s: on 2026-09-28 five suites fail there too
   (`orca-service`, `cfs-map-adapter`, `audit-controller`, `orca-live`,
   `portal-bridge-contribution`). Run the failing ones on `git archive HEAD` to
   tell a regression from the baseline.

2. **Exercise it against the local stack** (`docker compose up -d`) as both kinds
   of member — they take different paths through rule 3:
   - the platform administrator, `admin` / `studio`;
   - an ordinary member. The realm ships none; create one with a home tenant
     that is an organization and a membership in it:

     ```bash
     KC=http://127.0.0.1:8088; B=http://127.0.0.1:8090/cf
     # a Keycloak user whose tenant_id attribute is the organization's id
     #   (admin console, or the admin REST API with the master admin/admin)
     # then, with the member's token, their Studio person id:
     curl -s -H "Authorization: Bearer $MEMBER" $B/studio-user/v1/me        # → .id
     # and, with admin's token, the membership:
     curl -s -X PUT -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
       $B/studio-user/v1/users/<person id>/memberships/<org id> -d '{"role":"member"}'
     ```

     The membership takes the Studio person id from `/studio-user/v1/me`, not
     the token's `sub`.

3. **Open a portal session too**, and check that the views you touched
   (Documents, Sources, Analyze, the Studio view) behave as before. Rule 1 is
   only proven there.

4. **Update the docs** in the same PR: desktop-studio.md for anything a member,
   an operator or a developer sees differently, this page when a rule changes.

5. **Say what was verified, and how**, in the PR description: which stack, which
   member, what was seen. If the desktop app itself was not rebuilt and run, say
   so.

## Commits and PRs

- Branch per change, from `upstream/main`; PR from your fork to
  `constructorfabric/studio-web`.
- Every commit carries `Signed-off-by` (`git commit --signoff`); the DCO check
  refuses the PR otherwise.
- Titles use the `desktop` scope: `feat(desktop): …`, `fix(desktop): …`.
- PRs are squash-merged, often quickly: check that a PR is still open before
  pushing more to its branch.
- A PR changing `theia/electron-app/**` runs **Desktop — Windows build** in the
  upstream repository; its installer is the artifact to try before release.
  A push to a fork feature branch does not build a second installer. For an
  installer before opening a PR, run the workflow manually on that branch.
