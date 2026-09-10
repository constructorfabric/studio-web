//! The connector driver contract.
//!
//! A driver knows how to talk to one flavour of provider — a source host
//! (GitLab, GitHub, …), a model provider, or a chat platform. It is
//! deliberately narrow: authenticate, then whatever the one thing that
//! provider is good for happens to be — enumerate repositories, or post a
//! message. Everything tenant-shaped — which connections exist, who may see
//! them, where the token is kept — belongs to the connector service, not
//! here, so adding a provider stays a small, local job.
//!
//! Every capability past `test()` is a defaulted method that refuses in the
//! provider's own words, so a driver implements only what its provider can
//! actually do: a Slack driver never learns what a repository is, and the REST
//! layer turns the refusal into a 4xx rather than an empty listing.

use async_trait::async_trait;

/// Everything a driver needs to reach an installation. Assembled per call by
/// the service from the stored connection plus the credstore secret; drivers
/// never see the catalogue and never cache credentials.
#[derive(Debug, Clone)]
pub struct ConnectionAuth {
    /// Installation root, e.g. `https://gitlab.constr.dev` or
    /// `https://api.github.com`. Trailing slashes are tolerated.
    pub base_url: String,
    /// Personal access token.
    pub token: String,
}

impl ConnectionAuth {
    /// `base_url` without trailing slashes, for safe path concatenation.
    pub fn root(&self) -> &str {
        self.base_url.trim_end_matches('/')
    }
}

/// What a provider is for. Decides which affordances the UI offers: only a
/// source host can be browsed for repositories, only a notification target
/// can be posted to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectorCategory {
    /// Git hosting — repositories can be listed and attached to a workspace.
    SourceCode,
    /// Model provider — the credential is handed to agents, nothing to browse.
    Ai,
    /// Chat platform — Studio posts messages into it. Nothing is read back:
    /// the credential is an egress, not a source.
    Notification,
}

impl ConnectorCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SourceCode => "source_code",
            Self::Ai => "ai",
            Self::Notification => "notification",
        }
    }
}

/// What a credential resolves to, shown after a successful test so a human can
/// confirm they pasted the one they meant to.
///
/// Source hosts answer with a username. Model providers have no account
/// endpoint at all, so their drivers put a short capability summary here
/// instead (e.g. how many models the key can see) — the honest maximum the
/// provider is willing to tell us.
#[derive(Debug, Clone)]
pub struct DriverIdentity {
    pub account: String,
    pub display_name: Option<String>,
}

/// One repository as the provider describes it.
#[derive(Debug, Clone)]
pub struct RemoteRepo {
    /// Provider-native id, stringified (GitLab numeric, GitHub node id).
    pub id: String,
    /// Short name — the default directory name inside a workspace.
    pub name: String,
    /// Namespaced path, e.g. `hypotheses/hypothesis-workspace`.
    pub full_path: String,
    /// HTTPS clone URL as advertised by the provider.
    pub clone_url: String,
    pub default_branch: Option<String>,
    pub description: Option<String>,
    /// `private` | `internal` | `public` when the provider reports it.
    pub visibility: Option<String>,
}

/// One issue as the provider describes it. Provider-native ids are stringified
/// so the ingest can key GTS instances on them stably across syncs.
#[derive(Debug, Clone)]
pub struct RemoteIssue {
    /// Provider-native id, stringified.
    pub id: String,
    /// Human-facing number within the repository (`#42`).
    pub number: i64,
    pub title: String,
    /// `open` | `closed` as the provider reports it.
    pub state: String,
    /// Login of the author, when the provider exposes it.
    pub author: Option<String>,
    pub body: Option<String>,
    pub url: Option<String>,
    /// RFC 3339 timestamps, passed through verbatim.
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub labels: Vec<String>,
}

/// One file (or directory) entry in a repository tree, as the provider
/// describes it. Produced from a recursive tree listing — no file content, just
/// the shape of the repo — so the ingest can turn each path into a File node.
#[derive(Debug, Clone)]
pub struct RemoteFile {
    /// Repo-relative path, e.g. `src/main.rs`.
    pub path: String,
    /// Provider blob/tree sha, stringified — the stable key for the GTS
    /// instance (content-addressed, so it changes only when the file does).
    pub sha: String,
    /// `true` for a directory (tree), `false` for a file (blob).
    pub is_dir: bool,
    /// Size in bytes for blobs, when the provider reports it.
    pub size: Option<i64>,
}

/// One pull/merge request as the provider describes it.
#[derive(Debug, Clone)]
pub struct RemotePullRequest {
    pub id: String,
    pub number: i64,
    pub title: String,
    /// `open` | `closed` | `merged`, normalized by the driver.
    pub state: String,
    pub author: Option<String>,
    pub body: Option<String>,
    pub url: Option<String>,
    pub source_branch: Option<String>,
    pub target_branch: Option<String>,
    pub merged: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// One comment on an issue or pull request. GitHub returns comments for both
/// from a single repo-wide endpoint; `target_number` is the issue/PR number the
/// comment belongs to, so the ingest can link it to that node.
#[derive(Debug, Clone)]
pub struct RemoteComment {
    /// Provider-native id, stringified — the stable key for the GTS instance.
    pub id: String,
    /// Number of the issue/PR this comment is on.
    pub target_number: i64,
    pub author: Option<String>,
    pub body: Option<String>,
    pub url: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// One commit in a repository.
#[derive(Debug, Clone)]
pub struct RemoteCommit {
    /// Full commit sha — the stable key (content-addressed).
    pub sha: String,
    pub message: Option<String>,
    /// Author login, when the provider maps the commit to an account.
    pub author: Option<String>,
    /// Author display name from the commit metadata.
    pub author_name: Option<String>,
    pub url: Option<String>,
    /// Authored-at RFC 3339 timestamp from the commit metadata.
    pub created_at: Option<String>,
}

/// A repository tree read at a ref, for the knowledge-graph sync.
#[derive(Debug, Clone)]
pub struct RepoTree {
    /// The ref the tree was actually read at (default branch when none asked).
    pub git_ref: String,
    /// Every entry (files and directories) in the tree.
    pub entries: Vec<RepoTreeEntry>,
    /// Whether the provider truncated the tree for a very large repository.
    pub truncated: bool,
}

/// One entry of a [`RepoTree`].
#[derive(Debug, Clone)]
pub struct RepoTreeEntry {
    /// Repo-relative path.
    pub path: String,
    /// `true` for a directory (tree), `false` for a file (blob).
    pub is_dir: bool,
}

/// A contributor to a repository, for the knowledge-graph sync.
#[derive(Debug, Clone)]
pub struct Contributor {
    /// Provider login.
    pub login: String,
    /// Display name, when the provider exposes it.
    pub display_name: Option<String>,
    /// Commit count attributed to this contributor.
    pub contributions: u64,
}

/* ── Notifications ── */

/// One place a notification can be delivered: a Slack channel, a Zulip
/// channel, a Discord text channel.
///
/// Only channel-shaped targets are listed. Direct messages to a person are
/// deliberately absent: they need a mapping from a Studio subject to a
/// platform account, which is `studio-identity`'s job (ADR-0012) and not a
/// thing to guess from a display name.
#[derive(Debug, Clone)]
pub struct NotifyTarget {
    /// Provider-native id, and exactly what [`ConnectorDriver::send_message`]
    /// expects back: a Slack channel id (`C0123…`), a Zulip channel name, a
    /// Discord channel id. Opaque to everything above the driver.
    pub id: String,
    /// Human name, without the platform's sigil (`releases`, not `#releases`).
    pub name: String,
    /// Where the target lives, when the platform nests them — a Discord guild,
    /// a Slack team. `None` where the installation *is* the container.
    pub container: Option<String>,
    /// Whether posting needs an invite. Reported so a human can tell why an
    /// otherwise valid channel refuses the message.
    pub private: bool,
    /// Whether a message to this target must carry a topic. True for Zulip,
    /// whose channels are threaded by construction, false everywhere else —
    /// the UI reads it to decide whether to ask for one.
    pub topic_required: bool,
}

/// A notification to deliver.
///
/// Deliberately not a provider payload: no Slack blocks, no Discord embeds. A
/// caller says what happened and, optionally, where to look; each driver
/// renders that into its own platform's idiom. The alternative — passing
/// provider-shaped JSON through — would make every caller know which platform
/// it is talking to, which is the whole thing a connector exists to avoid.
#[derive(Debug, Clone, Default)]
pub struct NotifyMessage {
    /// The message body. Markdown-ish: emphasis and links survive on all three
    /// platforms, anything more exotic is on the caller.
    pub text: String,
    /// A short headline, rendered bold above the body — none of the three
    /// platforms has a first-class title for a plain message.
    pub title: Option<String>,
    /// A link to the thing the message is about, appended as its own line.
    pub link: Option<String>,
    /// Thread/topic within the target. Required by Zulip, ignored by the
    /// others — see [`NotifyTarget::topic_required`].
    pub topic: Option<String>,
}

/// What the platform said about a delivered message.
#[derive(Debug, Clone)]
pub struct SentMessage {
    /// The target it landed in, as the driver resolved it. Echoed because a
    /// webhook driver knows the channel only after the fact — the caller sent
    /// no target at all.
    pub target: String,
    /// Provider-native message id, where the platform returns one. Slack gives
    /// a `ts`, Zulip a numeric id, Discord a snowflake; a Discord webhook
    /// returns nothing unless asked to wait.
    pub id: Option<String>,
}

#[async_trait]
pub trait ConnectorDriver: Send + Sync + 'static {
    /// Stable provider key used in the API and the UI (`gitlab`, `github`).
    fn provider(&self) -> &'static str;

    /// Human label for the provider picker.
    fn display_name(&self) -> &'static str;

    /// Default installation root, offered as a placeholder in the UI.
    fn default_base_url(&self) -> &'static str;

    /// What this provider is for.
    fn category(&self) -> ConnectorCategory;

    /// Label for the credential field: source hosts say "Personal Access
    /// Token", model providers say "API Key".
    fn credential_label(&self) -> &'static str {
        match self.category() {
            ConnectorCategory::SourceCode => "Personal Access Token (PAT)",
            ConnectorCategory::Ai => "API Key",
            ConnectorCategory::Notification => "Bot Token",
        }
    }

    /// Placeholder hinting at the credential's shape (`glpat-…`, `sk-ant-…`).
    fn credential_hint(&self) -> &'static str {
        ""
    }

    /// Verify the credential and report whose it is.
    async fn test(&self, auth: &ConnectionAuth) -> anyhow::Result<DriverIdentity>;

    /// Repositories the credential can reach. `search` narrows server-side
    /// where the provider supports it; `limit` caps one page.
    ///
    /// Defaulted so a model-provider driver does not have to implement a
    /// concept it has no notion of; the REST layer turns this into a 400
    /// rather than pretending the listing is empty.
    async fn list_repositories(
        &self,
        auth: &ConnectionAuth,
        search: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<RemoteRepo>> {
        let _ = (auth, search, limit);
        Err(anyhow::anyhow!(
            "{} is not a source host — it has no repositories to list",
            self.display_name()
        ))
    }

    /// Issues in one repository. `since` (RFC 3339) narrows to items updated at
    /// or after that instant for incremental sync; `page` is 1-based and
    /// `per_page` caps one page — the caller pages until a short page comes
    /// back. Defaulted so a non-source driver stays a small, local job.
    async fn list_issues(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteIssue>> {
        let _ = (auth, repo_full_path, since, page, per_page);
        Err(anyhow::anyhow!(
            "{} does not expose issues",
            self.display_name()
        ))
    }

    /// Pull/merge requests in one repository. Same paging and `since` contract
    /// as [`Self::list_issues`].
    async fn list_pull_requests(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemotePullRequest>> {
        let _ = (auth, repo_full_path, since, page, per_page);
        Err(anyhow::anyhow!(
            "{} does not expose pull requests",
            self.display_name()
        ))
    }

    /// The file paths one pull/merge request changed. Used to link PR nodes to
    /// File nodes in the artifact graph. Defaulted to empty (not an error): a
    /// driver that cannot answer simply leaves those PR↔file links unbuilt
    /// rather than failing the whole sync.
    async fn pull_request_files(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        number: i64,
    ) -> anyhow::Result<Vec<String>> {
        let _ = (auth, repo_full_path, number);
        Ok(Vec::new())
    }

    /// Comments on issues and pull requests in one repository. `since` (RFC
    /// 3339) narrows to comments updated at or after that instant; `page` is
    /// 1-based and `per_page` caps one page. Defaulted to empty (not an error)
    /// so a driver without comments simply contributes none to the graph.
    async fn list_comments(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteComment>> {
        let _ = (auth, repo_full_path, since, page, per_page);
        Ok(Vec::new())
    }

    /// Commits in one repository. Same paging + `since` contract as
    /// [`Self::list_issues`]. Defaulted to empty so a non-source driver
    /// contributes no commit nodes.
    async fn list_commits(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        since: Option<&str>,
        page: u32,
        per_page: u32,
    ) -> anyhow::Result<Vec<RemoteCommit>> {
        let _ = (auth, repo_full_path, since, page, per_page);
        Ok(Vec::new())
    }

    /// Files in one repository as a flat, recursive tree of the given ref (or
    /// the repo's default branch when `git_ref` is `None`). There is no paging
    /// contract — providers return the whole tree in one response, which they
    /// may truncate for very large repos; the driver logs when that happens.
    /// Defaulted so a non-source driver stays a small, local job.
    async fn list_files(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        git_ref: Option<&str>,
    ) -> anyhow::Result<Vec<RemoteFile>> {
        let _ = (auth, repo_full_path, git_ref);
        Err(anyhow::anyhow!(
            "{} does not expose files",
            self.display_name()
        ))
    }

    /// Plain HTTPS clone URL (no credentials) for `repo_full_path` under this
    /// installation. `base_url` is the API root the connection uses; the driver
    /// maps it to the git host (e.g. `api.github.com` → `github.com`).
    /// Defaulted to an error for non-source drivers.
    fn clone_url(&self, base_url: &str, repo_full_path: &str) -> anyhow::Result<String> {
        let _ = (base_url, repo_full_path);
        Err(anyhow::anyhow!(
            "{} is not a source host — nothing to clone",
            self.display_name()
        ))
    }

    /// Username/password pair to authenticate a clone with the given token.
    /// Fed to git through a credential helper so the token never lands in the
    /// URL, the process arguments, or any log line. Defaulted to the common
    /// "token as password" shape; providers override the username.
    fn clone_credentials<'a>(&self, token: &'a str) -> (&'static str, &'a str) {
        ("x-access-token", token)
    }

    /// The full recursive tree of a repository at `git_ref` (the default branch
    /// when `None`), for the knowledge-graph sync. Defaulted to an error for a
    /// non-source driver.
    async fn repo_tree(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        git_ref: Option<&str>,
    ) -> anyhow::Result<RepoTree> {
        let _ = (auth, repo_full_path, git_ref);
        Err(anyhow::anyhow!(
            "{} does not expose a repository tree",
            self.display_name()
        ))
    }

    /// The top contributors to a repository (up to `max`), for the
    /// knowledge-graph sync. Defaulted to an error for a non-source driver.
    async fn contributors(
        &self,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        max: u32,
    ) -> anyhow::Result<Vec<Contributor>> {
        let _ = (auth, repo_full_path, max);
        Err(anyhow::anyhow!(
            "{} does not expose contributors",
            self.display_name()
        ))
    }

    /// Whether the credential itself decides where messages land.
    ///
    /// True for an incoming webhook: the channel is fixed when a human creates
    /// the URL, so there is nothing to enumerate and nothing to pick —
    /// [`Self::list_targets`] refuses and [`Self::send_message`] ignores the
    /// target it is handed. A bot token is the other shape: one connection
    /// reaches every channel the bot was invited to, and the target is part of
    /// the send. The UI reads this to decide whether to show a channel picker
    /// at all.
    fn fixed_target(&self) -> bool {
        false
    }

    /// Channels this credential can post to. `search` filters by name —
    /// client-side, since none of the chat platforms offer a channel search —
    /// and `limit` caps the result.
    ///
    /// Defaulted to a refusal: a source host has no channels, and a webhook
    /// has exactly one it will not name up front.
    async fn list_targets(
        &self,
        auth: &ConnectionAuth,
        search: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<NotifyTarget>> {
        let _ = (auth, search, limit);
        Err(anyhow::anyhow!(
            "{} does not expose notification channels",
            self.display_name()
        ))
    }

    /// Deliver one message. `target` is a [`NotifyTarget::id`]; it is `None`
    /// only for a [`Self::fixed_target`] driver, which would ignore it anyway.
    async fn send_message(
        &self,
        auth: &ConnectionAuth,
        target: Option<&str>,
        message: &NotifyMessage,
    ) -> anyhow::Result<SentMessage> {
        let _ = (auth, target, message);
        Err(anyhow::anyhow!(
            "{} is not a notification provider — there is nothing to post to",
            self.display_name()
        ))
    }
}
