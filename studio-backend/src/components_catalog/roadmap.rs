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
//! * the **ETA** is the item's milestone due date;
//! * the **effort** is a field with `effort` in its name, on the board or on
//!   the issue itself: GitHub's issue fields (`Estimated Efforts m*d`) are
//!   where the platform team keeps it, not the board.
//!
//! ── Which items are gears ────────────────────────────────────────────────────
//!
//! A board holds more than gears. When the source names root issues
//! ([`RoadmapSource::roots`]), a gear is a direct sub-issue of one of them --
//! the platform team's own rule -- including a sub-issue nobody has put on the
//! board yet, which is read from the root. Without roots, every item is one.
//! Each gear is stored as a `roadmap_item` node whether or not a component
//! matches it: a gear nobody has written yet is exactly what a plan is for.
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

use anyhow::{Result, anyhow};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::connectors::sdk::ConnectionAuth;
use crate::connectors::sdk::ConnectorService;
use crate::connectors::sdk::graphql_url;

const UA: &str = "constructor-studio-gears-catalog";

/// Items per GraphQL page — GitHub's maximum.
const PAGE: u32 = 100;
/// Pages read before giving up on a board. Two thousand items is far past any
/// roadmap a person reads; a board that large is a backlog, not a plan.
const MAX_PAGES: usize = 20;

/// Every profile field this module writes. A roadmap-only sync clears these
/// before writing, so a gear that stopped matching stops claiming a plan.
pub const ROADMAP_KEYS: [&str; 10] = [
    "stage",
    "milestone",
    "commitment",
    "roadmap_progress",
    "demand",
    "convergence",
    "roadmap_owner",
    "effort",
    "roadmap_item",
    "roadmap_board",
];

/// The board a gear's plan fields were read from, as a profile field:
/// `b` the board's title, `v` `owner/projects/<number>`, `l` its page.
///
/// It is the only record of which boards filled the catalogue, and it sits
/// where the plan fields themselves sit, so the two cannot disagree: a gear
/// that stops matching a board loses both in the same sync (it is one of
/// [`ROADMAP_KEYS`]). The Components page names the boards in its Sources
/// label from this field, beside the repositories `synced_from` names.
pub fn board_field(board: &Roadmap, source: &RoadmapSource) -> Value {
    let id = format!("{}/projects/{}", source.owner, source.number);
    let title = if board.title.trim().is_empty() {
        id.clone()
    } else {
        board.title.trim().to_string()
    };
    let mut out = json!({ "b": title, "v": id });
    if !board.url.is_empty() {
        out["l"] = Value::String(board.url.clone());
    }
    out
}

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
    /// The issues whose direct sub-issues are the gears: `owner/repo#123`, or
    /// `123` for an issue that is itself on the board. Empty: every item is a
    /// gear.
    #[serde(default)]
    pub roots: Vec<String>,
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
    /// Field name → value, for every field the item has a value in: the
    /// board's, then the issue's own fields where the board has none.
    pub fields: BTreeMap<String, FieldValue>,
    /// The parent issue's number, for a sub-issue.
    pub parent: Option<u64>,
    /// Read from a root's sub-issues rather than from the board.
    pub off_board: bool,
    /// The issue's type (`Feature`).
    pub kind: Option<String>,
    /// The `**Name**: value` lines of the issue body the planning team keeps
    /// a gear's card in (`Description`, `Is Plugin`, …), by field.
    pub card: BTreeMap<String, String>,
    /// The issues this one is blocked by.
    pub blocked_by: Vec<u64>,
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
    pub fn text(&self) -> String {
        match self {
            FieldValue::Text(s) | FieldValue::Date(s) => s.clone(),
            FieldValue::Number(n) if n.fract() == 0.0 => format!("{n:.0}"),
            FieldValue::Number(n) => n.to_string(),
        }
    }
}

// ── reading a board ─────────────────────────────────────────────────────────

/// What is read of an issue, on the board and under a root alike.
const ISSUE_CONTENT: &str = "number title url state body assignees(first:10){nodes{login}} milestone{title dueOn} parent{number}";

/// The issue's own fields -- GitHub's issue fields, where the platform team
/// keeps the effort estimate -- with its type and what blocks it, the other
/// two things only a recent host answers. Asked separately so a host without
/// them (an older GitHub Enterprise) still answers the rest.
const ISSUE_FIELDS: &str = "issueType{name} blockedBy(first:50){nodes{number}} \
issueFieldValues(first:50){nodes{__typename \
... on IssueFieldNumberValue{value field{... on IssueFieldNumber{name}}} \
... on IssueFieldTextValue{value field{... on IssueFieldText{name}}} \
... on IssueFieldSingleSelectValue{value field{... on IssueFieldSingleSelect{name}}} \
... on IssueFieldDateValue{value field{... on IssueFieldDate{name}}}}}";

fn issue_selection(issue_fields: bool) -> String {
    if issue_fields {
        format!("{ISSUE_CONTENT} {ISSUE_FIELDS}")
    } else {
        ISSUE_CONTENT.to_string()
    }
}

fn items_fragment(issue_fields: bool) -> String {
    let issue = issue_selection(issue_fields);
    format!(
        r"
projectV2(number:$number){{
  title url
  fields(first:50){{nodes{{... on ProjectV2SingleSelectField{{name options{{name}}}}}}}}
  items(first:$page,after:$after){{
    pageInfo{{hasNextPage endCursor}}
    nodes{{
      isArchived
      content{{
        __typename
        ... on Issue{{{issue}}}
        ... on PullRequest{{number title url state assignees(first:10){{nodes{{login}}}} milestone{{title dueOn}}}}
        ... on DraftIssue{{title assignees(first:10){{nodes{{login}}}}}}
      }}
      fieldValues(first:50){{nodes{{
        __typename
        ... on ProjectV2ItemFieldSingleSelectValue{{name field{{... on ProjectV2FieldCommon{{name}}}}}}
        ... on ProjectV2ItemFieldTextValue{{text field{{... on ProjectV2FieldCommon{{name}}}}}}
        ... on ProjectV2ItemFieldNumberValue{{number field{{... on ProjectV2FieldCommon{{name}}}}}}
        ... on ProjectV2ItemFieldDateValue{{date field{{... on ProjectV2FieldCommon{{name}}}}}}
        ... on ProjectV2ItemFieldIterationValue{{title field{{... on ProjectV2FieldCommon{{name}}}}}}
      }}}}
    }}
  }}
}}"
    )
}

/// Whether a GraphQL reply refused the issue fields -- a host that has none.
fn refused_issue_fields(reply: &Value) -> bool {
    reply
        .get("errors")
        .and_then(Value::as_array)
        .is_some_and(|errors| {
            errors.iter().any(|e| {
                e.get("message").and_then(Value::as_str).is_some_and(|m| {
                    ["issueFieldValues", "IssueField", "issueType", "blockedBy"]
                        .iter()
                        .any(|f| m.contains(f))
                })
            })
        })
}

/// Resolve the GitHub connection a source names, or the tenant's first one
/// this sync can read.
async fn resolve_auth(
    connectors: &ConnectorService,
    ctx: &SecurityContext,
    tenant: Uuid,
    connection_id: Option<Uuid>,
) -> Result<ConnectionAuth> {
    let (_driver, auth, _conn) = connectors
        .named_or_default(ctx, tenant, connection_id, "github")
        .await?;
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
    for issue_fields in [true, false] {
        for owner_kind in ["organization", "user"] {
            match fetch_as(&http, &url, &auth, owner_kind, source, issue_fields).await? {
                Fetched::Board(mut board) => {
                    add_root_sub_issues(&http, &url, &auth, source, &mut board, issue_fields).await;
                    return Ok(board);
                }
                Fetched::NotThisOwner => continue,
                Fetched::NoIssueFields => break,
            }
        }
    }
    Err(anyhow!(
        "project {}/{} is not visible to this connection (it needs the read:project scope)",
        source.owner,
        source.number
    ))
}

enum Fetched {
    Board(Roadmap),
    NotThisOwner,
    NoIssueFields,
}

async fn post_graphql(
    http: &Client,
    url: &str,
    auth: &ConnectionAuth,
    body: &Value,
) -> Result<Value> {
    let res = http
        .post(url)
        .bearer_auth(&auth.token)
        .header("Accept", "application/vnd.github+json")
        .json(body)
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
    Ok(res.json().await?)
}

async fn fetch_as(
    http: &Client,
    url: &str,
    auth: &ConnectionAuth,
    owner_kind: &str,
    source: &RoadmapSource,
    issue_fields: bool,
) -> Result<Fetched> {
    let fragment = items_fragment(issue_fields);
    let query = format!(
        "query($owner:String!,$number:Int!,$page:Int!,$after:String){{ owner:{owner_kind}(login:$owner){{ {fragment} }} }}"
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
        let reply = post_graphql(http, url, auth, &body).await?;
        if issue_fields && after.is_none() && refused_issue_fields(&reply) {
            return Ok(Fetched::NoIssueFields);
        }
        // An owner of the other kind answers `owner: null` with a NOT_FOUND
        // error; that is "ask the other way", not a failure.
        let project = reply.pointer("/data/owner/projectV2");
        let Some(project) = project.filter(|p| !p.is_null()) else {
            if after.is_none() {
                return Ok(Fetched::NotThisOwner);
            }
            break;
        };
        let next = read_page(project, &mut board);
        match next {
            Some(cursor) => after = Some(cursor),
            None => return Ok(Fetched::Board(board)),
        }
    }
    Ok(Fetched::Board(board))
}

/// A root issue: `owner/repo#123`, or `123` resolved to the repository of the
/// board item with that number.
pub fn parse_root(root: &str, board: &Roadmap) -> Option<(String, String, u64)> {
    let root = root.trim();
    if let Some((repo, number)) = root.split_once('#') {
        let (owner, name) = repo.trim().split_once('/')?;
        return Some((
            owner.to_string(),
            name.to_string(),
            number.trim().parse().ok()?,
        ));
    }
    let number: u64 = root.trim_start_matches('#').parse().ok()?;
    // The root itself on the board; else one of its sub-issues, which lives in
    // the same repository -- a root is often not on the board it organizes.
    let url = board
        .items
        .iter()
        .find(|i| i.number == Some(number))
        .or_else(|| board.items.iter().find(|i| i.parent == Some(number)))?
        .url
        .as_deref()?;
    let path = url.split("github.com/").nth(1)?;
    let mut parts = path.split('/');
    Some((parts.next()?.to_string(), parts.next()?.to_string(), number))
}

/// The root numbers a source names, however it names them.
pub fn root_numbers(source: &RoadmapSource) -> Vec<u64> {
    source
        .roots
        .iter()
        .filter_map(|r| r.rsplit(['#', ' ']).next()?.trim().parse().ok())
        .collect()
}

/// Add each root's sub-issues that are not on the board, so a gear nobody has
/// put on the board yet is still one. Best-effort: a root that cannot be read
/// costs its off-board sub-issues, never the board.
async fn add_root_sub_issues(
    http: &Client,
    url: &str,
    auth: &ConnectionAuth,
    source: &RoadmapSource,
    board: &mut Roadmap,
    issue_fields: bool,
) {
    let issue = issue_selection(issue_fields);
    let query = format!(
        "query($owner:String!,$name:String!,$number:Int!,$after:String){{ repository(owner:$owner,name:$name){{ issue(number:$number){{ subIssues(first:100,after:$after){{ pageInfo{{hasNextPage endCursor}} nodes{{ {issue} }} }} }} }} }}"
    );
    for root in &source.roots {
        let Some((owner, name, number)) = parse_root(root, board) else {
            tracing::warn!(root = %root, "components-catalog: a roadmap root names no issue this board can place");
            continue;
        };
        let mut after: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let body = json!({
                "query": query,
                "variables": { "owner": owner, "name": name, "number": number, "after": after },
            });
            let reply = match post_graphql(http, url, auth, &body).await {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), root = %root, "components-catalog: a roadmap root is unreadable");
                    break;
                }
            };
            let Some(subs) = reply
                .pointer("/data/repository/issue/subIssues")
                .filter(|v| !v.is_null())
            else {
                tracing::warn!(root = %root, "components-catalog: a roadmap root answered no sub-issues");
                break;
            };
            for node in array(subs, "/nodes") {
                let sub = issue_item(node, Some(number), true);
                if !board
                    .items
                    .iter()
                    .any(|i| i.url.is_some() && i.url == sub.url)
                {
                    board.items.push(sub);
                }
            }
            let more = subs
                .pointer("/pageInfo/hasNextPage")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !more {
                break;
            }
            after = subs
                .pointer("/pageInfo/endCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
    }
}

/// An issue as an item, from the content GraphQL answered: its own fields
/// included, and `parent` when the caller already knows it.
fn issue_item(content: &Value, parent: Option<u64>, off_board: bool) -> RoadmapItem {
    let s = |v: &Value, p: &str| v.pointer(p).and_then(Value::as_str).map(str::to_string);
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
        parent: parent.or_else(|| content.pointer("/parent/number").and_then(Value::as_u64)),
        off_board,
        kind: s(content, "/issueType/name").filter(|k| !k.is_empty()),
        card: card_of(
            content
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        blocked_by: {
            let mut out: Vec<u64> = Vec::new();
            for n in array(content, "/blockedBy/nodes") {
                if let Some(number) = n.get("number").and_then(Value::as_u64)
                    && !out.contains(&number)
                {
                    out.push(number);
                }
            }
            out
        },
    };
    for fv in array(content, "/issueFieldValues/nodes") {
        let Some(field) = s(fv, "/field/name") else {
            continue;
        };
        let value = match fv.get("value") {
            Some(Value::Number(n)) => n.as_f64().map(FieldValue::Number),
            Some(Value::String(v))
                if fv.get("__typename").and_then(Value::as_str) == Some("IssueFieldDateValue") =>
            {
                Some(FieldValue::Date(v.clone()))
            }
            Some(Value::String(v)) => Some(FieldValue::Text(v.clone())),
            _ => None,
        };
        if let Some(value) = value {
            item.fields.insert(field, value);
        }
    }
    item
}

/// The card the planning team keeps in an issue body, one `**Name**: value`
/// line per field. Only the four fields the card has; the rest of the body is
/// prose, not data, and is not kept.
pub fn card_of(body: &str) -> BTreeMap<String, String> {
    const FIELDS: [(&str, &str); 5] = [
        ("description", "Description"),
        ("is plugin", "Is Plugin"),
        ("has plugins", "Has Plugins"),
        ("has extension points", "Has Extension Point"),
        ("has extension point", "Has Extension Point"),
    ];
    let mut out = BTreeMap::new();
    for line in body.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("**") else {
            continue;
        };
        let Some((name, tail)) = rest.split_once("**") else {
            continue;
        };
        let Some(value) = tail.trim_start().strip_prefix(':') else {
            continue;
        };
        let name = name.trim().to_lowercase();
        if let Some((_, field)) = FIELDS.iter().find(|(k, _)| *k == name) {
            out.insert((*field).to_string(), value.trim().to_string());
        }
    }
    out
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
        // The issue's own fields first; the board's, read next, replace any
        // of the same name -- the board is the plan of record.
        let mut item = issue_item(content, None, false);
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

// ── which items are gears ───────────────────────────────────────────────────

/// The indexes of the items that are gears: with roots, the direct sub-issues
/// of one; without, every item.
pub fn gear_items(board: &Roadmap, roots: &[u64]) -> Vec<usize> {
    board
        .items
        .iter()
        .enumerate()
        .filter(|(_, i)| roots.is_empty() || i.parent.is_some_and(|p| roots.contains(&p)))
        .map(|(ix, _)| ix)
        .collect()
}

/// The group a title files a gear under: its `DOMAIN - ` prefix
/// (`CORE - Tenant Resolver` → `CORE`), or `Ungrouped`.
pub fn group_of(title: &str) -> String {
    match title.split_once(" - ") {
        Some((prefix, _))
            if !prefix.trim().is_empty()
                && prefix
                    .trim()
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) =>
        {
            prefix.trim().to_string()
        }
        _ => "Ungrouped".to_string(),
    }
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
    common >= 6 || (short.len() >= 5 && one_edit_apart(a, b))
}

/// Whether one insertion, deletion or substitution turns `a` into `b` -- a
/// typo on the board (`Egine` for `Engine`) is still the gear it names.
fn one_edit_apart(a: &str, b: &str) -> bool {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let (short, long) = if a.len() <= b.len() {
        (&a, &b)
    } else {
        (&b, &a)
    };
    let mut i = 0;
    let mut j = 0;
    let mut edits = 0;
    while i < short.len() && j < long.len() {
        if short[i] == long[j] {
            i += 1;
            j += 1;
            continue;
        }
        edits += 1;
        if edits > 1 {
            return false;
        }
        if short.len() == long.len() {
            i += 1;
        }
        j += 1;
    }
    edits + (long.len() - j) + (short.len() - i) <= 1
}

/// The title words a gear word covers when it is a compound of two of them:
/// `credstore` is `Credentials Store` -- a prefix of the first (three letters
/// or more) and the second, or a prefix of it.
fn compound_of(word: &str, title_words: &[String]) -> Option<(usize, usize)> {
    for cut in 3..word.len().saturating_sub(2) {
        let (head, tail) = word.split_at(cut);
        for (j, pair) in title_words.windows(2).enumerate() {
            if pair[0].starts_with(head)
                && pair[0].len() > head.len()
                && (same_word(tail, &pair[1]) || pair[1].starts_with(tail))
            {
                return Some((j, j + 1));
            }
        }
    }
    None
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
    let mut covered_ix = vec![false; title_words.len()];
    for g in gear_words {
        let mut found = false;
        for (ix, t) in title_words.iter().enumerate() {
            if same_word(g, t) {
                covered_ix[ix] = true;
                found = true;
            }
        }
        if !found {
            match compound_of(g, title_words) {
                Some((a, b)) => {
                    covered_ix[a] = true;
                    covered_ix[b] = true;
                }
                None => return 0.0,
            }
        }
    }
    let covered = covered_ix.iter().filter(|c| **c).count();
    let share = covered as f64 / title_words.len().max(gear_words.len()) as f64;
    if share < MIN_SCORE { 0.0 } else { share }
}

/// How an item came to be a gear's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchedBy {
    Title,
    Hand,
    /// A gear on the board that no catalogued component matches.
    Unmatched,
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
/// item is the gear's single best -- two items fitting one gear equally are
/// left for a person -- and no other gear fits the item better. Gears that
/// fit one item equally all get it: `Auth Resolver` is the plan for both
/// `authn-resolver` and `authz-resolver`.
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
        // The item must not name another gear better.
        let rival = gears.iter().any(|(other, ow, pin)| {
            other != name && pin.is_none() && score(ow, &item_words[*ix]) > best + 1e-9
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
        MatchedBy::Unmatched => "no component matches it",
    };
    v.insert(
        "v".into(),
        json!(format!("{label} — on \"{}\", {how}", board.title)),
    );
    f.insert("roadmap_item".into(), Value::Object(v));

    f
}

/// The board's id as the plan fields and the stored gears name it:
/// `owner/projects/<number>`.
pub fn board_id(source: &RoadmapSource) -> String {
    format!("{}/projects/{}", source.owner, source.number)
}

/// What identifies an item on its board: its issue number, or for a draft
/// its title.
pub fn item_key(item: &RoadmapItem) -> String {
    match item.number {
        Some(n) => format!("#{n}"),
        None => item.title.clone(),
    }
}

/// The payload of a board's gear as it is stored: who it is, where it sits,
/// which catalogued components implement it, and the plan fields in `auto`,
/// the shape a profile carries them in -- so the component pipeline reads a
/// planned gear exactly as it reads a profile.
pub fn item_node_value(
    board: &Roadmap,
    source: &RoadmapSource,
    item: &RoadmapItem,
    fields: Map<String, Value>,
    components: &[String],
) -> Value {
    let id = board_id(source);
    let title = if board.title.trim().is_empty() {
        id.clone()
    } else {
        board.title.trim().to_string()
    };
    json!({
        "name": item.title,
        "title": item.title,
        "category": group_of(&item.title),
        "group": group_of(&item.title),
        "number": item.number,
        "url": item.url,
        "closed": item.closed,
        "parent": item.parent,
        "off_board": item.off_board,
        "assignees": item.assignees,
        "kind": "planned",
        "board": id,
        "board_title": title,
        "components": components,
        "auto": Value::Object(fields),
        "sheet": sheet_of(item),
    })
}

/// The item as the board says it, before any of it is interpreted: every
/// field's value under the board's own column name, the milestone's title,
/// the issue's type, card and blockers. What the roadmap workbook is drawn
/// from, so it reads a board the way the planning team's sheet does.
pub fn sheet_of(item: &RoadmapItem) -> Value {
    let fields: Map<String, Value> = item
        .fields
        .iter()
        .map(|(k, v)| {
            let value = match v {
                FieldValue::Number(n) => json!(n),
                FieldValue::Text(s) | FieldValue::Date(s) => json!(s),
            };
            (k.clone(), value)
        })
        .collect();
    json!({
        "type": item.kind,
        // The board's Milestone column, which an issue off the board has no
        // cell in: the planning sheet leaves it empty (and the gear in the
        // backlog) rather than read the issue's own.
        "milestone": item
            .milestone
            .as_ref()
            .filter(|_| !item.off_board)
            .map(|m| m.title.clone()),
        "fields": fields,
        "card": item.card,
        "blocked_by": item.blocked_by,
    })
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
