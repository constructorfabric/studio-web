//! Backward compatibility of what Studio publishes, as a ratchet (rule G4).
//!
//! `docs/api-contract.json` shows what the API *is*; it is regenerated on every
//! change, so it cannot tell a reviewer that a change broke somebody. This
//! module keeps the other half: `docs/api-contract-accepted.txt`, every promise
//! the published contracts make, one line each —
//!
//! * `route` — an operation exists, keyed by method and path (path parameter
//!   names are not part of the wire, so `{id}` and `{run_id}` are both `{}`);
//! * `request` — a field of an operation's request body, its type, and whether
//!   a caller must send it;
//! * `response` — a field of an operation's response, its type, and whether it
//!   is always there;
//! * `event-subject`, `event`, `event-field` — a `subject_type`, a `kind` and
//!   the payload fields `docs/events-catalog.md` documents for it.
//!
//! Fields are followed into nested DTOs (`items.name`), by their names on the
//! wire (`rename`, `rename_all`, `flatten`), and a DTO's own name is not part of
//! a type: renaming `ItemDto` breaks nobody, dropping one of its fields does.
//!
//! The test compares the accepted lines with what the code and the catalogue
//! declare today. A change that removes or narrows a promise — an operation or
//! a kind gone, a response field gone or now optional, a field's type changed,
//! a request field that becomes required or appears required — **fails**,
//! unless that line is recorded in `docs/api-contract-breaks.txt` under a
//! comment that says why. A change that only adds is accepted by regenerating
//! the file (`cargo run --quiet -- api-contract --accept`), and the generator
//! refuses to write while an unrecorded break is open, so regenerating can
//! never be the way a break gets in.
//!
//! What is not covered: query parameters, response status codes, enum values,
//! and the payload a producer actually builds (its kinds are checked against
//! the catalogue by each producer's tests; the fields are the catalogue's
//! word).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use super::events;

/// The accepted contract, relative to the crate root. Generated; never edited
/// by hand.
pub(crate) const ACCEPTED: &str = "docs/api-contract-accepted.txt";
/// The recorded breaks, relative to the crate root. Written by hand, reviewed.
pub(crate) const BREAKS: &str = "docs/api-contract-breaks.txt";

/// How deep a field is followed into nested DTOs. Deeper than any DTO goes
/// today; the bound is there for recursive shapes (a tree node holding nodes).
const MAX_DEPTH: usize = 6;

/// One promise, as one line of the accepted file.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Fact {
    Route {
        key: String,
    },
    Request {
        key: String,
        field: String,
        ty: String,
        required: bool,
    },
    Response {
        key: String,
        field: String,
        ty: String,
        optional: bool,
    },
    EventSubject {
        subject_type: String,
    },
    Event {
        kind: String,
        subject_type: String,
    },
    EventField {
        kind: String,
        field: String,
    },
}

impl Fact {
    /// The line it is written as: tab-separated, so a type or a key can hold a
    /// space.
    fn line(&self) -> String {
        match self {
            Self::Route { key } => format!("route\t{key}"),
            Self::Request {
                key,
                field,
                ty,
                required,
            } => {
                let need = if *required { "required" } else { "optional" };
                format!("request\t{key}\t{field}\t{ty}\t{need}")
            }
            Self::Response {
                key,
                field,
                ty,
                optional,
            } => {
                let presence = if *optional { "optional" } else { "always" };
                format!("response\t{key}\t{field}\t{ty}\t{presence}")
            }
            Self::EventSubject { subject_type } => format!("event-subject\t{subject_type}"),
            Self::Event { kind, subject_type } => format!("event\t{kind}\t{subject_type}"),
            Self::EventField { kind, field } => format!("event-field\t{kind}\t{field}"),
        }
    }

    fn parse(line: &str) -> Option<Self> {
        let parts: Vec<&str> = line.split('\t').map(str::trim).collect();
        let owned = |i: usize| parts.get(i).map(|s| (*s).to_string());
        Some(match (parts.first().copied()?, parts.len()) {
            ("route", 2) => Self::Route { key: owned(1)? },
            ("request", 5) => Self::Request {
                key: owned(1)?,
                field: owned(2)?,
                ty: owned(3)?,
                required: match parts[4] {
                    "required" => true,
                    "optional" => false,
                    _ => return None,
                },
            },
            ("response", 5) => Self::Response {
                key: owned(1)?,
                field: owned(2)?,
                ty: owned(3)?,
                optional: match parts[4] {
                    "optional" => true,
                    "always" => false,
                    _ => return None,
                },
            },
            ("event-subject", 2) => Self::EventSubject {
                subject_type: owned(1)?,
            },
            ("event", 3) => Self::Event {
                kind: owned(1)?,
                subject_type: owned(2)?,
            },
            ("event-field", 3) => Self::EventField {
                kind: owned(1)?,
                field: owned(2)?,
            },
            _ => return None,
        })
    }
}

/// One promise the current tree no longer keeps.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Break {
    /// The line to record in the breaks file to accept it.
    fact: Fact,
    /// What a caller that relied on it now meets.
    why: &'static str,
}

// ---------------------------------------------------------------------------
// DTO shapes on the wire
// ---------------------------------------------------------------------------

/// A field as serde puts it on the wire.
#[derive(Debug, Clone)]
struct WireField {
    /// The name after `rename` / `rename_all`.
    name: String,
    /// The Rust type, whitespace and path qualifiers removed.
    ty: String,
    /// `#[serde(default)]` (or a `default = "…"`): a caller may leave it out.
    default: bool,
    flatten: bool,
    skip_serializing: bool,
    skip_deserializing: bool,
    /// `skip_serializing_if`: an answer may leave it out.
    skip_if: bool,
}

#[derive(Debug, Clone)]
struct Dto {
    /// Source file, to resolve a name declared in more than one.
    file: PathBuf,
    /// A struct-level `#[serde(default)]`: every field may be left out.
    default_all: bool,
    fields: Vec<WireField>,
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The slice inside the brace that opens at `open`, strings respected.
fn braced(src: &str, open: usize) -> Option<&str> {
    let bytes = src.as_bytes();
    if bytes.get(open) != Some(&b'{') {
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
            b'{' => depth += 1,
            b'}' => {
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

/// Split at the commas that are not nested in `<>`, `()`, `[]`, `{}` or a
/// string literal.
fn split_top_level(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut start = 0usize;
    let mut i = 0usize;
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
            b'<' | b'(' | b'[' | b'{' => depth += 1,
            // `->` in a fn type is not a closing bracket.
            b'>' if i > 0 && bytes[i - 1] == b'-' => {}
            b'>' | b')' | b']' | b'}' => depth -= 1,
            b',' if depth == 0 => {
                out.push(&text[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push(&text[start..]);
    out
}

/// The arguments of every `#[serde(…)]` in `attrs`, one item each.
fn serde_items(attrs: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(at) = attrs[from..].find("serde(") {
        let open = from + at + "serde".len();
        from = open;
        if let Some(args) = super::balanced(attrs, open) {
            out.extend(
                split_top_level(args)
                    .into_iter()
                    .map(|item| item.split_whitespace().collect::<String>())
                    .filter(|item| !item.is_empty()),
            );
        }
    }
    out
}

/// The string value of `name = "…"` among serde items.
fn serde_value(items: &[String], name: &str) -> Option<String> {
    items.iter().find_map(|item| {
        item.strip_prefix(name)?
            .strip_prefix('=')
            .map(|value| value.trim_matches('"').to_string())
    })
}

fn capitalised(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().collect::<String>() + chars.as_str()
    })
}

/// Apply a `rename_all` rule to a snake_case Rust field name.
fn rename_all(rule: Option<&str>, name: &str) -> String {
    let words = name.split('_').filter(|w| !w.is_empty());
    match rule {
        Some("camelCase") => words
            .enumerate()
            .map(|(i, w)| {
                if i == 0 {
                    w.to_string()
                } else {
                    capitalised(w)
                }
            })
            .collect(),
        Some("PascalCase") => words.map(capitalised).collect(),
        Some("lowercase") => name.to_lowercase(),
        Some("UPPERCASE" | "SCREAMING_SNAKE_CASE") => name.to_uppercase(),
        Some("kebab-case") => name.replace('_', "-"),
        Some("SCREAMING-KEBAB-CASE") => name.replace('_', "-").to_uppercase(),
        _ => name.to_string(),
    }
}

/// A type with whitespace and path qualifiers removed:
/// `Option<serde_json::Value>` is `Option<Value>`.
fn normalise_type(ty: &str) -> String {
    let compact: String = ty.split_whitespace().collect();
    let mut out = String::new();
    let mut token = String::new();
    let mut chars = compact.chars().peekable();
    while let Some(c) = chars.next() {
        if is_ident(c) {
            token.push(c);
            continue;
        }
        if c == ':' && chars.peek() == Some(&':') {
            chars.next();
            token.clear(); // a qualifier: keep only the last segment
            continue;
        }
        out.push_str(&token);
        token.clear();
        out.push(c);
    }
    out.push_str(&token);
    out
}

/// The identifiers in a normalised type.
fn idents(ty: &str) -> Vec<&str> {
    ty.split(|c: char| !is_ident(c))
        .filter(|word| !word.is_empty())
        .collect()
}

/// The fields of one struct body.
fn wire_fields(body: &str, rule: Option<&str>) -> Vec<WireField> {
    let mut out = Vec::new();
    for segment in split_top_level(body) {
        let mut rest = segment.trim();
        let mut attrs = String::new();
        while rest.starts_with("#[") {
            let Some(end) = attr_end(rest) else {
                break;
            };
            attrs.push_str(&rest[..end]);
            rest = rest[end..].trim_start();
        }
        for visibility in ["pub(crate)", "pub(super)", "pub(self)", "pub"] {
            // `pub ` and not the start of a field called `public_id`.
            if let Some(stripped) = rest.strip_prefix(visibility)
                && stripped.starts_with(char::is_whitespace)
            {
                rest = stripped.trim_start();
                break;
            }
        }
        let Some((name, ty)) = rest.split_once(':') else {
            continue;
        };
        let name = name.trim().trim_start_matches("r#");
        if name.is_empty() || !name.chars().all(is_ident) {
            continue; // not a named field
        }
        let items = serde_items(&attrs);
        let has = |word: &str| items.iter().any(|item| item == word);
        out.push(WireField {
            name: serde_value(&items, "rename").unwrap_or_else(|| rename_all(rule, name)),
            ty: normalise_type(ty.trim()),
            default: items
                .iter()
                .any(|item| item == "default" || item.starts_with("default=")),
            flatten: has("flatten"),
            skip_serializing: has("skip") || has("skip_serializing"),
            skip_deserializing: has("skip") || has("skip_deserializing"),
            skip_if: items
                .iter()
                .any(|item| item.starts_with("skip_serializing_if=")),
        });
    }
    out
}

/// Where the `#[…]` that opens `text` ends, brackets balanced.
fn attr_end(text: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (i, byte) in text.bytes().enumerate() {
        match byte {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// Every struct with named fields in the crate, by name. A name can be declared
/// in more than one file, so each maps to every declaration.
fn dtos(sources: &[(PathBuf, String)]) -> BTreeMap<String, Vec<Dto>> {
    const OPEN: &str = "struct ";
    let mut out: BTreeMap<String, Vec<Dto>> = BTreeMap::new();
    for (file, src) in sources {
        let mut from = 0usize;
        while let Some(at) = src[from..].find(OPEN) {
            let keyword = from + at;
            from = keyword + OPEN.len();
            if keyword > 0 && !src.as_bytes()[keyword - 1].is_ascii_whitespace() {
                continue; // `destruct ` and the like
            }
            let rest = &src[from..];
            let name: String = rest.chars().take_while(|c| is_ident(*c)).collect();
            if name.is_empty() {
                continue;
            }
            let Some(stop) = rest.find(['{', ';', '(', '"']) else {
                continue;
            };
            if rest.as_bytes()[stop] != b'{' {
                continue; // a unit or tuple struct, or prose
            }
            let Some(body) = braced(src, from + stop) else {
                continue;
            };
            // The attributes above the keyword: back to the item before it.
            let attrs_from = src[..keyword].rfind(['}', ';']).map_or(0, |i| i + 1);
            let items = serde_items(&src[attrs_from..keyword]);
            let rule = serde_value(&items, "rename_all");
            out.entry(name).or_default().push(Dto {
                file: file.clone(),
                default_all: items
                    .iter()
                    .any(|item| item == "default" || item.starts_with("default=")),
                fields: wire_fields(body, rule.as_deref()),
            });
        }
    }
    out
}

/// Which side of the wire a walk is describing.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Request,
    Response,
}

struct Walker<'a> {
    dtos: &'a BTreeMap<String, Vec<Dto>>,
    key: String,
    side: Side,
    out: &'a mut BTreeSet<Fact>,
}

impl<'a> Walker<'a> {
    /// The one declaration `name` means, seen from `file`: the only one, or
    /// the one in the same file. An ambiguous name is not followed.
    fn resolve(&self, name: &str, file: Option<&Path>) -> Option<&'a Dto> {
        let dtos: &'a BTreeMap<String, Vec<Dto>> = self.dtos;
        let candidates = dtos.get(name)?;
        if candidates.len() == 1 {
            return candidates.first();
        }
        let file = file?;
        let mut same = candidates.iter().filter(|dto| dto.file == file);
        match (same.next(), same.next()) {
            (Some(dto), None) => Some(dto),
            _ => None,
        }
    }

    /// Record every field of `name` under `prefix`.
    ///
    /// `required` is whether the enclosing field must be sent (request side),
    /// `optional` whether it may be missing (response side): a field is only as
    /// present as everything above it.
    fn walk(
        &mut self,
        name: &str,
        file: Option<&Path>,
        prefix: &str,
        required: bool,
        optional: bool,
        stack: &mut Vec<String>,
    ) {
        if stack.len() >= MAX_DEPTH || stack.iter().any(|seen| seen == name) {
            return;
        }
        let Some(dto) = self.resolve(name, file) else {
            return;
        };
        stack.push(name.to_string());
        for field in &dto.fields {
            let skipped = match self.side {
                Side::Request => field.skip_deserializing,
                Side::Response => field.skip_serializing,
            };
            if skipped {
                continue;
            }
            let (own_optional, base) = match field
                .ty
                .strip_prefix("Option<")
                .and_then(|inner| inner.strip_suffix('>'))
            {
                Some(inner) => (true, inner.to_string()),
                None => (false, field.ty.clone()),
            };
            let nested: Vec<String> = idents(&base)
                .into_iter()
                .filter(|ident| self.resolve(ident, Some(&dto.file)).is_some())
                .map(str::to_string)
                .collect();
            let field_required = required && !own_optional && !field.default && !dto.default_all;
            let field_optional = optional || own_optional || field.skip_if;
            if field.flatten {
                for inner in &nested {
                    self.walk(
                        inner,
                        Some(&dto.file),
                        prefix,
                        field_required,
                        field_optional,
                        stack,
                    );
                }
                continue;
            }
            let path = format!("{prefix}{}", field.name);
            // A nested DTO is `{}` in the type: its name is not on the wire,
            // its fields are, and they are recorded below.
            let mut ty = base.clone();
            for inner in &nested {
                ty = replace_ident(&ty, inner, "{}");
            }
            self.out.insert(match self.side {
                Side::Request => Fact::Request {
                    key: self.key.clone(),
                    field: path.clone(),
                    ty,
                    required: field_required,
                },
                Side::Response => Fact::Response {
                    key: self.key.clone(),
                    field: path.clone(),
                    ty,
                    optional: field_optional,
                },
            });
            for inner in &nested {
                self.walk(
                    inner,
                    Some(&dto.file),
                    &format!("{path}."),
                    field_required,
                    field_optional,
                    stack,
                );
            }
        }
        stack.pop();
    }
}

/// `ty` with the whole identifier `ident` replaced by `with`.
fn replace_ident(ty: &str, ident: &str, with: &str) -> String {
    let mut out = String::new();
    let mut token = String::new();
    for c in ty.chars().chain(std::iter::once(' ')) {
        if is_ident(c) {
            token.push(c);
            continue;
        }
        out.push_str(if token == ident { with } else { token.as_str() });
        token.clear();
        out.push(c);
    }
    out.pop(); // the sentinel
    out
}

/// `/a/{id}/b` → `/a/{}/b`: a path parameter's name is not on the wire.
fn wire_key(method: &str, path: &str) -> String {
    let mut out = String::new();
    let mut in_param = false;
    for c in path.chars() {
        match c {
            '{' => {
                in_param = true;
                out.push_str("{}");
            }
            '}' => in_param = false,
            _ if in_param => {}
            _ => out.push(c),
        }
    }
    format!("{method} {out}")
}

// ---------------------------------------------------------------------------
// The facts, the breaks, and the files
// ---------------------------------------------------------------------------

/// Every promise the tree makes today: the REST surface from the source scan,
/// the event vocabulary from the catalogue.
fn facts(crate_root: &Path) -> Result<BTreeSet<Fact>, String> {
    let (operations, _) = super::audit(crate_root);
    let sources = super::read_sources(crate_root);
    let dtos = dtos(&sources);
    let mut out = BTreeSet::new();
    for operation in &operations {
        let key = match operation.path.as_deref() {
            Some(path) => wire_key(&operation.method, path),
            None => operation.key(),
        };
        out.insert(Fact::Route { key: key.clone() });
        let file = crate_root.join(&operation.file);
        if let Some(request) = &operation.request_type {
            let mut walker = Walker {
                dtos: &dtos,
                key: key.clone(),
                side: Side::Request,
                out: &mut out,
            };
            walker.walk(request, Some(&file), "", true, false, &mut Vec::new());
        }
        for response in &operation.response_types {
            let mut walker = Walker {
                dtos: &dtos,
                key: key.clone(),
                side: Side::Response,
                out: &mut out,
            };
            walker.walk(response, Some(&file), "", true, false, &mut Vec::new());
        }
    }
    let catalogue = events::read(crate_root)?;
    for subject_type in catalogue.subjects {
        out.insert(Fact::EventSubject { subject_type });
    }
    for (kind, documented) in catalogue.kinds {
        for field in documented.fields {
            out.insert(Fact::EventField {
                kind: kind.clone(),
                field,
            });
        }
        out.insert(Fact::Event {
            kind,
            subject_type: documented.subject_type,
        });
    }
    Ok(out)
}

/// The promises in the accepted file. `None` when there is no file yet.
fn read_accepted(crate_root: &Path) -> Result<Option<BTreeSet<Fact>>, String> {
    let Ok(text) = fs::read_to_string(crate_root.join(ACCEPTED)) else {
        return Ok(None);
    };
    let mut out = BTreeSet::new();
    for line in text.lines() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        let fact =
            Fact::parse(line).ok_or_else(|| format!("{ACCEPTED}: unreadable line {line:?}"))?;
        out.insert(fact);
    }
    Ok(Some(out))
}

/// The recorded breaks: each line a fact, under the comment that says why.
///
/// A comment block is the reason for the lines directly below it, up to the
/// next blank line. A line with no reason above it is refused — a break
/// nobody explained is not accepted, it is merely silenced.
fn read_breaks(crate_root: &Path) -> Result<BTreeSet<String>, String> {
    let text = fs::read_to_string(crate_root.join(BREAKS)).unwrap_or_default();
    let mut out = BTreeSet::new();
    let mut reason = String::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            reason.clear();
            continue;
        }
        if let Some(comment) = line.strip_prefix('#') {
            reason.push_str(comment.trim());
            continue;
        }
        let Some(fact) = Fact::parse(line) else {
            return Err(format!("{BREAKS}: unreadable line {line:?}"));
        };
        if reason.trim().is_empty() {
            return Err(format!(
                "{BREAKS}: {line:?} has no reason — put a `# why, and who agreed` \
                 comment directly above it"
            ));
        }
        out.insert(fact.line());
    }
    Ok(out)
}

/// What `current` no longer promises of `accepted`.
fn breaks(accepted: &BTreeSet<Fact>, current: &BTreeSet<Fact>) -> Vec<Break> {
    let routes: BTreeSet<&str> = current
        .iter()
        .filter_map(|fact| match fact {
            Fact::Route { key } => Some(key.as_str()),
            _ => None,
        })
        .collect();
    let accepted_routes: BTreeSet<&str> = accepted
        .iter()
        .filter_map(|fact| match fact {
            Fact::Route { key } => Some(key.as_str()),
            _ => None,
        })
        .collect();
    let requests = |facts: &BTreeSet<Fact>| -> BTreeMap<(String, String), (String, bool)> {
        facts
            .iter()
            .filter_map(|fact| match fact {
                Fact::Request {
                    key,
                    field,
                    ty,
                    required,
                } => Some(((key.clone(), field.clone()), (ty.clone(), *required))),
                _ => None,
            })
            .collect()
    };
    let (requests_now, requests_then) = (requests(current), requests(accepted));
    let responses_now: BTreeMap<(&str, &str), (&str, bool)> = current
        .iter()
        .filter_map(|fact| match fact {
            Fact::Response {
                key,
                field,
                ty,
                optional,
            } => Some(((key.as_str(), field.as_str()), (ty.as_str(), *optional))),
            _ => None,
        })
        .collect();
    let kinds_now: BTreeMap<&str, &str> = current
        .iter()
        .filter_map(|fact| match fact {
            Fact::Event { kind, subject_type } => Some((kind.as_str(), subject_type.as_str())),
            _ => None,
        })
        .collect();

    let mut out = Vec::new();
    let mut broke = |fact: &Fact, why: &'static str| {
        out.push(Break {
            fact: fact.clone(),
            why,
        });
    };
    for fact in accepted {
        match fact {
            Fact::Route { key } => {
                if !routes.contains(key.as_str()) {
                    broke(fact, "the operation is gone: every caller gets a 404");
                }
            }
            Fact::Request {
                key,
                field,
                ty,
                required,
            } => {
                if !routes.contains(key.as_str()) {
                    continue; // the route's own break says it
                }
                match requests_now.get(&(key.clone(), field.clone())) {
                    None if *required => broke(
                        fact,
                        "a field callers must send is gone: what they send is now ignored",
                    ),
                    None => {}
                    Some((now, _)) if now != ty => {
                        broke(
                            fact,
                            "the field's type changed: what callers send no longer parses",
                        );
                    }
                    Some((_, true)) if !required => {
                        broke(
                            fact,
                            "the field became required: callers that leave it out now fail",
                        );
                    }
                    Some(_) => {}
                }
            }
            Fact::Response {
                key,
                field,
                ty,
                optional,
            } => {
                if !routes.contains(key.as_str()) {
                    continue;
                }
                match responses_now.get(&(key.as_str(), field.as_str())) {
                    None => broke(
                        fact,
                        "a field of the answer is gone: callers reading it break",
                    ),
                    Some((now, _)) if *now != ty.as_str() => {
                        broke(fact, "a field of the answer changed type");
                    }
                    Some((_, true)) if !optional => {
                        broke(fact, "a field of the answer may now be missing");
                    }
                    Some(_) => {}
                }
            }
            Fact::EventSubject { .. } => {
                if !current.contains(fact) {
                    broke(fact, "a subject type is no longer published");
                }
            }
            Fact::Event { kind, subject_type } => match kinds_now.get(kind.as_str()) {
                None => broke(
                    fact,
                    "the kind is no longer published: subscribers wait forever",
                ),
                Some(now) if *now != subject_type.as_str() => {
                    broke(fact, "the kind is about a different subject_type now");
                }
                Some(_) => {}
            },
            Fact::EventField { kind, .. } => {
                if kinds_now.contains_key(kind.as_str()) && !current.contains(fact) {
                    broke(fact, "a documented payload field is gone");
                }
            }
        }
    }
    // A required field that was never there is a new demand on every caller
    // the operation already had.
    for fact in current {
        if let Fact::Request {
            key,
            field,
            required: true,
            ..
        } = fact
            && accepted_routes.contains(key.as_str())
            && !requests_then.contains_key(&(key.clone(), field.clone()))
        {
            broke(
                fact,
                "a new required field on an existing operation: every caller now fails",
            );
        }
    }
    out.sort();
    out.dedup();
    out
}

/// The accepted file, as it is written: a header, then one sorted line per fact.
fn render(facts: &BTreeSet<Fact>) -> String {
    let mut out = String::from(concat!(
        "# What studio-backend has promised its callers: the REST contract and the\n",
        "# studio-events vocabulary. Generated by `cargo run --quiet -- api-contract --accept`;\n",
        "# never edit it by hand. A line that stops being true is a break, and\n",
        "# `cargo test api_contract` fails until it is recorded, with a reason, in\n",
        "# docs/api-contract-breaks.txt. See docs/api-conventions.md, rule G4.\n",
        "\n",
    ));
    let mut lines: Vec<String> = facts.iter().map(Fact::line).collect();
    lines.sort();
    for line in lines {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// The failure message for unrecorded breaks, or `None` when every one is
/// recorded.
fn unrecorded(breaks: &[Break], recorded: &BTreeSet<String>) -> Option<String> {
    let open: Vec<&Break> = breaks
        .iter()
        .filter(|b| !recorded.contains(&b.fact.line()))
        .collect();
    if open.is_empty() {
        return None;
    }
    let mut message = format!(
        "\nThese changes break what Studio has already published ({} of them):\n\n",
        open.len()
    );
    for b in &open {
        let _ = writeln!(
            message,
            "  {}\n      {}",
            b.fact.line().replace('\t', "  "),
            b.why
        );
    }
    message.push_str(
        "\nKeep the old shape (add beside it, deprecate, remove later — rule G1), or, if \
         the break is agreed, record each line, tab-separated exactly as below, in \
         studio-backend/docs/api-contract-breaks.txt under a `# why, and who agreed` \
         comment, then run `cargo run --quiet -- api-contract --accept`:\n\n",
    );
    for b in &open {
        let _ = writeln!(message, "{}", b.fact.line());
    }
    Some(message)
}

/// `studio-backend api-contract --accept`: write the accepted file and
/// `docs/api-contract.json` from the tree, unless an unrecorded break is open.
pub(crate) fn accept() -> anyhow::Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let current = facts(root).map_err(anyhow::Error::msg)?;
    let recorded = read_breaks(root).map_err(anyhow::Error::msg)?;
    if let Some(accepted) = read_accepted(root).map_err(anyhow::Error::msg)?
        && let Some(message) = unrecorded(&breaks(&accepted, &current), &recorded)
    {
        anyhow::bail!("{message}\nNothing was written.");
    }
    fs::write(root.join(ACCEPTED), render(&current))?;
    fs::write(
        root.join("docs/api-contract.json"),
        super::to_pretty_json()?,
    )?;
    eprintln!(
        "wrote {ACCEPTED} ({} promises) and docs/api-contract.json",
        current.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crate_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    fn set(lines: &[&str]) -> BTreeSet<Fact> {
        lines
            .iter()
            .map(|line| Fact::parse(line).unwrap_or_else(|| panic!("bad fact {line:?}")))
            .collect()
    }

    fn broken(accepted: &[&str], current: &[&str]) -> Vec<String> {
        breaks(&set(accepted), &set(current))
            .into_iter()
            .map(|b| b.fact.line())
            .collect()
    }

    /// The gate: nothing Studio already published was taken away unrecorded,
    /// and everything it publishes now is in the accepted file.
    #[test]
    fn the_published_contracts_stay_backward_compatible() {
        let root = crate_root();
        let current = facts(&root).unwrap_or_else(|e| panic!("{e}"));
        let recorded = read_breaks(&root).unwrap_or_else(|e| panic!("{e}"));
        let Some(accepted) = read_accepted(&root).unwrap_or_else(|e| panic!("{e}")) else {
            panic!(
                "there is no {ACCEPTED} yet: run `cargo run --quiet -- api-contract --accept` \
                 to accept today's contract as the baseline"
            );
        };
        if let Some(message) = unrecorded(&breaks(&accepted, &current), &recorded) {
            panic!("{message}");
        }
        let added = current.difference(&accepted).count();
        let dropped = accepted.difference(&current).count();
        assert!(
            added == 0 && dropped == 0,
            "the contract changed compatibly ({added} new lines, {dropped} recorded or \
             compatible removals): accept it with `cargo run --quiet -- api-contract --accept` \
             and commit {ACCEPTED} with the change"
        );
    }

    /// The canary: if the scan stopped seeing DTO fields or the catalogue,
    /// every check above would pass on an empty set.
    #[test]
    fn the_facts_reach_into_dtos_and_the_catalogue() {
        let facts = facts(&crate_root()).unwrap_or_else(|e| panic!("{e}"));
        let lines: BTreeSet<String> = facts.iter().map(Fact::line).collect();
        for expected in [
            "route\tGET /studio-events/v1/stream",
            "response\tGET /studio-events/v1/stream\tkind\tString\talways",
            "response\tGET /studio-events/v1/events\tevents\tVec<{}>\talways",
            "response\tGET /studio-events/v1/events\tevents.seq\ti64\talways",
            "event\ttask.succeeded\ttask_run",
            "event-field\ttask.succeeded\trun_id",
        ] {
            assert!(lines.contains(expected), "missing {expected:?}");
        }
        assert!(
            facts
                .iter()
                .filter(|fact| matches!(fact, Fact::Request { .. }))
                .count()
                > 100,
            "the scan stopped seeing request fields"
        );
    }

    #[test]
    fn a_line_round_trips() {
        for line in [
            "route\tGET /a/{}",
            "request\tPOST /a\tname\tString\trequired",
            "response\tGET /a\titems.id\tString\toptional",
            "event-subject\ttask_run",
            "event\ttask.queued\ttask_run",
            "event-field\ttask.queued\trun_id",
        ] {
            assert_eq!(Fact::parse(line).map(|f| f.line()).as_deref(), Some(line));
        }
    }

    #[test]
    fn removing_narrowing_and_demanding_are_breaks() {
        let route = "route\tPOST /a";
        // A route gone; its fields are not reported twice.
        assert_eq!(
            broken(&[route, "request\tPOST /a\tx\tString\trequired"], &[]),
            [route]
        );
        // A response field gone, retyped, or now optional.
        let answer = "response\tPOST /a\tid\tString\talways";
        let changes: [&[&str]; 3] = [
            &[route],
            &[route, "response\tPOST /a\tid\tu32\talways"],
            &[route, "response\tPOST /a\tid\tString\toptional"],
        ];
        for now in changes {
            assert_eq!(broken(&[route, answer], now), [answer]);
        }
        // A request field that becomes required, or a new required one.
        let optional = "request\tPOST /a\tx\tString\toptional";
        assert_eq!(
            broken(
                &[route, optional],
                &[route, "request\tPOST /a\tx\tString\trequired"]
            ),
            [optional]
        );
        let demanded = "request\tPOST /a\ty\tString\trequired";
        assert_eq!(broken(&[route], &[route, demanded]), [demanded]);
        // A documented kind or payload field gone.
        let kind = "event\tthing.made\tthing";
        let field = "event-field\tthing.made\tid";
        assert_eq!(broken(&[kind, field], &[kind]), [field]);
        assert_eq!(broken(&[kind, field], &[]), [kind]);
    }

    #[test]
    fn adding_and_relaxing_are_not() {
        let route = "route\tPOST /a";
        assert!(broken(&[route], &[route, "route\tGET /b"]).is_empty());
        // A new optional request field, a new response field, a required
        // field that became optional, an optional answer field now always
        // there, a new route's required fields.
        assert!(
            broken(
                &[
                    route,
                    "request\tPOST /a\tx\tString\trequired",
                    "response\tPOST /a\tid\tString\toptional",
                ],
                &[
                    route,
                    "request\tPOST /a\tx\tString\toptional",
                    "request\tPOST /a\tz\tString\toptional",
                    "response\tPOST /a\tid\tString\talways",
                    "response\tPOST /a\tname\tString\talways",
                    "route\tPOST /b",
                    "request\tPOST /b\tq\tString\trequired",
                ],
            )
            .is_empty()
        );
    }

    #[test]
    fn a_dto_is_read_as_serde_writes_it() {
        let src = r#"
            #[serde(rename_all = "camelCase")]
            pub struct OuterDto {
                pub run_id: String,
                #[serde(rename = "type")]
                pub kind: Option<serde_json::Value>,
                #[serde(default)]
                pub items: Vec<InnerDto>,
                #[serde(flatten)]
                pub extra: ExtraDto,
                #[serde(skip)]
                pub internal: u8,
            }
            pub struct InnerDto { pub name: String }
            pub struct ExtraDto { pub note: Option<String> }
        "#;
        let sources = [(PathBuf::from("x.rs"), src.to_string())];
        let dtos = dtos(&sources);
        let mut out = BTreeSet::new();
        let mut walker = Walker {
            dtos: &dtos,
            key: "POST /a".into(),
            side: Side::Request,
            out: &mut out,
        };
        walker.walk("OuterDto", None, "", true, false, &mut Vec::new());
        let lines: Vec<String> = out.iter().map(Fact::line).collect();
        assert_eq!(
            lines,
            [
                "request\tPOST /a\titems\tVec<{}>\toptional",
                "request\tPOST /a\titems.name\tString\toptional",
                "request\tPOST /a\tnote\tString\toptional",
                "request\tPOST /a\trunId\tString\trequired",
                "request\tPOST /a\ttype\tValue\toptional",
            ]
        );
    }

    #[test]
    fn a_break_needs_a_reason() {
        let dir = std::env::temp_dir().join(format!("api-compat-{}", std::process::id()));
        fs::create_dir_all(dir.join("docs")).expect("temp dir");
        fs::write(dir.join(BREAKS), "# header\n\nroute\tGET /a\n").expect("write");
        assert!(read_breaks(&dir).unwrap_err().contains("no reason"));
        fs::write(
            dir.join(BREAKS),
            "# header\n\n# retired with the v0 portal, agreed in #1\nroute\tGET /a\n",
        )
        .expect("write");
        assert!(read_breaks(&dir).expect("parses").contains("route\tGET /a"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_path_parameter_name_is_not_on_the_wire() {
        assert_eq!(
            wire_key("GET", "/studio-tasks/v1/runs/{run_id}/events"),
            "GET /studio-tasks/v1/runs/{}/events"
        );
    }
}
