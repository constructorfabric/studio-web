//! What the three chat drivers share.
//!
//! Rendering, error surfacing, and the guard on user-supplied URLs. Provider
//! knowledge itself stays in [`super::slack`], [`super::zulip`] and
//! [`super::discord`] — this module holds only what would otherwise be
//! written three times.
//!
//! ## Why a URL needs a guard
//!
//! An incoming-webhook connection stores a URL the caller typed, and the
//! backend then makes a POST to it. That is a request forgery primitive: the
//! endpoint is authenticated, but any tenant member could point it at
//! `http://169.254.169.254/…` or a service that is only reachable from inside
//! the cluster and have the backend deliver a body of their choosing. So every
//! URL that arrives as configuration passes [`check_url`] before it is used:
//! HTTPS only, no loopback or private-range literal, no obviously internal
//! name, and — where the provider has no self-hosted form — the provider's own
//! host.
//!
//! This is a host check, not a network policy. A public name that resolves to a
//! private address still gets through, because the resolution happens later, in
//! reqwest, and re-resolving here to compare would be its own race. Closing
//! that properly is an egress policy on the deployment, not a string check
//! here; what this does close is the whole class of directly-addressed internal
//! targets, which is what a hand-typed field actually carries.

use anyhow::{Context, anyhow};
use reqwest::Url;

use super::driver::NotifyMessage;

/// Compose the message body for a platform whose bold marker is `strong`
/// (`*` for Slack's mrkdwn, `**` for the Markdown that Zulip and Discord read).
///
/// One line per part, in the order a reader wants them: what happened, the
/// detail, then where to look. A bare URL auto-links on all three platforms,
/// so the link needs no markup of its own.
pub(super) fn render(message: &NotifyMessage, strong: &str) -> String {
    let mut out = String::new();
    if let Some(title) = message
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        out.push_str(strong);
        out.push_str(title);
        out.push_str(strong);
    }
    let text = message.text.trim();
    if !text.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(text);
    }
    if let Some(link) = message
        .link
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
    {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(link);
    }
    out
}

/// Cut `s` to `max` characters, marking the cut so a truncated message does
/// not read as a complete one.
///
/// Counts characters, not bytes: every one of these platforms limits by
/// codepoint, and slicing a UTF-8 string by byte offset would panic on the
/// first non-ASCII message anyway.
pub(super) fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let keep = max.saturating_sub(1);
    let mut out: String = s.chars().take(keep).collect();
    out.push('…');
    out
}

/// Turn a failed HTTP response into an error carrying what the provider said.
///
/// The body is included, capped: a chat platform answers a rejected message
/// with a one-line reason worth showing a human, and occasionally with an HTML
/// error page worth showing nobody.
pub(super) async fn http_error(res: reqwest::Response, provider: &str) -> anyhow::Error {
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    let body = body.trim();
    if body.is_empty() {
        return anyhow!("{provider} {status}");
    }
    anyhow!(
        "{provider} {status}: {}",
        body.chars().take(200).collect::<String>()
    )
}

/// What a URL is allowed to point at.
pub(super) enum HostRule {
    /// Exactly these hosts, or a subdomain of one. For a provider with no
    /// self-hosted form, anything else is a typo at best.
    OneOf(&'static [&'static str]),
    /// Any public host: the provider can be self-hosted, so the deployment's
    /// own installation is the normal case.
    AnyPublic,
}

/// Validate a URL that arrived as configuration, and return it parsed.
///
/// `what` names the field in the error, because this message is what the
/// person who typed it reads.
pub(super) fn check_url(raw: &str, what: &str, rule: HostRule) -> anyhow::Result<Url> {
    let raw = raw.trim();
    let url = Url::parse(raw).with_context(|| format!("{what} is not a URL"))?;

    if url.scheme() != "https" {
        return Err(anyhow!(
            "{what} must be an https:// URL — a token or webhook secret must not \
             travel over {}",
            url.scheme()
        ));
    }

    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("{what} has no host"))?
        .to_ascii_lowercase();

    // Literal addresses first: an IP in the field is either a mistake or the
    // thing this guard exists for, and never a chat platform.
    //
    // Parsed out of `host_str` rather than matched on `Url::host()`, whose
    // `Host` type belongs to the `url` crate — reqwest re-exports `Url` and
    // nothing else, and one string parse is not worth a direct dependency on
    // its transitive.
    let literal = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = literal.parse::<std::net::IpAddr>() {
        let internal = match ip {
            std::net::IpAddr::V4(ip) => {
                ip.is_loopback()
                    || ip.is_private()
                    || ip.is_link_local()
                    || ip.is_unspecified()
                    || ip.is_broadcast()
                    || ip.is_documentation()
            }
            // No `is_unicast_link_local` — still unstable. Loopback,
            // unspecified and the fc00::/7 private range are the ones a person
            // types.
            std::net::IpAddr::V6(ip) => {
                ip.is_loopback() || ip.is_unspecified() || ip.is_unique_local()
            }
        };
        if internal {
            return Err(anyhow!(
                "{what} points at {literal}, which is not reachable from outside this \
                 deployment — a chat platform never is"
            ));
        }
    }

    // Names that mean "inside". Not a complete list and not meant to be: it
    // covers what a person actually types when they mean an internal service.
    const INTERNAL: [&str; 6] = [
        "localhost",
        ".localhost",
        ".local",
        ".internal",
        ".cluster.local",
        ".svc",
    ];
    if INTERNAL
        .iter()
        .any(|bad| host == *bad || host.ends_with(bad))
    {
        return Err(anyhow!(
            "{what} points at the internal name {host}, which cannot be a chat platform"
        ));
    }

    if let HostRule::OneOf(allowed) = rule
        && !allowed
            .iter()
            .any(|a| host == *a || host.ends_with(&format!(".{a}")))
    {
        return Err(anyhow!(
            "{what} must be on {} — this provider has no self-hosted form, so {host} \
             is not one of its endpoints",
            allowed.join(" or "),
        ));
    }

    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(title: Option<&str>, text: &str, link: Option<&str>) -> NotifyMessage {
        NotifyMessage {
            text: text.into(),
            title: title.map(Into::into),
            link: link.map(Into::into),
            topic: None,
        }
    }

    #[test]
    fn render_puts_title_body_link_on_their_own_lines() {
        let out = render(
            &msg(Some("Build failed"), "3 tests red", Some("https://ci/1")),
            "*",
        );
        assert_eq!(out, "*Build failed*\n3 tests red\nhttps://ci/1");
    }

    #[test]
    fn render_omits_the_parts_that_are_absent_or_blank() {
        assert_eq!(
            render(&msg(None, "just the body", None), "**"),
            "just the body"
        );
        assert_eq!(render(&msg(Some("  "), "body", Some(" ")), "**"), "body");
    }

    #[test]
    fn render_uses_the_platforms_own_bold_marker() {
        assert!(render(&msg(Some("T"), "b", None), "**").starts_with("**T**"));
    }

    #[test]
    fn truncate_marks_the_cut_and_counts_characters() {
        assert_eq!(truncate("abcdef", 6), "abcdef");
        assert_eq!(truncate("abcdef", 4), "abc…");
        // Would panic on a byte slice.
        assert_eq!(truncate("привет", 3), "пр…");
    }

    #[test]
    fn check_url_refuses_plaintext_and_internal_targets() {
        for bad in [
            "http://hooks.slack.com/services/A/B/C",
            "https://127.0.0.1/services/A/B/C",
            "https://10.1.2.3/api/v1/external/slack_incoming",
            "https://localhost/api/v1/external/slack_incoming",
            "https://zulip.svc/api/v1/external/slack_incoming",
            "https://[::1]/api/v1/external/slack_incoming",
            "https://169.254.169.254/latest/meta-data",
        ] {
            assert!(
                check_url(bad, "Webhook URL", HostRule::AnyPublic).is_err(),
                "{bad} should have been refused"
            );
        }
    }

    #[test]
    fn check_url_pins_the_host_where_the_provider_has_no_self_hosted_form() {
        let rule = || HostRule::OneOf(&["slack.com"]);
        assert!(check_url("https://hooks.slack.com/services/A/B/C", "URL", rule()).is_ok());
        assert!(check_url("https://slack.com/api", "URL", rule()).is_ok());
        // Not a subdomain of slack.com, however much it looks like one.
        assert!(check_url("https://slack.com.evil.example/api", "URL", rule()).is_err());
        assert!(check_url("https://example.com/api", "URL", rule()).is_err());
    }

    #[test]
    fn check_url_allows_a_self_hosted_installation() {
        assert!(
            check_url(
                "https://zulip.constr.dev/api/v1",
                "URL",
                HostRule::AnyPublic
            )
            .is_ok()
        );
    }
}
