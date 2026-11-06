//! A save edits the latest revision; it never writes a re-rendered text over
//! it (ADR-0060 §4).
//!
//! On 2026-11-05 a save from the Product page wrote revision 12 of
//! "Studioweb" from [`super::gearbox::render_product_gdl_from`] alone: the
//! text the picks record renders to. Everything revision 11 said that the
//! record does not hold went with it -- each gear's `config`, the
//! `gears-rust` source pinned to a fork, the comments -- and the frontend's
//! repository came back as a second source beside the one the description
//! already declared.
//!
//! A save now starts from the latest revision's text and changes only what
//! the caller changed ([`onto_latest`]):
//!
//! - a gear the picks add is appended to `gears`, as rendered; a gear (or
//!   plugin) the picks took out is removed; every other entry stays as
//!   written;
//! - a gear's `config` is replaced only when the caller changed it;
//! - the `frontend` block is written when the record's frontend differs from
//!   the text's, and removed when the record cleared it;
//! - a source an added entry needs is reused when the description already
//!   declares it, by id or by repository (one repository, one source), and
//!   added otherwise; no declared source is ever changed or removed.
//!
//! What cannot be edited in place -- a description without a literal
//! `product(...)` or `gears = [...]` -- is refused with the reasons
//! ([`WouldDrop`], `DESCRIPTION_WOULD_DROP`), never written over.
//!
//! The scanner here reads the Starlark subset a `product.gdl` is written in
//! tolerantly: strings and comments are skipped, brackets are matched, and a
//! call's arguments are split at its top-level commas. Text it does not touch
//! is copied byte for byte.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

/// What a save does to the latest revision's `frontend` block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrontendChange {
    /// Leave it as written: the record says nothing about a frontend, or the
    /// engine Studio runs is not told about frontends.
    Keep,
    /// Write the rendered block (the record's frontend).
    Write,
    /// Take it out: the record's frontend was cleared.
    Remove,
}

/// What the caller changed, against the latest revision.
#[derive(Debug, Clone)]
pub struct Change<'a> {
    /// Gears and plugins, by engine id (or as picked), the caller took out.
    pub removed: &'a BTreeSet<String>,
    /// Gears and plugins, by engine id, whose configuration the caller
    /// changed.
    pub config_changed: &'a BTreeSet<String>,
    pub frontend: FrontendChange,
    /// Where the description sits in its repository.
    pub product_path: &'a str,
    /// `owner/name` of that repository, when known.
    pub repo: Option<&'a str>,
}

/// A save that would drop what the latest revision says, refused: one
/// sentence per thing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WouldDrop(pub Vec<String>);

/// The precondition a refused save names.
pub const DESCRIPTION_WOULD_DROP: &str = "DESCRIPTION_WOULD_DROP";

impl fmt::Display for WouldDrop {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the save would drop what the latest revision says, so it is refused: {}",
            self.0.join("; ")
        )
    }
}

impl std::error::Error for WouldDrop {}

fn refuse(why: impl Into<String>) -> WouldDrop {
    WouldDrop(vec![why.into()])
}

/// `rendered` (the text the picks render to) laid onto `latest` (the latest
/// revision's text): `latest` with only what `change` names changed.
pub fn onto_latest(latest: &str, rendered: &str, change: &Change<'_>) -> Result<String, WouldDrop> {
    let ld = Doc::new(latest);
    let rd = Doc::new(rendered);
    let lp = ld.product().ok_or_else(|| {
        refuse(
            "the latest revision has no literal `product(...)` to edit, and replacing its text \
             would drop all of it",
        )
    })?;
    let rp = rd
        .product()
        .ok_or_else(|| refuse("the text Studio rendered has no `product(...)`"))?;
    let lgears_arg = ld.kw(&lp, "gears");
    let lgears = lgears_arg
        .as_ref()
        .and_then(|a| ld.list(a.value))
        .ok_or_else(|| {
            refuse(
                "the latest revision's `gears` is not a literal list Studio can add to or take \
                 from; edit the description itself",
            )
        })?;
    let rgears = rd
        .kw(&rp, "gears")
        .and_then(|a| rd.list(a.value))
        .ok_or_else(|| refuse("the text Studio rendered has no `gears` list"))?;

    let root_path = repo_root_from(change.product_path);
    let mut sources = Sources {
        latest: ld.sources(&lp, &root_path, change.repo),
        rendered: rd
            .sources(&rp, &root_path, change.repo)
            .into_iter()
            .map(|s| (s.id.clone(), s))
            .collect(),
        added: Vec::new(),
    };
    let removed = |id: &str| {
        change
            .removed
            .iter()
            .any(|r| r == id || r.ends_with(&format!("-{id}")))
    };

    let mut edits = Edits::default();
    // Rendered gears by id, in the rendered order.
    let rendered_gears: Vec<(String, Span, Call)> = rd
        .items(rgears)
        .into_iter()
        .filter_map(|it| {
            let c = rd.call(it)?;
            let id = rd.first_str(&c)?;
            Some((id, it, c))
        })
        .collect();
    let rendered_by_id: BTreeMap<&str, &Call> = rendered_gears
        .iter()
        .map(|(id, _, c)| (id.as_str(), c))
        .collect();

    let mut latest_gears = BTreeSet::new();
    for it in ld.items(lgears) {
        let Some(c) = ld.call(it) else { continue };
        let Some(id) = ld.first_str(&c) else { continue };
        latest_gears.insert(id.clone());
        match rendered_by_id.get(id.as_str()) {
            None if removed(id.as_str()) => edits.delete_item(&ld, it),
            None => {}
            Some(rc) => {
                if change.config_changed.contains(&id) {
                    let value = rd.kw(rc, "config").map(|a| rd.slice(a.value).to_owned());
                    edits.set_kw(&ld, &c, "config", value);
                }
                plugins(&ld, &rd, &c, rc, change, &removed, &mut edits);
            }
        }
    }
    let added: Vec<String> = rendered_gears
        .iter()
        .filter(|(id, _, _)| !latest_gears.contains(id))
        .map(|(_, it, _)| sources.remap(rd.slice(*it)))
        .collect();
    edits.insert_items(&ld, lgears, &added, lgears_arg.as_ref().map(|a| a.span));

    // The frontend block.
    let mut frontend_written = false;
    match change.frontend {
        FrontendChange::Keep => {}
        FrontendChange::Remove => {
            if let Some(a) = ld.kw(&lp, "frontend") {
                edits.delete_item(&ld, a.span);
            }
        }
        FrontendChange::Write => {
            if let Some(ra) = rd.kw(&rp, "frontend") {
                let value = sources.remap(rd.slice(ra.value));
                match ld.kw(&lp, "frontend") {
                    Some(la) => {
                        if ld.norm(la.value) != Doc::new(&value).norm((0, value.len())) {
                            edits.replace(la.value, value);
                            frontend_written = true;
                        }
                    }
                    None => {
                        let at = lgears_arg.as_ref().map_or(lgears.0, |a| a.span.0);
                        let start = ld.line_start(at);
                        let indent = ld.indent_of(at);
                        edits.insert(start, format!("{indent}frontend = {value},\n"));
                        frontend_written = true;
                    }
                }
            }
        }
    }
    if frontend_written {
        gdl_version(&ld, &rd, &mut edits);
    }

    // The product's id and name, as the caller gives them.
    for key in ["id", "name"] {
        if let (Some(la), Some(ra)) = (ld.kw(&lp, key), rd.kw(&rp, key))
            && ld.norm(la.value) != rd.norm(ra.value)
        {
            edits.replace(la.value, rd.slice(ra.value).to_owned());
        }
    }

    // Sources the new entries need and the description does not declare.
    if !sources.added.is_empty() {
        let list = ld.kw(&lp, "sources");
        let Some(open_close) = list.as_ref().and_then(|a| ld.list(a.value)) else {
            let ids = sources
                .added
                .iter()
                .map(|s| format!("`{}`", s.id))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(refuse(format!(
                "the latest revision has no literal `sources` list to declare {ids} in"
            )));
        };
        let texts: Vec<String> = sources.added.iter().map(|s| s.text.clone()).collect();
        edits.insert_items(&ld, open_close, &texts, list.map(|a| a.span));
    }

    let merged = edits.apply(latest)?;
    verify(latest, &merged, change, &removed)?;
    Ok(merged)
}

/// Plugins of a gear both texts name: added, removed and reconfigured as the
/// caller asked; the rest as written.
fn plugins(
    ld: &Doc<'_>,
    rd: &Doc<'_>,
    lc: &Call,
    rc: &Call,
    change: &Change<'_>,
    removed: &dyn Fn(&str) -> bool,
    edits: &mut Edits,
) {
    let rlist = rd.kw(rc, "plugins").and_then(|a| rd.list(a.value));
    let rplugins: Vec<(String, Span, Call)> = rlist
        .map(|l| {
            rd.items(l)
                .into_iter()
                .filter_map(|it| {
                    let c = rd.call(it)?;
                    Some((rd.first_str(&c)?, it, c))
                })
                .collect()
        })
        .unwrap_or_default();
    let larg = ld.kw(lc, "plugins");
    let llist = larg.as_ref().and_then(|a| ld.list(a.value));
    let Some(llist) = llist else {
        // No literal list: the rendered one when it has plugins and the
        // entry has no `plugins` at all.
        if larg.is_none()
            && let Some(ra) = rd.kw(rc, "plugins")
            && !rplugins.is_empty()
        {
            edits.set_kw(ld, lc, "plugins", Some(rd.slice(ra.value).to_owned()));
        }
        return;
    };
    let mut have = BTreeSet::new();
    for it in ld.items(llist) {
        let Some(c) = ld.call(it) else { continue };
        let Some(id) = ld.first_str(&c) else { continue };
        have.insert(id.clone());
        match rplugins.iter().find(|(p, _, _)| *p == id) {
            None if removed(id.as_str()) => edits.delete_item(ld, it),
            None => {}
            Some((_, _, pc)) if change.config_changed.contains(&id) => {
                let value = rd.kw(pc, "config").map(|a| rd.slice(a.value).to_owned());
                edits.set_kw(ld, &c, "config", value);
            }
            Some(_) => {}
        }
    }
    let added: Vec<String> = rplugins
        .iter()
        .filter(|(p, _, _)| !have.contains(p))
        .map(|(_, it, _)| rd.slice(*it).to_owned())
        .collect();
    edits.insert_items(ld, llist, &added, larg.map(|a| a.span));
}

/// `gdl_version = "1.5"` when the frontend was written and the latest text
/// says less (or nothing).
fn gdl_version(ld: &Doc<'_>, rd: &Doc<'_>, edits: &mut Edits) {
    let Some((_, rvalue)) = rd.top_assign("gdl_version") else {
        return;
    };
    let want = rd.slice(rvalue).to_owned();
    match ld.top_assign("gdl_version") {
        Some((_, lvalue)) => {
            let have = str_value(ld.slice(lvalue)).unwrap_or_default();
            let wanted = str_value(&want).unwrap_or_default();
            if version_lt(&have, &wanted) {
                edits.replace(lvalue, want);
            }
        }
        None => edits.insert(0, format!("gdl_version = {want}\n\n")),
    }
}

fn version_lt(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> { v.split('.').filter_map(|p| p.parse().ok()).collect() };
    parse(a) < parse(b)
}

/// Every gear and source the latest revision names is still there, unless
/// the caller removed it; a frontend too, unless it was cleared.
fn verify(
    latest: &str,
    merged: &str,
    change: &Change<'_>,
    removed: &dyn Fn(&str) -> bool,
) -> Result<(), WouldDrop> {
    let (ld, md) = (Doc::new(latest), Doc::new(merged));
    let (Some(lp), Some(mp)) = (ld.product(), md.product()) else {
        return Err(refuse("the edited text no longer has a `product(...)`"));
    };
    let gears = |d: &Doc<'_>, p: &Call| -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        let Some(list) = d.kw(p, "gears").and_then(|a| d.list(a.value)) else {
            return out;
        };
        for it in d.items(list) {
            let Some(c) = d.call(it) else { continue };
            if let Some(id) = d.first_str(&c) {
                out.insert(id);
            }
            if let Some(pl) = d.kw(&c, "plugins").and_then(|a| d.list(a.value)) {
                for pi in d.items(pl) {
                    if let Some(id) = d.call(pi).and_then(|pc| d.first_str(&pc)) {
                        out.insert(id);
                    }
                }
            }
        }
        out
    };
    let mut lost = Vec::new();
    let has = gears(&md, &mp);
    for g in gears(&ld, &lp) {
        if !has.contains(&g) && !removed(g.as_str()) {
            lost.push(format!("gear `{g}`"));
        }
    }
    let root = repo_root_from(change.product_path);
    let declared: BTreeSet<String> = md
        .sources(&mp, &root, change.repo)
        .into_iter()
        .map(|s| s.id)
        .collect();
    for s in ld.sources(&lp, &root, change.repo) {
        if !declared.contains(&s.id) {
            lost.push(format!("source `{}`", s.id));
        }
    }
    if change.frontend != FrontendChange::Remove
        && ld.kw(&lp, "frontend").is_some()
        && md.kw(&mp, "frontend").is_none()
    {
        lost.push("the frontend".to_owned());
    }
    if lost.is_empty() {
        Ok(())
    } else {
        Err(WouldDrop(vec![format!(
            "it would drop {} of the latest revision",
            lost.join(", ")
        )]))
    }
}

/// The repository's root as a `path(...)` from the description's directory:
/// `products/x/product.gdl` -> `../..`.
fn repo_root_from(product_path: &str) -> String {
    let depth = product_path.split('/').filter(|s| !s.is_empty()).count();
    let up = "../".repeat(depth.saturating_sub(1));
    let up = up.trim_end_matches('/');
    if up.is_empty() {
        ".".to_owned()
    } else {
        up.to_owned()
    }
}

/* ── sources ── */

struct Source {
    id: String,
    /// What it points at: `repo:owner/name` or `path:<dir>`; two sources
    /// with one identity are one repository.
    identity: String,
    text: String,
}

struct Sources {
    latest: Vec<Source>,
    rendered: BTreeMap<String, Source>,
    added: Vec<Source>,
}

impl Sources {
    /// The id the description knows rendered source `id` by, declaring it
    /// when it has none.
    fn resolve(&mut self, id: &str) -> String {
        if self.latest.iter().any(|s| s.id == id) {
            return id.to_owned();
        }
        let Some(r) = self.rendered.get(id) else {
            return id.to_owned();
        };
        if let Some(same) = self.latest.iter().find(|s| s.identity == r.identity) {
            return same.id.clone();
        }
        if !self.added.iter().any(|s| s.id == id) {
            self.added.push(Source {
                id: r.id.clone(),
                identity: r.identity.clone(),
                text: r.text.clone(),
            });
        }
        id.to_owned()
    }

    /// `text` (rendered) with each `source = "x"` naming the description's
    /// own id for that source.
    fn remap(&mut self, text: &str) -> String {
        const MARK: &str = "source = \"";
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(at) = rest.find(MARK) {
            out.push_str(&rest[..at + MARK.len()]);
            rest = &rest[at + MARK.len()..];
            let end = rest.find('"').unwrap_or(rest.len());
            out.push_str(&self.resolve(&rest[..end]));
            rest = &rest[end..];
        }
        out.push_str(rest);
        out
    }
}

/* ── edits ── */

#[derive(Default)]
struct Edits {
    /// `(start, end, text, order)`.
    list: Vec<(usize, usize, String, usize)>,
}

impl Edits {
    fn push(&mut self, start: usize, end: usize, text: String) {
        let n = self.list.len();
        self.list.push((start, end, text, n));
    }

    fn insert(&mut self, at: usize, text: String) {
        self.push(at, at, text);
    }

    fn replace(&mut self, span: Span, text: String) {
        self.push(span.0, span.1, text);
    }

    /// Remove a list item or an argument with its comma; its whole lines
    /// when it has them to itself (a comment on its line goes with it).
    fn delete_item(&mut self, d: &Doc<'_>, span: Span) {
        let (mut s, mut e) = span;
        let b = d.t.as_bytes();
        let mut j = e;
        while j < b.len() && (b[j] == b' ' || b[j] == b'\t') {
            j += 1;
        }
        if j < b.len() && b[j] == b',' && d.m[j] == K::Code {
            e = j + 1;
        }
        let ls = d.line_start(s);
        let le = d.line_end(e);
        let before_blank = d.t[ls..s].trim().is_empty();
        let after_blank = d.t[e..le]
            .bytes()
            .zip(&d.m[e..le])
            .all(|(c, k)| *k == K::Comment || c == b' ' || c == b'\t' || c == b'\r');
        if before_blank && after_blank {
            s = ls;
            e = (le + 1).min(b.len());
        } else {
            while e < b.len() && b[e] == b' ' {
                e += 1;
            }
        }
        self.push(s, e, String::new());
    }

    /// Append `texts` to the list `(open, close)`, one per line in the
    /// list's own indentation (a one-line list stays on its line). `owner`
    /// is the argument the list is the value of, for an empty list's indent.
    fn insert_items(&mut self, d: &Doc<'_>, list: Span, texts: &[String], owner: Option<Span>) {
        if texts.is_empty() {
            return;
        }
        let (open, close) = list;
        let items = d.items(list);
        let multiline = d.t[open..close].contains('\n') || items.is_empty();
        let b = d.t.as_bytes();
        match items.last() {
            Some(&(_, last_end)) => {
                let mut j = last_end;
                while j < close && b[j].is_ascii_whitespace() {
                    j += 1;
                }
                let comma = j < close && b[j] == b',';
                if multiline {
                    let indent = d.indent_of(items[items.len() - 1].0);
                    let after = if comma { j + 1 } else { last_end };
                    let line_end = d.line_end(after);
                    if !comma {
                        self.insert(last_end, ",".to_owned());
                    }
                    if line_end < close {
                        // At the start of the next line: the last item's
                        // line may itself be taken out.
                        let body: String =
                            texts.iter().map(|t| format!("{indent}{t},\n")).collect();
                        self.insert(line_end + 1, body);
                    } else {
                        // Before a `]` on the item's own line, the bracket
                        // goes to a line of its own.
                        let close_indent = d.indent_of(owner.map_or(open, |o| o.0));
                        let body: String =
                            texts.iter().map(|t| format!("\n{indent}{t},")).collect();
                        self.insert(close, format!("{body}\n{close_indent}"));
                    }
                } else {
                    let body = texts.join(", ");
                    if comma {
                        self.insert(j + 1, format!(" {body}"));
                    } else {
                        self.insert(last_end, format!(", {body}"));
                    }
                }
            }
            None => {
                let base = d.indent_of(owner.map_or(open, |o| o.0));
                let body: String = texts.iter().map(|t| format!("\n{base}    {t},")).collect();
                self.push(open + 1, close, format!("{body}\n{base}"));
            }
        }
    }

    /// Set (`Some`) or take out (`None`) keyword argument `key` of `call`.
    fn set_kw(&mut self, d: &Doc<'_>, call: &Call, key: &str, value: Option<String>) {
        let args = d.args(call);
        let at = args.iter().position(|a| a.key.as_deref() == Some(key));
        match (at, value) {
            (Some(i), Some(v)) => {
                if d.norm(args[i].value) != Doc::new(&v).norm((0, v.len())) {
                    self.replace(args[i].value, v);
                }
            }
            (Some(i), None) => {
                let (s, e) = if i > 0 {
                    (args[i - 1].span.1, args[i].span.1)
                } else if let Some(next) = args.get(1) {
                    (args[i].span.0, next.span.0)
                } else {
                    args[i].span
                };
                self.push(s, e, String::new());
            }
            (None, Some(v)) => match args.last() {
                Some(last) => self.insert(last.span.1, format!(", {key} = {v}")),
                None => self.insert(call.open + 1, format!("{key} = {v}")),
            },
            (None, None) => {}
        }
    }

    fn apply(mut self, text: &str) -> Result<String, WouldDrop> {
        self.list
            .sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(b.3.cmp(&a.3)));
        // Non-overlapping, or the edits contradict each other.
        let mut floor = usize::MAX;
        for (s, e, _, _) in &self.list {
            if *e > floor {
                return Err(refuse("Studio's edits of the description overlap"));
            }
            floor = floor.min(*s);
        }
        let mut out = text.to_owned();
        for (s, e, t, _) in &self.list {
            out.replace_range(*s..*e, t);
        }
        Ok(out)
    }
}

/* ── the scanner ── */

type Span = (usize, usize);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum K {
    Code,
    Str,
    Comment,
}

#[derive(Debug, Clone)]
struct Call {
    open: usize,
    close: usize,
}

#[derive(Debug, Clone)]
struct Arg {
    span: Span,
    key: Option<String>,
    value: Span,
}

struct Doc<'a> {
    t: &'a str,
    m: Vec<K>,
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// A string literal's value (`"a\"b"` -> `a"b`).
fn str_value(text: &str) -> Option<String> {
    let t = text.trim();
    let q = t.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let inner = t.strip_prefix(q)?.strip_suffix(q)?;
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some(o) => out.push(o),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    Some(out)
}

impl<'a> Doc<'a> {
    fn new(t: &'a str) -> Self {
        let b = t.as_bytes();
        let mut m = vec![K::Code; b.len()];
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'#' => {
                    while i < b.len() && b[i] != b'\n' {
                        m[i] = K::Comment;
                        i += 1;
                    }
                }
                q @ (b'"' | b'\'') => {
                    let start = i;
                    let triple = i + 2 < b.len() && b[i + 1] == q && b[i + 2] == q;
                    if triple {
                        i += 3;
                        while i < b.len() {
                            if b[i] == b'\\' {
                                i += 2;
                            } else if i + 2 < b.len() && b[i] == q && b[i + 1] == q && b[i + 2] == q
                            {
                                i += 3;
                                break;
                            } else {
                                i += 1;
                            }
                        }
                    } else {
                        i += 1;
                        while i < b.len() && b[i] != q && b[i] != b'\n' {
                            i += if b[i] == b'\\' { 2 } else { 1 };
                        }
                        i += 1;
                    }
                    let i2 = i.min(b.len());
                    for k in &mut m[start..i2] {
                        *k = K::Str;
                    }
                    i = i2;
                }
                _ => i += 1,
            }
        }
        Self { t, m }
    }

    fn slice(&self, s: Span) -> &'a str {
        &self.t[s.0..s.1]
    }

    /// The code of a span without whitespace or comments: what two
    /// spellings of one value compare equal in.
    fn norm(&self, s: Span) -> String {
        self.t[s.0..s.1]
            .char_indices()
            .filter(|(i, c)| {
                self.m[s.0 + i] != K::Comment && !(self.m[s.0 + i] == K::Code && c.is_whitespace())
            })
            .map(|(_, c)| c)
            .collect::<String>()
            .replace(",)", ")")
            .replace(",]", "]")
            .replace(",}", "}")
    }

    fn line_start(&self, at: usize) -> usize {
        self.t[..at].rfind('\n').map_or(0, |i| i + 1)
    }

    fn line_end(&self, at: usize) -> usize {
        self.t[at..].find('\n').map_or(self.t.len(), |i| at + i)
    }

    fn indent_of(&self, at: usize) -> String {
        let s = self.line_start(at);
        self.t[s..]
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .collect()
    }

    /// The bracket that closes the one at `open`.
    fn close_of(&self, open: usize) -> Option<usize> {
        let b = self.t.as_bytes();
        let mut depth = 0usize;
        for (i, c) in b.iter().enumerate().skip(open) {
            if self.m[i] != K::Code {
                continue;
            }
            match c {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => {
                    depth = depth.checked_sub(1)?;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// The items between `open` and `close`, split at top-level commas and
    /// trimmed of whitespace and comments.
    fn items(&self, (open, close): Span) -> Vec<Span> {
        let b = self.t.as_bytes();
        let mut out = Vec::new();
        let mut depth = 0usize;
        let mut start = open + 1;
        let mut push = |s: usize, e: usize| {
            let (mut s, mut e) = (s, e);
            while s < e && (self.m[s] == K::Comment || b[s].is_ascii_whitespace()) {
                s += 1;
            }
            while e > s && (self.m[e - 1] == K::Comment || b[e - 1].is_ascii_whitespace()) {
                e -= 1;
            }
            if s < e {
                out.push((s, e));
            }
        };
        for (i, &ch) in b.iter().enumerate().take(close).skip(open + 1) {
            if self.m[i] != K::Code {
                continue;
            }
            match ch {
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => depth = depth.saturating_sub(1),
                b',' if depth == 0 => {
                    push(start, i);
                    start = i + 1;
                }
                _ => {}
            }
        }
        push(start, close);
        out
    }

    /// The call a span is: `name(...)` and nothing after.
    fn call(&self, (s, e): Span) -> Option<Call> {
        let b = self.t.as_bytes();
        let mut i = s;
        while i < e && (is_ident(b[i]) || b[i] == b'.') {
            i += 1;
        }
        if i == s {
            return None;
        }
        while i < e && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= e || b[i] != b'(' {
            return None;
        }
        let close = self.close_of(i)?;
        (close + 1 == e).then_some(Call { open: i, close })
    }

    fn args(&self, c: &Call) -> Vec<Arg> {
        let b = self.t.as_bytes();
        self.items((c.open, c.close))
            .into_iter()
            .map(|(s, e)| {
                let mut i = s;
                while i < e && is_ident(b[i]) {
                    i += 1;
                }
                let mut j = i;
                while j < e && b[j].is_ascii_whitespace() {
                    j += 1;
                }
                let keyed = i > s && j < e && b[j] == b'=' && b.get(j + 1) != Some(&b'=');
                if keyed {
                    let mut v = j + 1;
                    while v < e && b[v].is_ascii_whitespace() {
                        v += 1;
                    }
                    Arg {
                        span: (s, e),
                        key: Some(self.t[s..i].to_owned()),
                        value: (v, e),
                    }
                } else {
                    Arg {
                        span: (s, e),
                        key: None,
                        value: (s, e),
                    }
                }
            })
            .collect()
    }

    fn kw(&self, c: &Call, key: &str) -> Option<Arg> {
        self.args(c)
            .into_iter()
            .find(|a| a.key.as_deref() == Some(key))
    }

    fn first_str(&self, c: &Call) -> Option<String> {
        self.args(c)
            .into_iter()
            .find(|a| a.key.is_none())
            .and_then(|a| str_value(self.slice(a.value)))
    }

    fn kw_str(&self, c: &Call, key: &str) -> Option<String> {
        self.kw(c, key).and_then(|a| str_value(self.slice(a.value)))
    }

    /// A literal list value: its brackets.
    fn list(&self, (s, e): Span) -> Option<Span> {
        (self.t.as_bytes().get(s) == Some(&b'[') && self.close_of(s) == Some(e - 1))
            .then_some((s, e - 1))
    }

    /// The first top-level `product(...)`.
    fn product(&self) -> Option<Call> {
        let b = self.t.as_bytes();
        let mut depth = 0usize;
        let mut i = 0;
        while i < b.len() {
            if self.m[i] == K::Code {
                match b[i] {
                    b'(' | b'[' | b'{' => depth += 1,
                    b')' | b']' | b'}' => depth = depth.saturating_sub(1),
                    _ if depth == 0
                        && self.t[i..].starts_with("product")
                        && (i == 0 || !(is_ident(b[i - 1]) || b[i - 1] == b'.')) =>
                    {
                        let mut j = i + "product".len();
                        while j < b.len() && b[j].is_ascii_whitespace() {
                            j += 1;
                        }
                        if j < b.len() && b[j] == b'(' {
                            let close = self.close_of(j)?;
                            return Some(Call { open: j, close });
                        }
                    }
                    _ => {}
                }
            }
            i += 1;
        }
        None
    }

    /// A top-level `name = value` on a line of its own: its key and value.
    fn top_assign(&self, name: &str) -> Option<(Span, Span)> {
        let mut at = 0;
        for line in self.t.split_inclusive('\n') {
            let start = at;
            at += line.len();
            if !line.starts_with(name) || self.m.get(start) != Some(&K::Code) {
                continue;
            }
            let rest = line[name.len()..].trim_start();
            let Some(value) = rest.strip_prefix('=') else {
                continue;
            };
            let v0 = start + (line.len() - value.len());
            let v = value.trim();
            let vs = v0 + (value.len() - value.trim_start().len());
            return Some(((start, start + name.len()), (vs, vs + v.len())));
        }
        None
    }

    /// The product's declared sources.
    fn sources(&self, p: &Call, root: &str, repo: Option<&str>) -> Vec<Source> {
        let Some(list) = self.kw(p, "sources").and_then(|a| self.list(a.value)) else {
            return Vec::new();
        };
        self.items(list)
            .into_iter()
            .filter_map(|it| {
                let c = self.call(it)?;
                let id = self.kw_str(&c, "id").or_else(|| self.first_str(&c))?;
                let identity = self
                    .kw(&c, "at")
                    .map(|a| self.identity(a.value, root, repo))
                    .unwrap_or_else(|| format!("id:{id}"));
                Some(Source {
                    id,
                    identity,
                    text: self.slice(it).to_owned(),
                })
            })
            .collect()
    }

    /// What a source's `at` points at.
    fn identity(&self, at: Span, root: &str, repo: Option<&str>) -> String {
        let text = self.slice(at);
        let Some(c) = self.call(at) else {
            return format!("text:{}", self.norm(at));
        };
        let name = text[..c.open - at.0].trim();
        match name {
            "git" => match self.kw_str(&c, "url").or_else(|| self.first_str(&c)) {
                Some(url) => format!("repo:{}", super::gearbox::repo_key(&url)),
                None => format!("text:{}", self.norm(at)),
            },
            "path" => {
                let p = self.first_str(&c).unwrap_or_default();
                let p = p.trim().trim_end_matches('/');
                let p = p.strip_prefix("./").unwrap_or(p);
                let p = if p.is_empty() { "." } else { p };
                match repo {
                    Some(r) if p == root => format!("repo:{}", super::gearbox::repo_key(r)),
                    _ => format!("path:{p}"),
                }
            }
            _ => format!("text:{}", self.norm(at)),
        }
    }
}

/* ── each gear's configuration, as the description writes it ── */

/// Each gear's and plugin's `config = {...}` in a description, by its id
/// (`mini-chat`, `oidc-authn-plugin`), as JSON. A value that is not a
/// literal (a call, a name) is kept as its text, so a field is still seen as
/// set. A gear without `config` is absent; a description without a literal
/// `product(...)` or `gears` list gives nothing.
pub fn gear_configs(text: &str) -> BTreeMap<String, serde_json::Value> {
    let d = Doc::new(text);
    let mut out = BTreeMap::new();
    let Some(p) = d.product() else { return out };
    let Some(gears) = d.kw(&p, "gears").and_then(|a| d.list(a.value)) else {
        return out;
    };
    let mut take = |c: &Call| {
        if let (Some(id), Some(config)) = (d.first_str(c), d.kw(c, "config")) {
            out.insert(id, d.literal(config.value));
        }
    };
    for it in d.items(gears) {
        let Some(c) = d.call(it) else { continue };
        take(&c);
        if let Some(list) = d.kw(&c, "plugins").and_then(|a| d.list(a.value)) {
            for pi in d.items(list) {
                if let Some(pc) = d.call(pi) {
                    take(&pc);
                }
            }
        }
    }
    out
}

impl Doc<'_> {
    /// A Starlark literal as JSON: strings, numbers, `True`/`False`/`None`,
    /// lists and dicts; anything else is its text.
    fn literal(&self, s: Span) -> serde_json::Value {
        use serde_json::Value;
        let text = self.slice(s).trim();
        let b = self.t.as_bytes();
        match b.get(s.0) {
            Some(b'{') if self.close_of(s.0) == Some(s.1 - 1) => {
                let mut map = serde_json::Map::new();
                for (is, ie) in self.items((s.0, s.1 - 1)) {
                    // The `:` that splits the key from the value, in code.
                    let Some(at) = (is..ie).find(|&i| b[i] == b':' && self.m[i] == K::Code) else {
                        continue;
                    };
                    let raw = self.t[is..at].trim();
                    let key = str_value(raw).unwrap_or_else(|| raw.to_owned());
                    let mut v = at + 1;
                    while v < ie && b[v].is_ascii_whitespace() {
                        v += 1;
                    }
                    map.insert(key, self.literal((v, ie)));
                }
                Value::Object(map)
            }
            Some(b'[') if self.close_of(s.0) == Some(s.1 - 1) => Value::Array(
                self.items((s.0, s.1 - 1))
                    .into_iter()
                    .map(|i| self.literal(i))
                    .collect(),
            ),
            Some(b'"' | b'\'') => Value::String(str_value(text).unwrap_or_else(|| text.to_owned())),
            _ => match text {
                "True" => Value::Bool(true),
                "False" => Value::Bool(false),
                "None" => Value::Null,
                t => t
                    .parse::<i64>()
                    .map(Value::from)
                    .ok()
                    .or_else(|| t.parse::<f64>().ok().map(Value::from))
                    .unwrap_or_else(|| Value::String(t.to_owned())),
            },
        }
    }
}

#[cfg(test)]
#[path = "description_edit_tests.rs"]
mod tests;
