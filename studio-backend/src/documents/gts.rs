//! GTS type registration for studio-documents.
//!
//! Four types are registered in the platform types-registry so other gears and
//! the UI can discover them: the shape of a document-type catalogue entry, the
//! shape of a document, and the shapes of a journey stage and a capability.
//!
//! A catalogue key (`prd`, `adr`, a workspace's own `vision`) is an INSTANCE
//! of `DOCUMENT_TYPE`, not a type of its own — see ADR-0014 section 2 for why
//! minting one id per key was wrong.
//!
//! Free-form (`type: object`) schemas, the same shape the studio artifact types
//! use, so registration never trips the closed-envelope narrowing check.

use serde_json::{Value, json};

pub const DOCUMENT_TYPE: &str = "gts.cf.studio.doc.document_type.v1~";
pub const DOCUMENT: &str = "gts.cf.studio.doc.document.v1~";

/// Stages describe the process, not a document, so they take a namespace of
/// their own rather than crowding `doc` (ADR-0014 section 5).
pub const STAGE: &str = "gts.cf.studio.process.stage.v1~";

/// The capability vocabulary, same namespace and same reasoning as `STAGE`.
pub const CAPABILITY: &str = "gts.cf.studio.process.capability.v1~";

/// Schemas registered at gear init.
pub fn type_schemas() -> Vec<Value> {
    [
        (
            DOCUMENT_TYPE,
            // Written for a person, not for a compiler: ADR-0013 makes the
            // catalogue's titles a product surface, and this one is rendered as
            // a component type on the Components page.
            "Document type",
            "A document type: a template, section checklist and conformance rules.",
        ),
        (
            DOCUMENT,
            "Document",
            "A document instance created from a document type.",
        ),
        (
            STAGE,
            "Journey Stage",
            "One stage of the journey a project passes through.",
        ),
        (
            CAPABILITY,
            "Capability",
            "Something a product may need, and the terms that find components providing it.",
        ),
    ]
    .into_iter()
    .map(|(id, title, description)| {
        json!({
            "$id": format!("gts://{id}"),
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": title,
            "description": description,
            "type": "object",
        })
    })
    .collect()
}
