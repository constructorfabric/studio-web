//! What a gear's files say, parsed — the rules behind the fields the repository
//! scan fills beyond presence: version and release, lifecycle, spec progress,
//! traceability, who works on it, and how its history is signed.
//!
//! Pure functions over text the scan has already read, so every rule is tested
//! against real fragments of `gears-rust` without a network in sight. The scan
//! (`repo_enrich`) does the reading; this module does the believing.
//!
//! The methods follow the gears-catalog playground's documented sources
//! (`studio-internal/product/gear-engineering-focus/gears-catalog/README.md`),
//! reimplemented here rather than borrowed: the playground reads a `git archive`
//! with Python, the catalogue reads the GitHub API in Rust.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

// ── Cargo manifests ─────────────────────────────────────────────────────────

/// A manifest's `[package]` name and version. The version is `None` when it is
/// inherited (`version.workspace = true`) — the caller has the workspace's.
pub fn cargo_package(body: &str) -> Option<(String, Option<String>)> {
    let table = toml_table(body, "package")?;
    let name = table_value(&table, "name")?;
    let version = table_value(&table, "version");
    Some((name, version))
}

/// A `[workspace.package]` key of the root manifest: the version and licence
/// every crate that says `.workspace = true` inherits.
pub fn workspace_package(body: &str, key: &str) -> Option<String> {
    table_value(&toml_table(body, "workspace.package")?, key)
}

/// A crate's own `[package] license`, when it does not inherit one.
pub fn package_license(body: &str) -> Option<String> {
    table_value(&toml_table(body, "package")?, "license")
}

/// The names in a manifest's `[features]` table, `default` excepted: `default`
/// is which features are on, not a feature of its own.
pub fn feature_names(body: &str) -> Vec<String> {
    let Some(table) = toml_table(body, "features") else {
        return Vec::new();
    };
    table
        .iter()
        .filter_map(|line| {
            let key = line.split_once('=')?.0.trim().trim_matches('"');
            (!key.is_empty() && key != "default" && !key.starts_with('#')).then(|| key.to_string())
        })
        .collect()
}

/// The databases a set of manifests reaches for, named the way a person would.
///
/// A proxy and it undercounts, as the playground warns: a gear that talks to
/// PostgreSQL through a shared crate does not name a driver itself. What it
/// does name, it uses.
pub fn db_engines<'a>(bodies: impl IntoIterator<Item = &'a str>) -> Vec<&'static str> {
    let mut found = BTreeSet::new();
    for body in bodies {
        let lower = body.to_ascii_lowercase();
        if lower.contains("postgres") {
            found.insert(0);
        }
        if lower.contains("sqlite") {
            found.insert(1);
        }
        if lower.contains("mysql") || lower.contains("mariadb") {
            found.insert(2);
        }
        if lower.contains("clickhouse") {
            found.insert(3);
        }
        if lower.contains("timescale") {
            found.insert(4);
        }
    }
    let names = ["PostgreSQL", "SQLite", "MySQL", "ClickHouse", "TimescaleDB"];
    found.into_iter().map(|i| names[i]).collect()
}

/// The lines of one `[table]`, comments and blanks dropped. Enough TOML for
/// the handful of scalar keys read here, without a TOML dependency in a
/// `--locked` build.
fn toml_table(body: &str, name: &str) -> Option<Vec<String>> {
    let header = format!("[{name}]");
    let mut inside = false;
    let mut lines = Vec::new();
    let mut seen = false;
    for raw in body.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            inside = line == header;
            seen |= inside;
            continue;
        }
        if inside && !line.is_empty() && !line.starts_with('#') {
            lines.push(line.to_string());
        }
    }
    seen.then_some(lines)
}

/// `key = "value"` in a table's lines; `None` for `key.workspace = true`.
fn table_value(lines: &[String], key: &str) -> Option<String> {
    lines.iter().find_map(|line| {
        let (k, v) = line.split_once('=')?;
        if k.trim() != key {
            return None;
        }
        let v = v.trim();
        let v = v.split(" #").next().unwrap_or(v).trim();
        v.starts_with('"')
            .then(|| v.trim_matches('"').to_string())
            .filter(|s| !s.is_empty())
    })
}

// ── releases ────────────────────────────────────────────────────────────────

/// A semantic version, compared the way releases are: numbers first, and a
/// pre-release below the release it precedes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Option<String>,
}

impl Version {
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim().trim_start_matches('v');
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, Some(p.to_string())),
            None => (s, None),
        };
        let core = core.split('+').next()?;
        let mut parts = core.split('.');
        let v = Version {
            major: parts.next()?.parse().ok()?,
            minor: parts.next()?.parse().ok()?,
            patch: parts.next()?.parse().ok()?,
            pre,
        };
        parts.next().is_none().then_some(v)
    }
}

impl Ord for Version {
    fn cmp(&self, o: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(o.major, o.minor, o.patch))
            .then_with(|| match (&self.pre, &o.pre) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => a.cmp(b),
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(p) = &self.pre {
            write!(f, "-{p}")?;
        }
        Ok(())
    }
}

/// Release tags (`cf-gears-account-management-v0.7.2`) grouped by crate, each
/// crate's versions newest first.
pub fn tag_index<'a>(tags: impl IntoIterator<Item = &'a str>) -> BTreeMap<String, Vec<Version>> {
    let mut out: BTreeMap<String, Vec<Version>> = BTreeMap::new();
    for tag in tags {
        let Some(at) = tag.rfind("-v") else {
            continue;
        };
        let (name, ver) = (&tag[..at], &tag[at + 2..]);
        if let Some(v) = Version::parse(ver) {
            out.entry(name.to_string()).or_default().push(v);
        }
    }
    for versions in out.values_mut() {
        versions.sort_by(|a, b| b.cmp(a));
    }
    out
}

/// The names a crate has been released under. Gears moved from `cf-<slug>` to
/// `cf-gears-<slug>`, and their older releases still carry the old name.
pub fn release_names(package: &str) -> Vec<String> {
    let mut names = vec![package.to_string()];
    if let Some(rest) = package.strip_prefix("cf-gears-") {
        names.push(format!("cf-{rest}"));
    }
    names
}

/// The newest release of a crate under any of its names.
pub fn latest_release(tags: &BTreeMap<String, Vec<Version>>, package: &str) -> Option<Version> {
    release_names(package)
        .iter()
        .filter_map(|n| tags.get(n)?.first().cloned())
        .max()
}

/// Where a gear is in its life, by the playground's rule, until gears declare
/// it: a 1.0 is mature, a release with an E2E suite is in production, a
/// release without one is in QA, and anything unreleased is in development.
pub fn lifecycle(version: Option<&Version>, released: bool, e2e: bool) -> &'static str {
    match version {
        Some(v) if v.major >= 1 && v.pre.is_none() => "mature",
        _ if released && e2e => "in prod",
        _ if released => "in qa",
        _ => "in development",
    }
}

// ── specifications ──────────────────────────────────────────────────────────

/// What one gear's specification documents add up to.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SpecStats {
    /// Lines across the documents.
    pub lines: usize,
    /// Distinct traceability IDs (`cpt-…`).
    pub ids: BTreeSet<String>,
    /// Requirement markers ticked, and all of them.
    pub ticked: usize,
    pub markers: usize,
}

impl SpecStats {
    /// Fold one document in.
    pub fn add(&mut self, body: &str) {
        self.lines += body.lines().count();
        for line in body.lines() {
            if let Some((done, _)) = marker(line) {
                self.markers += 1;
                if done {
                    self.ticked += 1;
                }
            }
        }
        let bytes = body.as_bytes();
        let mut i = 0;
        while let Some(at) = body[i..].find("cpt-") {
            let start = i + at;
            // A word boundary before it: `xcpt-` is not an ID.
            let bounded = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
            let end = body[start + 4..]
                .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
                .map_or(body.len(), |e| start + 4 + e);
            let id = body[start..end].trim_end_matches('-');
            if bounded && id.len() > 4 {
                self.ids.insert(id.to_string());
            }
            i = end.max(start + 4);
        }
    }
}

/// A requirement marker: ``- [x] `p1` `` → (ticked, priority).
///
/// Only markers that carry a priority count. The spec templates ship plain
/// unticked checklists too, and counting those would measure the template.
fn marker(line: &str) -> Option<(bool, u8)> {
    let rest = line.trim_start().strip_prefix("- [")?;
    let (mark, rest) = rest.split_once(']')?;
    let done = match mark {
        "x" | "X" => true,
        " " => false,
        _ => return None,
    };
    let p = rest.trim_start().strip_prefix("`p")?;
    let (n, _) = p.split_once('`')?;
    Some((done, n.parse().ok()?))
}

/// One release in a repository-wide changelog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangelogEntry {
    pub crate_name: String,
    pub version: String,
    /// `YYYY-MM-DD`, when the heading carries one.
    pub date: Option<String>,
}

/// The releases a release-please changelog records, one per heading:
///
/// `## [0.2.8](…/compare/cf-gears-event-broker-v0.2.7...cf-gears-event-broker-v0.2.8) - 2026-09-23`
///
/// gears-rust keeps one changelog for every crate, so the crate is read off
/// the heading's compare link -- the tag it ends at -- rather than assumed.
pub fn changelog_releases(body: &str) -> Vec<ChangelogEntry> {
    body.lines()
        .filter_map(|l| {
            let heading = l.strip_prefix("## ")?;
            let link = heading.split_once("](")?.1;
            let target = link.split(')').next()?;
            let tag = target.rsplit("...").next()?.rsplit('/').next()?;
            let at = tag.rfind("-v")?;
            let version = Version::parse(&tag[at + 2..])?;
            let date = heading
                .rsplit_once(") - ")
                .map(|(_, d)| d.trim().chars().take(10).collect::<String>())
                .filter(|d| d.len() == 10);
            Some(ChangelogEntry {
                crate_name: tag[..at].to_string(),
                version: version.to_string(),
                date,
            })
        })
        .collect()
}

// ── code ────────────────────────────────────────────────────────────────────

/// What a gear's Rust sources add up to. Read from a local checkout only:
/// thousands of files are a walk on disk and an afternoon over the API.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CodeStats {
    /// Lines of production code.
    pub code: usize,
    /// Lines in unit-test modules (`*_tests.rs`).
    pub unit: usize,
    /// Lines in integration tests (`tests/`).
    pub integration: usize,
    /// Whether the code serves a readiness or liveness probe.
    pub health: bool,
    /// GTS types the code names (`gts::Something`).
    pub gts_types: BTreeSet<String>,
}

impl CodeStats {
    /// Fold one source file in, by its path relative to the gear.
    pub fn add(&mut self, rel: &str, body: &str) {
        if !rel.ends_with(".rs") {
            return;
        }
        let lines = body.lines().count();
        if rel.ends_with("_tests.rs") {
            self.unit += lines;
        } else if rel.starts_with("tests/") || rel.contains("/tests/") {
            self.integration += lines;
        } else {
            self.code += lines;
        }
        if body.contains("readyz") || body.contains("healthz") {
            self.health = true;
        }
        let mut rest = body;
        while let Some(at) = rest.find("gts::") {
            let tail = &rest[at + 5..];
            let ident: String = tail
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if ident.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
                self.gts_types.insert(ident);
            }
            rest = tail;
        }
    }
}

/// Lines of code per line of specification, as the page prints it: `1 : 5.3`.
pub fn spec_to_code(spec: usize, code: usize) -> Option<String> {
    (spec > 0 && code > 0).then(|| format!("1 : {:.1}", code as f64 / spec as f64))
}

// ── history ─────────────────────────────────────────────────────────────────

/// One commit, as far as authorship and sign-off go.
#[derive(Debug, Clone)]
pub struct CommitFacts {
    pub author: String,
    pub message: String,
}

/// Whether a commit is a bot's. Release bots sign nothing and write most
/// commits in a busy directory, so leaving them in would make every gear look
/// unsigned and every gear's expert a robot.
pub fn is_bot(author: &str) -> bool {
    let a = author.to_ascii_lowercase();
    a.ends_with("[bot]") || a.ends_with("-bot") || a == "github-actions" || a.contains("dependabot")
}

/// The people who wrote most of a gear, most commits first, at most `n`.
pub fn experts(commits: &[CommitFacts], n: usize) -> Vec<String> {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for c in commits.iter().filter(|c| !is_bot(&c.author)) {
        *counts.entry(c.author.as_str()).or_default() += 1;
    }
    let mut ranked: Vec<(&str, usize)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    ranked
        .into_iter()
        .take(n)
        .map(|(a, _)| a.to_string())
        .collect()
}

/// Human commits carrying a `Signed-off-by:` trailer, and human commits.
pub fn sign_off(commits: &[CommitFacts]) -> (usize, usize) {
    let human: Vec<&CommitFacts> = commits.iter().filter(|c| !is_bot(&c.author)).collect();
    let signed = human
        .iter()
        .filter(|c| {
            c.message
                .lines()
                .any(|l| l.trim_start().starts_with("Signed-off-by:"))
        })
        .count();
    (signed, human.len())
}

#[cfg(test)]
#[path = "repo_facts_tests.rs"]
mod tests;
