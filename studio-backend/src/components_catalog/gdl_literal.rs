//! The declarative subset every component passport is written in, read
//! without evaluating it: `service.gdl` and `kit.gdl` (ADR-0061), beside
//! `frontx.gdl`, whose own reader predates this one.
//!
//! A passport is a `gdl_version = "1.x"` line and one call with named literal
//! arguments: `True`, `False`, `None`, strings, non-negative integers, lists
//! of strings, and dicts from strings to strings or integers. `#` comments,
//! newlines and trailing commas are free. Anything that computes -- a name, an
//! operator, `if`, `def`, `load()` -- is refused with the reason and the line,
//! and nothing is executed: the scan reads files from repositories Studio does
//! not own.
//!
//! Gearbox evaluates the same files as Starlark when it generates; this subset
//! is what reads the same either way.

/// One literal argument value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Lit {
    Bool(bool),
    None,
    Str(String),
    Int(u64),
    List(Vec<String>),
    /// In source order; a key is given once.
    Dict(Vec<(String, DictValue)>),
}

/// A dict's value: a string or an integer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DictValue {
    Str(String),
    Int(u64),
}

impl DictValue {
    /// The value as text: an integer is its digits.
    pub(crate) fn text(&self) -> String {
        match self {
            Self::Str(s) => s.clone(),
            Self::Int(n) => n.to_string(),
        }
    }
}

/// The one call a passport makes: its name, its named arguments in order,
/// and the line it starts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Call {
    pub name: String,
    pub args: Vec<(String, Lit, usize)>,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Ident(String),
    Str(String),
    Int(u64),
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

type Spanned = (Tok, usize);

/// Starlark words that compute rather than state.
const KEYWORDS: [&str; 10] = [
    "if", "elif", "else", "for", "while", "def", "lambda", "return", "and", "or",
];

fn lex(src: &str, file: &str) -> Result<Vec<Spanned>, String> {
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
                        "line {line}: `==` is a comparison; a {file} states, it does not compute"
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
            c if c.is_ascii_digit() => {
                let start = i;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                if chars
                    .get(i)
                    .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '_')
                {
                    return Err(format!(
                        "line {line}: only whole numbers are read; a version or a size is a string"
                    ));
                }
                let digits: String = chars[start..i].iter().collect();
                let n = digits
                    .parse::<u64>()
                    .map_err(|_| format!("line {line}: {digits} is too large"))?;
                out.push((Tok::Int(n), line));
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
            other => {
                return Err(format!(
                    "line {line}: `{other}` is outside what a {file} may say (one call with literal arguments)"
                ));
            }
        }
    }
    Ok(out)
}

/// A one-line `"..."` or `'...'` string starting at `at`; returns it and the
/// index after its closing quote.
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

const A_VALUE: &str = "True, False, None, a string, a whole number, a list of strings or a dict of strings to strings or numbers";

struct Parser {
    toks: Vec<Spanned>,
    at: usize,
}

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
        let mut entries: Vec<(String, DictValue)> = Vec::new();
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
                        Some((Tok::Str(v), _)) => DictValue::Str(v),
                        Some((Tok::Int(n), _)) => DictValue::Int(n),
                        Some((_, l)) => {
                            return Err(format!(
                                "line {l}: a dict maps strings to strings or numbers"
                            ));
                        }
                        None => return Err(self.ends_inside("dict")),
                    };
                    if entries.iter().any(|(e, _)| e == &k) {
                        return Err(format!("line {l}: the key \"{k}\" is given twice"));
                    }
                    entries.push((k, v));
                    if self.item_end(&Tok::RBrace, "dict")? {
                        break;
                    }
                }
                Some((_, l)) => return Err(format!("line {l}: a dict's keys are strings")),
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
            Some((Tok::Int(n), _)) => Ok(Lit::Int(n)),
            Some((Tok::LBracket, _)) => self.list(),
            Some((Tok::LBrace, _)) => self.dict(),
            Some((_, l)) => Err(format!("line {l}: expected a value ({A_VALUE})")),
            None => Err(format!(
                "line {}: the file ends where a value was expected",
                self.line()
            )),
        }
    }

    fn args(&mut self) -> Result<Vec<(String, Lit, usize)>, String> {
        let mut out: Vec<(String, Lit, usize)> = Vec::new();
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

/// Whether `v` is a GDL version at or after `since` (`1.x`, x >= since's minor).
fn reads_version(v: &str, since: &str) -> bool {
    let minor = |s: &str| -> Option<u32> {
        let (major, minor) = s.split_once('.')?;
        (major == "1").then_some(())?;
        minor.parse::<u32>().ok()
    };
    match (minor(v), minor(since)) {
        (Some(m), Some(s)) => m >= s,
        _ => false,
    }
}

/// Read a passport: `file` names it in the reasons (`service.gdl`), `calls`
/// are the declarations it may make, and `since` is the GDL version its
/// vocabulary was introduced in -- later 1.x is read too.
pub(crate) fn read_call(
    src: &str,
    file: &str,
    calls: &[&str],
    since: &str,
) -> Result<Call, String> {
    let mut p = Parser {
        toks: lex(src, file)?,
        at: 0,
    };
    let mut version: Option<String> = None;
    let mut call: Option<Call> = None;
    let mut last_line = 0usize;
    let declarations = calls
        .iter()
        .map(|c| format!("`{c}(...)`"))
        .collect::<Vec<_>>()
        .join(" or ");

    while let Some((tok, line)) = p.next() {
        if line == last_line {
            return Err(format!("line {line}: one statement per line"));
        }
        if let Tok::Ident(w) = &tok
            && KEYWORDS.contains(&w.as_str())
        {
            return Err(format!(
                "line {line}: `{w}`; a {file} is declarative, with no control flow or definitions"
            ));
        }
        let Tok::Ident(name) = tok else {
            return Err(format!(
                "line {line}: a statement is `gdl_version = \"{since}\"` or one call"
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
                if name == "load" {
                    return Err(format!("line {line}: `load()`; a {file} loads nothing"));
                }
                if !calls.contains(&name.as_str()) {
                    return Err(format!(
                        "line {line}: `{name}()` is not what a {file} declares; it is {declarations}"
                    ));
                }
                if let Some(first) = &call {
                    return Err(format!(
                        "line {line}: a second declaration, `{name}()`; line {} already declared `{}()`",
                        first.line, first.name
                    ));
                }
                let args = p.args()?;
                call = Some(Call { name, args, line });
            }
            _ => {
                return Err(format!(
                    "line {line}: `{name}` alone; a statement is `gdl_version = \"{since}\"` or one call"
                ));
            }
        }
        last_line = p.toks.get(p.at - 1).map_or(line, |(_, l)| *l);
    }

    match version.as_deref() {
        Some(v) if reads_version(v, since) => {}
        Some(other) => {
            return Err(format!(
                "gdl_version = \"{other}\"; this reads \"{since}\", where {file} was introduced, and later 1.x"
            ));
        }
        None => return Err(format!("no `gdl_version = \"{since}\"` line")),
    }
    call.ok_or_else(|| format!("no declaration; a {file} makes one call, {declarations}"))
}

/// A call's arguments, each taken and checked.
pub(crate) struct Args<'a> {
    pub call: &'a Call,
}

impl Args<'_> {
    /// Refuse an argument the call does not take.
    pub(crate) fn only(&self, takes: &[&str]) -> Result<(), String> {
        match self
            .call
            .args
            .iter()
            .find(|(a, _, _)| !takes.contains(&a.as_str()))
        {
            Some((arg, _, l)) => Err(format!(
                "line {l}: `{}()` has no argument `{arg}`; it takes {}",
                self.call.name,
                takes.join(", ")
            )),
            None => Ok(()),
        }
    }

    pub(crate) fn get(&self, key: &str) -> Option<(&Lit, usize)> {
        self.call
            .args
            .iter()
            .find(|(a, _, _)| a == key)
            .map(|(_, v, l)| (v, *l))
    }

    /// A string; `None` and absent are `None`.
    pub(crate) fn string(
        &self,
        key: &str,
        check: impl Fn(&str) -> Result<(), String>,
    ) -> Result<Option<String>, String> {
        match self.get(key) {
            None | Some((Lit::None, _)) => Ok(None),
            Some((Lit::Str(s), l)) => {
                check(s).map_err(|e| format!("line {l}: {key} = \"{s}\" {e}"))?;
                Ok(Some(s.clone()))
            }
            Some((_, l)) => Err(format!("line {l}: `{key}` is a string")),
        }
    }

    /// A list of strings, each checked; absent is `None`.
    pub(crate) fn list(
        &self,
        key: &str,
        check: impl Fn(&str) -> Result<(), String>,
    ) -> Result<Option<Vec<String>>, String> {
        match self.get(key) {
            None | Some((Lit::None, _)) => Ok(None),
            Some((Lit::List(items), l)) => {
                for item in items {
                    check(item).map_err(|e| format!("line {l}: {key}: \"{item}\" {e}"))?;
                }
                Ok(Some(items.clone()))
            }
            Some((_, l)) => Err(format!("line {l}: `{key}` is a list of strings")),
        }
    }

    /// A dict, its keys checked by `key_check` and its values by `value_check`.
    pub(crate) fn dict(
        &self,
        key: &str,
        key_check: impl Fn(&str) -> Result<(), String>,
        value_check: impl Fn(&DictValue) -> Result<(), String>,
    ) -> Result<Option<Vec<(String, DictValue)>>, String> {
        match self.get(key) {
            None | Some((Lit::None, _)) => Ok(None),
            Some((Lit::Dict(entries), l)) => {
                for (k, v) in entries {
                    key_check(k).map_err(|e| format!("line {l}: {key}: the key \"{k}\" {e}"))?;
                    value_check(v)
                        .map_err(|e| format!("line {l}: {key}: \"{k}\": {} {e}", v.text()))?;
                }
                Ok(Some(entries.clone()))
            }
            Some((_, l)) => Err(format!("line {l}: `{key}` is a dict")),
        }
    }
}

/// A word with no spaces: a name, a version, a key.
pub(crate) fn word(s: &str) -> Result<(), String> {
    if s.is_empty() || s.chars().any(char::is_whitespace) {
        return Err("is empty or has spaces".into());
    }
    Ok(())
}

/// A non-empty string on one line.
pub(crate) fn one_line(s: &str) -> Result<(), String> {
    if s.trim().is_empty() || s.contains(['\n', '\r']) {
        return Err("is empty or spans lines".into());
    }
    Ok(())
}

/// A kebab-case id: `account-management`, `studio-user`.
pub(crate) fn kebab(s: &str) -> Result<(), String> {
    let ok = s.starts_with(|c: char| c.is_ascii_lowercase())
        && !s.ends_with('-')
        && !s.contains("--")
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(
            "is not an id (lowercase letters, digits and single hyphens, starting with a letter)"
                .into(),
        )
    }
}

/// A route: `/healthz`.
pub(crate) fn route(s: &str) -> Result<(), String> {
    if !s.starts_with('/') || s.chars().any(char::is_whitespace) {
        return Err("is not a route (it starts with `/` and has no spaces)".into());
    }
    Ok(())
}

/// A path relative to the passport's directory: forward slashes, no spaces,
/// not absolute, no empty or `.` part. `..` is allowed -- a Dockerfile's
/// context is often the repository root -- and kept inside the repository by
/// [`resolve`].
pub(crate) fn relative_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("is empty".into());
    }
    if path.contains('\\') {
        return Err("uses backslashes".into());
    }
    if path.starts_with('/') || path.contains(':') {
        return Err("is absolute".into());
    }
    if path.chars().any(char::is_whitespace) {
        return Err("has spaces".into());
    }
    if path != "." && path.split('/').any(|seg| seg.is_empty() || seg == ".") {
        return Err("has an empty or `.` part".into());
    }
    Ok(())
}

/// `path` (relative to the passport's directory `dir`, itself relative to the
/// repository root) as a path from the repository root; `None` when it climbs
/// out of the repository. `"."` is `dir` itself.
pub(crate) fn resolve(dir: &str, path: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

#[cfg(test)]
#[path = "gdl_literal_tests.rs"]
mod tests;
