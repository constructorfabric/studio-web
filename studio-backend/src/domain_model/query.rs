//! The experimental query surface: one request reads the objects of a type
//! with a filter, an order, the fields it wants and the relations it wants
//! followed, nested.
//!
//! A screen built on `GET /objects` assembles that itself: it lists a type,
//! filters in the browser, and reads the graph once more per relation. Here
//! the request says what the screen shows and the gear answers it, so a screen
//! that changes changes its request, not the backend. The shape follows
//! Hasura's boolean expressions (`{"status": {"_eq": "active"}}`, `_and`,
//! `_or`, `_not`) because a frontend developer has likely written one before.
//!
//! Everything a request names is checked against the model first: a field the
//! type does not have, or a relation it does not declare, is a 400 naming what
//! it does have, never an empty answer.
//!
//! Two executors answer the same plan (ADR-0051):
//!
//! * **SQL over the read model** ([`super::mirror`]), once the tenant's mirror
//!   is filled: `where`, `order_by`, `total`, the page and
//!   `aggregate` run in Postgres (see [`sql`]), and each relation is one
//!   indexed read per level. No bound on the size of a type.
//! * **The graph**, while the mirror fills or where there is none: a type is
//!   read up to [`SCAN_LIMIT`] objects and filtered here, because domain types
//!   declare no payload indexes in graph-storage. `complete` says whether that
//!   read saw every object.
//!
//! A relation is followed from its source, or with `~name` from its target
//! back to its source. Each edge carries the declared relation it is, so two
//! relations of one verb do not answer for each other.
//!
//! Pages go by cursor: an answer with more rows after it carries
//! `next_cursor`, the last row's sort values and id, and the next request
//! sends it back as `cursor`. graph-storage pages only that way and will not
//! add offsets, so a query that pages by cursor can move onto the graph when
//! the read model goes. `offset` still works while screens move over.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use toolkit_security::SecurityContext;

use super::access::Access;
use super::gts;
use super::mirror::{DomainMirror, Group};
use super::ontology::Ontology;
use super::store::{DomainStore, Hop, Neighbourhood, ObjectNode};
use crate::pagination::{DEFAULT_LIMIT, MAX_LIMIT};

mod sql;

/// How many objects of the queried type the graph executor reads before
/// filtering. The same bound the conformance check reads under, for the same
/// reason: past it the answer is honest about being partial rather than slow.
pub const SCAN_LIMIT: usize = 5_000;

/// How many rows a gear's own read ([`run_bulk`]) returns at most.
pub const BULK_LIMIT: usize = 100_000;

/// How many fields one aggregate may group by.
pub const MAX_GROUP_BY: usize = 3;

/// The prefix that follows a relation backwards: `~delivers` on a project
/// reads the teams that deliver it.
pub const REVERSE: char = '~';

/// How deep `include` may nest. Each level is one traversal per relation, so
/// this bounds the round trips one request can cost.
pub const MAX_DEPTH: usize = 3;

// ── The request ───────────────────────────────────────────────────────────

/// What to read of one type: the root of a query, or one relation of it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    /// A boolean expression over the type's fields.
    #[serde(default, rename = "where")]
    pub filter: Option<Value>,
    /// Sort keys, first one first. Rows without the field sort last.
    #[serde(default)]
    pub order_by: Vec<OrderBy>,
    /// The payload fields to return. Omitted returns the whole payload.
    #[serde(default)]
    pub fields: Option<Vec<String>>,
    /// Relations to follow, by the name the model declares them under
    /// (`has_members`, or qualified, `team.has_members`), or backwards from
    /// their target with a leading `~` (`~has_members`).
    #[serde(default)]
    pub include: BTreeMap<String, Selection>,
    /// Rows to return, 1..=200, default 50. Under `include` this is per parent.
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderBy {
    pub field: String,
    #[serde(default)]
    pub direction: Direction,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    #[default]
    Asc,
    Desc,
}

impl Query {
    /// A query from the body `POST /query` takes: `type`, `project_id`,
    /// `offset`, `aggregate`, and the selection (`where`, `order_by`,
    /// `fields`, `include`, `limit`). What a gear hands the port.
    pub fn from_json(mut body: Value) -> Result<Self, String> {
        let obj = body.as_object_mut().ok_or("a query is an object")?;
        let type_ref = obj
            .remove("type")
            .and_then(|v| v.as_str().map(str::to_string))
            .ok_or("a query names its `type`")?;
        let scope = obj
            .remove("project_id")
            .and_then(|v| v.as_str().map(str::to_string));
        let offset = obj
            .remove("offset")
            .and_then(|v| v.as_u64())
            .map(|n| usize::try_from(n).unwrap_or(usize::MAX));
        let cursor = obj
            .remove("cursor")
            .and_then(|v| v.as_str().map(str::to_string));
        let aggregate = match obj.remove("aggregate") {
            None | Some(Value::Null) => None,
            Some(a) => Some(serde_json::from_value(a).map_err(|e| format!("`aggregate`: {e}"))?),
        };
        let selection = serde_json::from_value(body).map_err(|e| e.to_string())?;
        Ok(Self {
            type_ref,
            scope,
            offset,
            cursor,
            selection,
            aggregate,
        })
    }
}

/// Counts over the root's matches, grouped by up to [`MAX_GROUP_BY`] fields.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Aggregate {
    #[serde(default)]
    pub group_by: Vec<String>,
}

/// One query: the type it starts from and what to read of it.
#[derive(Debug, Clone, Default)]
pub struct Query {
    pub type_ref: String,
    /// The workspace/project scope objects were created in, as on `GET /objects`.
    pub scope: Option<String>,
    pub offset: Option<usize>,
    /// Where the previous page ended: its `next_cursor`.
    pub cursor: Option<String>,
    pub selection: Selection,
    /// Groups and their counts beside the rows.
    pub aggregate: Option<Aggregate>,
}

// ── The answer ────────────────────────────────────────────────────────────

/// One object in an answer, with the relations that were asked for.
#[derive(Debug, Clone)]
pub struct Row {
    pub id: String,
    pub entity: String,
    pub value: Value,
    pub relations: BTreeMap<String, RowSet>,
}

/// Rows and how many matched. `total` counts matches before `limit`;
/// `complete` is false when the read behind them stopped early.
#[derive(Debug, Clone)]
pub struct RowSet {
    pub items: Vec<Row>,
    pub total: usize,
    pub complete: bool,
}

#[derive(Debug, Clone)]
pub struct Outcome {
    pub rows: RowSet,
    /// The aggregate's groups, largest first, when one was asked for.
    pub groups: Option<Vec<Group>>,
    /// What the answer may get wrong, said rather than hidden.
    pub warnings: Vec<String>,
    /// Which executor answered: `read_model` or `graph`.
    pub source: &'static str,
    /// What to send as `cursor` for the rows after these; `None` on the last
    /// page.
    pub next_cursor: Option<String>,
}

impl Row {
    /// The wire form: `{id, entity, value, relations: {name: {items, total, complete}}}`.
    pub fn to_json(&self) -> Value {
        let relations: Map<String, Value> = self
            .relations
            .iter()
            .map(|(name, set)| (name.clone(), set.to_json()))
            .collect();
        json!({
            "id": self.id,
            "entity": self.entity,
            "value": self.value,
            "relations": relations,
        })
    }
}

impl RowSet {
    pub fn to_json(&self) -> Value {
        json!({
            "items": self.items.iter().map(Row::to_json).collect::<Vec<_>>(),
            "total": self.total,
            "complete": self.complete,
        })
    }
}

/// A request the model refuses, told apart from a store that failed.
#[derive(Debug)]
pub enum QueryError {
    Invalid(String),
    Failed(anyhow::Error),
}

impl From<anyhow::Error> for QueryError {
    fn from(e: anyhow::Error) -> Self {
        Self::Failed(e)
    }
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(m) => f.write_str(m),
            Self::Failed(e) => write!(f, "{e:#}"),
        }
    }
}

fn invalid(m: impl Into<String>) -> QueryError {
    QueryError::Invalid(m.into())
}

// ── Boolean expressions ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Eq,
    Neq,
    Gt,
    Gte,
    Lt,
    Lte,
    In,
    Nin,
    Contains,
    IsNull,
}

impl Op {
    const ALL: &'static str = "_eq, _neq, _gt, _gte, _lt, _lte, _in, _nin, _contains, _is_null";

    fn parse(token: &str) -> Option<Self> {
        Some(match token {
            "_eq" => Self::Eq,
            "_neq" => Self::Neq,
            "_gt" => Self::Gt,
            "_gte" => Self::Gte,
            "_lt" => Self::Lt,
            "_lte" => Self::Lte,
            "_in" => Self::In,
            "_nin" => Self::Nin,
            "_contains" => Self::Contains,
            "_is_null" => Self::IsNull,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone)]
enum Expr {
    And(Vec<Expr>),
    Or(Vec<Expr>),
    Not(Box<Expr>),
    Cmp {
        path: Vec<String>,
        op: Op,
        arg: Value,
    },
}

fn parse_expr(v: &Value) -> Result<Expr, String> {
    let obj = v
        .as_object()
        .ok_or("a `where` is an object: {\"field\": {\"_eq\": value}}")?;
    let mut parts: Vec<Expr> = Vec::new();
    for (key, val) in obj {
        match key.as_str() {
            "_and" | "_or" => {
                let list = val
                    .as_array()
                    .ok_or_else(|| format!("`{key}` takes a list of expressions"))?
                    .iter()
                    .map(parse_expr)
                    .collect::<Result<Vec<_>, _>>()?;
                parts.push(if key == "_and" {
                    Expr::And(list)
                } else {
                    Expr::Or(list)
                });
            }
            "_not" => parts.push(Expr::Not(Box::new(parse_expr(val)?))),
            k if k.starts_with('_') => {
                return Err(format!(
                    "`{k}` is not a combinator; use _and, _or, _not, or a field name"
                ));
            }
            field => {
                let ops = val.as_object().ok_or_else(|| {
                    format!("`{field}` takes operators, as in {{\"{field}\": {{\"_eq\": …}}}}")
                })?;
                for (token, arg) in ops {
                    let op = Op::parse(token).ok_or_else(|| {
                        format!("`{token}` on `{field}` is not an operator; use {}", Op::ALL)
                    })?;
                    match op {
                        Op::In | Op::Nin if !arg.is_array() => {
                            return Err(format!("`{token}` on `{field}` takes a list"));
                        }
                        Op::IsNull if !arg.is_boolean() => {
                            return Err(format!("`_is_null` on `{field}` takes true or false"));
                        }
                        _ => {}
                    }
                    parts.push(Expr::Cmp {
                        path: field.split('.').map(str::to_string).collect(),
                        op,
                        arg: arg.clone(),
                    });
                }
            }
        }
    }
    Ok(if parts.len() == 1 {
        parts.remove(0)
    } else {
        Expr::And(parts)
    })
}

/// Every field an expression reads, by its first path segment.
fn fields_of(e: &Expr, out: &mut Vec<String>) {
    match e {
        Expr::And(list) | Expr::Or(list) => list.iter().for_each(|e| fields_of(e, out)),
        Expr::Not(e) => fields_of(e, out),
        Expr::Cmp { path, .. } => out.push(path[0].clone()),
    }
}

/// A field's value on an object. `id` is the object's own id — the payload's
/// `id` is one the graph supplies, so the two do not compete. A JSON `null`
/// reads as absent.
fn lookup<'a>(node: &'a ObjectNode, path: &[String], id: &'a Value) -> Option<&'a Value> {
    if path.len() == 1 && path[0] == "id" {
        return Some(id);
    }
    let mut at = &node.value;
    for seg in path {
        at = at.get(seg)?;
    }
    (!at.is_null()).then_some(at)
}

/// Numbers by value, strings by code point (RFC 3339 timestamps sort right),
/// booleans false-first. Anything else, or two different kinds, has no order.
fn compare(a: &Value, b: &Value) -> Option<Ordering> {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64()?.partial_cmp(&y.as_f64()?),
        (Value::String(x), Value::String(y)) => Some(x.cmp(y)),
        (Value::Bool(x), Value::Bool(y)) => Some(x.cmp(y)),
        _ => None,
    }
}

fn equal(a: &Value, b: &Value) -> bool {
    compare(a, b).map_or(a == b, Ordering::is_eq)
}

/// SQL's reading of a missing field: every comparison with it is false, so
/// `_neq` does not match an object that lacks the field. `_is_null` is how to
/// ask for those.
fn eval(e: &Expr, node: &ObjectNode, id: &Value) -> bool {
    match e {
        Expr::And(list) => list.iter().all(|e| eval(e, node, id)),
        Expr::Or(list) => list.iter().any(|e| eval(e, node, id)),
        Expr::Not(e) => !eval(e, node, id),
        Expr::Cmp { path, op, arg } => {
            let found = lookup(node, path, id);
            if *op == Op::IsNull {
                return found.is_none() == arg.as_bool().unwrap_or(true);
            }
            let Some(x) = found else {
                return false;
            };
            let in_list = || {
                arg.as_array()
                    .is_some_and(|l| l.iter().any(|a| equal(x, a)))
            };
            match op {
                Op::Eq => equal(x, arg),
                Op::Neq => !equal(x, arg),
                Op::Gt => compare(x, arg) == Some(Ordering::Greater),
                Op::Gte => matches!(compare(x, arg), Some(Ordering::Greater | Ordering::Equal)),
                Op::Lt => compare(x, arg) == Some(Ordering::Less),
                Op::Lte => matches!(compare(x, arg), Some(Ordering::Less | Ordering::Equal)),
                Op::In => in_list(),
                Op::Nin => !in_list(),
                // Substring for text, ignoring case; membership for a list.
                Op::Contains => match (x, arg) {
                    (Value::String(s), Value::String(needle)) => {
                        s.to_lowercase().contains(&needle.to_lowercase())
                    }
                    (Value::Array(items), needle) => items.iter().any(|i| equal(i, needle)),
                    _ => false,
                },
                Op::IsNull => unreachable!("handled above"),
            }
        }
    }
}

// ── Planning: the request checked against the model ───────────────────────

#[derive(Debug)]
struct Plan {
    filter: Option<Expr>,
    order_by: Vec<(Vec<String>, Direction)>,
    fields: Option<Vec<String>>,
    include: Vec<IncludePlan>,
    limit: usize,
}

#[derive(Debug)]
struct IncludePlan {
    name: String,
    edge_type_id: String,
    /// The declared relation's own name, which its edges carry.
    relation: String,
    reverse: bool,
    node_type_ids: Vec<String>,
    plan: Plan,
}

impl IncludePlan {
    fn hop(&self) -> Hop<'_> {
        Hop {
            edge_type_id: &self.edge_type_id,
            relation: Some(&self.relation),
            node_type_ids: &self.node_type_ids,
            reverse: self.reverse,
        }
    }
}

/// Every entity that is `target` or extends it — what may sit at the far end
/// of a relation declared to point at `target`.
fn extending(ontology: &Ontology, target: &str) -> Vec<String> {
    ontology
        .entity_ids()
        .into_iter()
        .filter(|id| ontology.ancestors(id).iter().any(|a| a == target))
        .collect()
}

fn plan(
    ontology: &Ontology,
    entities: &[String],
    label: &str,
    sel: &Selection,
    depth: usize,
) -> Result<Plan, QueryError> {
    // A field is admitted when any of the types the rows can be has it: a
    // relation pointing at a base returns objects of what extends it.
    let mut admitted: Vec<String> = vec!["id".to_string()];
    for e in entities {
        for p in ontology.effective_properties(e) {
            if !admitted.contains(&p.name) {
                admitted.push(p.name);
            }
        }
    }
    let check = |field: &str, role: &str| -> Result<(), QueryError> {
        let head = field.split('.').next().unwrap_or(field);
        if admitted.iter().any(|a| a == head) {
            return Ok(());
        }
        let mut known = admitted.clone();
        known.sort();
        Err(invalid(format!(
            "`{field}` in {role} is not a field of `{label}`; it has: {}",
            known.join(", ")
        )))
    };

    let filter = match &sel.filter {
        None => None,
        Some(v) => {
            let e = parse_expr(v).map_err(invalid)?;
            let mut used = Vec::new();
            fields_of(&e, &mut used);
            for f in &used {
                check(f, "`where`")?;
            }
            Some(e)
        }
    };
    let mut order_by = Vec::new();
    for o in &sel.order_by {
        check(&o.field, "`order_by`")?;
        order_by.push((
            o.field.split('.').map(str::to_string).collect(),
            o.direction,
        ));
    }
    if let Some(fields) = &sel.fields {
        for f in fields {
            check(f, "`fields`")?;
        }
    }
    if !sel.include.is_empty() && depth >= MAX_DEPTH {
        return Err(invalid(format!(
            "`include` nests at most {MAX_DEPTH} levels deep"
        )));
    }

    let chains: std::collections::HashSet<String> = entities
        .iter()
        .flat_map(|e| ontology.ancestors(e))
        .collect();
    let declared = ontology.declared_relations();
    let mut include = Vec::new();
    for (name, child) in &sel.include {
        let (reverse, written) = match name.strip_prefix(REVERSE) {
            Some(rest) => (true, rest),
            None => (false, name.as_str()),
        };
        let (owner, bare) = match written.split_once('.') {
            Some((o, n)) => (ontology.resolve_entity_id(o), n),
            None => (None, written),
        };
        // Forwards, the rows are the relation's source; backwards, its target.
        let near_end = |d: &super::ontology::DeclaredRelation| {
            if reverse {
                d.target_entity.as_ref().is_some_and(|t| chains.contains(t))
            } else {
                chains.contains(&d.source)
            }
        };
        let hits: Vec<_> = declared
            .iter()
            .filter(|d| d.name == bare && near_end(d))
            .filter(|d| owner.as_ref().is_none_or(|o| *o == d.source))
            .collect();
        let Some(d) = hits.first() else {
            let mut offered: Vec<String> = declared
                .iter()
                .filter(|d| d.target_entity.is_some())
                .filter_map(|d| {
                    if chains.contains(&d.source) {
                        Some(d.name.clone())
                    } else if d.target_entity.as_ref().is_some_and(|t| chains.contains(t)) {
                        Some(format!("{REVERSE}{}.{}", d.source, d.name))
                    } else {
                        None
                    }
                })
                .collect();
            offered.sort();
            offered.dedup();
            return Err(invalid(format!(
                "`{label}` has no relation `{name}`; it has: {}",
                offered.join(", ")
            )));
        };
        let far = |h: &super::ontology::DeclaredRelation| {
            if reverse {
                Some(h.source.clone())
            } else {
                h.target_entity.clone()
            }
        };
        if hits.iter().any(|h| h.verb != d.verb || far(h) != far(d)) {
            return Err(invalid(format!(
                "`{name}` means different relations on the types `{label}` can be; qualify it: {}",
                hits.iter()
                    .map(|h| format!("{}{}.{}", if reverse { "~" } else { "" }, h.source, h.name))
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
        let Some(target) = far(d) else {
            return Err(invalid(format!(
                "`{name}` points at `{}`, which is not in the loaded model",
                d.target
            )));
        };
        let targets = extending(ontology, &target);
        include.push(IncludePlan {
            name: name.clone(),
            edge_type_id: gts::edge_type_id(&d.verb),
            relation: d.name.clone(),
            reverse,
            node_type_ids: targets.iter().map(|t| gts::node_type_id(t)).collect(),
            plan: plan(ontology, &targets, &target, child, depth + 1)?,
        });
    }

    Ok(Plan {
        filter,
        order_by,
        fields: sel.fields.clone(),
        include,
        limit: sel.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
    })
}

// ── Execution ─────────────────────────────────────────────────────────────

/// The values an object sorts by, one per `order_by` key; `None` where absent.
fn sort_values<'a>(
    node: &'a ObjectNode,
    order_by: &[(Vec<String>, Direction)],
    id: &'a Value,
) -> Vec<Option<&'a Value>> {
    order_by
        .iter()
        .map(|(path, _)| lookup(node, path, id))
        .collect()
}

/// Two rows in the order a query asks for: its keys in turn, absent last
/// whichever way a key runs, then the id, so a page is stable.
fn by_order(
    order_by: &[(Vec<String>, Direction)],
    (a, a_id): (&[Option<&Value>], &str),
    (b, b_id): (&[Option<&Value>], &str),
) -> Ordering {
    for ((_, dir), (x, y)) in order_by.iter().zip(a.iter().zip(b)) {
        let ord = match (x, y) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => return Ordering::Greater,
            (Some(_), None) => return Ordering::Less,
            (Some(x), Some(y)) => {
                let o = compare(x, y).unwrap_or(Ordering::Equal);
                if *dir == Direction::Desc {
                    o.reverse()
                } else {
                    o
                }
            }
        };
        if ord.is_ne() {
            return ord;
        }
    }
    a_id.cmp(b_id)
}

/// Filter and order, ties broken by id so a page is stable.
fn select(nodes: Vec<ObjectNode>, plan: &Plan) -> Vec<ObjectNode> {
    let mut keyed: Vec<(Value, ObjectNode)> = nodes
        .into_iter()
        .map(|n| (Value::String(n.instance_id.clone()), n))
        .filter(|(id, n)| plan.filter.as_ref().is_none_or(|e| eval(e, n, id)))
        .collect();
    keyed.sort_by(|(ia, a), (ib, b)| {
        by_order(
            &plan.order_by,
            (&sort_values(a, &plan.order_by, ia), &a.instance_id),
            (&sort_values(b, &plan.order_by, ib), &b.instance_id),
        )
    });
    keyed.into_iter().map(|(_, n)| n).collect()
}

// ── Cursors ───────────────────────────────────────────────────────────────

/// Where a page ended: the last row's sort values and id. It travels with a
/// digest of the query it came from, because sent with another `where` or
/// `order_by` it would name a place that order does not have.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Cursor {
    pub keys: Vec<Option<Value>>,
    pub id: String,
}

/// What a cursor is bound to: the type, the scope, the filter and the order.
/// Not the limit, so a client may change its page size between pages.
fn binding(entity: &str, q: &Query, order_by: &[(Vec<String>, Direction)]) -> String {
    use sha2::{Digest, Sha256};
    let order: Vec<Value> = order_by
        .iter()
        .map(|(path, dir)| json!([path.join("."), *dir == Direction::Desc]))
        .collect();
    let of = json!({
        "type": entity,
        "scope": q.scope,
        "where": q.selection.filter,
        "order_by": order,
    });
    hex::encode(&Sha256::digest(of.to_string().as_bytes())[..8])
}

impl Cursor {
    /// The place right after `node`.
    fn at(node: &ObjectNode, order_by: &[(Vec<String>, Direction)]) -> Self {
        let id = Value::String(node.instance_id.clone());
        Self {
            keys: sort_values(node, order_by, &id)
                .into_iter()
                .map(|v| v.cloned())
                .collect(),
            id: node.instance_id.clone(),
        }
    }

    fn encode(&self, bound: &str) -> String {
        use base64::Engine as _;
        let body = json!({ "q": bound, "k": self.keys, "id": self.id });
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body.to_string())
    }

    fn decode(token: &str, bound: &str, keys: usize) -> Result<Self, QueryError> {
        use base64::Engine as _;
        let refused = || {
            invalid(
                "`cursor` is not one this query gave out: send back the `next_cursor` \
                 of a query with the same `type`, `project_id`, `where` and `order_by`",
            )
        };
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(token.trim())
            .map_err(|_| refused())?;
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| refused())?;
        if body.get("q").and_then(Value::as_str) != Some(bound) {
            return Err(refused());
        }
        let values = body
            .get("k")
            .and_then(Value::as_array)
            .filter(|k| k.len() == keys)
            .ok_or_else(refused)?;
        let id = body.get("id").and_then(Value::as_str).ok_or_else(refused)?;
        Ok(Self {
            keys: values
                .iter()
                .map(|v| (!v.is_null()).then(|| v.clone()))
                .collect(),
            id: id.to_string(),
        })
    }

    /// True when `node` comes after this place in the query's order.
    fn is_before(&self, node: &ObjectNode, order_by: &[(Vec<String>, Direction)]) -> bool {
        let id = Value::String(node.instance_id.clone());
        let here: Vec<Option<&Value>> = self.keys.iter().map(Option::as_ref).collect();
        by_order(
            order_by,
            (&sort_values(node, order_by, &id), &node.instance_id),
            (&here, &self.id),
        )
        .is_gt()
    }
}

fn row(ontology: &Ontology, node: ObjectNode, plan: &Plan) -> Row {
    let entity = ontology
        .resolve_entity_id(&node.type_id)
        .unwrap_or_else(|| gts::type_leaf(&node.type_id).to_string());
    let value = match &plan.fields {
        None => node.value,
        Some(fields) => {
            let mut out = Map::new();
            for f in fields {
                let head = f.split('.').next().unwrap_or(f);
                if let Some(v) = node.value.get(head) {
                    out.insert(head.to_string(), v.clone());
                }
            }
            Value::Object(out)
        }
    };
    Row {
        id: node.instance_id,
        entity,
        value,
        relations: BTreeMap::new(),
    }
}

type Step<'a> = Pin<Box<dyn Future<Output = Result<(), QueryError>> + Send + 'a>>;

/// Where one hop of a query is read: the store (the graph) or the read model.
#[async_trait]
trait Hops: Send + Sync {
    async fn hop(
        &self,
        ctx: &SecurityContext,
        seeds: &[String],
        hop: Hop<'_>,
    ) -> anyhow::Result<Neighbourhood>;
}

struct ThroughStore<'a>(&'a dyn DomainStore);

#[async_trait]
impl Hops for ThroughStore<'_> {
    async fn hop(
        &self,
        ctx: &SecurityContext,
        seeds: &[String],
        hop: Hop<'_>,
    ) -> anyhow::Result<Neighbourhood> {
        self.0.neighbours(ctx, seeds, hop).await
    }
}

#[async_trait]
impl Hops for DomainMirror {
    async fn hop(
        &self,
        ctx: &SecurityContext,
        seeds: &[String],
        hop: Hop<'_>,
    ) -> anyhow::Result<Neighbourhood> {
        DomainMirror::hop(self, ctx.subject_tenant_id(), seeds, hop).await
    }
}

/// Follow each included relation for every row at once: one read per
/// relation and level, the way a federated engine batches a join, then the
/// next level over all the children together.
fn expand<'a>(
    hops: &'a dyn Hops,
    ctx: &'a SecurityContext,
    ontology: &'a Ontology,
    access: &'a Access,
    rows: &'a mut [Row],
    includes: &'a [IncludePlan],
) -> Step<'a> {
    Box::pin(async move {
        if rows.is_empty() {
            return Ok(());
        }
        for inc in includes {
            let mut seen = std::collections::HashSet::new();
            let seeds: Vec<String> = rows
                .iter()
                .filter(|r| seen.insert(r.id.clone()))
                .map(|r| r.id.clone())
                .collect();
            let hood = hops.hop(ctx, &seeds, inc.hop()).await?;
            // Every level, not only the root: a relation must not carry a
            // caller into rows they may not read (ADR-0035 §5).
            let reachable = access.retain(ctx, hood.nodes).await;
            let nodes: HashMap<&str, &ObjectNode> = reachable
                .iter()
                .map(|n| (n.instance_id.as_str(), n))
                .collect();
            let mut out: HashMap<&str, Vec<ObjectNode>> = HashMap::new();
            for e in &hood.edges {
                if let Some(n) = nodes.get(e.to.as_str()) {
                    let list = out.entry(e.from.as_str()).or_default();
                    if !list.iter().any(|x| x.instance_id == n.instance_id) {
                        list.push((*n).clone());
                    }
                }
            }
            let mut children: Vec<Row> = Vec::new();
            let mut spans: Vec<(usize, usize)> = Vec::with_capacity(rows.len());
            for r in rows.iter() {
                // Cloned, not taken: one object can sit under two parents.
                let found = select(
                    out.get(r.id.as_str()).cloned().unwrap_or_default(),
                    &inc.plan,
                );
                let total = found.len();
                let before = children.len();
                children.extend(
                    found
                        .into_iter()
                        .take(inc.plan.limit)
                        .map(|n| row(ontology, n, &inc.plan)),
                );
                spans.push((children.len() - before, total));
            }
            expand(
                hops,
                ctx,
                ontology,
                access,
                &mut children,
                &inc.plan.include,
            )
            .await?;
            let mut it = children.into_iter();
            for (r, (count, total)) in rows.iter_mut().zip(spans) {
                r.relations.insert(
                    inc.name.clone(),
                    RowSet {
                        items: it.by_ref().take(count).collect(),
                        total,
                        complete: !hood.truncated,
                    },
                );
            }
        }
        Ok(())
    })
}

/// The aggregate's fields, checked against the type like any other field.
fn group_paths(
    ontology: &Ontology,
    entity: &str,
    aggregate: Option<&Aggregate>,
) -> Result<Option<Vec<Vec<String>>>, QueryError> {
    let Some(a) = aggregate else {
        return Ok(None);
    };
    if a.group_by.len() > MAX_GROUP_BY {
        return Err(invalid(format!(
            "`aggregate.group_by` takes at most {MAX_GROUP_BY} fields"
        )));
    }
    let known: Vec<String> = std::iter::once("id".to_string())
        .chain(
            ontology
                .effective_properties(entity)
                .into_iter()
                .map(|p| p.name),
        )
        .collect();
    let mut paths = Vec::new();
    for f in &a.group_by {
        let head = f.split('.').next().unwrap_or(f);
        if !known.iter().any(|k| k == head) {
            let mut known = known.clone();
            known.sort();
            return Err(invalid(format!(
                "`{f}` in `aggregate.group_by` is not a field of `{entity}`; it has: {}",
                known.join(", ")
            )));
        }
        paths.push(f.split('.').map(str::to_string).collect());
    }
    Ok(Some(paths))
}

/// Largest group first, then by key, so both executors answer in one order.
fn sorted(mut groups: Vec<Group>) -> Vec<Group> {
    groups.sort_by(|a, b| {
        b.count.cmp(&a.count).then_with(|| {
            Value::Array(a.key.clone())
                .to_string()
                .cmp(&Value::Array(b.key.clone()).to_string())
        })
    });
    groups
}

/// The groups of `matched`, counted here: the graph executor's aggregate.
fn groups_of(matched: &[ObjectNode], paths: &[Vec<String>]) -> Vec<Group> {
    let mut counts: Vec<(Vec<Value>, u64)> = Vec::new();
    for n in matched {
        let id = Value::String(n.instance_id.clone());
        let key: Vec<Value> = paths
            .iter()
            .map(|p| lookup(n, p, &id).cloned().unwrap_or(Value::Null))
            .collect();
        match counts.iter_mut().find(|(k, _)| *k == key) {
            Some((_, c)) => *c += 1,
            None => counts.push((key, 1)),
        }
    }
    sorted(
        counts
            .into_iter()
            .map(|(key, count)| Group { key, count })
            .collect(),
    )
}

/// A gear's read of its own objects: [`run`] with the page bound lifted to
/// [`BULK_LIMIT`] for the root (relations keep theirs). On the graph the
/// scan bound lifts with it, so the answer is complete either way.
pub(super) async fn run_bulk(
    store: &dyn DomainStore,
    ontology: &Ontology,
    ctx: &SecurityContext,
    q: &Query,
    access: &Access,
) -> Result<Outcome, QueryError> {
    run_with(
        store,
        ontology,
        ctx,
        q,
        access,
        Some(q.selection.limit.unwrap_or(BULK_LIMIT).clamp(1, BULK_LIMIT)),
    )
    .await
}

/// Answer a query against `ontology`, reading through `store`: from its read
/// model when the tenant's is complete, from the graph otherwise.
pub(super) async fn run(
    store: &dyn DomainStore,
    ontology: &Ontology,
    ctx: &SecurityContext,
    q: &Query,
    access: &Access,
) -> Result<Outcome, QueryError> {
    run_with(store, ontology, ctx, q, access, None).await
}

async fn run_with(
    store: &dyn DomainStore,
    ontology: &Ontology,
    ctx: &SecurityContext,
    q: &Query,
    access: &Access,
    bulk: Option<usize>,
) -> Result<Outcome, QueryError> {
    let entity = ontology
        .resolve_entity_id(&q.type_ref)
        .ok_or_else(|| invalid(format!("unknown domain type: {}", q.type_ref)))?;
    let warnings: Vec<String> = Vec::new();
    let mut plan = plan(
        ontology,
        std::slice::from_ref(&entity),
        &entity,
        &q.selection,
        0,
    )?;
    if let Some(limit) = bulk {
        plan.limit = limit;
    }
    let scan_limit = bulk.map_or(SCAN_LIMIT, |b| b.max(SCAN_LIMIT));
    let group_by = group_paths(ontology, &entity, q.aggregate.as_ref())?;
    let scope = q.scope.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let type_ids = vec![gts::node_type_id(&entity)];
    if q.cursor.is_some() && q.offset.is_some_and(|o| o > 0) {
        return Err(invalid(
            "send `cursor` or `offset`, not both: they page differently",
        ));
    }
    let bound = binding(&entity, q, &plan.order_by);
    let after = q
        .cursor
        .as_deref()
        .map(|c| Cursor::decode(c, &bound, plan.order_by.len()))
        .transpose()?;
    // A page reads one row past its limit: if it comes back, there is a next.
    let next_of = |page: &mut Vec<ObjectNode>| {
        (page.len() > plan.limit)
            .then(|| {
                page.truncate(plan.limit);
                page.last()
                    .map(|n| Cursor::at(n, &plan.order_by).encode(&bound))
            })
            .flatten()
    };

    if let Some(mirror) = store.read_model(ctx, ontology).await {
        let tenant = ctx.subject_tenant_id();
        // The PDP's answer as a predicate: asked once per owner that has
        // objects of the type, before anything is counted (ADR-0035 §5).
        let owners = if access.is_unconstrained() {
            None
        } else {
            let mut admitted = Vec::new();
            for owner in mirror.owners(tenant, &type_ids, scope).await? {
                if access.admits_owner(ctx, owner).await {
                    admitted.push(owner);
                }
            }
            Some(admitted)
        };
        let root = super::mirror::RootSelect {
            type_ids,
            scope: scope.map(str::to_string),
            filter: plan.filter.as_ref().map(sql::condition),
            order: sql::order(&plan.order_by),
            owners,
        };
        let offset = u64::try_from(q.offset.unwrap_or(0)).unwrap_or(u64::MAX);
        let past = after
            .as_ref()
            .map(|c| sql::after(&plan.order_by, &c.keys, &c.id));
        let (mut nodes, total) = mirror
            .root(tenant, &root, past, offset, plan.limit as u64 + 1)
            .await?;
        let next_cursor = next_of(&mut nodes);
        let groups = match &group_by {
            Some(paths) => Some(sorted(
                mirror.groups(tenant, &root, sql::group_key(paths)).await?,
            )),
            None => None,
        };
        let mut rows: Vec<Row> = nodes.into_iter().map(|n| row(ontology, n, &plan)).collect();
        expand(&*mirror, ctx, ontology, access, &mut rows, &plan.include).await?;
        return Ok(Outcome {
            rows: RowSet {
                items: rows,
                total: usize::try_from(total).unwrap_or(usize::MAX),
                complete: true,
            },
            groups,
            warnings,
            source: "read_model",
            next_cursor,
        });
    }

    // One over the bound: if it comes back, the read did not see everything.
    let mut found = store
        .list_objects(ctx, &type_ids, scope, Some(scan_limit + 1))
        .await?;
    let complete = found.len() <= scan_limit;
    found.truncate(scan_limit);
    // Before `where` and `total`: a count that included rows the caller cannot
    // see would say they exist (ADR-0035 §5).
    let found = access.retain(ctx, found).await;

    let matched = select(found, &plan);
    let total = matched.len();
    let groups = group_by.as_deref().map(|paths| groups_of(&matched, paths));
    let start = match &after {
        Some(c) => matched
            .iter()
            .position(|n| c.is_before(n, &plan.order_by))
            .unwrap_or(total),
        None => q.offset.unwrap_or(0),
    };
    let mut page: Vec<ObjectNode> = matched
        .into_iter()
        .skip(start)
        .take(plan.limit + 1)
        .collect();
    let next_cursor = next_of(&mut page);
    let mut rows: Vec<Row> = page.into_iter().map(|n| row(ontology, n, &plan)).collect();
    expand(
        &ThroughStore(store),
        ctx,
        ontology,
        access,
        &mut rows,
        &plan.include,
    )
    .await?;
    Ok(Outcome {
        rows: RowSet {
            items: rows,
            total,
            complete,
        },
        groups,
        warnings,
        source: "graph",
        next_cursor,
    })
}

#[cfg(test)]
mod tests {
    //! Over the in-memory store, which keeps edges, through the service, so
    //! the plan is checked against the real seed model.

    use std::sync::Arc;

    use uuid::Uuid;

    use super::*;
    use crate::domain_model::service::{DomainModelService, WriteOptions};
    use crate::domain_model::store::InMemoryDomainStore;
    use crate::domain_model::validate::ValidateMode;

    fn ctx() -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(1))
            .subject_tenant_id(Uuid::from_u128(1))
            .token_scopes(vec!["*".to_string()])
            .build()
            .expect("test security context")
    }

    async fn object(s: &DomainModelService, ty: &str, key: &str, value: Value) -> String {
        s.create_object(
            &ctx(),
            ty,
            key,
            WriteOptions {
                validate: ValidateMode::Off,
                ..Default::default()
            },
            value,
        )
        .await
        .unwrap()
        .instance_id
    }

    /// Three projects, two teams; `core` delivers apollo and gemini and has
    /// one member.
    async fn fixture() -> DomainModelService {
        let s = DomainModelService::new(Arc::new(InMemoryDomainStore::default()));
        let apollo = object(
            &s,
            "project",
            "apollo",
            json!({"name": "Apollo", "status": "active", "started_at": "2026-03-01T00:00:00Z"}),
        )
        .await;
        let gemini = object(
            &s,
            "project",
            "gemini",
            json!({"name": "Gemini", "status": "paused", "started_at": "2026-01-01T00:00:00Z"}),
        )
        .await;
        object(
            &s,
            "project",
            "mercury",
            json!({"name": "Mercury", "status": "active"}),
        )
        .await;
        let core = object(
            &s,
            "team",
            "core",
            json!({"name": "Core", "aliases": ["kernel"]}),
        )
        .await;
        object(&s, "team", "edge", json!({"name": "Edge"})).await;
        let ak = object(
            &s,
            "person",
            "ak",
            json!({"name": "AK", "status": "active"}),
        )
        .await;
        for (rel, to) in [
            ("team.delivers", &apollo),
            ("team.delivers", &gemini),
            ("has_members", &ak),
        ] {
            s.create_relation(&ctx(), rel, &core, to).await.unwrap();
        }
        s
    }

    fn query(ty: &str, selection: Value) -> Query {
        Query {
            type_ref: ty.to_string(),
            selection: serde_json::from_value(selection).unwrap(),
            ..Default::default()
        }
    }

    fn names(set: &RowSet) -> Vec<String> {
        set.items
            .iter()
            .map(|r| r.value["name"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    async fn refusal(s: &DomainModelService, ty: &str, sel: Value) -> String {
        match s.query(&ctx(), &query(ty, sel)).await {
            Err(QueryError::Invalid(m)) => m,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_filter_and_an_order_answer_in_one_request() {
        let s = fixture().await;
        let q = query(
            "project",
            json!({
                "where": {"status": {"_eq": "active"}},
                "order_by": [{"field": "name", "direction": "desc"}],
            }),
        );
        let out = s.query(&ctx(), &q).await.unwrap();
        assert_eq!(names(&out.rows), ["Mercury", "Apollo"]);
        assert_eq!(out.rows.total, 2);
        assert!(out.rows.complete);
    }

    #[tokio::test]
    async fn combinators_and_a_missing_field() {
        let s = fixture().await;
        let ask = |w: Value| {
            query(
                "project",
                json!({"where": w, "order_by": [{"field": "name"}]}),
            )
        };
        // Mercury has no `started_at`: no comparison matches it, `_is_null` does.
        let cases = [
            (
                json!({"started_at": {"_gte": "2026-02-01T00:00:00Z"}}),
                vec!["Apollo"],
            ),
            (json!({"started_at": {"_is_null": true}}), vec!["Mercury"]),
            (json!({"status": {"_neq": "active"}}), vec!["Gemini"]),
            (
                json!({"_or": [{"status": {"_eq": "paused"}}, {"name": {"_contains": "merc"}}]}),
                vec!["Gemini", "Mercury"],
            ),
            (
                json!({"_not": {"status": {"_in": ["active"]}}}),
                vec!["Gemini"],
            ),
        ];
        for (w, want) in cases {
            let out = s.query(&ctx(), &ask(w.clone())).await.unwrap();
            assert_eq!(names(&out.rows), want, "{w}");
        }
    }

    #[tokio::test]
    async fn rows_without_the_sort_field_come_last_both_ways() {
        let s = fixture().await;
        for dir in ["asc", "desc"] {
            let q = query(
                "project",
                json!({"order_by": [{"field": "started_at", "direction": dir}]}),
            );
            let out = s.query(&ctx(), &q).await.unwrap();
            assert_eq!(
                names(&out.rows).last().map(String::as_str),
                Some("Mercury"),
                "{dir}"
            );
        }
    }

    #[tokio::test]
    async fn a_page_keeps_the_total_and_fields_project_the_payload() {
        let s = fixture().await;
        let mut q = query(
            "project",
            json!({"order_by": [{"field": "name"}], "fields": ["name"], "limit": 1}),
        );
        q.offset = Some(1);
        let out = s.query(&ctx(), &q).await.unwrap();
        assert_eq!(out.rows.total, 3);
        assert_eq!(out.rows.items.len(), 1);
        assert_eq!(out.rows.items[0].value, json!({"name": "Gemini"}));
        assert_eq!(out.rows.items[0].entity, "project");
    }

    #[tokio::test]
    async fn a_cursor_walks_every_page_once_and_ends() {
        let s = fixture().await;
        // `started_at` is absent on Mercury: it comes last both ways, and a
        // cursor that stops on it still finds what follows.
        for dir in ["asc", "desc"] {
            let body = json!({"order_by": [{"field": "started_at", "direction": dir}], "limit": 1});
            let whole = s
                .query(
                    &ctx(),
                    &query("project", json!({"order_by": body["order_by"]})),
                )
                .await
                .unwrap();
            let mut seen = Vec::new();
            let mut q = query("project", body.clone());
            loop {
                let out = s.query(&ctx(), &q).await.unwrap();
                assert_eq!(out.rows.total, 3);
                seen.extend(names(&out.rows));
                match out.next_cursor {
                    Some(c) => q.cursor = Some(c),
                    None => break,
                }
            }
            assert_eq!(seen, names(&whole.rows), "{dir}");
        }
    }

    #[tokio::test]
    async fn a_cursor_belongs_to_its_query() {
        let s = fixture().await;
        let q = query(
            "project",
            json!({"order_by": [{"field": "name"}], "limit": 1}),
        );
        let cursor = s.query(&ctx(), &q).await.unwrap().next_cursor.unwrap();

        let mut other = query(
            "project",
            json!({"where": {"status": {"_eq": "active"}}, "order_by": [{"field": "name"}], "limit": 1}),
        );
        other.cursor = Some(cursor.clone());
        let e = s.query(&ctx(), &other).await.unwrap_err().to_string();
        assert!(e.contains("not one this query gave out"), "{e}");

        let mut both = q.clone();
        both.cursor = Some(cursor);
        both.offset = Some(1);
        let e = s.query(&ctx(), &both).await.unwrap_err().to_string();
        assert!(e.contains("not both"), "{e}");

        let mut garbage = q;
        garbage.cursor = Some("not-a-cursor".to_string());
        assert!(s.query(&ctx(), &garbage).await.is_err());
    }

    #[tokio::test]
    async fn relations_are_followed_filtered_and_counted_per_parent() {
        let s = fixture().await;
        let q = query(
            "team",
            json!({
                "order_by": [{"field": "name"}],
                "include": {
                    "delivers": {"where": {"status": {"_eq": "active"}}, "fields": ["name"]},
                    "has_members": {},
                },
            }),
        );
        let out = s.query(&ctx(), &q).await.unwrap();
        assert_eq!(names(&out.rows), ["Core", "Edge"]);
        let core = &out.rows.items[0];
        assert_eq!(names(&core.relations["delivers"]), ["Apollo"]);
        assert_eq!(core.relations["delivers"].total, 1);
        assert_eq!(names(&core.relations["has_members"]), ["AK"]);
        // A team with nothing related still says so, rather than omitting it.
        assert_eq!(out.rows.items[1].relations["delivers"].total, 0);

        // The wire form nests the same shape.
        let wire = core.to_json();
        assert_eq!(
            wire["relations"]["delivers"]["items"][0]["value"]["name"],
            "Apollo"
        );
    }

    #[tokio::test]
    async fn an_included_limit_bounds_items_not_the_total() {
        let s = fixture().await;
        let q = query(
            "team",
            json!({
                "where": {"name": {"_eq": "Core"}},
                "include": {"delivers": {"order_by": [{"field": "name"}], "limit": 1}},
            }),
        );
        let out = s.query(&ctx(), &q).await.unwrap();
        let delivers = &out.rows.items[0].relations["delivers"];
        assert_eq!(names(delivers), ["Apollo"]);
        assert_eq!(delivers.total, 2);
    }

    #[tokio::test]
    async fn what_the_model_does_not_have_is_named() {
        let s = fixture().await;
        let m = refusal(&s, "project", json!({"where": {"colour": {"_eq": "red"}}})).await;
        assert!(m.contains("`colour`") && m.contains("status"), "{m}");
        let m = refusal(&s, "project", json!({"order_by": [{"field": "colour"}]})).await;
        assert!(m.contains("`order_by`"), "{m}");
        let m = refusal(&s, "project", json!({"where": {"status": {"_like": "a%"}}})).await;
        assert!(m.contains("_contains"), "{m}");
        let m = refusal(&s, "team", json!({"include": {"members": {}}})).await;
        assert!(
            m.contains("has no relation `members`")
                && m.contains("delivers")
                && m.contains("~project.includes_2"),
            "{m}"
        );
        let m = refusal(&s, "starship", json!({})).await;
        assert!(m.contains("unknown domain type"), "{m}");
    }

    #[tokio::test]
    async fn include_depth_is_bounded() {
        let s = fixture().await;
        // team -delivers-> project -includes_2-> team -delivers-> project -…
        let deep = json!({"include": {"delivers": {"include": {"includes_2": {
            "include": {"delivers": {"include": {"includes_2": {}}}}
        }}}}});
        let m = refusal(&s, "team", deep).await;
        assert!(m.contains("at most 3"), "{m}");
    }

    // ── ADR-0035: what a project-scoped grant lets through ─────────────────

    use crate::domain_model::access::{Access, AccessError, ObjectPolicy, TenantParents};
    use toolkit_security::{AccessScope, ScopeConstraint, ScopeFilter, pep_properties};

    const ORG: Uuid = Uuid::from_u128(1);
    const MINE: Uuid = Uuid::from_u128(0x0a);
    const THEIRS: Uuid = Uuid::from_u128(0x0b);

    /// Both projects sit in the organization.
    struct Tree;
    #[async_trait::async_trait]
    impl TenantParents for Tree {
        async fn parent_of(&self, _ctx: &SecurityContext, t: Uuid) -> Option<Uuid> {
            (t == MINE || t == THEIRS).then_some(ORG)
        }
    }

    /// What the PDP answers a member with a grant on `MINE` only: every branch
    /// of the clamp ANDed with that project.
    struct OneProject;
    #[async_trait::async_trait]
    impl ObjectPolicy for OneProject {
        async fn access(
            &self,
            ctx: &SecurityContext,
            _action: &str,
            _entity: Option<&str>,
        ) -> Result<Access, AccessError> {
            let only = ScopeFilter::in_uuids(pep_properties::OWNER_TENANT_ID, vec![MINE]);
            let subtree =
                ScopeFilter::InTenantSubtree(toolkit_security::InTenantSubtreeScopeFilter::new(
                    pep_properties::OWNER_TENANT_ID,
                    toolkit_security::ScopeValue::Uuid(ORG),
                ));
            Ok(Access::new(
                ctx,
                AccessScope::from_constraints(vec![ScopeConstraint::new(vec![subtree, only])]),
                Some(Arc::new(Tree)),
            ))
        }
    }

    async fn in_project(s: &DomainModelService, ty: &str, key: &str, project: Uuid) -> String {
        s.create_object(
            &ctx(),
            ty,
            key,
            WriteOptions {
                validate: ValidateMode::Off,
                scope: Some(&project.to_string()),
                ..Default::default()
            },
            json!({ "name": key }),
        )
        .await
        .unwrap()
        .instance_id
    }

    /// The same store, seen first with every grant and then through `OneProject`.
    async fn two_projects() -> (Arc<InMemoryDomainStore>, String, String) {
        let store = Arc::new(InMemoryDomainStore::default());
        let open = DomainModelService::new(store.clone());
        let team = in_project(&open, "team", "core", MINE).await;
        let mine = in_project(&open, "project", "apollo", MINE).await;
        let theirs = in_project(&open, "project", "gemini", THEIRS).await;
        for p in [&mine, &theirs] {
            open.create_relation(&ctx(), "team.delivers", &team, p)
                .await
                .unwrap();
        }
        (store, team, theirs)
    }

    #[tokio::test]
    async fn a_project_grant_narrows_the_root_and_its_total() {
        let (store, _, _) = two_projects().await;
        let s = DomainModelService::new(store).with_policy(Arc::new(OneProject));
        let out = s.query(&ctx(), &query("project", json!({}))).await.unwrap();
        assert_eq!(names(&out.rows), ["apollo"]);
        assert_eq!(out.rows.total, 1, "a hidden row is not counted either");
    }

    #[tokio::test]
    async fn a_relation_does_not_carry_the_caller_into_another_project() {
        let (store, _, _) = two_projects().await;
        let s = DomainModelService::new(store).with_policy(Arc::new(OneProject));
        let out = s
            .query(
                &ctx(),
                &query("team", json!({ "include": { "delivers": {} } })),
            )
            .await
            .unwrap();
        let delivers = &out.rows.items[0].relations["delivers"];
        assert_eq!(names(delivers), ["apollo"]);
        assert_eq!(delivers.total, 1);
    }

    #[tokio::test]
    async fn writing_into_another_project_or_relating_to_it_is_refused() {
        let (store, team, theirs) = two_projects().await;
        let s = DomainModelService::new(store).with_policy(Arc::new(OneProject));
        let e = s
            .create_object(
                &ctx(),
                "project",
                "mercury",
                WriteOptions {
                    validate: ValidateMode::Off,
                    scope: Some(&THEIRS.to_string()),
                    ..Default::default()
                },
                json!({ "name": "mercury" }),
            )
            .await
            .expect_err("another project");
        assert!(matches!(
            crate::domain_model::access::access_error(&e),
            Some(AccessError::Denied)
        ));
        let e = s
            .create_relation(&ctx(), "team.delivers", &team, &theirs)
            .await
            .expect_err("an unreadable target");
        assert!(matches!(
            crate::domain_model::access::access_error(&e),
            Some(AccessError::Denied)
        ));
    }

    #[tokio::test]
    async fn an_organization_wide_object_needs_an_organization_grant() {
        let store = Arc::new(InMemoryDomainStore::default());
        object(
            &DomainModelService::new(store.clone()),
            "project",
            "shared",
            json!({ "name": "shared" }),
        )
        .await;
        let s = DomainModelService::new(store).with_policy(Arc::new(OneProject));
        let out = s.query(&ctx(), &query("project", json!({}))).await.unwrap();
        assert!(out.rows.items.is_empty());
    }

    #[tokio::test]
    async fn the_legacy_report_lists_only_scopes_that_name_no_project() {
        let s = DomainModelService::new(Arc::new(InMemoryDomainStore::default()));
        in_project(&s, "project", "apollo", MINE).await;
        object(&s, "project", "shared", json!({ "name": "shared" })).await;
        s.create_object(
            &ctx(),
            "team",
            "old",
            WriteOptions {
                validate: ValidateMode::Off,
                scope: Some("workspace-7"),
                ..Default::default()
            },
            json!({ "name": "old" }),
        )
        .await
        .unwrap();
        let r = s.legacy_scopes(&ctx(), 100).await.unwrap();
        assert!(r.complete);
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.items[0].entity, "team");
        assert_eq!(r.items[0].scope, "workspace-7");
        assert_eq!(r.items[0].name.as_deref(), Some("old"));
    }

    #[test]
    fn numbers_compare_by_value_and_kinds_do_not_mix() {
        assert!(equal(&json!(1), &json!(1.0)));
        assert_eq!(compare(&json!(2), &json!(10)), Some(Ordering::Less));
        assert_eq!(compare(&json!("2"), &json!(10)), None);
    }
}
