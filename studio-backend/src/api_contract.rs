//! `api-contract` — the mechanical half of `docs/api-conventions.md`.
//!
//! # Why a source scanner and not a router walk
//!
//! The conventions this module enforces are about the *declaration* of an
//! operation, not about its behaviour: the path it is registered under, the
//! `operation_id` a generated client will name its method after, whether a
//! human wrote down what the endpoint is for, whether a response carries a
//! schema at all. All of that lives in the `OperationBuilder` chain, and all of
//! it is readable from the source without booting an assembly, opening a
//! database or resolving twenty gears. A check that needs none of those runs on
//! every PR in milliseconds, which is the difference between a rule that is
//! enforced and a rule that is aspirational.
//!
//! The same choice [`crate::gts_inventory`] made, for the same reason.
//!
//! # The ratchet
//!
//! This assembly grew ~170 operations before it had conventions, so most rules
//! have existing violations. Failing on all of them would mean either a
//! months-long migration before the check can land, or a check nobody turns on.
//! Instead every known violation is listed in
//! `docs/api-contract-baseline.txt`, and the test asserts the violation set is
//! **exactly** that file:
//!
//! * a new violation fails the build — the rules bind every operation written
//!   from now on;
//! * a *fixed* violation also fails the build, until its line is deleted from
//!   the baseline — so the file can only shrink, and the debt stays counted
//!   rather than forgotten.
//!
//! When the baseline reaches zero lines it is deleted, along with this section.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

/// The domain registry: the first path segment of every Studio API.
///
/// A domain lands here in the same PR that registers its first operation, which
/// makes "new domain or typo?" a review question instead of a runtime surprise.
const DOMAINS: &[&str] = &[
    "spec-quality",
    "studio-artifact-ingest",
    "studio-components-catalog",
    "studio-connector",
    "studio-documents",
    "studio-domain-model",
    "studio-events",
    "studio-identity",
    "studio-insight",
    "studio-kits",
    "studio-llm",
    "studio-notify",
    "studio-organizations",
    "studio-scheduler",
    "studio-session",
    "studio-tasks",
    "studio-theia",
    "studio-user",
];

/// The verbs an `operation_id` may begin with (rule A2).
///
/// The first seven are the resource lifecycle and cover every CRUD surface. The
/// rest are *actions*: things done to a resource that are not a read or a write
/// of it. The list is closed on purpose — two words for one act (`save` and
/// `update`, `set` and `put`) is how a client ends up with two names for one
/// call.
#[rustfmt::skip]
const VERBS: &[&str] = &[
    // the resource lifecycle
    "list", "get", "create", "update", "patch", "delete", "upsert",
    // actions: a thing done to a resource that is neither a read nor a write
    // of it. Each one here is a distinct act — `invite` is not `create`, and
    // `materialize` is not `update`. What is deliberately absent is the
    // synonyms: `save`, `set`, `put` and `edit` all mean `update` or `upsert`,
    // `add` means `create`, `remove` means `delete`.
    "accept", "analyze", "assign", "backfill", "cancel", "claim", "classify", "close", "confirm",
    "count", "decide",
    "enqueue", "export", "import", "invite", "leave", "materialize", "merge", "open", "probe",
    "pull", "push", "query", "reconcile", "resolve", "retry", "revert", "revoke", "run",
    "scaffold", "search", "send", "start", "stream", "sync", "test", "validate",
];

/// Path parameters that name a scope (rule C).
///
/// Tenancy comes from the security context and a project from `?project_id=`; a
/// scope in the path is the shape that forces one operation per scope, which is
/// how `studio-documents` ended up with `list_workspace_documents` and
/// `list_organization_types` side by side.
const SCOPE_PARAMS: &[&str] = &[
    "{organization_id}",
    "{org_id}",
    "{tenant_id}",
    "{workspace_id}",
    "{project_id}",
];

/// This module's own source, excluded from the scan: it quotes every token the
/// scanner looks for, and scanning it would invent operations that do not exist.
const SELF_FILE: &str = "api_contract.rs";

/// One registered operation, as the source declares it.
#[derive(Debug, Clone)]
struct Operation {
    /// Path of the source file, relative to the crate root.
    file: String,
    /// 1-based line of the `OperationBuilder::…` that starts the chain.
    line: usize,
    /// Upper-case HTTP method.
    method: String,
    /// The registered path, or `None` when it is not a string literal.
    path: Option<String>,
    operation_id: Option<String>,
    summary: Option<String>,
    description: Option<String>,
    tag: Option<String>,
    authenticated: bool,
    anonymous: bool,
    /// Error responses declared on the chain, by status code.
    errors: BTreeSet<String>,
    /// The request body DTO, where the operation takes one.
    request_type: Option<String>,
    /// Response types registered with a schema.
    response_types: Vec<String>,
    /// The operation answers `204` and has no body by design.
    no_content: bool,
}

impl Operation {
    /// `GET /studio-events/v1/stream` — the key a baseline line is written
    /// under. Stable across refactors that move code within a file.
    ///
    /// An operation whose path is computed has no such name, so it is keyed by
    /// the file it lives in — enough to tell the three of them apart, and one
    /// more reason the rule wants them gone.
    fn key(&self) -> String {
        match self.path.as_deref() {
            Some(path) => format!("{} {path}", self.method),
            None => format!("{} <dynamic@{}>", self.method, self.file),
        }
    }

    /// The path's first segment: the domain that owns the operation.
    fn domain(&self) -> &str {
        self.path
            .as_deref()
            .and_then(|p| p.strip_prefix('/'))
            .and_then(|p| p.split('/').next())
            .unwrap_or("")
    }
}

/// One broken rule, attributed to one operation.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Violation {
    /// Rule code. The same code appears in `docs/api-conventions.md` next to
    /// the rule it enforces.
    rule: &'static str,
    /// `<METHOD> <path>`.
    key: String,
    /// What is wrong, in one line, for the failure message.
    detail: String,
    /// `file:line`, for the failure message only — deliberately **not** part of
    /// the baseline line, so moving code between files does not churn it.
    site: String,
}

impl Violation {
    /// The baseline line: rule and key, tab-separated.
    fn baseline_line(&self) -> String {
        format!("{}\t{}", self.rule, self.key)
    }
}

/// A struct declared somewhere in the crate, reduced to what rule B needs.
#[derive(Debug, Default, Clone)]
struct StructShape {
    /// `(field name, type)` in declaration order, `pub` fields only.
    fields: Vec<(String, String)>,
}

impl StructShape {
    fn vec_fields(&self) -> Vec<&(String, String)> {
        self.fields
            .iter()
            .filter(|(_, ty)| ty.starts_with("Vec<"))
            .collect()
    }

    fn field(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, ty)| ty.as_str())
    }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// Every `.rs` file under `src/`, sorted, so a run is reproducible.
fn source_files(src: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![src.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "rs")
                && path.file_name().is_some_and(|name| name != SELF_FILE)
            {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// Blank out `//` comments while leaving byte offsets and line breaks intact.
///
/// Offsets have to survive because line numbers are computed from them, and a
/// comment cannot simply be searched for: `https://…` inside a string literal is
/// not a comment, and a commented-out builder chain is not an operation.
fn strip_line_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut in_string = false;
    let mut in_char = false;
    while i < bytes.len() {
        let byte = bytes[i];
        if in_string || in_char {
            out.push(byte);
            if byte == b'\\' && i + 1 < bytes.len() {
                out.push(bytes[i + 1]);
                i += 2;
                continue;
            }
            if (in_string && byte == b'"') || (in_char && byte == b'\'') {
                in_string = false;
                in_char = false;
            }
            i += 1;
            continue;
        }
        match byte {
            b'"' => {
                in_string = true;
                out.push(byte);
                i += 1;
            }
            // A char literal, as opposed to a lifetime: `'x'` and `'\n'` both
            // have a quote two bytes on, `'static` does not.
            b'\'' if i + 2 < bytes.len() && bytes[i + 2] == b'\'' => {
                in_char = true;
                out.push(byte);
                i += 1;
            }
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'/' => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    out.push(b' ');
                    i += 1;
                }
            }
            _ => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| src.to_string())
}

/// The slice inside the parentheses that open at `open`, parens balanced and
/// string literals respected. `open` must index a `(`.
fn balanced(src: &str, open: usize) -> Option<&str> {
    let bytes = src.as_bytes();
    if bytes.get(open) != Some(&b'(') {
        return None;
    }
    let mut depth = 0usize;
    let mut in_string = false;
    let mut i = open;
    while i < bytes.len() {
        let byte = bytes[i];
        if in_string {
            if byte == b'\\' {
                i += 2;
                continue;
            }
            if byte == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&src[open + 1..i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Contents of every `"…"` literal in `slice`, concatenated in order.
///
/// Concatenated because the builder's long prose arrives as adjacent literals
/// that `rustfmt` wraps across lines; what the rules ask about is the text.
fn joined_literals(slice: &str) -> String {
    let bytes = slice.as_bytes();
    let mut out: Vec<u8> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'"' {
            i += 1;
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i] != b'"' {
            if bytes[i] == b'\\' {
                i += 2;
                continue;
            }
            out.push(bytes[i]);
            i += 1;
        }
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// The argument slice of `.name(` inside a chain, if the call is there.
fn call_args<'a>(chain: &'a str, name: &str) -> Option<&'a str> {
    let at = chain.find(name)?;
    balanced(chain, at + name.len() - 1)
}

/// Turbofish type argument of `.name::<T>(`, if the call is there.
fn call_type(chain: &str, name: &str) -> Option<String> {
    let at = chain.find(name)?;
    let rest = &chain[at + name.len()..];
    let end = rest.find('>')?;
    Some(rest[..end].trim().to_string())
}

/// Parse every `OperationBuilder` chain in one file.
fn operations_in(file: &Path, crate_root: &Path, src: &str) -> Vec<Operation> {
    const OPEN: &str = "OperationBuilder::";
    let relative = file
        .strip_prefix(crate_root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/");
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(at) = src[from..].find(OPEN) {
        let start = from + at;
        from = start + OPEN.len();
        let tail = &src[from..];
        let Some(paren) = tail.find('(') else {
            continue;
        };
        let method = tail[..paren].trim().to_ascii_uppercase();
        if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
            continue;
        }
        // The chain runs to its `.register(`; everything the rules ask about is
        // declared before it.
        let chain_end = src[start..]
            .find(".register(")
            .map_or(src.len(), |offset| start + offset);
        let chain = &src[start..chain_end];
        let constructor = balanced(src, from + paren).unwrap_or("");
        let path = {
            let literal = joined_literals(constructor);
            (!literal.is_empty()).then_some(literal)
        };
        out.push(Operation {
            file: relative.clone(),
            line: src[..start].bytes().filter(|byte| *byte == b'\n').count() + 1,
            method,
            path,
            operation_id: call_args(chain, ".operation_id(").map(joined_literals),
            summary: call_args(chain, ".summary(").map(joined_literals),
            description: call_args(chain, ".description(").map(joined_literals),
            tag: call_args(chain, ".tag(").map(joined_literals),
            authenticated: chain.contains(".authenticated("),
            anonymous: chain.contains(".anonymous("),
            errors: ["400", "401", "403", "404", "500"]
                .into_iter()
                .filter(|code| chain.contains(&format!(".error_{code}(")))
                .map(str::to_string)
                .collect(),
            request_type: call_type(chain, ".json_request::<"),
            response_types: [".json_response_with_schema::<", ".sse_json::<"]
                .into_iter()
                .filter_map(|name| call_type(chain, name))
                .collect(),
            no_content: chain.contains(".no_content_response("),
        });
    }
    out
}

/// Every `pub struct` in the crate, by name.
///
/// Response DTO names are unique assembly-wide — a duplicate panics the boot —
/// so a flat map is the right index.
fn struct_shapes(sources: &[(PathBuf, String)]) -> BTreeMap<String, StructShape> {
    const OPEN: &str = "pub struct ";
    let mut out: BTreeMap<String, StructShape> = BTreeMap::new();
    for (_, src) in sources {
        let mut from = 0usize;
        while let Some(at) = src[from..].find(OPEN) {
            let start = from + at + OPEN.len();
            from = start;
            let rest = &src[start..];
            let Some(brace) = rest.find('{') else {
                continue;
            };
            let header = &rest[..brace];
            if header.contains(';') || header.contains('(') {
                continue; // a unit or tuple struct: no named fields to check
            }
            let name: String = header
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if name.is_empty() {
                continue;
            }
            let body = &rest[brace + 1..];
            let Some(end) = body.find("\n}") else {
                continue;
            };
            let mut shape = StructShape::default();
            for line in body[..end].lines() {
                let Some(declaration) = line.trim().strip_prefix("pub ") else {
                    continue;
                };
                let Some((field, ty)) = declaration.split_once(':') else {
                    continue;
                };
                shape.fields.push((
                    field.trim().trim_start_matches("r#").to_string(),
                    ty.trim().trim_end_matches(',').trim().to_string(),
                ));
            }
            out.insert(name, shape);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/// Apply every rule to every operation. The result is sorted and deduplicated.
fn violations(operations: &[Operation], structs: &BTreeMap<String, StructShape>) -> Vec<Violation> {
    let mut out: Vec<Violation> = Vec::new();
    let mut seen_ids: BTreeMap<&str, String> = BTreeMap::new();
    let mut domain_tags: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();

    for operation in operations {
        let key = operation.key();
        let site = format!("{}:{}", operation.file, operation.line);
        let mut broken: Vec<(&'static str, String)> = Vec::new();

        // --- A. path and name ------------------------------------------------
        let Some(path) = operation.path.as_deref() else {
            out.push(Violation {
                rule: "path-literal",
                key,
                detail: "the path is not a string literal, so no client can be generated from it"
                    .into(),
                site,
            });
            continue;
        };
        let domain = operation.domain();
        if !DOMAINS.contains(&domain) {
            broken.push((
                "domain-registered",
                format!("`{domain}` is not in the domain registry (api_contract::DOMAINS)"),
            ));
        }
        if !domain.starts_with("studio-") {
            broken.push((
                "domain-prefix",
                format!("`{domain}` does not start with `studio-`"),
            ));
        }
        if !path.starts_with(&format!("/{domain}/v1/")) {
            broken.push((
                "path-version",
                "the path is not `/<domain>/v1/<resource>`".into(),
            ));
        }

        match operation.operation_id.as_deref() {
            None => broken.push((
                "op-id",
                "no operation_id: a generated client has nothing to name the method".into(),
            )),
            Some(id) => {
                match id.split_once('.') {
                    Some((head, tail)) => {
                        let expected = domain.replace('-', "_");
                        if head != expected {
                            broken.push((
                                "op-id",
                                format!("`{id}` does not start with the domain `{expected}.`"),
                            ));
                        }
                        let verb = tail.split('_').next().unwrap_or("");
                        if !VERBS.contains(&verb) {
                            broken.push((
                                "op-id-verb",
                                format!("`{verb}` is not one of api_contract::VERBS"),
                            ));
                        }
                    }
                    None => {
                        broken.push(("op-id", format!("`{id}` is not `<domain>.<verb>_<noun>`")))
                    }
                }
                if let Some(previous) = seen_ids.insert(id, key.clone()) {
                    broken.push((
                        "op-id-unique",
                        format!("`{id}` is already used by {previous}"),
                    ));
                }
            }
        }

        // --- C. scope ---------------------------------------------------------
        for param in SCOPE_PARAMS {
            if path.contains(param) {
                broken.push((
                    "scope-in-path",
                    format!(
                        "{param} belongs in the security context or in `?project_id=`, not in the path"
                    ),
                ));
            }
        }

        // --- D. long-running work ---------------------------------------------
        if path.contains("/tasks/{") && domain != "studio-tasks" {
            broken.push((
                "local-task-endpoint",
                "background work is observed through studio-tasks and `task.*` events, not a private status endpoint"
                    .into(),
            ));
        }

        // --- F. documentation --------------------------------------------------
        match operation.summary.as_deref() {
            None => broken.push((
                "summary",
                "no summary: the operation is unnamed in /cf/docs".into(),
            )),
            Some(text) if text.trim().is_empty() => {
                broken.push(("summary", "the summary is empty".into()));
            }
            Some(text) if text.chars().count() > 120 => broken.push((
                "summary",
                format!(
                    "the summary is {} characters; a summary is one line (<= 120)",
                    text.chars().count()
                ),
            )),
            Some(_) => {}
        }
        match operation.description.as_deref() {
            None => broken.push((
                "description",
                "no description: when to call it and what bites is undocumented".into(),
            )),
            Some(text) if text.trim().chars().count() < 40 => broken.push((
                "description",
                format!(
                    "the description is {} characters; say when to call it, not what it is named",
                    text.trim().chars().count()
                ),
            )),
            Some(_) => {}
        }
        match operation.tag.as_deref() {
            None => broken.push((
                "tag",
                "no tag: the operation lands ungrouped in /cf/docs".into(),
            )),
            Some(tag) => {
                domain_tags.entry(domain).or_default().insert(tag);
            }
        }

        // --- authentication ----------------------------------------------------
        if !operation.authenticated && !operation.anonymous {
            broken.push((
                "auth",
                "neither .authenticated() nor .anonymous(): the gateway's route policy is left to a default"
                    .into(),
            ));
        }
        if operation.authenticated && !operation.errors.contains("401") {
            broken.push((
                "error-401",
                "an authenticated operation can answer 401 and does not declare it".into(),
            ));
        }

        // --- B. response shape --------------------------------------------------
        let lists_a_collection = operation
            .operation_id
            .as_deref()
            .and_then(|id| id.split_once('.'))
            .is_some_and(|(_, tail)| tail == "list" || tail.starts_with("list_"));

        if operation.response_types.is_empty() && !operation.no_content {
            broken.push((
                "typed-response",
                "the response is registered without a schema, so it is invisible to client generation"
                    .into(),
            ));
        }
        for ty in &operation.response_types {
            let Some(shape) = structs.get(ty) else {
                continue;
            };
            let vectors = shape.vec_fields();
            // A collection is recognised by its DTO's name or by the operation
            // being a `list_…`. Deliberately NOT "the struct has one Vec field":
            // `DocumentDto` has `sections` and `SessionDto` has `repositories`,
            // and demanding `items` and a `total` of those is nonsense.
            let looks_like_a_list = ty.ends_with("ListDto")
                || ty.ends_with("ListResponse")
                || ty.ends_with("Page")
                || lists_a_collection;
            if vectors.is_empty() || !looks_like_a_list {
                continue;
            }
            if vectors.len() != 1 || vectors[0].0 != "items" {
                let names: Vec<&str> = vectors.iter().map(|(name, _)| name.as_str()).collect();
                broken.push((
                    "list-envelope",
                    format!("{ty} carries {names:?}; a collection is `items`"),
                ));
            }
            match shape.field("total") {
                None => broken.push((
                    "list-envelope",
                    format!(
                        "{ty} has no `total`, so a caller cannot tell that another page exists"
                    ),
                )),
                Some("u32") => {}
                Some(other) => broken.push((
                    "list-envelope",
                    format!("{ty}.total is `{other}`; it is `u32` everywhere else"),
                )),
            }
        }

        out.extend(broken.into_iter().map(|(rule, detail)| Violation {
            rule,
            key: key.clone(),
            detail,
            site: site.clone(),
        }));
    }

    for (domain, tags) in &domain_tags {
        if tags.len() > 1 {
            let tags: Vec<&str> = tags.iter().copied().collect();
            out.push(Violation {
                rule: "tag-per-domain",
                key: format!("DOMAIN /{domain}"),
                detail: format!("/{domain} is tagged {tags:?}; one domain is one tag"),
                site: format!("/{domain}"),
            });
        }
    }

    out.sort();
    out.dedup();
    out
}

// ---------------------------------------------------------------------------
// The committed snapshot
// ---------------------------------------------------------------------------

/// `studio-backend/docs/api-contract.json` — the API surface this binary
/// declares, in one file a reviewer can diff.
///
/// It is not the OpenAPI document: that one is built by the api-gateway during
/// the `rest` phase and needs a booted assembly. This is what can be proven
/// from the source alone, and it is the half a frontend reviewer needs — a path
/// that moved, an `operation_id` that was renamed, a DTO that changed sides.
/// `scripts/check-api-usage.mjs` reads it to prove both portals still call
/// paths that exist.
///
/// Deliberately absent: `description` (long, and a wording fix would swamp the
/// diff) and the source location (churns whenever code moves).
#[derive(serde::Serialize)]
struct ContractSnapshot {
    note: &'static str,
    /// How many lines the baseline file holds — distinct `(rule, operation)`
    /// pairs, so it is the number a reader can check against that file rather
    /// than the raw violation count (one operation can break one rule in two
    /// ways and still be one line).
    open_violations: usize,
    operations: Vec<SnapshotOperation>,
}

/// One operation as the snapshot records it.
#[derive(serde::Serialize)]
struct SnapshotOperation {
    method: String,
    /// The registered path, or `<dynamic@file>` for a computed one.
    path: String,
    operation_id: Option<String>,
    tag: Option<String>,
    summary: Option<String>,
    authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    request: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    responses: Vec<String>,
    errors: Vec<String>,
}

/// The snapshot as it is committed: pretty JSON, newline-terminated, stable
/// order.
pub fn to_pretty_json() -> anyhow::Result<String> {
    let (operations, violations) = audit(Path::new(env!("CARGO_MANIFEST_DIR")));
    let snapshot = ContractSnapshot {
        note: concat!(
            "The API surface studio-backend declares. ",
            "Generated from source by `cargo run --quiet -- api-contract`; ",
            "the rules it must follow are docs/api-conventions.md."
        ),
        open_violations: violations
            .iter()
            .map(Violation::baseline_line)
            .collect::<BTreeSet<_>>()
            .len(),
        operations: operations
            .iter()
            .map(|operation| SnapshotOperation {
                method: operation.method.clone(),
                path: operation
                    .path
                    .clone()
                    .unwrap_or_else(|| format!("<dynamic@{}>", operation.file)),
                operation_id: operation.operation_id.clone(),
                tag: operation.tag.clone(),
                summary: operation.summary.clone(),
                authenticated: operation.authenticated,
                request: operation.request_type.clone(),
                responses: operation.response_types.clone(),
                errors: operation.errors.iter().cloned().collect(),
            })
            .collect(),
    };
    Ok(format!("{}\n", serde_json::to_string_pretty(&snapshot)?))
}

/// `studio-backend api-contract --violations`: the same report `cargo test`
/// gives, plus the baseline lines to paste, without compiling the test harness.
pub fn print_violations() {
    let (_, violations) = audit(Path::new(env!("CARGO_MANIFEST_DIR")));
    let listed: Vec<&Violation> = violations.iter().collect();
    print!(
        "{}",
        report("Open violations of docs/api-conventions.md", &listed)
    );
    println!("\nAs baseline lines (docs/api-contract-baseline.txt):\n");
    for violation in &violations {
        println!("{}", violation.baseline_line());
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Scan the crate: every declared operation, and every rule it breaks.
fn audit(crate_root: &Path) -> (Vec<Operation>, Vec<Violation>) {
    let sources: Vec<(PathBuf, String)> = source_files(&crate_root.join("src"))
        .into_iter()
        .filter_map(|path| {
            let text = fs::read_to_string(&path).ok()?;
            Some((path, strip_line_comments(&text)))
        })
        .collect();

    let mut operations = Vec::new();
    for (path, text) in &sources {
        operations.extend(operations_in(path, crate_root, text));
    }
    operations.sort_by(|a, b| a.key().cmp(&b.key()).then_with(|| a.file.cmp(&b.file)));

    let structs = struct_shapes(&sources);
    let violations = violations(&operations, &structs);
    (operations, violations)
}

/// Render a violation list as a failure message: what broke, and where.
fn report(title: &str, violations: &[&Violation]) -> String {
    let mut out = format!("\n{title} ({} of them)\n\n", violations.len());
    for violation in violations {
        let _ = writeln!(
            out,
            "  [{}] {}\n      {} ({})",
            violation.rule, violation.key, violation.detail, violation.site
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crate_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    /// The agreed exceptions: one `<rule>\t<METHOD> <path>` line each.
    fn baseline() -> BTreeSet<String> {
        let text = fs::read_to_string(crate_root().join("docs/api-contract-baseline.txt"))
            .unwrap_or_default();
        text.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            // `<rule><whitespace><METHOD> <path>`: the split is on the FIRST
            // run of whitespace only — the space inside the key is part of it.
            .map(|line| {
                let (rule, key) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
                format!("{rule}	{}", key.trim())
            })
            .collect()
    }

    /// The scanner still sees the operations that are actually there.
    ///
    /// A parser that silently stopped matching chains would turn every rule
    /// below into a no-op, and the suite would stay green while the contract
    /// rotted. This is the canary for that.
    #[test]
    fn the_scanner_finds_every_operation() {
        let (operations, _) = audit(&crate_root());
        assert!(
            operations.len() >= 150,
            "only {} OperationBuilder chains found — the scanner stopped seeing them",
            operations.len()
        );
        assert!(
            operations
                .iter()
                .any(|operation| operation.path.as_deref() == Some("/studio-events/v1/stream")),
            "the events stream is missing from the scan"
        );
    }

    /// The committed snapshot still describes the surface the code declares.
    ///
    /// This is what makes an API change visible in a pull request: the diff of
    /// `docs/api-contract.json` is the diff of the contract, and it is what a
    /// frontend reviewer reads instead of the whole backend patch.
    #[test]
    fn the_snapshot_matches_the_committed_contract() -> anyhow::Result<()> {
        let committed = include_str!("../docs/api-contract.json");
        assert_eq!(
            to_pretty_json()?,
            committed,
            concat!(
                "the API surface changed — regenerate the snapshot with ",
                "`cargo run --quiet -- api-contract > docs/api-contract.json` ",
                "and review the diff. If a path, an operation_id or a DTO moved, ",
                "both portals have to move with it (rule G3): ",
                "`node scripts/check-api-usage.mjs` says whether they did."
            )
        );
        Ok(())
    }

    /// Every rule in `docs/api-conventions.md`, against every operation.
    ///
    /// See the module docs for why this is a ratchet rather than a gate.
    #[test]
    fn the_api_contract_holds() {
        let (_, violations) = audit(&crate_root());
        let baseline = baseline();
        let current: BTreeSet<String> = violations.iter().map(Violation::baseline_line).collect();

        let fresh: Vec<&Violation> = violations
            .iter()
            .filter(|violation| !baseline.contains(&violation.baseline_line()))
            .collect();
        let fixed: Vec<&String> = baseline.difference(&current).collect();

        let mut message = String::new();
        if !fresh.is_empty() {
            message.push_str(&report(
                "These operations break docs/api-conventions.md",
                &fresh,
            ));
            message.push_str(
                "\nFix them, or — if the break is deliberate and agreed — add the \
                 `<rule><TAB><METHOD> <path>` line to \
                 studio-backend/docs/api-contract-baseline.txt.\n",
            );
        }
        if !fixed.is_empty() {
            let _ = write!(
                message,
                "\nThese baseline entries no longer happen. Delete them from \
                 studio-backend/docs/api-contract-baseline.txt — the baseline only \
                 ever shrinks ({} of them):\n\n{}\n",
                fixed.len(),
                fixed
                    .iter()
                    .map(|line| format!("  {line}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
        }
        assert!(message.is_empty(), "{message}");
    }
}
