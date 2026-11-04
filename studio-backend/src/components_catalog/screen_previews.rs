//! Screen previews: what each screen of a micro-frontend looked like in a
//! build.
//!
//! A build of the shell starts it, visits every screen a micro-frontend's
//! `mfe.json` places, and takes a picture of each
//! (`scripts/mfe-screen-previews.mjs`). The pictures are kept here, beside the
//! component they show, so the product map can show the real screen of the
//! built version instead of a schematic one.
//!
//! The bytes live in the graph node's payload as a `data:` URL. A picture is a
//! small WebP or PNG (a 1280x800 screen scaled down), and the catalogue's store
//! is the only one every deployment has: the file-storage gear is
//! config-gated and reads nothing back yet (`artifact_ingest::object_store`).
//! When it can, `image` becomes a reference and the wire shape stays.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail};
use base64::Engine as _;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;

use super::gts::{self, GtsNode};
use super::service::CatalogService;

/// The largest picture kept, decoded.
pub(crate) const MAX_IMAGE_BYTES: usize = 512 * 1024;
/// How many builds of one component are kept: the newest, and two to compare.
pub(crate) const KEPT_BUILDS: usize = 3;
/// The image types a picture may be.
const IMAGE_TYPES: [&str; 3] = ["image/webp", "image/png", "image/jpeg"];

/// One screen's picture as a build hands it in.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NewScreenPreview {
    pub component: String,
    pub version: Option<String>,
    pub commit: String,
    pub route: String,
    pub label: Option<String>,
    pub order: u32,
    /// `data:image/webp;base64,...`
    pub image: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Why a picture is refused, by the field that is wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Refusal {
    pub field: &'static str,
    pub reason: String,
}

fn refuse(field: &'static str, reason: impl Into<String>) -> Refusal {
    Refusal {
        field,
        reason: reason.into(),
    }
}

/// A commit, a tag or a local build's name: letters, digits, `.`, `_`, `-`.
fn is_build_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// The picture checked: names that read, a route in the shell, and an image
/// that is one of [`IMAGE_TYPES`], decodes, and is no larger than
/// [`MAX_IMAGE_BYTES`].
pub(crate) fn validate(p: &NewScreenPreview) -> Result<(), Refusal> {
    let component = p.component.trim();
    if component.is_empty() || component.len() > 214 {
        return Err(refuse("component", "must be 1 to 214 characters"));
    }
    if !is_build_id(&p.commit) {
        return Err(refuse(
            "commit",
            "must be 1 to 64 letters, digits, '.', '_' or '-'",
        ));
    }
    if let Some(v) = &p.version
        && (v.is_empty() || v.len() > 64)
    {
        return Err(refuse("version", "must be 1 to 64 characters"));
    }
    if !p.route.starts_with('/') || p.route.len() > 200 {
        return Err(refuse(
            "route",
            "must start with '/' and be at most 200 characters",
        ));
    }
    if p.label.as_ref().is_some_and(|l| l.len() > 120) {
        return Err(refuse("label", "must be at most 120 characters"));
    }
    let Some((head, data)) = p.image.split_once(',') else {
        return Err(refuse("image", "must be a data: URL"));
    };
    let Some(mime) = head
        .strip_prefix("data:")
        .and_then(|h| h.strip_suffix(";base64"))
    else {
        return Err(refuse("image", "must be a base64 data: URL"));
    };
    if !IMAGE_TYPES.contains(&mime) {
        return Err(refuse(
            "image",
            format!("must be one of {}, got {mime}", IMAGE_TYPES.join(", ")),
        ));
    }
    // Decoded size from the length, before decoding a body that is too big.
    if data.len() / 4 * 3 > MAX_IMAGE_BYTES + 3 {
        return Err(refuse(
            "image",
            format!("must be at most {MAX_IMAGE_BYTES} bytes"),
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| refuse("image", format!("is not base64: {e}")))?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(refuse(
            "image",
            format!("must be 1 to {MAX_IMAGE_BYTES} bytes"),
        ));
    }
    Ok(())
}

/// The node a picture is kept as, stamped with when it was taken in.
pub(crate) fn node(p: &NewScreenPreview, captured_at: &str) -> GtsNode {
    let component = p.component.trim();
    gts::screen_preview_node(
        component,
        &p.commit,
        &p.route,
        json!({
            "component": component,
            "version": p.version,
            "commit": p.commit,
            "route": p.route,
            "label": p.label,
            "order": p.order,
            "image": p.image,
            "width": p.width,
            "height": p.height,
            "captured_at": captured_at,
        }),
    )
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// When each build was last taken in: its newest picture's time.
fn build_times(rows: &[Value]) -> BTreeMap<&str, &str> {
    let mut at: BTreeMap<&str, &str> = BTreeMap::new();
    for r in rows {
        let (commit, time) = (text(r, "commit"), text(r, "captured_at"));
        let slot = at.entry(commit).or_default();
        if time > *slot {
            *slot = time;
        }
    }
    at
}

/// The pictures in the order a reader wants them: the newest build first,
/// and within a build the order the build gave, then the route.
pub(crate) fn ordered(mut rows: Vec<Value>) -> Vec<Value> {
    rows.retain(|r| !text(r, "commit").is_empty() && !text(r, "image").is_empty());
    let at: BTreeMap<String, String> = build_times(&rows)
        .into_iter()
        .map(|(c, t)| (c.to_owned(), t.to_owned()))
        .collect();
    let order = |r: &Value| r.get("order").and_then(Value::as_u64).unwrap_or(u64::MAX);
    rows.sort_by(|a, b| {
        let (ca, cb) = (text(a, "commit"), text(b, "commit"));
        at[cb]
            .cmp(&at[ca])
            .then_with(|| ca.cmp(cb))
            .then_with(|| order(a).cmp(&order(b)))
            .then_with(|| text(a, "route").cmp(text(b, "route")))
    });
    rows
}

/// The pictures of builds past the newest [`KEPT_BUILDS`], by instance id.
pub(crate) fn stale(rows: &[Value]) -> Vec<String> {
    let mut builds: Vec<(&str, &str)> = build_times(rows).into_iter().collect();
    builds.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    let kept: Vec<&str> = builds.iter().take(KEPT_BUILDS).map(|(c, _)| *c).collect();
    rows.iter()
        .filter(|r| !kept.contains(&text(r, "commit")))
        .map(|r| {
            gts::screen_preview_instance_id(
                text(r, "component"),
                text(r, "commit"),
                text(r, "route"),
            )
        })
        .collect()
}

impl CatalogService {
    /// Keep one screen's picture, and drop the builds past the newest
    /// [`KEPT_BUILDS`] of its component.
    pub async fn save_screen_preview(
        &self,
        ctx: &SecurityContext,
        preview: &NewScreenPreview,
    ) -> anyhow::Result<Value> {
        if let Err(r) = validate(preview) {
            bail!("{} {}", r.field, r.reason);
        }
        let now = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|e| anyhow!("format the time: {e}"))?;
        let node = node(preview, &now);
        // The type may be new to this tenant's graph; registering is idempotent.
        self.sink.register_types(ctx).await?;
        self.sink
            .write_previews(ctx, std::slice::from_ref(&node))
            .await?;
        let rows = self.sink.previews(ctx, preview.component.trim()).await?;
        let gone = stale(&rows);
        if !gone.is_empty() {
            self.sink.delete_previews(ctx, &gone).await?;
        }
        Ok(node.value)
    }

    /// One component's pictures, the newest build first.
    pub async fn screen_previews(
        &self,
        ctx: &SecurityContext,
        component: &str,
    ) -> anyhow::Result<Vec<Value>> {
        Ok(ordered(self.sink.previews(ctx, component.trim()).await?))
    }
}

#[cfg(test)]
#[path = "screen_previews_tests.rs"]
mod tests;
