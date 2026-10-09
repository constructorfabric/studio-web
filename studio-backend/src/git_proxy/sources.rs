//! What the proxy decides without the network: where a request goes upstream,
//! and what credential it came with. Kept apart from `rest` so each decision
//! is a plain function with a test. Which sources a project has is
//! `project_sources`.

use base64::Engine;

/// One Git source of a project, as a session or a desktop clones it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub name: String,
    /// The source host's clone URL. Never returned to a client.
    pub url: String,
    pub branch: Option<String>,
    /// Where the IDE checks it out, relative to the workspace root.
    pub target: Option<String>,
    /// credstore reference of the source host token. Never returned either.
    pub token_ref: Option<String>,
    /// The tenant holding the source's connection, when that is outside the
    /// project's organization (the platform's root, another organization):
    /// its token is not the organization's to use, so `token_ref` is `None`
    /// and the proxy refuses the source rather than reach the host as the
    /// platform (`cpt-studio-constraint-connector-own-connections`).
    pub held_outside: Option<uuid::Uuid>,
}

/// The two Git services the smart-HTTP protocol names in `info/refs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Service {
    UploadPack,
    ReceivePack,
}

impl Service {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "git-upload-pack" => Some(Self::UploadPack),
            "git-receive-pack" => Some(Self::ReceivePack),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::UploadPack => "git-upload-pack",
            Self::ReceivePack => "git-receive-pack",
        }
    }
}

/// The upstream URL for one protocol request: the source's clone URL with the
/// protocol path appended, exactly as `git` itself would build it.
///
/// Only `http(s)` is served. An `ssh://` or `git@host:` source cannot be
/// proxied over HTTP, and a `file://` one would let a workspace setting read
/// the backend's own disk.
pub fn upstream_url(clone_url: &str, protocol_path: &str) -> Option<String> {
    let base = clone_url.trim().trim_end_matches('/');
    let lower = base.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return None;
    }
    Some(format!("{base}/{protocol_path}"))
}

/// The Studio token a Git request carries: the password of Basic credentials
/// (what a credential helper hands `git`), or a Bearer token (what
/// `http.extraHeader` sends). The Basic user name is ignored.
pub fn presented_token(authorization: Option<&str>) -> Option<String> {
    let value = authorization?.trim();
    if let Some(token) = value.strip_prefix("Bearer ") {
        let token = token.trim();
        return (!token.is_empty()).then(|| token.to_owned());
    }
    let encoded = value.strip_prefix("Basic ")?.trim();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    let (_, password) = decoded.split_once(':')?;
    (!password.is_empty()).then(|| password.to_owned())
}

/// What `git` prints for a source whose connection is held outside the
/// project's organization ([`Source::held_outside`]).
pub fn not_owned_text(holder: uuid::Uuid) -> String {
    use crate::connectors::sdk::ownership::{CONNECTION_NOT_OWNED, NOT_OWNED_HINT, whose};
    format!(
        "{CONNECTION_NOT_OWNED}: this source's connection is held by {}, outside the project's organization. {NOT_OWNED_HINT}",
        whose(holder)
    )
}

/// Basic credentials for the source host: the token as the password, the way
/// the session container's credential helper presents it.
pub fn upstream_authorization(token: &str) -> String {
    let pair = format!("oauth2:{token}");
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(pair)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_protocol_path_is_appended_like_git_does() {
        assert_eq!(
            upstream_url("https://example.com/acme/api.git/", "info/refs").as_deref(),
            Some("https://example.com/acme/api.git/info/refs")
        );
    }

    #[test]
    fn only_http_sources_are_proxied() {
        assert_eq!(
            upstream_url("git@github.com:acme/api.git", "info/refs"),
            None
        );
        assert_eq!(upstream_url("ssh://github.com/acme/api", "info/refs"), None);
        assert_eq!(upstream_url("file:///etc", "info/refs"), None);
    }

    #[test]
    fn the_token_is_the_basic_password() {
        let header = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("studio:tok-123")
        );
        assert_eq!(presented_token(Some(&header)).as_deref(), Some("tok-123"));
    }

    #[test]
    fn a_bearer_token_is_accepted_too() {
        assert_eq!(
            presented_token(Some("Bearer tok-456")).as_deref(),
            Some("tok-456")
        );
    }

    #[test]
    fn no_or_empty_credentials_present_no_token() {
        assert_eq!(presented_token(None), None);
        assert_eq!(presented_token(Some("Bearer  ")), None);
        let empty = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("studio:")
        );
        assert_eq!(presented_token(Some(&empty)), None);
        assert_eq!(presented_token(Some("Digest abc")), None);
    }

    #[test]
    fn a_source_held_outside_the_organization_says_whose_and_what_to_do() {
        let text = not_owned_text(uuid::Uuid::from_u128(1));
        assert!(text.starts_with("CONNECTION_NOT_OWNED"), "{text}");
        assert!(text.contains("the platform's root"), "{text}");
        assert!(text.contains("organization-scope connection of your own"));
    }

    #[test]
    fn only_the_two_git_services_are_known() {
        assert_eq!(Service::parse("git-upload-pack"), Some(Service::UploadPack));
        assert_eq!(
            Service::parse("git-receive-pack"),
            Some(Service::ReceivePack)
        );
        assert_eq!(Service::parse("git-upload-archive"), None);
    }
}
