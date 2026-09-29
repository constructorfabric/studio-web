//! Roadmap enrichment — what a gear's *plan* says, next to what its code says.
//!
//! The repository scan answers "what is there": documents, tests, tags. It
//! cannot answer the three questions a person deciding whether to wait for a
//! gear actually asks — **what stage is it at, when will it be ready, and who
//! is waiting for it**. Those live in a GitHub Project (v2) board that the
//! platform team plans the gears on, one item per gear, with a stage column, a
//! milestone that carries a due date, per-axis progress and a per-consumer
//! priority.
//!
//! This module reads such a board through the same GitHub connection the
//! repository scan uses and writes what it finds into each gear's profile, in
//! the `{ v, b, n, s, l, u }` shape every other field has.
//!
//! ── Nothing about one board is compiled in ───────────────────────────────────
//!
//! Which board, and what its consumer letters stand for, is the sync source's
//! data ([`RoadmapSource`]). What the columns *mean* is read off the board:
//!
//! * the **stage** is the single-select field named `Status` (GitHub's own
//!   default), and its option order is the pipeline — the last option is done;
//! * a **progress axis** is any single-select whose options are percentages
//!   (`10%` … `90%`, `Done`), labelled by the field's name;
//! * the **priority** is a field whose name ends in dotted letters, like
//!   `Prio (A.C.V.Ag)`, holding values like `2 (1.3.3)` — overall 2, then one
//!   number per letter in order;
//! * the **ETA** is the item's milestone due date.
//!
//! A board that lays its columns out differently names them in
//! [`RoadmapFields`] instead.
//!
//! ── Matching an item to a gear ───────────────────────────────────────────────
//!
//! Board items are titled for people (`CORE - Events Broker`), gears are named
//! by directory (`event-broker`). The match is by words and is deliberately
//! strict: every word of the gear's name must appear in the title, and an item
//! is only taken when it is the single best candidate for that gear. A tie is
//! left unmatched rather than guessed — two serverless runtimes claiming one
//! gear is a question for a person, and a person answers it by setting the
//! gear's `roadmap_item` field, which always wins.

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::connectors::driver::ConnectionAuth;
use crate::connectors::github::graphql_url;
use crate::connectors::service::ConnectorService;

const UA: &str = "constructor-studio-gears-catalog";

/// Items per GraphQL page — GitHub's maximum.
const PAGE: u32 = 100;
/// Pages read before giving up on a board. Two thousand items is far past any
/// roadmap a person reads; a board that large is a backlog, not a plan.
const MAX_PAGES: usize = 20;

/// Every profile field this module writes. A roadmap-only sync clears these
/// before writing, so a gear that stopped matching stops claiming a plan.
pub const ROADMAP_KEYS: [&str; 9] = [
    "stage",
    "milestone",
    "commitment",
    "roadmap_progress",
    "demand",
    "convergence",
    "roadmap_owner",
    "effort",
    "roadmap_item",
];

/// A roadmap board a sync reads. Half of a `catalog.sync` run's payload, so it
/// round-trips through the queue.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RoadmapSource {
    /// Tenant that owns the GitHub connection.
    pub tenant: Uuid,
    /// Connection to use; the tenant's first GitHub connection when absent.
    #[serde(default)]
    pub connection_id: Option<Uuid>,
    /// Organization or user login that owns the board.
    pub owner: String,
    /// The board's number, as in `/orgs/<owner>/projects/<number>`.
    pub number: u32,
    /// What each priority letter stands for (`"A" → "Acronis"`). A letter with
    /// no entry is shown as the letter.
    #[serde(default)]
    pub consumers: BTreeMap<String, String>,
    /// Column names, for a board that does not use the defaults.
    #[serde(default)]
    pub fields: RoadmapFields,
}

/// Which of a board's columns answer which question. Every one optional: the
/// defaults read a board laid out the way GitHub lays one out.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RoadmapFields {
    /// Single-select holding the stage. Default `Status`.
    #[serde(default)]
    pub stage: Option<String>,
    /// Single-select saying whether the date is a commitment. Default `Commitment`.
    #[serde(default)]
    pub commitment: Option<String>,
    /// The per-consumer priority. Default: the field whose name ends in
    /// dotted letters, e.g. `Prio (A.C.V.Ag)`.
    #[serde(default)]
    pub priority: Option<String>,
    /// Effort estimate. Default: a field with `effort` in its name.
    #[serde(default)]
    pub effort: Option<String>,
}

impl RoadmapFields {
    fn stage(&self) -> &str {
        self.stage.as_deref().unwrap_or("Status")
    }
    fn commitment(&self) -> &str {
        self.commitment.as_deref().unwrap_or("Commitment")
    }
}

/// A board, read.
#[derive(Clone, Debug, Default)]
pub struct Roadmap {
    pub title: String,
    pub url: String,
    /// Single-select fields and their options, in board order.
    pub selects: BTreeMap<String, Vec<String>>,
    /// The single-selects in the board's own column order, which is the order
    /// the progress axes are read in (`Design`, `SDK`, `Implementation`).
    pub select_order: Vec<String>,
    pub items: Vec<RoadmapItem>,
}

/// One board item.
#[derive(Clone, Debug, Default)]
pub struct RoadmapItem {
    pub title: String,
    pub url: Option<String>,
    /// Issue or pull request number; `None` for a draft.
    pub number: Option<u64>,
    pub closed: bool,
    pub assignees: Vec<String>,
    pub milestone: Option<Milestone>,
    /// Field name → value, for every field the item has a value in.
    pub fields: BTreeMap<String, FieldValue>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Milestone {
    pub title: String,
    /// `YYYY-MM-DD`, or `None` for an undated milestone such as `Backlog`.
    pub due: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum FieldValue {
    Text(String),
    Number(f64),
    Date(String),
}

impl FieldValue {
    fn text(&self) -> String {
        match self {
            FieldValue::Text(s) | FieldValue::Date(s) => s.clone(),
            FieldValue::Number(n) if n.fract() == 0.0 => format!("{n:.0}"),
            FieldValue::Number(n) => n.to_string(),
        }
    }
}

// ── reading a board ─────────────────────────────────────────────────────────

const ITEMS_FRAGMENT: &str = r"
projectV2(number:$number){
  title url
  fields(first:50){nodes{... on ProjectV2SingleSelectField{name options{name}}}}
  items(first:$page,after:$after){
    pageInfo{hasNextPage endCursor}
    nodes{
      isArchived
      content{
        __typename
        ... on Issue{number title url state assignees(first:10){nodes{login}} milestone{title dueOn}}
        ... on PullRequest{number title url state assignees(first:10){nodes{login}} milestone{title dueOn}}
        ... on DraftIssue{title assignees(first:10){nodes{login}}}
      }
      fieldValues(first:50){nodes{
        __typename
        ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}}
        ... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2FieldCommon{name}}}
        ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}}
        ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{name}}}
        ... on ProjectV2ItemFieldIterationValue{title field{... on ProjectV2FieldCommon{name}}}
      }}
    }
  }
}";

/// Resolve the GitHub connection a source names, or the tenant's first one.
async fn resolve_auth(
    connectors: &ConnectorService,
    ctx: &SecurityContext,
    tenant: Uuid,
    connection_id: Option<Uuid>,
) -> Result<ConnectionAuth> {
    let id = match connection_id {
        Some(id) => id,
        None => {
            connectors
                .list(ctx, tenant)
                .await?
                .into_iter()
                .find(|c| c.provider == "github")
                .context("no GitHub connection in the roadmap's tenant")?
                .id
        }
    };
    let (_driver, auth, _conn) = connectors.driver_and_auth(ctx, tenant, id).await?;
    Ok(auth)
}

/// Read a whole board.
///
/// The owner may be an organization or a user, and GraphQL has no field that
/// answers for both, so the organization is asked first and the user second.
pub async fn fetch(
    connectors: Arc<ConnectorService>,
    ctx: &SecurityContext,
    source: &RoadmapSource,
) -> Result<Roadmap> {
    let auth = resolve_auth(&connectors, ctx, source.tenant, source.connection_id).await?;
    let http = Client::builder().user_agent(UA).build()?;
    let url = graphql_url(auth.root());
    for owner_kind in ["organization", "user"] {
        if let Some(board) = fetch_as(&http, &url, &auth, owner_kind, source).await? {
            return Ok(board);
        }
    }
    Err(anyhow!(
        "project {}/{} is not visible to this connection (it needs the read:project scope)",
        source.owner,
        source.number
    ))
}

async fn fetch_as(
    http: &Client,
    url: &str,
    auth: &ConnectionAuth,
    owner_kind: &str,
    source: &RoadmapSource,
) -> Result<Option<Roadmap>> {
    let query = format!(
        "query($owner:String!,$number:Int!,$page:Int!,$after:String){{ owner:{owner_kind}(login:$owner){{ {ITEMS_FRAGMENT} }} }}"
    );
    let mut board = Roadmap::default();
    let mut after: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let body = json!({
            "query": query,
            "variables": {
                "owner": source.owner, "number": source.number, "page": PAGE, "after": after,
            },
        });
        let res = http
            .post(url)
            .bearer_auth(&auth.token)
            .header("Accept", "application/vnd.github+json")
            .json(&body)
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "GitHub GraphQL {status}: {}",
                text.chars().take(200).collect::<String>()
            );
        }
        let reply: Value = res.json().await?;
        // An owner of the other kind answers `owner: null` with a NOT_FOUND
        // error; that is "ask the other way", not a failure.
        let project = reply.pointer("/data/owner/projectV2");
        let Some(project) = project.filter(|p| !p.is_null()) else {
            if after.is_none() {
                return Ok(None);
            }
            break;
        };
        let next = read_page(project, &mut board);
        match next {
            Some(cursor) => after = Some(cursor),
            None => return Ok(Some(board)),
        }
    }
    Ok(Some(board))
}

/// Fold one GraphQL page of `projectV2` into `board`; the next cursor, if any.
fn read_page(project: &Value, board: &mut Roadmap) -> Option<String> {
    let s = |v: &Value, p: &str| v.pointer(p).and_then(Value::as_str).map(str::to_string);
    if board.title.is_empty() {
        board.title = s(project, "/title").unwrap_or_default();
        board.url = s(project, "/url").unwrap_or_default();
        for f in array(project, "/fields/nodes") {
            let (Some(name), Some(options)) =
                (s(f, "/name"), f.get("options").and_then(Value::as_array))
            else {
                continue;
            };
            let options = options
                .iter()
                .filter_map(|o| o.get("name").and_then(Value::as_str).map(str::to_string))
                .collect();
            board.select_order.push(name.clone());
            board.selects.insert(name, options);
        }
    }
    for node in array(project, "/items/nodes") {
        if node.get("isArchived").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let content = node.get("content").unwrap_or(&Value::Null);
        let mut item = RoadmapItem {
            title: s(content, "/title").unwrap_or_default(),
            url: s(content, "/url"),
            number: content.get("number").and_then(Value::as_u64),
            closed: matches!(
                content.get("state").and_then(Value::as_str),
                Some("CLOSED" | "MERGED")
            ),
            assignees: array(content, "/assignees/nodes")
                .iter()
                .filter_map(|a| s(a, "/login"))
                .collect(),
            milestone: content
                .get("milestone")
                .filter(|m| !m.is_null())
                .map(|m| Milestone {
                    title: s(m, "/title").unwrap_or_default(),
                    due: s(m, "/dueOn")
                        .filter(|d| !d.is_empty())
                        .map(|d| d.chars().take(10).collect()),
                }),
            fields: BTreeMap::new(),
        };
        for fv in array(node, "/fieldValues/nodes") {
            let Some(field) = s(fv, "/field/name") else {
                continue;
            };
            let value = match fv.get("__typename").and_then(Value::as_str) {
                Some("ProjectV2ItemFieldSingleSelectValue") => s(fv, "/name").map(FieldValue::Text),
                Some("ProjectV2ItemFieldTextValue") => s(fv, "/text").map(FieldValue::Text),
                Some("ProjectV2ItemFieldIterationValue") => s(fv, "/title").map(FieldValue::Text),
                Some("ProjectV2ItemFieldNumberValue") => fv
                    .get("number")
                    .and_then(Value::as_f64)
                    .map(FieldValue::Number),
                Some("ProjectV2ItemFieldDateValue") => s(fv, "/date").map(FieldValue::Date),
                _ => None,
            };
            if let Some(value) = value {
                item.fields.insert(field, value);
            }
        }
        board.items.push(item);
    }
    let more = project
        .pointer("/items/pageInfo/hasNextPage")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if more {
        s(project, "/items/pageInfo/endCursor")
    } else {
        None
    }
}

fn array<'a>(v: &'a Value, pointer: &str) -> &'a [Value] {
    v.pointer(pointer)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

// ── matching items to gears ─────────────────────────────────────────────────

/// Words that say nothing about which gear an item is.
const STOPWORDS: [&str; 10] = [
    "a", "an", "and", "for", "of", "the", "with", "module", "gear", "gears",
];

/// The words of a board item's title: the `DOMAIN - ` prefix and every
/// parenthetical dropped (`(p1)`, `(simple chat for Azure/OpenAI)`), plurals
/// folded, stopwords removed.
fn title_words(title: &str) -> Vec<String> {
    let body = match title.split_once(" - ") {
        Some((prefix, rest))
            if !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_uppercase()) =>
        {
            rest
        }
        _ => title,
    };
    let mut plain = String::new();
    let mut depth = 0usize;
    for c in body.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => plain.push(c),
            _ => {}
        }
    }
    words(&plain)
}

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| singular(&w.to_ascii_lowercase()))
        .filter(|w| !STOPWORDS.contains(&w.as_str()))
        .collect()
}

fn singular(w: &str) -> String {
    match w.strip_suffix('s') {
        Some(stem) if stem.len() >= 3 && !stem.ends_with('s') => stem.to_string(),
        _ => w.to_string(),
    }
}

/// Whether two words name the same thing: equal, one a prefix of the other
/// (`auth`/`authn`, `timescale`/`timescaledb`), or sharing a long stem
/// (`enforcer`/`enforcement`).
fn same_word(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    if short.len() >= 4 && long.starts_with(short) {
        return true;
    }
    let common = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
    common >= 6
}

/// Below this a title merely mentions a gear: `CORE - Data Fabric Connectors
/// Orchestrator` shares one word of four with `gear-orchestrator`.
const MIN_SCORE: f64 = 0.5;

/// How well an item title names a gear: 0 when some word of the gear's name is
/// missing from the title, else the share of the title's words it accounts for.
///
/// Two refinements, both from reading the real board: a gear named in two
/// words may be titled as one (`mini-chat` / `MiniChat`), and a plugin is not
/// its host — `CredStore Plugin for Vault` is not `credstore`.
fn score(gear_words: &[String], title_words: &[String]) -> f64 {
    if gear_words.is_empty() || title_words.is_empty() {
        return 0.0;
    }
    let joined = gear_words.concat();
    let joined_form = [joined];
    let gear_words: &[String] = if gear_words.len() > 1 && title_words.contains(&joined_form[0]) {
        &joined_form
    } else {
        gear_words
    };
    let plugin = |ws: &[String]| ws.iter().any(|w| w == "plugin");
    if plugin(gear_words) != plugin(title_words) {
        return 0.0;
    }
    if !gear_words
        .iter()
        .all(|g| title_words.iter().any(|t| same_word(g, t)))
    {
        return 0.0;
    }
    let covered = title_words
        .iter()
        .filter(|t| gear_words.iter().any(|g| same_word(g, t)))
        .count();
    let share = covered as f64 / title_words.len().max(gear_words.len()) as f64;
    if share < MIN_SCORE { 0.0 } else { share }
}

/// How an item came to be a gear's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchedBy {
    Title,
    Hand,
}

/// The issue number a hand-set `roadmap_item` names: a URL ending in the
/// number, or `#123`, or the bare number.
pub fn pinned_number(v: &str) -> Option<u64> {
    let tail = v
        .trim()
        .trim_end_matches('/')
        .rsplit(['/', '#', ' '])
        .next()?;
    tail.parse().ok()
}

/// Pick each gear's item. `gears` is `(gear name, words of its name, pinned
/// issue number)`; the answer maps a gear name to an item index.
///
/// A pinned number always wins. Otherwise an item goes to a gear only when the
/// gear is that item's best candidate and the item is the gear's single best —
/// a tie on either side is left for a person.
pub fn match_items(
    gears: &[(String, Vec<String>, Option<u64>)],
    items: &[RoadmapItem],
) -> BTreeMap<String, (usize, MatchedBy)> {
    let mut out = BTreeMap::new();
    // An item a person pinned to one gear is not up for matching to another.
    let pinned_items: Vec<u64> = gears.iter().filter_map(|(_, _, p)| *p).collect();
    let item_words: Vec<Vec<String>> = items
        .iter()
        .map(|i| match i.number {
            Some(n) if pinned_items.contains(&n) => Vec::new(),
            _ => title_words(&i.title),
        })
        .collect();
    for (name, words, pinned) in gears {
        if let Some(n) = pinned {
            if let Some(ix) = items.iter().position(|i| i.number == Some(*n)) {
                out.insert(name.clone(), (ix, MatchedBy::Hand));
            }
            continue;
        }
        let scored: Vec<(usize, f64)> = item_words
            .iter()
            .enumerate()
            .map(|(ix, tw)| (ix, score(words, tw)))
            .filter(|(_, s)| *s > 0.0)
            .collect();
        let Some(best) = scored.iter().map(|(_, s)| *s).reduce(f64::max) else {
            continue;
        };
        let top: Vec<usize> = scored
            .iter()
            .filter(|(_, s)| (*s - best).abs() < 1e-9)
            .map(|(ix, _)| *ix)
            .collect();
        let [ix] = top.as_slice() else {
            continue;
        };
        // The item must not name another gear as well or better:
        // `Auth Resolver` fits `authn-resolver` and `authz-resolver` equally.
        let rival = gears.iter().any(|(other, ow, pin)| {
            other != name && pin.is_none() && score(ow, &item_words[*ix]) >= best - 1e-9
        });
        if !rival {
            out.insert(name.clone(), (*ix, MatchedBy::Title));
        }
    }
    out
}

/// The words of a gear's name, from its crate name (`cf-gears-event-broker`).
pub fn gear_words(crate_name: &str) -> Vec<String> {
    words(crate_name.strip_prefix("cf-gears-").unwrap_or(crate_name))
}

// ── what an item says about its gear ────────────────────────────────────────

/// A percentage axis: `Todo` = 0, `10%` … `90%`, `Done` = 100, `N/A` = none.
fn percent(value: &str) -> Option<u8> {
    let v = value.trim();
    if v.eq_ignore_ascii_case("done") {
        return Some(100);
    }
    if v.eq_ignore_ascii_case("todo") {
        return Some(0);
    }
    v.strip_suffix('%')?.trim().parse().ok()
}

/// A single-select whose options are percentages is a progress axis.
fn is_percent_axis(options: &[String]) -> bool {
    options.iter().filter(|o| o.ends_with('%')).count() >= 3
}

/// The letters a priority field's name ends in: `Prio (A.C.V.Ag)` → A, C, V, Ag.
fn priority_letters(field: &str) -> Option<Vec<String>> {
    let inner = field.trim().strip_suffix(')')?.rsplit_once('(')?.1;
    let letters: Vec<String> = inner.split('.').map(|l| l.trim().to_string()).collect();
    (letters.len() >= 2
        && letters
            .iter()
            .all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphabetic())))
    .then_some(letters)
}

/// `2 (1.3.3)` → overall 2, then one priority per letter in order.
fn parse_priority(value: &str) -> Option<(u8, Vec<u8>)> {
    let (overall, rest) = match value.split_once('(') {
        Some((o, r)) => (o, Some(r.trim_end_matches(')'))),
        None => (value, None),
    };
    let overall = overall.trim().trim_start_matches(['P', 'p']).parse().ok()?;
    let per = rest
        .map(|r| r.split('.').filter_map(|n| n.trim().parse().ok()).collect())
        .unwrap_or_default();
    Some((overall, per))
}

/// Whether a commitment value commits: anything but a negation.
fn commits(value: &str) -> bool {
    let v = value.trim().to_ascii_lowercase();
    !(v.is_empty() || v == "no" || v == "false" || v.starts_with("not") || v.starts_with("no "))
}

/// The profile fields one board item contributes to its gear, as of `today`
/// (`YYYY-MM-DD`).
pub fn item_fields(
    board: &Roadmap,
    item: &RoadmapItem,
    matched: MatchedBy,
    source: &RoadmapSource,
    today: &str,
) -> Map<String, Value> {
    let mut f = Map::new();
    let link = item.url.as_deref();

    // stage
    let stage_field = source.fields.stage();
    let stage_options = board.selects.get(stage_field);
    let stage = item.fields.get(stage_field).map(FieldValue::text);
    let stage_pos = stage.as_ref().and_then(|s| {
        let options = stage_options?;
        Some((options.iter().position(|o| o == s)?, options.len()))
    });
    let last_stage = matches!(stage_pos, Some((ix, n)) if ix + 1 == n);
    // A closed issue is taken as shipped -- people close the issue, and forget
    // the column. The disagreement is still worth saying, below.
    let done = item.closed || last_stage;
    if let Some(s) = &stage {
        let mut v = answer(s, link);
        if let Some((ix, n)) = stage_pos {
            v.insert("v".into(), json!(format!("{s} ({} of {n})", ix + 1)));
            v.insert("n".into(), json!(ix + 1));
        }
        f.insert("stage".into(), Value::Object(v));
    }

    // milestone / ETA
    let due = item.milestone.as_ref().and_then(|m| m.due.clone());
    let overdue = !done && due.as_deref().is_some_and(|d| d < today);
    if let Some(m) = &item.milestone {
        let mut v = answer(&m.title, link);
        match &m.due {
            Some(d) => {
                v.insert("v".into(), json!(format!("{} — due {d}", m.title)));
                v.insert("u".into(), json!(d));
                v.insert("s".into(), json!(if overdue { "bad" } else { "good" }));
            }
            None => {
                v.insert("v".into(), json!(format!("{} — no date", m.title)));
                v.insert("s".into(), json!("watch"));
            }
        }
        f.insert("milestone".into(), Value::Object(v));
    }

    // commitment
    let committed = item
        .fields
        .get(source.fields.commitment())
        .map(|v| commits(&v.text()));
    if let Some(c) = committed {
        f.insert(
            "commitment".into(),
            Value::Object(answer(if c { "committed" } else { "not committed" }, None)),
        );
    }

    // progress axes
    let axes: Vec<(String, String, Option<u8>)> = board
        .select_order
        .iter()
        .filter_map(|name| Some((name, board.selects.get(name)?)))
        .filter(|(_, options)| is_percent_axis(options))
        .filter_map(|(name, _)| {
            let v = item.fields.get(name)?.text();
            let pct = percent(&v);
            Some((name.clone(), v, pct))
        })
        .collect();
    if !axes.is_empty() {
        let brief = axes
            .iter()
            .map(|(name, v, _)| format!("{name} {v}"))
            .collect::<Vec<_>>()
            .join(" · ");
        let mut v = answer(&brief, link);
        v.insert(
            "parts".into(),
            Value::Array(
                axes.iter()
                    .map(|(name, v, pct)| json!({ "label": name, "value": v, "pct": pct }))
                    .collect(),
            ),
        );
        f.insert("roadmap_progress".into(), Value::Object(v));
    }

    // demand: who wants it and how badly
    let priority_field = source.fields.priority.clone().or_else(|| {
        item.fields
            .keys()
            .chain(board.selects.keys())
            .find(|k| priority_letters(k).is_some())
            .cloned()
    });
    let mut urgent: Vec<String> = Vec::new();
    if let Some(field) = &priority_field
        && let Some(raw) = item.fields.get(field).map(FieldValue::text)
        && let Some((overall, per)) = parse_priority(&raw)
    {
        let letters = priority_letters(field).unwrap_or_default();
        let parts: Vec<Value> = letters
            .iter()
            .zip(per.iter())
            .map(|(letter, p)| {
                let consumer = source
                    .consumers
                    .get(letter)
                    .cloned()
                    .unwrap_or_else(|| letter.clone());
                if *p == 1 {
                    urgent.push(consumer.clone());
                }
                json!({ "letter": letter, "consumer": consumer, "priority": p })
            })
            .collect();
        let brief = if parts.is_empty() {
            format!("P{overall}")
        } else {
            parts
                .iter()
                .map(|p| {
                    format!(
                        "{} P{}",
                        p["consumer"].as_str().unwrap_or(""),
                        p["priority"]
                    )
                })
                .collect::<Vec<_>>()
                .join(" · ")
        };
        let mut v = answer(&brief, None);
        v.insert("v".into(), json!(format!("overall P{overall}: {brief}")));
        v.insert("n".into(), json!(overall));
        v.insert("parts".into(), Value::Array(parts));
        f.insert("demand".into(), Value::Object(v));
    }

    // convergence: does the plan meet the demand?
    let mut bad: Vec<String> = Vec::new();
    let mut watch: Vec<String> = Vec::new();
    if overdue {
        bad.push(format!(
            "overdue: due {} and still {}",
            due.as_deref().unwrap_or("?"),
            stage.as_deref().unwrap_or("open")
        ));
    }
    if item.closed
        && !last_stage
        && let Some(s) = &stage
    {
        watch.push(format!("the issue is closed but the board still says {s}"));
    }
    if !done && !urgent.is_empty() {
        let who = urgent.join(", ");
        if due.is_none() {
            bad.push(format!("P1 for {who}, but no dated milestone"));
        } else if committed == Some(false) {
            watch.push(format!("P1 for {who}, but the date is not a commitment"));
        }
    }
    let known: Vec<u8> = axes.iter().filter_map(|(_, _, p)| *p).collect();
    if let (Some((ix, n)), false) = (stage_pos, known.is_empty()) {
        let max = known.iter().copied().max().unwrap_or(0);
        let min = known.iter().copied().min().unwrap_or(0);
        if ix == 0 && max >= 50 {
            watch.push(format!(
                "status says {} while progress reaches {max}%",
                stage.as_deref().unwrap_or("?")
            ));
        } else if n > 1 && ix * 10 >= (n - 1) * 6 && min == 0 && !done {
            watch.push(format!(
                "status says {} while an axis has not started",
                stage.as_deref().unwrap_or("?")
            ));
        }
    }
    let (brief, lamp, reasons) = if !bad.is_empty() {
        ("at risk", "bad", [bad, watch].concat())
    } else if !watch.is_empty() {
        ("check", "watch", watch)
    } else if done {
        ("delivered", "good", Vec::new())
    } else if due.is_some() {
        ("on track", "good", Vec::new())
    } else {
        ("unplanned", "none", Vec::new())
    };
    let mut v = answer(brief, None);
    v.insert("s".into(), json!(lamp));
    if !reasons.is_empty() {
        v.insert("v".into(), json!(reasons.join("; ")));
    }
    f.insert("convergence".into(), Value::Object(v));

    // owner(s) on the board
    if !item.assignees.is_empty() {
        let who = item
            .assignees
            .iter()
            .map(|a| format!("@{a}"))
            .collect::<Vec<_>>()
            .join(", ");
        let first = format!("https://github.com/{}", item.assignees[0]);
        f.insert(
            "roadmap_owner".into(),
            Value::Object(answer(&who, Some(&first))),
        );
    }

    // effort
    let effort_field = source.fields.effort.clone().or_else(|| {
        item.fields
            .keys()
            .find(|k| k.to_ascii_lowercase().contains("effort"))
            .cloned()
    });
    if let Some(e) = effort_field.and_then(|k| item.fields.get(&k).map(FieldValue::text)) {
        f.insert("effort".into(), Value::Object(answer(&e, None)));
    }

    // the item itself, and how it was picked
    let label = match item.number {
        Some(n) => format!("#{n} {}", item.title),
        None => item.title.clone(),
    };
    let mut v = answer(&label, link);
    let how = match matched {
        MatchedBy::Title => "matched by title",
        MatchedBy::Hand => "set by hand",
    };
    v.insert(
        "v".into(),
        json!(format!("{label} — on \"{}\", {how}", board.title)),
    );
    f.insert("roadmap_item".into(), Value::Object(v));

    f
}

/// Hold the board's last stage against what the repository shows.
///
/// A board that says a gear is shipped while the repository has no release
/// of it -- the rule's lifecycle still before QA -- is a plan that has run
/// ahead of the code, and the convergence field says so. The lifecycle is the
/// repository scan's (`lifecycle`), so this runs where both are known.
pub fn check_release(f: &mut Map<String, Value>, repo_lifecycle: Option<&str>) {
    let Some(lifecycle) = repo_lifecycle else {
        return;
    };
    if !matches!(
        lifecycle,
        "in development" | "in design" | "in requirements"
    ) {
        return;
    }
    let final_stage = f
        .get("stage")
        .and_then(|s| s.get("v"))
        .and_then(Value::as_str)
        .and_then(|v| {
            let (_, tail) = v.rsplit_once('(')?;
            let (at, of) = tail.trim_end_matches(')').split_once(" of ")?;
            Some(at.trim() == of.trim())
        })
        .unwrap_or(false);
    if !final_stage {
        return;
    }
    let stage = f
        .get("stage")
        .and_then(|s| s.get("b"))
        .and_then(Value::as_str)
        .unwrap_or("done")
        .to_string();
    let reason = format!("the board says {stage}, but the repository shows it {lifecycle}");
    let Some(Value::Object(conv)) = f.get_mut("convergence") else {
        return;
    };
    let was_good = matches!(conv.get("s").and_then(Value::as_str), Some("good" | "none"));
    let why = match conv.get("v").and_then(Value::as_str) {
        Some(v) if !was_good => format!("{v}; {reason}"),
        _ => reason,
    };
    conv.insert("v".into(), json!(why));
    if was_good {
        conv.insert("s".into(), json!("watch"));
        conv.insert("b".into(), json!("check"));
    }
}

fn answer(brief: &str, link: Option<&str>) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("v".into(), json!(brief));
    m.insert("b".into(), json!(brief));
    if let Some(l) = link {
        m.insert("l".into(), json!(l));
    }
    m
}

#[cfg(test)]
#[path = "roadmap_tests.rs"]
mod tests;
