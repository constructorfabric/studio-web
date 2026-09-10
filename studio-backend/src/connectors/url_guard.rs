//! The guard on URLs that arrive as configuration.
//!
//! ## Why a URL needs one
//!
//! A connection stores an address a person typed — the webhook a notification
//! is posted to, the self-hosted GitLab a repository is read from — and the
//! backend then makes a request to it, carrying that connection's credential.
//! That is a request-forgery primitive: the endpoint is authenticated, but any
//! tenant member could point it at `http://169.254.169.254/…` or a service only
//! reachable from inside the cluster, and have the backend go there on their
//! behalf. The reply comes back to them, because a provider that answers
//! nothing like the provider produces an error carrying the first part of the
//! body.
//!
//! So every URL that arrives as configuration passes [`check_url`] before it is
//! used: HTTPS only, no loopback or private-range literal, no obviously
//! internal name, and — where the provider has no self-hosted form — the
//! provider's own host.
//!
//! ## What it is not
//!
//! This is a host check, not a network policy. A public name that resolves to a
//! private address still gets through, because the resolution happens later, in
//! reqwest, and re-resolving here to compare would be its own race. Closing
//! that properly is an egress policy on the deployment, not a string check
//! here; what this does close is the whole class of directly-addressed internal
//! targets, which is what a hand-typed field actually carries.

use anyhow::{Context, anyhow};
use reqwest::Url;

/// What a URL is allowed to point at.
pub(crate) enum HostRule {
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
pub(crate) fn check_url(raw: &str, what: &str, rule: HostRule) -> anyhow::Result<Url> {
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
    // thing this guard exists for, and never a hosted provider.
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
                 deployment — a provider you connect to never is"
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
            "{what} points at the internal name {host}, which is inside this deployment \
             rather than a provider"
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

    /// The addresses a source-host connection is actually given. Self-hosted
    /// installations are the normal case for these, so the rule is the open
    /// one — what must still not get through is an internal target.
    #[test]
    fn a_source_host_may_be_self_hosted_but_not_internal() {
        for good in [
            "https://api.github.com",
            "https://gitlab.example.org",
            "https://git.internal-name-that-is-public.com/api/v4",
        ] {
            assert!(
                check_url(good, "Server URL", HostRule::AnyPublic).is_ok(),
                "{good} is a public installation and should be allowed"
            );
        }
        for bad in [
            "https://gitlab.svc.cluster.local",
            "https://192.168.1.10/api/v4",
            "http://gitlab.example.org",
        ] {
            assert!(
                check_url(bad, "Server URL", HostRule::AnyPublic).is_err(),
                "{bad} should have been refused"
            );
        }
    }
}
