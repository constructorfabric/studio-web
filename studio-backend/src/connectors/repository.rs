//! One repository, read and written through the connection that reaches it.
//!
//! Every gear that reads a repository used to hold a GitHub client of its own:
//! the catalogue's scan, the plan reader in reports, the scaffold's writer.
//! Each borrowed the connection's token and then spoke GitHub's REST dialect by
//! hand, so a provider other than GitHub, a rate-limit fix or a header change
//! had four places to land. A [`Repository`] is the connection's driver bound
//! to one repository and ref: the tree, a file, a path's history, the tags, a
//! commit of many files, and the clone credentials for a checkout
//! ([`super::clone`]).

use std::sync::Arc;

use anyhow::Result;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::driver::{
    ConnectionAuth, ConnectorDriver, CreatedRepository, FileToWrite, OpenedPullRequest,
    RemoteCommit, RemoteFileList, RemoteFileText,
};
use super::service::ConnectorService;

/// A repository reached through one connection, at one ref.
#[derive(Clone)]
pub struct Repository {
    driver: Arc<dyn ConnectorDriver>,
    auth: ConnectionAuth,
    /// The connection's id: what keeps two connections to one host on
    /// separate checkouts.
    connection_id: Uuid,
    /// `owner/name`.
    repo: String,
    /// The ref every read is at; `None` means the default branch.
    git_ref: Option<String>,
}

impl Repository {
    /// `repo` through the connection named, or -- when none is -- the first
    /// `provider` connection of `tenant` that `ctx` can use
    /// ([`ConnectorService::named_or_default`]).
    pub async fn open(
        connectors: &ConnectorService,
        ctx: &SecurityContext,
        tenant: Uuid,
        connection_id: Option<Uuid>,
        provider: &str,
        repo: &str,
        git_ref: Option<&str>,
    ) -> Result<Self> {
        let (driver, auth, conn) = connectors
            .named_or_default(ctx, tenant, connection_id, provider)
            .await?;
        Ok(Self {
            driver,
            auth,
            connection_id: conn.id,
            repo: repo.trim().trim_matches('/').to_string(),
            git_ref: git_ref
                .map(str::trim)
                .filter(|r| !r.is_empty())
                .map(str::to_string),
        })
    }

    pub fn git_ref(&self) -> Option<&str> {
        self.git_ref.as_deref()
    }

    pub fn connection_id(&self) -> Uuid {
        self.connection_id
    }

    /// Every file and directory at the ref, and whether the provider cut the
    /// listing short.
    pub async fn tree(&self) -> Result<RemoteFileList> {
        self.driver
            .list_files(&self.auth, &self.repo, self.git_ref())
            .await
    }

    /// One text file at the ref; `None` when there is no such file.
    pub async fn read_file(&self, path: &str) -> Result<Option<RemoteFileText>> {
        self.driver
            .read_file(&self.auth, &self.repo, path, self.git_ref())
            .await
    }

    /// The newest commits (up to `limit`) that touched `path` on the ref.
    pub async fn history(&self, path: &str, limit: u32) -> Result<Vec<RemoteCommit>> {
        self.driver
            .path_history(&self.auth, &self.repo, path, self.git_ref(), limit)
            .await
    }

    /// One page of tag names.
    pub async fn tags(&self, page: u32, per_page: u32) -> Result<Vec<String>> {
        self.driver
            .list_tags(&self.auth, &self.repo, page, per_page)
            .await
    }

    /// Commit `files` in one commit on top of `base_branch`, onto `branch`
    /// ([`ConnectorDriver::commit_files`]). Returns the commit `branch` points
    /// at.
    pub async fn commit_files(
        &self,
        base_branch: &str,
        branch: &str,
        files: &[FileToWrite],
        message: &str,
    ) -> Result<String> {
        self.driver
            .commit_files(&self.auth, &self.repo, base_branch, branch, files, message)
            .await
    }

    /// Open a pull request from `head` into `base`, or return the one already
    /// open between them.
    pub async fn open_pull_request(
        &self,
        head: &str,
        base: &str,
        title: &str,
        body: Option<&str>,
    ) -> Result<OpenedPullRequest> {
        self.driver
            .open_pull_request(&self.auth, &self.repo, head, base, title, body)
            .await
    }

    /// Where to clone it from, and the credential pair `git` is handed
    /// through a helper (never the URL or argv): `(url, username, token)`.
    pub fn clone_source(&self) -> Result<(String, String, String)> {
        let url = self.driver.clone_url(&self.auth.base_url, &self.repo)?;
        let (username, token) = self.driver.clone_credentials(&self.auth.token);
        Ok((url, username.to_string(), token.to_string()))
    }
}

/// Create a repository through a connection: under organization `owner` when
/// `is_org`, otherwise under the connection's own account.
#[allow(clippy::too_many_arguments)]
pub async fn create_repository(
    connectors: &ConnectorService,
    ctx: &SecurityContext,
    tenant: Uuid,
    connection_id: Option<Uuid>,
    provider: &str,
    owner: Option<&str>,
    is_org: bool,
    name: &str,
    private: bool,
) -> Result<CreatedRepository> {
    let (driver, auth, _conn) = connectors
        .named_or_default(ctx, tenant, connection_id, provider)
        .await?;
    driver
        .create_repository(&auth, owner, is_org, name, private)
        .await
}
