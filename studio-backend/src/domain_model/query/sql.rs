//! A query's `where`, `order_by` and aggregate keys as SQL over
//! `studio_domain_objects` (ADR-0051 §3).
//!
//! The SQL has to answer what the in-memory executor answers, because a
//! tenant moves from one to the other when its read model fills, and
//! `mirror_tests.rs` asks both the same questions. So it spells out the same
//! reading of the payload:
//!
//! * a field is absent when the path is missing or holds JSON `null`, and an
//!   absent field matches no comparison (`_is_null` is how to ask for it);
//! * numbers compare by value, strings by code point (`COLLATE "C"`),
//!   booleans false-first, and two different kinds never compare;
//! * `_contains` is a case-insensitive substring on text and membership on a
//!   list. Case folding is Postgres's `lower`, which follows the database's
//!   ctype: the same as Rust's for ASCII, and for other letters only under a
//!   UTF-8 ctype.
//!
//! Every comparison is wrapped so it is `TRUE` or `FALSE`, never `NULL`, so
//! `_not` turns a non-match into a match the way it does in memory. A cast
//! sits inside a `CASE` on the value's kind, which Postgres evaluates in
//! order, so a string is never cast to a number.
//!
//! Field names travel as bound parameters (`payload -> $1 -> $2`), never as
//! SQL text.

use sea_orm::sea_query::{Expr as SqlExpr, Value as SqlValue};
use sea_orm::{Condition, Order};
use serde_json::Value;

use super::{Direction, Expr, Op};

/// SQL text and the parameters its `$n` placeholders name, numbered from 1.
#[derive(Default)]
struct Sql {
    params: Vec<SqlValue>,
}

impl Sql {
    fn param(&mut self, v: SqlValue) -> String {
        self.params.push(v);
        format!("${}", self.params.len())
    }

    fn done(self, text: String) -> SqlExpr {
        SqlExpr::cust_with_values(text, self.params)
    }

    /// The JSON at `path`: the object's id for `id`, a payload path otherwise.
    fn value_at(&mut self, path: &[String]) -> String {
        if path.len() == 1 && path[0] == "id" {
            return "to_jsonb(instance_id)".to_string();
        }
        let mut s = String::from("(payload");
        for seg in path {
            let p = self.param(SqlValue::String(Some(seg.clone())));
            s.push_str(" -> ");
            s.push_str(&p);
            s.push_str("::text");
        }
        s.push(')');
        s
    }

    /// `v` equals `arg`, by the in-memory `equal`.
    fn eq(&mut self, v: &str, arg: &Value) -> String {
        match arg {
            Value::Number(n) => match n.as_f64() {
                Some(f) => {
                    let p = self.param(SqlValue::Double(Some(f)));
                    format!(
                        "CASE WHEN jsonb_typeof({v}) = 'number' THEN ({v} #>> '{{}}')::float8 = {p} ELSE FALSE END"
                    )
                }
                None => "FALSE".to_string(),
            },
            Value::String(s) => {
                let p = self.param(SqlValue::String(Some(s.clone())));
                format!(
                    "CASE WHEN jsonb_typeof({v}) = 'string' THEN ({v} #>> '{{}}') = {p} ELSE FALSE END"
                )
            }
            Value::Bool(b) => {
                let p = self.param(SqlValue::Bool(Some(*b)));
                format!(
                    "CASE WHEN jsonb_typeof({v}) = 'boolean' THEN ({v} #>> '{{}}')::boolean = {p} ELSE FALSE END"
                )
            }
            // A field is never present as `null`, so nothing equals it.
            Value::Null => "FALSE".to_string(),
            Value::Array(_) | Value::Object(_) => {
                let p = self.param(SqlValue::Json(Some(Box::new(arg.clone()))));
                format!("({v} = {p}::jsonb)")
            }
        }
    }

    /// `v` orders against `arg` as `op` asks; two kinds never compare.
    fn ordered(&mut self, v: &str, op: &str, arg: &Value) -> String {
        match arg {
            Value::Number(n) => match n.as_f64() {
                Some(f) => {
                    let p = self.param(SqlValue::Double(Some(f)));
                    format!(
                        "CASE WHEN jsonb_typeof({v}) = 'number' THEN ({v} #>> '{{}}')::float8 {op} {p} ELSE FALSE END"
                    )
                }
                None => "FALSE".to_string(),
            },
            Value::String(s) => {
                let p = self.param(SqlValue::String(Some(s.clone())));
                format!(
                    "CASE WHEN jsonb_typeof({v}) = 'string' THEN ({v} #>> '{{}}') COLLATE \"C\" {op} {p} ELSE FALSE END"
                )
            }
            Value::Bool(b) => {
                let p = self.param(SqlValue::Bool(Some(*b)));
                format!(
                    "CASE WHEN jsonb_typeof({v}) = 'boolean' THEN ({v} #>> '{{}}')::boolean {op} {p} ELSE FALSE END"
                )
            }
            _ => "FALSE".to_string(),
        }
    }

    fn any_of(&mut self, v: &str, arg: &Value) -> String {
        let items: Vec<String> = arg
            .as_array()
            .map(|l| l.iter().map(|a| self.eq(v, a)).collect())
            .unwrap_or_default();
        if items.is_empty() {
            "FALSE".to_string()
        } else {
            format!("({})", items.join(" OR "))
        }
    }

    fn expr(&mut self, e: &Expr) -> String {
        match e {
            Expr::And(list) if list.is_empty() => "TRUE".to_string(),
            Expr::Or(list) if list.is_empty() => "FALSE".to_string(),
            Expr::And(list) => {
                let parts: Vec<String> = list.iter().map(|e| self.expr(e)).collect();
                format!("({})", parts.join(" AND "))
            }
            Expr::Or(list) => {
                let parts: Vec<String> = list.iter().map(|e| self.expr(e)).collect();
                format!("({})", parts.join(" OR "))
            }
            Expr::Not(e) => format!("(NOT {})", self.expr(e)),
            Expr::Cmp { path, op, arg } => {
                let v = self.value_at(path);
                let absent = format!("(jsonb_typeof({v}) IS NULL OR jsonb_typeof({v}) = 'null')");
                let body = match op {
                    Op::IsNull => {
                        if arg.as_bool().unwrap_or(true) {
                            absent
                        } else {
                            format!("(NOT {absent})")
                        }
                    }
                    Op::Eq => self.eq(&v, arg),
                    Op::Neq => {
                        let eq = self.eq(&v, arg);
                        format!("(NOT {absent} AND NOT ({eq}))")
                    }
                    Op::Gt => self.ordered(&v, ">", arg),
                    Op::Gte => self.ordered(&v, ">=", arg),
                    Op::Lt => self.ordered(&v, "<", arg),
                    Op::Lte => self.ordered(&v, "<=", arg),
                    Op::In => self.any_of(&v, arg),
                    Op::Nin => {
                        let any = self.any_of(&v, arg);
                        format!("(NOT {absent} AND NOT ({any}))")
                    }
                    Op::Contains => {
                        let member = self.eq("e.x", arg);
                        let in_list = format!(
                            "EXISTS (SELECT 1 FROM jsonb_array_elements({v}) AS e(x) WHERE {member})"
                        );
                        match arg {
                            Value::String(s) => {
                                let p = self.param(SqlValue::String(Some(s.clone())));
                                format!(
                                    "CASE WHEN jsonb_typeof({v}) = 'string' THEN strpos(lower({v} #>> '{{}}'), lower({p})) > 0 \
                                     WHEN jsonb_typeof({v}) = 'array' THEN {in_list} ELSE FALSE END"
                                )
                            }
                            _ => format!(
                                "CASE WHEN jsonb_typeof({v}) = 'array' THEN {in_list} ELSE FALSE END"
                            ),
                        }
                    }
                };
                format!("COALESCE(({body}), FALSE)")
            }
        }
    }
}

/// A `where` as one SQL condition.
pub(super) fn condition(e: &Expr) -> Condition {
    let mut sql = Sql::default();
    let text = sql.expr(e);
    Condition::all().add(sql.done(text))
}

/// Sort keys, each as the in-memory order has it: absent last whichever way
/// the key runs, then numbers, text by code point, and booleans, each by
/// value. The caller appends the id tie-break.
pub(super) fn order(keys: &[(Vec<String>, Direction)]) -> Vec<(SqlExpr, Order)> {
    let mut out = Vec::new();
    for (path, dir) in keys {
        let by = if *dir == Direction::Desc {
            Order::Desc
        } else {
            Order::Asc
        };
        let mut absent = Sql::default();
        let v = absent.value_at(path);
        out.push((
            absent.done(format!(
                "CASE WHEN jsonb_typeof({v}) IS NULL OR jsonb_typeof({v}) = 'null' THEN 1 ELSE 0 END"
            )),
            Order::Asc,
        ));
        for (kind, cast) in [
            ("number", "({v} #>> '{}')::float8"),
            ("string", "({v} #>> '{}') COLLATE \"C\""),
            ("boolean", "({v} #>> '{}')::boolean"),
        ] {
            let mut sql = Sql::default();
            let v = sql.value_at(path);
            let cast = cast.replace("{v}", &v);
            out.push((
                sql.done(format!(
                    "CASE WHEN jsonb_typeof({v}) = '{kind}' THEN {cast} END"
                )),
                by.clone(),
            ));
        }
    }
    out
}

/// The rows after a cursor, in the order [`order`] and the id tie-break give.
///
/// Each key sorts as four columns: whether it is absent (ascending), then its
/// number, text and boolean reading in the key's direction, where Postgres puts
/// a column's NULLs last ascending and first descending. A row is after the
/// cursor when, at the first column where they differ, it is on the far side:
/// the usual keyset expansion, `c1 > v1 OR (c1 = v1 AND c2 > v2) OR …`, with
/// those NULL placements spelled out because `>` on a NULL is never true.
pub(super) fn after(keys: &[(Vec<String>, Direction)], at: &[Option<Value>], id: &str) -> SqlExpr {
    let mut sql = Sql::default();
    // (column, its value at the cursor, descending)
    let mut cols: Vec<(String, Option<SqlValue>, bool)> = Vec::new();
    for ((path, dir), value) in keys.iter().zip(at) {
        let v = sql.value_at(path);
        let desc = *dir == Direction::Desc;
        cols.push((
            format!("(CASE WHEN jsonb_typeof({v}) IS NULL OR jsonb_typeof({v}) = 'null' THEN 1 ELSE 0 END)"),
            Some(SqlValue::Int(Some(i32::from(value.is_none())))),
            false,
        ));
        let (number, text, flag) = match value {
            Some(Value::Number(n)) => (n.as_f64().map(|f| SqlValue::Double(Some(f))), None, None),
            Some(Value::String(s)) => (None, Some(SqlValue::String(Some(s.clone()))), None),
            Some(Value::Bool(b)) => (None, None, Some(SqlValue::Bool(Some(*b)))),
            _ => (None, None, None),
        };
        cols.push((
            format!("(CASE WHEN jsonb_typeof({v}) = 'number' THEN ({v} #>> '{{}}')::float8 END)"),
            number,
            desc,
        ));
        cols.push((
            format!(
                "(CASE WHEN jsonb_typeof({v}) = 'string' THEN ({v} #>> '{{}}') COLLATE \"C\" END)"
            ),
            text,
            desc,
        ));
        cols.push((
            format!("(CASE WHEN jsonb_typeof({v}) = 'boolean' THEN ({v} #>> '{{}}')::boolean END)"),
            flag,
            desc,
        ));
    }
    cols.push((
        "instance_id".to_string(),
        Some(SqlValue::String(Some(id.to_string()))),
        false,
    ));

    let mut either = Vec::new();
    for (i, (col, value, desc)) in cols.iter().enumerate() {
        let beyond = match (value, desc) {
            // Ascending, NULLs come last: nothing is past a NULL.
            (None, false) => continue,
            // Descending, NULLs come first: every value is past a NULL.
            (None, true) => format!("{col} IS NOT NULL"),
            (Some(v), false) => {
                let p = sql.param(v.clone());
                format!("({col} > {p} OR {col} IS NULL)")
            }
            (Some(v), true) => {
                let p = sql.param(v.clone());
                format!("{col} < {p}")
            }
        };
        let mut all: Vec<String> = cols[..i]
            .iter()
            .map(|(c, v, _)| match v {
                Some(v) => {
                    let p = sql.param(v.clone());
                    format!("{c} = {p}")
                }
                None => format!("{c} IS NULL"),
            })
            .collect();
        all.push(beyond);
        either.push(format!("({})", all.join(" AND ")));
    }
    let text = if either.is_empty() {
        "FALSE".to_string()
    } else {
        format!("({})", either.join(" OR "))
    };
    sql.done(text)
}

/// The grouping key of an aggregate: the grouped values as one JSON array,
/// `null` where a field is absent.
pub(super) fn group_key(paths: &[Vec<String>]) -> SqlExpr {
    let mut sql = Sql::default();
    let parts: Vec<String> = paths
        .iter()
        .map(|p| {
            let v = sql.value_at(p);
            format!("CASE WHEN jsonb_typeof({v}) = 'null' THEN NULL ELSE {v} END")
        })
        .collect();
    sql.done(format!("jsonb_build_array({})", parts.join(", ")))
}
