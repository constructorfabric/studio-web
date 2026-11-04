//! A kit's passport, `kit.gdl` (GDL 1.6, ADR-0061), read without evaluating
//! it.
//!
//! A kit -- specification templates, workflows and the rules that check them,
//! installed into a project by `cfs` -- says what it is in one file beside its
//! `.cf-studio-kit.toml`, one passport per kit:
//!
//! ```text
//! gdl_version = "1.6"
//!
//! kit(
//!     name = "sdlc",
//!     title = "Software Delivery Lifecycle",
//!     version = "1.4.0",
//!     description = "Product-to-code traceability with PRD, ADR and DESIGN workflows",
//!     publisher = "Constructor Fabric",
//!     visibility = "public",
//!     manifest = ".cf-studio-kit.toml",
//!     kinds = ["PRD", "ADR", "DESIGN", "FEATURE"],
//!     docs = ["README.md"],
//! )
//! ```
//!
//! `name` is the slug the kit registry and the installer know it by, and the
//! only argument required. The installer still reads the manifest; the
//! passport is what the catalogue shows and versions.

use super::gdl_literal::{self, Args};

/// The GDL version `kit.gdl` was introduced in.
pub(crate) const GDL_VERSION: &str = "1.6";

/// The file that marks a kit.
pub(crate) const FILE: &str = "kit.gdl";

/// What a `kit.gdl` declares.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct KitPassport {
    /// Its slug: what a project installs it by.
    pub name: String,
    /// What a person calls it.
    pub title: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    pub publisher: Option<String>,
    /// `public` or `private`.
    pub visibility: Option<String>,
    /// The installer's manifest, relative to the passport's directory.
    pub manifest: Option<String>,
    /// The kinds of artifact it brings templates and rules for.
    pub kinds: Vec<String>,
    /// Its documents, relative to the passport's directory.
    pub docs: Vec<String>,
}

const ARGS: [&str; 9] = [
    "name",
    "title",
    "version",
    "description",
    "publisher",
    "visibility",
    "manifest",
    "kinds",
    "docs",
];

/// Read a `kit.gdl`. `Err` says why it is not one this reads.
pub(crate) fn read(src: &str) -> Result<KitPassport, String> {
    let call = gdl_literal::read_call(src, FILE, &["kit"], GDL_VERSION)?;
    let a = Args { call: &call };
    a.only(&ARGS)?;
    let name = a.string("name", gdl_literal::kebab)?.ok_or_else(|| {
        format!(
            "line {}: `kit()` must name itself: `name = \"…\"`",
            call.line
        )
    })?;
    Ok(KitPassport {
        name,
        title: a.string("title", gdl_literal::one_line)?,
        version: a.string("version", gdl_literal::word)?,
        description: a.string("description", gdl_literal::one_line)?,
        publisher: a.string("publisher", gdl_literal::one_line)?,
        visibility: a.string("visibility", |v| {
            if matches!(v, "public" | "private") {
                Ok(())
            } else {
                Err("is not \"public\" or \"private\"".into())
            }
        })?,
        manifest: a.string("manifest", gdl_literal::relative_path)?,
        kinds: a.list("kinds", gdl_literal::word)?.unwrap_or_default(),
        docs: a
            .list("docs", gdl_literal::relative_path)?
            .unwrap_or_default(),
    })
}

#[cfg(test)]
#[path = "kit_gdl_tests.rs"]
mod tests;
