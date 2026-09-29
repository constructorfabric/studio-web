//! What a workspace or a project CONTAINS, counted once, on the server.
//!
//! The portfolio and the projects table name their rows and then have to say
//! something about them: which of these has anything in it, and which needs
//! attention. Answering that in the row is what stops somebody opening three
//! projects to find out which one to open.
//!
//! IT USED TO BE ANSWERED IN THE BROWSER, and that is why this exists. The
//! prototype composed every row itself — `tenantChildren` for a workspace, then
//! `docBindings` + `listArtifactNodes` + `workspaceSettings` for each project.
//! Three requests per row, from a client, over a link it does not control; and
//! one of the three was the artifact listing, which cannot narrow by payload and
//! so walks the tenant's whole typed node set on every call (28,717 nodes and a
//! p95 of 8.06 s, measured on studio-dev). A ten-project table asked for that
//! ten times.
//!
//! Worse than slow, it was unshareable: the next portal would have to write the
//! same composition again, and the three rules below with it.
//!
//! ── The three rules, which are the whole point ──────────────────────────────
//!
//! **A count that is not known is `None`, never 0.** A zero that really means
//! "the gear did not answer" is the most expensive kind of wrong here: it tells
//! somebody deciding where to look that a project is empty.
//!
//! **One failure costs one number.** Every count is settled independently, so a
//! self-managed tenant answering 404 from outside its subtree — which is tenant
//! isolation working correctly — leaves the other columns alone.
//!
//! **Counts come from the store's total, never from `len()`.** Each source is
//! asked for a single row and reports how many there are. Fetching the rows to
//! count them reads a project's whole document set to render one cell.

use std::collections::HashSet;
use std::sync::Arc;

use account_management_sdk::AccountManagementClient;
use toolkit_odata::ODataQuery;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::access_config::AccessConfig;
use crate::artifact_ingest::port::{ArtifactCounter, ProjectSignalSource, ProjectSignals};
use crate::documents::port::{DocumentCounter, SpecSummary};
use crate::user_profile::{OrganizationRoster, RosterMember};

/// Tenant type of a workspace, as account-management records it.
pub const WORKSPACE_TENANT_TYPE: &str =
    "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~";
/// Tenant type of an organization, which holds workspaces.
pub const ORGANIZATION_TENANT_TYPE: &str = super::service::ORGANIZATION_TENANT_TYPE;
/// Tenant type of a project.
pub const PROJECT_TENANT_TYPE: &str = "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.project.v1~";
/// Where a project's attached repositories are recorded.
const SETTINGS_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.workspace.settings.v1~";
/// What a project is: its kind and its brief.
const PROJECT_CONFIG_TYPE: &str = "gts.cf.core.am.tenant_metadata.v1~cf.studio.project.config.v1~";
/// The node type a detector writes its verdicts as.
const FINDING_TYPE_LEAF: &str = "spec_finding";
/// The window a projects-table row draws its pull requests over.
pub const ACTIVITY_DAYS: usize = 7;

/// Which kind of row this is. A workspace is counted by what it holds; a
/// project by what is in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RollupKind {
    Workspace,
    Project,
}

impl RollupKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RollupKind::Workspace => "workspace",
            RollupKind::Project => "project",
        }
    }
}

/// One row's counts. Every number is optional, and the option carries the
/// difference between "none" and "nobody could tell me".
#[derive(Debug, Clone)]
pub struct Rollup {
    pub id: Uuid,
    pub name: String,
    pub kind: RollupKind,
    /// The workspace a project belongs to. `None` on a workspace row.
    ///
    /// Carried because the portfolio draws a tree: without it a client that
    /// received a flat list would have to ask again for the parentage this
    /// call already walked.
    pub parent_id: Option<Uuid>,
    /// Workspaces only: child tenants of type project.
    pub projects: Option<u32>,
    /// Projects only: files bound to a document type, or still undecided.
    pub documents: Option<u32>,
    /// Projects only: detector verdicts across those documents.
    pub findings: Option<u32>,
    /// Projects only: repositories attached in the project's settings.
    pub repos: Option<u32>,
    /// Projects only: the project's kind (`new_gears`, `product`,
    /// `existing`) and its brief, from its own configuration.
    pub project_kind: Option<String>,
    pub brief: Option<String>,
    /// Projects only: how its specs stand.
    pub specs: Option<SpecSummary>,
    /// Projects only: open findings and comments, pull requests over the last
    /// [`ACTIVITY_DAYS`] days, and the last thing that happened.
    pub signals: Option<ProjectSignals>,
    /// Projects only: the people who may work in it — see [`team_of`] for
    /// what that means under each access model.
    pub team: Option<u32>,
}

impl Rollup {
    fn workspace(id: Uuid, name: String, projects: u32) -> Self {
        Self {
            id,
            name,
            kind: RollupKind::Workspace,
            parent_id: None,
            projects: Some(projects),
            documents: None,
            findings: None,
            repos: None,
            project_kind: None,
            brief: None,
            specs: None,
            signals: None,
            team: None,
        }
    }
}

/// The sources a rollup reads.
///
/// Each counter is optional because each gear stands down independently — no
/// database, no connector driver — and a rollup missing one number is worth
/// more than no rollup at all.
pub struct Sources {
    pub am: Arc<dyn AccountManagementClient>,
    pub documents: Option<Arc<dyn DocumentCounter>>,
    pub artifacts: Option<Arc<dyn ArtifactCounter>>,
    pub signals: Option<Arc<dyn ProjectSignalSource>>,
    /// studio-user's memberships: who belongs to the organization, which is
    /// what a project's team is counted from (ADR-0011 §2).
    pub roster: Option<Arc<dyn OrganizationRoster>>,
}

/// What every project of one workspace counts its team from: the
/// organization's active members and its access config.
///
/// Read once per workspace, not per project: every project of a workspace
/// shares the organization, and a table that asked for the same roster ten
/// times would be the slowness this endpoint exists to remove.
struct TeamBasis {
    members: Vec<RosterMember>,
    access: AccessConfig,
}

impl Sources {
    /// Every workspace under the caller's tenant, and every project under those.
    ///
    /// The caller's tenant comes from the security context and is never a
    /// parameter: a tenant somebody can type is not a scope (convention C1).
    pub async fn portfolio(&self, ctx: &SecurityContext) -> Vec<Rollup> {
        let root = ctx.subject_tenant_id();
        // Workspaces sit under the caller's tenant, or one level down under an
        // organization in it (ADR-0011): a platform tenant holds
        // organizations, and they hold the workspaces. Walking only the
        // direct children answered an empty portfolio for exactly that tree.
        let mut parents = vec![root];
        parents.extend(
            self.children_of(ctx, root, ORGANIZATION_TENANT_TYPE)
                .await
                .into_iter()
                .map(|(id, _)| id),
        );
        let mut out = Vec::new();
        for parent in parents {
            let workspaces = self.children_of(ctx, parent, WORKSPACE_TENANT_TYPE).await;
            if workspaces.is_empty() {
                continue;
            }
            // Every workspace under one parent shares its organization, so
            // the team basis is read once for all of them.
            let team = self.team_basis(ctx, Some(parent)).await;
            for (workspace_id, workspace_name) in workspaces {
                out.extend(
                    self.workspace(ctx, workspace_id, workspace_name, team.as_ref())
                        .await,
                );
            }
        }
        out
    }

    /// One workspace and its projects, for the table that shows a workspace.
    ///
    /// Empty when the tenant is not a workspace or cannot be read: the same
    /// answer a portfolio gives for a subtree it may not see.
    pub async fn one_workspace(&self, ctx: &SecurityContext, workspace_id: Uuid) -> Vec<Rollup> {
        match self.am.get_tenant(ctx, workspace_id).await {
            Ok(t) if t.tenant_type.as_deref() == Some(WORKSPACE_TENANT_TYPE) => {
                let team = self.team_basis(ctx, t.parent_id.map(|p| p.0)).await;
                self.workspace(ctx, workspace_id, t.name, team.as_ref())
                    .await
            }
            _ => Vec::new(),
        }
    }

    /// A workspace's row, then one row per project in it.
    async fn workspace(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        workspace_name: String,
        team: Option<&TeamBasis>,
    ) -> Vec<Rollup> {
        let projects = self
            .children_of(ctx, workspace_id, PROJECT_TENANT_TYPE)
            .await;
        // The children were listed in order to walk into them, so this count
        // is what that listing already said — not a second question asked for
        // the number alone.
        let mut out = vec![Rollup::workspace(
            workspace_id,
            workspace_name,
            u32::try_from(projects.len()).unwrap_or(u32::MAX),
        )];
        // A workspace's projects at once: each row is a handful of independent
        // reads, and a table waiting on them one after another is the slowness
        // this endpoint exists to remove.
        out.extend(
            futures_util::future::join_all(
                projects.into_iter().map(|(project_id, name)| {
                    self.project(ctx, workspace_id, project_id, name, team)
                }),
            )
            .await,
        );
        out
    }

    /// One project, for a screen that shows a project rather than a portfolio.
    pub async fn one_project(&self, ctx: &SecurityContext, project_id: Uuid) -> Option<Rollup> {
        let tenant = self.am.get_tenant(ctx, project_id).await.ok()?;
        // Bindings are stored against the PARENT workspace and scoped to the
        // project. Without the parent this would count nothing, which is better
        // than counting the wrong rows — so it says it does not know.
        let workspace_id = tenant.parent_id?.0;
        let organization = match self.am.get_tenant(ctx, workspace_id).await {
            Ok(workspace) => workspace.parent_id.map(|p| p.0),
            Err(_) => None,
        };
        let team = self.team_basis(ctx, organization).await;
        Some(
            self.project(ctx, workspace_id, project_id, tenant.name, team.as_ref())
                .await,
        )
    }

    /// The organization's roster and access config, or `None` when either is
    /// unknown — and then every project under it reports its team as unknown.
    ///
    /// `organization` is the workspace's parent. It has to be an organization
    /// tenant: membership is recorded per organization (ADR-0011 §2), so a
    /// workspace hanging anywhere else has nobody who can be said to belong
    /// to it, and counting the members of whatever it hangs under would be a
    /// number about a different place.
    ///
    /// The parent is read as the caller, so the roster is only ever asked
    /// about an organization the caller's tenant scope reaches.
    async fn team_basis(
        &self,
        ctx: &SecurityContext,
        organization: Option<Uuid>,
    ) -> Option<TeamBasis> {
        let roster = self.roster.as_ref()?;
        let org = organization?;
        let tenant = self.am.get_tenant(ctx, org).await.ok()?;
        if tenant.tenant_type.as_deref() != Some(ORGANIZATION_TENANT_TYPE) {
            return None;
        }
        let (members, access) = tokio::join!(
            roster.active_members(org),
            crate::access_config::try_read(self.am.as_ref(), ctx, org),
        );
        Some(TeamBasis {
            members: members.ok()?,
            access: access?,
        })
    }

    /// Children of `parent` of one tenant type, as `(id, name)`.
    ///
    /// An unreadable parent yields no children rather than an error: a
    /// self-managed subtree refusing an ancestor is tenant isolation working as
    /// designed, and the rest of the portfolio still renders.
    async fn children_of(
        &self,
        ctx: &SecurityContext,
        parent: Uuid,
        tenant_type: &str,
    ) -> Vec<(Uuid, String)> {
        match self
            .am
            .list_children(ctx, parent, &ODataQuery::default())
            .await
        {
            Ok(page) => page
                .items
                .into_iter()
                .filter(|t| t.tenant_type.as_deref() == Some(tenant_type))
                .map(|t| (t.id.0, t.name))
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// One project's row, every part settled on its own.
    async fn project(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
        name: String,
        team: Option<&TeamBasis>,
    ) -> Rollup {
        let documents = async {
            match &self.documents {
                Some(counter) => counter
                    .count_bindings(ctx, workspace_id, project_id)
                    .await
                    .ok(),
                None => None,
            }
        };
        let scope = project_id.to_string();
        let findings = async {
            match &self.artifacts {
                Some(counter) => counter
                    .count_nodes(ctx, FINDING_TYPE_LEAF, &scope)
                    .await
                    .ok(),
                None => None,
            }
        };
        let specs = async {
            match &self.documents {
                Some(counter) => counter
                    .spec_summary(ctx, workspace_id, project_id)
                    .await
                    .ok(),
                None => None,
            }
        };
        let signals = async {
            match &self.signals {
                Some(source) => source
                    .project_signals(ctx, &scope, ACTIVITY_DAYS)
                    .await
                    .ok(),
                None => None,
            }
        };
        let team = team.map(|basis| team_of(basis, &scope));
        let (documents, findings, specs, signals, repos, config) = tokio::join!(
            documents,
            findings,
            specs,
            signals,
            self.repos(ctx, project_id),
            self.config(ctx, project_id),
        );
        let text = |key: &str| {
            config
                .as_ref()
                .and_then(|c| c.get(key))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        Rollup {
            id: project_id,
            name,
            kind: RollupKind::Project,
            parent_id: Some(workspace_id),
            projects: None,
            documents,
            findings,
            repos,
            project_kind: text("kind"),
            brief: text("brief"),
            specs,
            signals,
            team,
        }
    }

    /// The project's own configuration, or `None` when it has none or it
    /// could not be read -- its kind and brief are then simply not shown.
    async fn config(&self, ctx: &SecurityContext, project_id: Uuid) -> Option<serde_json::Value> {
        self.am
            .get_metadata(ctx, project_id, gts::GtsTypeId::new(PROJECT_CONFIG_TYPE))
            .await
            .ok()
            .map(|e| e.value)
    }

    /// Repositories attached to a project.
    ///
    /// A project whose settings read back has exactly as many repositories as
    /// they list, including none. A project whose settings could not be read has
    /// an unknown number — which is why a settings entry without the field is
    /// `Some(0)` and a failed read is `None`.
    async fn repos(&self, ctx: &SecurityContext, project_id: Uuid) -> Option<u32> {
        let entry = self
            .am
            .get_metadata(ctx, project_id, gts::GtsTypeId::new(SETTINGS_METADATA_TYPE))
            .await
            .ok();
        repos_in(entry.as_ref().map(|e| &e.value))
    }
}

/// How many people are on a project's team.
///
/// ── What "team" means, decided here ────────────────────────────────────────
///
/// **The people who may work in the project, counted from Studio's own
/// records: active organization memberships, narrowed by the organization's
/// access config.** Never from the IdP. Keycloak's users-per-tenant is a
/// projection of group membership, not the authority for who belongs
/// (ADR-0011 §1–2), and on a stand whose project tenants have no IdP group
/// it answers 503 for every row — which the first version of this column
/// rendered as a table of `—`.
///
/// A project has no membership of its own: projects are tenants of the
/// organization, and reaching one is membership rather than a privilege
/// (ADR-0019 §2). So the answer depends on the organization's access model,
/// exactly as the prototype's project Team screen does (`people.tsx`):
///
/// - **`tenant` model** (every organization today, and the default when the
///   organization has no access config): everyone in the organization can
///   work in every project, so the team is **every active member**.
/// - **`roles` model**: a role decides who may work where, so the team is
///   **the active members holding a member grant on this project** —
///   scoped to it, or organization-wide. A grant naming somebody who is not
///   an active member counts for nothing, because a role only ever narrows
///   membership and never widens it (ADR-0019 §1).
///
/// Each person is counted once however many logins or grants they have: a
/// grant names a token subject, so it matches a member through any of their
/// sign-in subjects, and a person is also matched when a grant names them
/// directly.
///
/// Suspended members are not in `members` at all (`OrganizationRoster`
/// hands out active ones only), so a suspended person is never on a team.
fn team_of(basis: &TeamBasis, project_id: &str) -> u32 {
    let mut people: HashSet<&str> = HashSet::new();
    if basis.access.is_roles_model() {
        let granted: HashSet<&str> = basis
            .access
            .subjects_granted_on_project(project_id)
            .collect();
        for member in &basis.members {
            let on_project = granted.contains(member.person.as_str())
                || member.subjects.iter().any(|s| granted.contains(s.as_str()));
            if on_project {
                people.insert(member.person.as_str());
            }
        }
    } else {
        people.extend(basis.members.iter().map(|m| m.person.as_str()));
    }
    u32::try_from(people.len()).unwrap_or(u32::MAX)
}

/// How many repositories a project's settings list.
///
/// `None` in means the settings could not be read, and `None` out says so. A
/// settings document that simply has no `repos` is `Some(0)` — the project
/// really has none, which is a different sentence and renders differently.
///
/// Pulled out of the read so the distinction can be tested without standing up
/// an account-management client: this is the rule, the read is plumbing.
fn repos_in(settings: Option<&serde_json::Value>) -> Option<u32> {
    let repos = settings?
        .get("repos")
        .and_then(serde_json::Value::as_array)
        .map(|repos| repos.len())
        .unwrap_or(0);
    Some(u32::try_from(repos).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The distinction the whole file turns on, at the one place it is decided.
    #[test]
    fn settings_that_could_not_be_read_are_unknown_not_empty() {
        assert_eq!(repos_in(None), None);
    }

    #[test]
    fn settings_without_the_field_mean_the_project_has_none() {
        assert_eq!(repos_in(Some(&json!({}))), Some(0));
        assert_eq!(repos_in(Some(&json!({ "repos": [] }))), Some(0));
    }

    #[test]
    fn repositories_are_counted_as_listed() {
        assert_eq!(
            repos_in(Some(&json!({ "repos": ["a", "b", "c"] }))),
            Some(3)
        );
    }

    /// A `repos` of the wrong shape is a malformed document, not a claim that
    /// the project has repositories nobody can name.
    #[test]
    fn a_repos_field_of_the_wrong_shape_counts_as_none_listed() {
        assert_eq!(repos_in(Some(&json!({ "repos": "nope" }))), Some(0));
    }

    /* ── team_of ── */

    fn member(person: &str, subjects: &[&str]) -> RosterMember {
        RosterMember {
            person: person.to_owned(),
            subjects: subjects.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    fn basis(members: Vec<RosterMember>, access: serde_json::Value) -> TeamBasis {
        TeamBasis {
            members,
            access: serde_json::from_value(access).expect("valid access config"),
        }
    }

    fn grant(subject: &str, scope: &str, scope_id: Option<&str>) -> serde_json::Value {
        json!({
            "subjectType": "member", "subjectId": subject, "roleKey": "editor",
            "scopeType": scope, "scopeId": scope_id,
        })
    }

    fn three() -> Vec<RosterMember> {
        vec![
            member("p-ada", &["kc-ada", "gh-ada"]),
            member("p-bob", &["kc-bob"]),
            member("p-cy", &["kc-cy"]),
        ]
    }

    /// The tenant model: everybody in the organization works in every
    /// project, whatever grants the document happens to carry.
    #[test]
    fn under_the_tenant_model_the_team_is_every_active_member() {
        let b = basis(
            three(),
            json!({ "model": "tenant", "grants": [grant("kc-ada", "project", Some("p1"))] }),
        );
        assert_eq!(team_of(&b, "p1"), 3);
        assert_eq!(team_of(&b, "p2"), 3);
    }

    /// No access config at all reads as the default document: the tenant
    /// model, which is what every organization that exists is on.
    #[test]
    fn an_organization_with_no_access_config_counts_every_member() {
        let b = TeamBasis {
            members: three(),
            access: AccessConfig::default(),
        };
        assert_eq!(team_of(&b, "p1"), 3);
    }

    /// An organization with no members has a team of zero — a known zero,
    /// which is the distinction the whole file turns on.
    #[test]
    fn an_empty_organization_has_a_team_of_zero() {
        let b = basis(Vec::new(), json!({}));
        assert_eq!(team_of(&b, "p1"), 0);
    }

    #[test]
    fn under_the_roles_model_the_team_is_who_holds_a_grant_there() {
        let b = basis(
            three(),
            json!({ "model": "roles", "grants": [
                grant("kc-ada", "org", None),
                grant("kc-bob", "project", Some("p1")),
                grant("kc-cy", "project", Some("p2")),
            ] }),
        );
        assert_eq!(team_of(&b, "p1"), 2, "ada org-wide, bob on p1");
        assert_eq!(team_of(&b, "p2"), 2, "ada org-wide, cy on p2");
        assert_eq!(team_of(&b, "p3"), 1, "only the org-wide grant");
    }

    /// One person, two logins, a grant through each: one head.
    #[test]
    fn a_person_is_counted_once_however_many_logins_and_grants() {
        let b = basis(
            three(),
            json!({ "model": "roles", "grants": [
                grant("kc-ada", "project", Some("p1")),
                grant("gh-ada", "project", Some("p1")),
                grant("kc-ada", "org", None),
            ] }),
        );
        assert_eq!(team_of(&b, "p1"), 1);
    }

    /// A grant naming the person id rather than a login still finds them.
    #[test]
    fn a_grant_naming_the_person_matches_them() {
        let b = basis(
            three(),
            json!({ "model": "roles", "grants": [grant("p-bob", "project", Some("p1"))] }),
        );
        assert_eq!(team_of(&b, "p1"), 1);
    }

    /// A role narrows membership and never widens it: a grant for somebody
    /// who is not an active member — never joined, left, or suspended —
    /// puts nobody on the team.
    #[test]
    fn a_grant_for_a_non_member_counts_for_nothing() {
        let b = basis(
            three(),
            json!({ "model": "roles", "grants": [
                grant("kc-stranger", "project", Some("p1")),
                grant("kc-bob", "project", Some("p1")),
            ] }),
        );
        assert_eq!(team_of(&b, "p1"), 1);
    }

    /// Team grants are not people, as the prototype's Team screen treats them.
    #[test]
    fn a_team_grant_puts_no_person_on_the_project() {
        let b = basis(
            three(),
            json!({ "model": "roles", "grants": [{
                "subjectType": "team", "subjectId": "kc-ada", "roleKey": "editor",
                "scopeType": "project", "scopeId": "p1",
            }] }),
        );
        assert_eq!(team_of(&b, "p1"), 0);
    }

    #[test]
    fn a_rollup_names_its_kind_the_way_the_api_spells_it() {
        assert_eq!(RollupKind::Workspace.as_str(), "workspace");
        assert_eq!(RollupKind::Project.as_str(), "project");
    }
}
