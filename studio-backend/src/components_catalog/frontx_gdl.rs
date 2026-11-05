//! A FrontX package's passport, `frontx.gdl` (GDL 1.5), read without
//! evaluating it.
//!
//! The file sits at a package's root beside its `package.json` and says what
//! the package is, in one call — `shell(...)`, `mfe(...)` or `library(...)` —
//! and everything a tool needs to know about it, including what its
//! `package.json` and `mfe.json` already say (name, version, pins, screens).
//! Gearbox evaluates it as Starlark; Studio does not depend on Gearbox's
//! crates, and the scan reads files from repositories it does not own, so this
//! reads only the subset the vocabulary needs — a `gdl_version = "1.5"` line
//! (or a later 1.x), the one call with literal named arguments (`True`,
//! `False`, `None`, strings, lists of strings, dicts of strings to strings),
//! and `#` comments — and refuses anything else with the reason. Nothing is
//! executed.
//!
//! Every argument but a shell's `signs_in` is optional. Where one restates a
//! manifest, the catalogue checks the two agree and records a disagreement
//! as a warning (`apply_frontx_description`), not a refusal: the passport
//! still reads.

use std::collections::BTreeMap;

/// Who a package says it is: `package.json`'s name, version and description.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Identity {
    pub name: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    /// Its documents, relative to the package (`docs = ["README.md"]`,
    /// ADR-0061). Studio reads it; Gearbox's vocabulary does not take it yet,
    /// so a package Gearbox also generates from leaves it out and the
    /// catalogue falls back to the package's README.
    pub docs: Vec<String>,
}

/// A shell's passport.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ShellPassport {
    pub identity: Identity,
    /// Whether it signs users in before it mounts a screen.
    pub signs_in: bool,
    /// Where the identity provider sends a signed-in user back to.
    pub sign_in_redirect: Vec<String>,
    /// The file (inside the package) it reads the product's addresses from at
    /// start, `None` when it takes them at build.
    pub runtime_env: Option<String>,
    /// The keys it reads at start, each to what fills it.
    pub env: BTreeMap<String, String>,
    /// The variables it needs at build.
    pub build_env: Vec<String>,
    pub node: Option<String>,
    pub package_manager: Option<String>,
    pub build: Option<String>,
    pub output: Option<String>,
    pub base: Option<String>,
    /// The path its screens call the backend under (`/cf/`).
    pub api_prefix: Option<String>,
    /// The FrontX packages it gives what it mounts; `None` when not declared.
    pub carries: Option<BTreeMap<String, String>>,
}

/// A micro-frontend's passport.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MfePassport {
    pub identity: Identity,
    /// The backend gears its screens call, sorted and once each; empty when it
    /// calls none.
    pub requires: Vec<String>,
    /// Its `mfe.json` extensions' labels, in order.
    pub screens: Option<Vec<String>>,
    /// Its `mfe.json` extensions' routes, in order.
    pub mounts: Option<Vec<String>>,
    /// Its `@gears-frontx/react` pin.
    pub frontx: Option<String>,
    /// The permissions its screens need, when known.
    pub roles: Option<Vec<String>>,
    pub preview: Vec<String>,
    pub fixtures: Option<String>,
}

/// What a `frontx.gdl` declares the package to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FrontxDescription {
    /// A shell, which mounts micro-frontends.
    Shell(Box<ShellPassport>),
    /// A micro-frontend.
    Mfe(Box<MfePassport>),
    /// A package micro-frontends share, which is not one itself.
    Library(Identity),
}

impl FrontxDescription {
    /// The kind as the profile records it: `shell`, `mfe` or `library`.
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Shell(_) => "shell",
            Self::Mfe(_) => "mfe",
            Self::Library(_) => "library",
        }
    }

    /// Who the package says it is.
    pub(crate) fn identity(&self) -> &Identity {
        match self {
            Self::Shell(s) => &s.identity,
            Self::Mfe(m) => &m.identity,
            Self::Library(i) => i,
        }
    }
}

/// Starlark words that compute rather than state, refused by name so the
/// reason says why.
const KEYWORDS: [&str; 10] = [
    "if", "elif", "else", "for", "while", "def", "lambda", "return", "and", "or",
];

/// The GDL version the vocabulary was introduced in. Any later 1.x is read
/// too: a later minor may add arguments, and an unknown one is refused by
/// name, so nothing a newer file says is misread.
const GDL_VERSION: &str = "1.5";

/// Whether `v` is a GDL version this reader takes: `1.5` or a later `1.x`.
fn reads_version(v: &str) -> bool {
    let Some((major, minor)) = v.split_once('.') else {
        return false;
    };
    major == "1" && minor.parse::<u32>().is_ok_and(|m| m >= 5)
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Ident(String),
    Str(String),
    LParen,
    RParen,
    LBracket,
    RBracket,
    LBrace,
    RBrace,
    Colon,
    Comma,
    Eq,
}

/// A token and the line it starts on (1-based), for the reason a file is
/// refused with.
type Spanned = (Tok, usize);

/// A named argument, its value and the line it is on.
type Arg = (String, Lit, usize);

/// A literal argument value.
#[derive(Debug, Clone, PartialEq)]
enum Lit {
    Bool(bool),
    None,
    Str(String),
    List(Vec<String>),
    Dict(Vec<(String, String)>),
}

fn lex(src: &str) -> Result<Vec<Spanned>, String> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut line = 1usize;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        let single = match c {
            '(' => Some(Tok::LParen),
            ')' => Some(Tok::RParen),
            '[' => Some(Tok::LBracket),
            ']' => Some(Tok::RBracket),
            '{' => Some(Tok::LBrace),
            '}' => Some(Tok::RBrace),
            ':' => Some(Tok::Colon),
            ',' => Some(Tok::Comma),
            _ => None,
        };
        if let Some(tok) = single {
            out.push((tok, line));
            i += 1;
            continue;
        }
        match c {
            '\n' => {
                line += 1;
                i += 1;
            }
            ' ' | '\t' | '\r' => i += 1,
            '#' => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '=' => {
                if chars.get(i + 1) == Some(&'=') {
                    return Err(format!(
                        "line {line}: `==` is a comparison; a description states, it does not compute"
                    ));
                }
                out.push((Tok::Eq, line));
                i += 1;
            }
            '"' | '\'' => {
                let (s, next) = string(&chars, i, line)?;
                out.push((Tok::Str(s), line));
                i = next;
            }
            c if c.is_ascii_alphabetic() || c == '_' => {
                let start = i;
                while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                if matches!(chars.get(i), Some('"' | '\'')) {
                    return Err(format!(
                        "line {line}: `{word}\"...\"` is a prefixed string; only plain \"...\" or '...' strings are read"
                    ));
                }
                out.push((Tok::Ident(word), line));
            }
            c if c.is_ascii_digit() => {
                return Err(format!(
                    "line {line}: a number; none of `shell`, `mfe` or `library` takes one"
                ));
            }
            other => {
                return Err(format!(
                    "line {line}: `{other}` is outside what a frontx.gdl may say (one call with literal arguments)"
                ));
            }
        }
    }
    Ok(out)
}

/// A one-line `"..."` or `'...'` string starting at `at`, with the escapes a
/// path or an id could need; returns it and the index after its closing quote.
fn string(chars: &[char], at: usize, line: usize) -> Result<(String, usize), String> {
    let quote = chars[at];
    if chars.get(at + 1) == Some(&quote) && chars.get(at + 2) == Some(&quote) {
        return Err(format!(
            "line {line}: a triple-quoted string; only one-line strings are read"
        ));
    }
    let mut s = String::new();
    let mut i = at + 1;
    loop {
        match chars.get(i) {
            None | Some('\n') => return Err(format!("line {line}: a string is not closed")),
            Some(c) if *c == quote => return Ok((s, i + 1)),
            Some('\\') => {
                let esc = match chars.get(i + 1) {
                    Some('\\') => '\\',
                    Some('"') => '"',
                    Some('\'') => '\'',
                    Some('n') => '\n',
                    Some('t') => '\t',
                    other => {
                        return Err(format!(
                            "line {line}: the escape `\\{}` is not read",
                            other.map(char::to_string).unwrap_or_default()
                        ));
                    }
                };
                s.push(esc);
                i += 2;
            }
            Some(c) => {
                s.push(*c);
                i += 1;
            }
        }
    }
}

struct Parser {
    toks: Vec<Spanned>,
    at: usize,
}

const A_VALUE: &str =
    "True, False, None, a string, a list of strings or a dict of strings to strings";

impl Parser {
    fn peek(&self) -> Option<&Spanned> {
        self.toks.get(self.at)
    }

    fn line(&self) -> usize {
        self.peek()
            .or_else(|| self.toks.last())
            .map_or(1, |(_, l)| *l)
    }

    fn next(&mut self) -> Option<Spanned> {
        let t = self.toks.get(self.at).cloned();
        self.at += 1;
        t
    }

    fn ends_inside(&self, what: &str) -> String {
        format!("line {}: the file ends inside a {what}", self.line())
    }

    /// After an item of a list or dict: `,` or the closing token. `true` when
    /// it closed.
    fn item_end(&mut self, close: &Tok, what: &str) -> Result<bool, String> {
        match self.next() {
            Some((Tok::Comma, _)) => Ok(false),
            Some((t, _)) if &t == close => Ok(true),
            Some((_, l)) => Err(format!("line {l}: expected `,` or the end of the {what}")),
            None => Err(self.ends_inside(what)),
        }
    }

    fn list(&mut self) -> Result<Lit, String> {
        let mut items = Vec::new();
        loop {
            match self.next() {
                Some((Tok::RBracket, _)) => break,
                Some((Tok::Str(s), _)) => {
                    items.push(s);
                    if self.item_end(&Tok::RBracket, "list")? {
                        break;
                    }
                }
                Some((_, l)) => return Err(format!("line {l}: a list holds strings only")),
                None => return Err(self.ends_inside("list")),
            }
        }
        Ok(Lit::List(items))
    }

    fn dict(&mut self) -> Result<Lit, String> {
        let mut entries = Vec::new();
        loop {
            match self.next() {
                Some((Tok::RBrace, _)) => break,
                Some((Tok::Str(k), l)) => {
                    match self.next() {
                        Some((Tok::Colon, _)) => {}
                        Some((_, l)) => return Err(format!("line {l}: expected `:` after a key")),
                        None => return Err(self.ends_inside("dict")),
                    }
                    let v = match self.next() {
                        Some((Tok::Str(v), _)) => v,
                        Some((_, l)) => {
                            return Err(format!("line {l}: a dict maps strings to strings"));
                        }
                        None => return Err(self.ends_inside("dict")),
                    };
                    if entries.iter().any(|(e, _): &(String, String)| e == &k) {
                        return Err(format!("line {l}: the key \"{k}\" is given twice"));
                    }
                    entries.push((k, v));
                    if self.item_end(&Tok::RBrace, "dict")? {
                        break;
                    }
                }
                Some((_, l)) => return Err(format!("line {l}: a dict maps strings to strings")),
                None => return Err(self.ends_inside("dict")),
            }
        }
        Ok(Lit::Dict(entries))
    }

    fn value(&mut self) -> Result<Lit, String> {
        match self.next() {
            Some((Tok::Ident(w), l)) => match w.as_str() {
                "True" => Ok(Lit::Bool(true)),
                "False" => Ok(Lit::Bool(false)),
                "None" => Ok(Lit::None),
                _ => Err(format!(
                    "line {l}: `{w}` is a name, not a literal; a value is {A_VALUE}"
                )),
            },
            Some((Tok::Str(s), _)) => Ok(Lit::Str(s)),
            Some((Tok::LBracket, _)) => self.list(),
            Some((Tok::LBrace, _)) => self.dict(),
            Some((_, l)) => Err(format!("line {l}: expected a value ({A_VALUE})")),
            None => Err(format!(
                "line {}: the file ends where a value was expected",
                self.line()
            )),
        }
    }

    /// `name = value, …` up to the closing `)`. Every argument is named, once.
    fn args(&mut self) -> Result<Vec<Arg>, String> {
        let mut out: Vec<Arg> = Vec::new();
        loop {
            match self.next() {
                Some((Tok::RParen, _)) => return Ok(out),
                Some((Tok::Ident(name), l)) if matches!(self.peek(), Some((Tok::Eq, _))) => {
                    self.next();
                    let v = self.value()?;
                    if out.iter().any(|(n, _, _)| n == &name) {
                        return Err(format!("line {l}: `{name}` is given twice"));
                    }
                    out.push((name, v, l));
                    match self.next() {
                        Some((Tok::Comma, _)) => {}
                        Some((Tok::RParen, _)) => return Ok(out),
                        Some((_, l)) => return Err(format!("line {l}: expected `,` or `)`")),
                        None => return Err(self.ends_inside("call")),
                    }
                }
                Some((_, l)) => {
                    return Err(format!(
                        "line {l}: arguments are named (`name = value`); a positional one is not read"
                    ));
                }
                None => return Err(self.ends_inside("call")),
            }
        }
    }
}

/// Read a `frontx.gdl`. `Err` says why the file is not one this reads; the
/// scan then keeps its guesses.
pub(crate) fn read(src: &str) -> Result<FrontxDescription, String> {
    let mut p = Parser {
        toks: lex(src)?,
        at: 0,
    };
    let mut version: Option<String> = None;
    let mut call: Option<(String, Vec<Arg>, usize)> = None;
    // The line the previous statement ended on: two statements never share one.
    let mut last_line = 0usize;

    while let Some((tok, line)) = p.next() {
        if line == last_line {
            return Err(format!("line {line}: one statement per line"));
        }
        if let Tok::Ident(w) = &tok
            && KEYWORDS.contains(&w.as_str())
        {
            return Err(format!(
                "line {line}: `{w}`; a frontx.gdl is declarative, with no control flow or definitions"
            ));
        }
        let Tok::Ident(name) = tok else {
            return Err(format!(
                "line {line}: a statement is `gdl_version = \"{GDL_VERSION}\"` or one call"
            ));
        };
        match p.peek() {
            Some((Tok::Eq, _)) => {
                p.next();
                if name != "gdl_version" {
                    return Err(format!(
                        "line {line}: `{name} = …`; the only assignment is `gdl_version`"
                    ));
                }
                if version.is_some() {
                    return Err(format!("line {line}: `gdl_version` is set twice"));
                }
                match p.next() {
                    Some((Tok::Str(v), _)) => version = Some(v),
                    _ => return Err(format!("line {line}: `gdl_version` is a string")),
                }
            }
            Some((Tok::LParen, _)) => {
                p.next();
                match name.as_str() {
                    "shell" | "mfe" | "library" => {}
                    "load" => {
                        return Err(format!("line {line}: `load()`; a frontx.gdl loads nothing"));
                    }
                    other => {
                        return Err(format!(
                            "line {line}: `{other}()` is not a FrontX package declaration; it is one of `shell(...)`, `mfe(...)` or `library(...)`"
                        ));
                    }
                }
                if let Some((first, _, at)) = &call {
                    return Err(format!(
                        "line {line}: a second declaration, `{name}()`; a package is one kind and line {at} already declared `{first}()`"
                    ));
                }
                let args = p.args()?;
                call = Some((name, args, line));
            }
            _ => {
                return Err(format!(
                    "line {line}: `{name}` alone; a statement is `gdl_version = \"{GDL_VERSION}\"` or one call"
                ));
            }
        }
        last_line = p.toks.get(p.at - 1).map_or(line, |(_, l)| *l);
    }

    match version.as_deref() {
        Some(v) if reads_version(v) => {}
        Some(other) => {
            return Err(format!(
                "gdl_version = \"{other}\"; this reads \"{GDL_VERSION}\", where frontx.gdl was introduced, and later 1.x"
            ));
        }
        None => {
            return Err(format!("no `gdl_version = \"{GDL_VERSION}\"` line"));
        }
    }
    let Some((name, args, line)) = call else {
        return Err(
            "no declaration; add one of `shell(signs_in = …)`, `mfe(requires = [...])` or `library()`"
                .to_string(),
        );
    };
    declaration(&name, args, line)
}

const IDENTITY: [&str; 4] = ["name", "version", "description", "docs"];
const SHELL_ARGS: [&str; 12] = [
    "signs_in",
    "sign_in_redirect",
    "runtime_env",
    "env",
    "build_env",
    "node",
    "package_manager",
    "build",
    "output",
    "base",
    "api_prefix",
    "carries",
];
const MFE_ARGS: [&str; 7] = [
    "requires", "screens", "mounts", "frontx", "roles", "preview", "fixtures",
];

/// The arguments of one call, each taken once and checked.
struct Args {
    call: &'static str,
    args: Vec<Arg>,
}

impl Args {
    fn get(&self, key: &str) -> Option<(&Lit, usize)> {
        self.args
            .iter()
            .find(|(a, _, _)| a == key)
            .map(|(_, v, l)| (v, *l))
    }

    /// A string argument, checked by `check`; absent is `None`.
    fn string(
        &self,
        key: &str,
        check: impl Fn(&str) -> Result<(), String>,
    ) -> Result<Option<String>, String> {
        match self.get(key) {
            None => Ok(None),
            Some((Lit::Str(s), l)) => {
                check(s).map_err(|e| format!("line {l}: {key} = \"{s}\" {e}"))?;
                Ok(Some(s.clone()))
            }
            Some((_, l)) => Err(format!("line {l}: `{key}` is a string")),
        }
    }

    /// A list-of-strings argument, each item checked; absent is `None`.
    fn list(
        &self,
        key: &str,
        check: impl Fn(&str) -> Result<(), String>,
    ) -> Result<Option<Vec<String>>, String> {
        match self.get(key) {
            None => Ok(None),
            Some((Lit::List(items), l)) => {
                for item in items {
                    check(item).map_err(|e| format!("line {l}: {key}: \"{item}\" {e}"))?;
                }
                Ok(Some(items.clone()))
            }
            Some((_, l)) => Err(format!("line {l}: `{key}` is a list of strings")),
        }
    }

    /// A dict-of-strings argument, each key and value non-empty; absent is
    /// `None`.
    fn dict(&self, key: &str) -> Result<Option<BTreeMap<String, String>>, String> {
        match self.get(key) {
            None => Ok(None),
            Some((Lit::Dict(entries), l)) => {
                if let Some((k, v)) = entries
                    .iter()
                    .find(|(k, v)| word(k).is_err() || one_line(v).is_err())
                {
                    return Err(format!(
                        "line {l}: {key}: \"{k}\": \"{v}\" is not a key with no spaces to a one-line value"
                    ));
                }
                Ok(Some(entries.iter().cloned().collect()))
            }
            Some((_, l)) => Err(format!("line {l}: `{key}` is a dict of strings to strings")),
        }
    }

    fn identity(&self) -> Result<Identity, String> {
        Ok(Identity {
            name: self.string("name", word)?,
            version: self.string("version", word)?,
            description: self.string("description", one_line)?,
            docs: self
                .list("docs", |p| {
                    package_path(p).map(|_| ()).map_err(str::to_string)
                })?
                .unwrap_or_default(),
        })
    }
}

fn declaration(name: &str, args: Vec<Arg>, line: usize) -> Result<FrontxDescription, String> {
    let (call, own): (&'static str, &[&str]) = match name {
        "shell" => ("shell", &SHELL_ARGS),
        "mfe" => ("mfe", &MFE_ARGS),
        _ => ("library", &[]),
    };
    if let Some((arg, _, l)) = args
        .iter()
        .find(|(a, _, _)| !IDENTITY.contains(&a.as_str()) && !own.contains(&a.as_str()))
    {
        let takes: Vec<&str> = IDENTITY.iter().chain(own).copied().collect();
        return Err(format!(
            "line {l}: `{call}()` has no argument `{arg}`; it takes {}",
            takes.join(", ")
        ));
    }
    let a = Args { call, args };
    let identity = a.identity()?;
    match a.call {
        "shell" => shell(&a, identity, line),
        "mfe" => mfe(&a, identity),
        _ => Ok(FrontxDescription::Library(identity)),
    }
}

fn shell(a: &Args, identity: Identity, line: usize) -> Result<FrontxDescription, String> {
    let signs_in = match a.get("signs_in") {
        Some((Lit::Bool(b), _)) => *b,
        Some((_, l)) => return Err(format!("line {l}: `signs_in` is True or False")),
        None => {
            return Err(format!(
                "line {line}: `shell()` must say whether it signs users in: `signs_in = True` or `False`"
            ));
        }
    };
    let runtime_env = match a.get("runtime_env") {
        None | Some((Lit::None, _)) => None,
        Some((Lit::Str(path), l)) => Some(package_path(path).map_err(|e| {
            format!("line {l}: runtime_env = \"{path}\" is not a path inside the package: {e}")
        })?),
        Some((_, l)) => {
            return Err(format!(
                "line {l}: `runtime_env` is a path inside the package or None"
            ));
        }
    };
    let sign_in_redirect = match a.get("sign_in_redirect") {
        None | Some((Lit::None, _)) => Vec::new(),
        Some((Lit::Str(_), _)) => vec![a.string("sign_in_redirect", route)?.unwrap_or_default()],
        Some((Lit::List(_), _)) => a.list("sign_in_redirect", route)?.unwrap_or_default(),
        Some((_, l)) => {
            return Err(format!(
                "line {l}: `sign_in_redirect` is a route, a list of them, or None"
            ));
        }
    };
    if !signs_in
        && let Some((_, l)) = a
            .get("sign_in_redirect")
            .filter(|_| !sign_in_redirect.is_empty())
    {
        return Err(format!(
            "line {l}: sign_in_redirect is where a signed-in user comes back to; a shell with `signs_in = False` has none"
        ));
    }
    Ok(FrontxDescription::Shell(Box::new(ShellPassport {
        identity,
        signs_in,
        sign_in_redirect,
        runtime_env,
        env: a.dict("env")?.unwrap_or_default(),
        build_env: a.list("build_env", env_name)?.unwrap_or_default(),
        node: a.string("node", word)?,
        package_manager: a.string("package_manager", |pm| {
            if matches!(pm, "npm" | "pnpm" | "yarn") {
                Ok(())
            } else {
                Err("is not \"npm\", \"pnpm\" or \"yarn\"".into())
            }
        })?,
        build: a.string("build", one_line)?,
        output: a.string("output", |p| {
            package_path(p).map(|_| ()).map_err(str::to_string)
        })?,
        base: a.string("base", |p| url_path(p, true))?,
        api_prefix: a.string("api_prefix", |p| url_path(p, false))?,
        carries: a.dict("carries")?,
    })))
}

fn mfe(a: &Args, identity: Identity) -> Result<FrontxDescription, String> {
    let mut requires = a
        .list("requires", |id| {
            if is_gear_id(id) {
                Ok(())
            } else {
                Err("is not a gear id (lowercase letters, digits and single hyphens, starting with a letter)".into())
            }
        })?
        .unwrap_or_default();
    requires.sort();
    requires.dedup();
    Ok(FrontxDescription::Mfe(Box::new(MfePassport {
        identity,
        requires,
        screens: a.list("screens", one_line)?,
        mounts: a.list("mounts", route)?,
        frontx: a.string("frontx", word)?,
        roles: a.list("roles", word)?,
        preview: a.list("preview", route)?.unwrap_or_default(),
        fixtures: a.string("fixtures", |p| {
            package_path(p).map(|_| ()).map_err(str::to_string)
        })?,
    })))
}

/// A word with no spaces: a name, a version, a key.
fn word(s: &str) -> Result<(), String> {
    if s.is_empty() || s.chars().any(char::is_whitespace) {
        return Err("is empty or has spaces".into());
    }
    Ok(())
}

/// A non-empty string on one line.
fn one_line(s: &str) -> Result<(), String> {
    if s.trim().is_empty() || s.contains(['\n', '\r']) {
        return Err("is empty or spans lines".into());
    }
    Ok(())
}

/// A route on the package's origin: `/accounts`.
fn route(s: &str) -> Result<(), String> {
    if !s.starts_with('/') || s.chars().any(char::is_whitespace) {
        return Err("is not a route (it starts with `/` and has no spaces)".into());
    }
    Ok(())
}

/// A path that starts and ends with `/`, of letters, digits, `-`, `_`, `.`.
fn url_path(s: &str, root_allowed: bool) -> Result<(), String> {
    let safe = s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'));
    if !safe || !s.starts_with('/') || !s.ends_with('/') || s.contains("//") {
        return Err("is not a path such as \"/cf/\"".into());
    }
    if s == "/" && !root_allowed {
        return Err("would send every request to the backend".into());
    }
    Ok(())
}

/// An environment variable name: `VITE_API_BASE`.
fn env_name(s: &str) -> Result<(), String> {
    let valid = s.starts_with(|c: char| c.is_ascii_uppercase() || c == '_')
        && s.chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if !valid {
        return Err("is not a variable name (uppercase letters, digits and `_`)".into());
    }
    Ok(())
}

/// A path inside the package: relative, forward slashes, no `..` or empty part.
fn package_path(path: &str) -> Result<String, &'static str> {
    if path.is_empty() {
        return Err("it is empty");
    }
    if path.contains('\\') {
        return Err("it uses backslashes");
    }
    if path.starts_with('/') || path.contains(':') {
        return Err("it is absolute");
    }
    if path.chars().any(char::is_whitespace) {
        return Err("it has spaces");
    }
    if path
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err("it has an empty, `.` or `..` part");
    }
    Ok(path.to_string())
}

/// A kebab-case gear id: `account-management`, `studio-user`.
fn is_gear_id(id: &str) -> bool {
    id.starts_with(|c: char| c.is_ascii_lowercase())
        && !id.ends_with('-')
        && !id.contains("--")
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[cfg(test)]
#[path = "frontx_gdl_tests.rs"]
mod tests;
