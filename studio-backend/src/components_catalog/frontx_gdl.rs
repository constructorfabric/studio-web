//! A FrontX package's own description, `frontx.gdl` (GDL 1.6), read without
//! evaluating it.
//!
//! The file sits at a package's root beside its `package.json` and says what
//! the package is, in one call: `shell(signs_in = …, runtime_env = …)`,
//! `mfe(requires = [...])` or `library()`. Gearbox evaluates it as Starlark;
//! Studio does not depend on Gearbox's crates, and the scan reads files from
//! repositories it does not own, so this reads only the subset the vocabulary
//! needs — a `gdl_version = "1.6"` line, the one call with literal named
//! arguments (`True`, `False`, `None`, strings, lists of strings), and `#`
//! comments — and refuses anything else with the reason. Nothing is executed.
//!
//! What the package's manifests already say (name, version, pins, screens,
//! what a shell carries) is not part of the vocabulary, so an argument naming
//! one is refused like any unknown argument, as Gearbox refuses it.

/// What a `frontx.gdl` declares the package to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FrontxDescription {
    /// A shell: whether it signs users in before it mounts a screen, and the
    /// file (inside the package) it reads the product's addresses from at
    /// start, `None` when it takes them at build.
    Shell {
        signs_in: bool,
        runtime_env: Option<String>,
    },
    /// A micro-frontend and the backend gears its screens call, sorted and
    /// once each; empty when it calls none.
    Mfe { requires: Vec<String> },
    /// A package micro-frontends share, which is not one itself.
    Library,
}

impl FrontxDescription {
    /// The kind as the profile records it: `shell`, `mfe` or `library`.
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Shell { .. } => "shell",
            Self::Mfe { .. } => "mfe",
            Self::Library => "library",
        }
    }
}

/// Starlark words that compute rather than state, refused by name so the
/// reason says why.
const KEYWORDS: [&str; 10] = [
    "if", "elif", "else", "for", "while", "def", "lambda", "return", "and", "or",
];

/// The GDL version the vocabulary was introduced in, and the only one read.
const GDL_VERSION: &str = "1.6";

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Ident(String),
    Str(String),
    LParen,
    RParen,
    LBracket,
    RBracket,
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
}

fn lex(src: &str) -> Result<Vec<Spanned>, String> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut line = 1usize;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
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
            '(' => {
                out.push((Tok::LParen, line));
                i += 1;
            }
            ')' => {
                out.push((Tok::RParen, line));
                i += 1;
            }
            '[' => {
                out.push((Tok::LBracket, line));
                i += 1;
            }
            ']' => {
                out.push((Tok::RBracket, line));
                i += 1;
            }
            ',' => {
                out.push((Tok::Comma, line));
                i += 1;
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

    fn value(&mut self) -> Result<Lit, String> {
        match self.next() {
            Some((Tok::Ident(w), l)) => match w.as_str() {
                "True" => Ok(Lit::Bool(true)),
                "False" => Ok(Lit::Bool(false)),
                "None" => Ok(Lit::None),
                _ => Err(format!(
                    "line {l}: `{w}` is a name, not a literal; a value is True, False, None, a string or a list of strings"
                )),
            },
            Some((Tok::Str(s), _)) => Ok(Lit::Str(s)),
            Some((Tok::LBracket, _)) => {
                let mut items = Vec::new();
                loop {
                    match self.next() {
                        Some((Tok::RBracket, _)) => break,
                        Some((Tok::Str(s), _)) => {
                            items.push(s);
                            match self.next() {
                                Some((Tok::Comma, _)) => {}
                                Some((Tok::RBracket, _)) => break,
                                Some((_, l)) => {
                                    return Err(format!("line {l}: expected `,` or `]` in a list"));
                                }
                                None => {
                                    return Err(format!(
                                        "line {}: the file ends inside a list",
                                        self.line()
                                    ));
                                }
                            }
                        }
                        Some((_, l)) => {
                            return Err(format!("line {l}: a list holds strings only"));
                        }
                        None => {
                            return Err(format!(
                                "line {}: the file ends inside a list",
                                self.line()
                            ));
                        }
                    }
                }
                Ok(Lit::List(items))
            }
            Some((_, l)) => Err(format!(
                "line {l}: expected a value (True, False, None, a string or a list of strings)"
            )),
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
                        None => {
                            return Err(format!(
                                "line {}: the file ends inside a call",
                                self.line()
                            ));
                        }
                    }
                }
                Some((_, l)) => {
                    return Err(format!(
                        "line {l}: arguments are named (`name = value`); a positional one is not read"
                    ));
                }
                None => return Err(format!("line {}: the file ends inside a call", self.line())),
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
                            "line {line}: `{other}()` is not a FrontX package declaration; it is one of `shell(...)`, `mfe(...)` or `library()`"
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
        Some(GDL_VERSION) => {}
        Some(other) => {
            return Err(format!(
                "gdl_version = \"{other}\"; this reads \"{GDL_VERSION}\", where frontx.gdl was introduced"
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

fn declaration(name: &str, args: Vec<Arg>, line: usize) -> Result<FrontxDescription, String> {
    let allowed: &[&str] = match name {
        "shell" => &["signs_in", "runtime_env"],
        "mfe" => &["requires"],
        _ => &[],
    };
    if let Some((arg, _, l)) = args.iter().find(|(a, _, _)| !allowed.contains(&a.as_str())) {
        let says = if allowed.is_empty() {
            "it takes no arguments".to_string()
        } else {
            format!("it takes {}", allowed.join(", "))
        };
        return Err(format!(
            "line {l}: `{name}()` has no argument `{arg}`; {says}"
        ));
    }
    let get = |key: &str| {
        args.iter()
            .find(|(a, _, _)| a == key)
            .map(|(_, v, l)| (v, *l))
    };
    match name {
        "shell" => {
            let signs_in = match get("signs_in") {
                Some((Lit::Bool(b), _)) => *b,
                Some((_, l)) => return Err(format!("line {l}: `signs_in` is True or False")),
                None => {
                    return Err(format!(
                        "line {line}: `shell()` must say whether it signs users in: `signs_in = True` or `False`"
                    ));
                }
            };
            let runtime_env = match get("runtime_env") {
                None | Some((Lit::None, _)) => None,
                Some((Lit::Str(path), l)) => Some(package_path(path).map_err(|e| {
                    format!(
                        "line {l}: runtime_env = \"{path}\" is not a path inside the package: {e}"
                    )
                })?),
                Some((_, l)) => {
                    return Err(format!(
                        "line {l}: `runtime_env` is a path inside the package or None"
                    ));
                }
            };
            Ok(FrontxDescription::Shell {
                signs_in,
                runtime_env,
            })
        }
        "mfe" => {
            let mut requires = match get("requires") {
                None => Vec::new(),
                Some((Lit::List(ids), l)) => {
                    if let Some(bad) = ids.iter().find(|id| !is_gear_id(id)) {
                        return Err(format!(
                            "line {l}: requires: `{bad}` is not a gear id (lowercase letters, digits and single hyphens, starting with a letter)"
                        ));
                    }
                    ids.clone()
                }
                Some((_, l)) => return Err(format!("line {l}: `requires` is a list of gear ids")),
            };
            requires.sort();
            requires.dedup();
            Ok(FrontxDescription::Mfe { requires })
        }
        _ => Ok(FrontxDescription::Library),
    }
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
