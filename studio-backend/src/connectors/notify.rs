//! What the three chat drivers share.
//!
//! Rendering and error surfacing. Provider knowledge itself stays in
//! [`super::slack`], [`super::zulip`] and [`super::discord`] — this module
//! holds only what would otherwise be written three times.
//!
//! The guard on user-supplied URLs used to live here, when the three chat
//! drivers were the only ones that checked. It is [`super::url_guard`] now,
//! because every driver takes an address from configuration and every one of
//! them needs it.

use anyhow::anyhow;

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
}
