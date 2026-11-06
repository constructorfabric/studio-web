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
//! What it cannot do yet, and why:
//!
//! * **Filtering and ordering run in the gear.** Domain types declare no
//!   payload indexes yet — graph-storage 0.3 can add one to a registered type,
//!   but each indexed path also needs a typed property in the type's schema —
//!   so a type is read up to [`SCAN_LIMIT`] objects and filtered here.
//!   `complete` says whether that read saw every object.
//! * **A relation is followed from its source only.** The edge is stored on
//!   the declaring side, and the traversal walks outgoing edges alone;
//!   following it backwards is a later step.
//! * **A relation is told apart by its name, not its declaring type.** Two
//!   relations of one verb share an edge type, and the edge's discriminator
//!   (the relation's name) is what the traversal filters on. Two relations
//!   with the same verb AND the same name, declared on different types a row
//!   can be, still share edges; the plan reports that as a warning instead of
//!   answering wrongly in silence.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use toolkit_security::SecurityContext;

use super::access::Access;
use super::gts;
use super::ontology::Ontology;
use super::store::{DomainStore, ObjectNode};
use crate::pagination::{DEFAULT_LIMIT, MAX_LIMIT};

/// How many objects of the queried type are read before filtering. The same
/// bound the conformance check reads under, for the same reason: past it the
/// answer is honest about being partial rather than slow.
pub const SCAN_LIMIT: usize = 5_000;

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
    /// (`has_members`, or qualified, `team.has_members`).
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

/// One query: the type it starts from and what to read of it.
#[derive(Debug, Clone, Default)]
pub struct Query {
    pub type_ref: String,
    /// The workspace/project scope objects were created in, as on `GET /objects`.
    pub scope: Option<String>,
    pub offset: Option<usize>,
    pub selection: Selection,
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
    /// What the answer may get wrong, said rather than hidden.
    pub warnings: Vec<String>,
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
    /// The declared relation's name: the discriminator its edges carry.
    discriminator: String,
    node_type_ids: Vec<String>,
    plan: Plan,
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
    warnings: &mut Vec<String>,
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

    let chains: HashSet<String> = entities
        .iter()
        .flat_map(|e| ontology.ancestors(e))
        .collect();
    let declared = ontology.declared_relations();
    let mut include = Vec::new();
    for (name, child) in &sel.include {
        let (owner, bare) = match name.split_once('.') {
            Some((o, n)) => (ontology.resolve_entity_id(o), n),
            None => (None, name.as_str()),
        };
        let hits: Vec<_> = declared
            .iter()
            .filter(|d| d.name == bare && chains.contains(&d.source))
            .filter(|d| owner.as_ref().is_none_or(|o| *o == d.source))
            .collect();
        let Some(d) = hits.first() else {
            let mut offered: Vec<String> = declared
                .iter()
                .filter(|d| chains.contains(&d.source) && d.target_entity.is_some())
                .map(|d| d.name.clone())
                .collect();
            offered.sort();
            offered.dedup();
            return Err(invalid(format!(
                "`{label}` declares no relation `{name}`; it declares: {}",
                offered.join(", ")
            )));
        };
        if hits
            .iter()
            .any(|h| h.verb != d.verb || h.target_entity != d.target_entity)
        {
            return Err(invalid(format!(
                "`{name}` means different relations on the types `{label}` can be; qualify it: {}",
                hits.iter()
                    .map(|h| format!("{}.{}", h.source, h.name))
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
        let Some(target) = d.target_entity.clone() else {
            return Err(invalid(format!(
                "`{name}` points at `{}`, which is not in the loaded model",
                d.target
            )));
        };
        let targets = extending(ontology, &target);
        for other in &declared {
            // The traversal filters on the relation's name, so only a relation
            // with the same verb and the same name can bring its edges along.
            let same = other.source == d.source && other.name == d.name;
            if same
                || other.verb != d.verb
                || other.name != d.name
                || !chains.contains(&other.source)
            {
                continue;
            }
            let overlaps = other
                .target_entity
                .as_ref()
                .is_some_and(|t| extending(ontology, t).iter().any(|x| targets.contains(x)));
            if overlaps {
                warnings.push(format!(
                    "`{name}` and `{}.{}` are both stored as `{}` edges with the same name, \
                     so `{name}` also returns the other's",
                    other.source, other.name, d.verb
                ));
            }
        }
        include.push(IncludePlan {
            name: name.clone(),
            edge_type_id: gts::edge_type_id(&d.verb),
            discriminator: d.name.clone(),
            node_type_ids: targets.iter().map(|t| gts::node_type_id(t)).collect(),
            plan: plan(ontology, &targets, &target, child, depth + 1, warnings)?,
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

/// Filter and order, ties broken by id so a page is stable.
fn select(nodes: Vec<ObjectNode>, plan: &Plan) -> Vec<ObjectNode> {
    let mut keyed: Vec<(Value, ObjectNode)> = nodes
        .into_iter()
        .map(|n| (Value::String(n.instance_id.clone()), n))
        .filter(|(id, n)| plan.filter.as_ref().is_none_or(|e| eval(e, n, id)))
        .collect();
    keyed.sort_by(|(ia, a), (ib, b)| {
        for (path, dir) in &plan.order_by {
            let ord = match (lookup(a, path, ia), lookup(b, path, ib)) {
                (None, None) => Ordering::Equal,
                // Absent last, whichever way the column runs.
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
        a.instance_id.cmp(&b.instance_id)
    });
    keyed.into_iter().map(|(_, n)| n).collect()
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

/// Follow each included relation for every row at once: one traversal per
/// relation and level, the way a federated engine batches a join, then the
/// next level over all the children together.
fn expand<'a>(
    store: &'a dyn DomainStore,
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
            let mut seen = HashSet::new();
            let seeds: Vec<String> = rows
                .iter()
                .filter(|r| seen.insert(r.id.clone()))
                .map(|r| r.id.clone())
                .collect();
            let hood = store
                .neighbours(
                    ctx,
                    &seeds,
                    &inc.edge_type_id,
                    Some(&inc.discriminator),
                    &inc.node_type_ids,
                )
                .await?;
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
                store,
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

/// Answer a query against `ontology`, reading through `store`.
pub(super) async fn run(
    store: &dyn DomainStore,
    ontology: &Ontology,
    ctx: &SecurityContext,
    q: &Query,
    access: &Access,
) -> Result<Outcome, QueryError> {
    let entity = ontology
        .resolve_entity_id(&q.type_ref)
        .ok_or_else(|| invalid(format!("unknown domain type: {}", q.type_ref)))?;
    let mut warnings = Vec::new();
    let plan = plan(
        ontology,
        std::slice::from_ref(&entity),
        &entity,
        &q.selection,
        0,
        &mut warnings,
    )?;

    let scope = q.scope.as_deref().map(str::trim).filter(|s| !s.is_empty());
    // One over the bound: if it comes back, the read did not see everything.
    let mut found = store
        .list_objects(
            ctx,
            &[gts::node_type_id(&entity)],
            scope,
            Some(SCAN_LIMIT + 1),
        )
        .await?;
    let complete = found.len() <= SCAN_LIMIT;
    found.truncate(SCAN_LIMIT);
    // Before `where` and `total`: a count that included rows the caller cannot
    // see would say they exist (ADR-0035 §5).
    let found = access.retain(ctx, found).await;

    let matched = select(found, &plan);
    let total = matched.len();
    let mut rows: Vec<Row> = matched
        .into_iter()
        .skip(q.offset.unwrap_or(0))
        .take(plan.limit)
        .map(|n| row(ontology, n, &plan))
        .collect();
    expand(store, ctx, ontology, access, &mut rows, &plan.include).await?;
    Ok(Outcome {
        rows: RowSet {
            items: rows,
            total,
            complete,
        },
        warnings,
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
            m.contains("declares no relation `members`") && m.contains("delivers"),
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

    /// `project.uses` (→ repository) and `project.includes_3` (→ managed-object)
    /// are both `references` edges, and a repository is a managed-object. The
    /// edge's discriminator is what keeps one out of the other.
    #[tokio::test]
    async fn two_relations_of_one_verb_do_not_answer_for_each_other() {
        let s = DomainModelService::new(Arc::new(InMemoryDomainStore::default()));
        let project = object(&s, "project", "apollo", json!({"name": "Apollo"})).await;
        let repo = object(
            &s,
            "repository",
            "studio-web",
            json!({"name": "studio-web"}),
        )
        .await;
        s.create_relation(&ctx(), "project.uses", &project, &repo)
            .await
            .unwrap();

        let q = query(
            "project",
            json!({ "include": { "uses": {}, "includes_3": {} } }),
        );
        let out = s.query(&ctx(), &q).await.unwrap();
        let row = &out.rows.items[0];
        assert_eq!(names(&row.relations["uses"]), ["studio-web"]);
        assert_eq!(row.relations["includes_3"].total, 0);
        assert!(
            out.warnings.iter().all(|w| !w.contains("includes_3")),
            "{:?}",
            out.warnings
        );
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
