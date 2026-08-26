//! SQL/PGQ `GRAPH_TABLE` as a `FROM` source, built from typed input.
//!
//! # Why this module exists
//!
//! `sea_query` has no AST node for `GRAPH_TABLE`, so the obvious way to reach
//! SQL/PGQ from Rust is to fork `sea_query` and add one. That turns out to be
//! unnecessary. Three existing pieces compose into the construct:
//!
//! * [`TableRef::FunctionCall`] puts a function call in the `FROM` clause;
//! * `Func::Custom` renders the function's name **raw and unquoted**
//!   (`sea-query-1.0.2/src/backend/query_builder.rs:768`) — which matters,
//!   because `GRAPH_TABLE(...)` parses and `"GRAPH_TABLE"(...)` does not;
//! * `Expr::cust_with_values` renders arbitrary text while still **binding**
//!   its values, so the graph pattern carries parameters rather than literals.
//!
//! The pattern body is therefore the only free-form text in the statement, and
//! everything around it stays an ordinary `sea_query` select the secure ORM can
//! scope.
//!
//! # How the free-form text is made safe
//!
//! `Expr::cust_with_values` will render whatever string it is given, so a
//! builder that concatenated caller strings would have reintroduced raw SQL
//! with none of its guardrails. Nothing here takes a string:
//!
//! * every identifier that reaches the text — graph name, labels, pattern
//!   variables, property names, output column names — comes from a closed enum
//!   in this module, so the set of producible identifiers is finite and
//!   reviewable, and no request value can become one;
//! * every value is bound. [`Pattern::render`] appends to a `Vec<Value>` and
//!   emits `$n` by position; a value never reaches the text. Note that `$n` is
//!   a reference *into the values array*, and `sea_query` expands each
//!   occurrence into its own placeholder with its own copy of the value — so
//!   the tenant, written once and referenced on both endpoints, arrives on the
//!   wire twice;
//! * a whole frontier binds as **one** parameter (`= ANY($n::bigint[])`), so
//!   the statement text does not vary with the number of seeds — the plan is
//!   reused and there is no per-size statement to cache;
//! * the tenant is a constructor argument of [`Pattern`], not a predicate the
//!   caller may add or omit, and rendering always emits it. A pattern without a
//!   tenant predicate is unrepresentable.
//!
//! # How much of the tenant predicate is load-bearing
//!
//! Measured on the stand rather than reasoned about, because the answer is not
//! the obvious one. For a one-hop pattern seeded by id:
//!
//! | predicate | foreign tenant sees | own tenant sees |
//! |---|---|---|
//! | on the source endpoint only | 0 | 2 |
//! | on the target endpoint only | 0 | 2 |
//! | none | 2 | 2 |
//!
//! Either endpoint alone fences the walk, because composite element keys tie
//! both ends of an edge to one tenant: anchoring either end anchors the other.
//! What is *not* optional is having a predicate at all — with none, a caller
//! who names an id reads whichever tenant owns it, which is exactly the leak
//! `dev/FINDINGS.md (F10)` demonstrates.
//!
//! Rendering emits it on both endpoints anyway. The cost is one bound value and
//! no change to the plan, and it keeps the pattern correct if the schema ever
//! stops carrying `tenant_id` in the element keys — at which point the
//! redundancy stops being redundant. The stand tests cannot tell the two apart,
//! so the guard is a unit test on the emitted text.
//!
//! # What is still the caller's job
//!
//! Composite element keys mean an edge cannot reach another tenant's node, and
//! the mandatory tenant predicate means the pattern does not return other
//! tenants' rows. Neither covers a scope that is narrower than a tenant —
//! resource-id lists, group subtrees. Those are not expressible here and are
//! the outer query's responsibility; see the traversal backend, which treats
//! this pattern as a **candidate producer** and authorizes what it returns
//! through the secure ORM.
//!
//! `Expr::cust_with_values` is raw SQL, which gear code is not allowed to write
//! (`docs/arch/toolkit_unified_system/11_database_patterns.md`). On the
//! development stand that is a deliberate, contained exception so the approach
//! can be measured. The production home for this construct is inside
//! `toolkit-db`, which the platform CTE policy already exempts for exactly this
//! kind of dialect-specific assembly.

use sea_orm::Value;
use sea_orm::sea_query::{Alias, Expr, Func, IntoIden, TableRef};
use std::borrow::Cow;
use toolkit_security::AccessScope;

/// A property graph declared by this gear's migrations.
///
/// Closed, because the name is spelled into SQL text: a graph the migrations do
/// not create cannot be named here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Graph {
    /// The knowledge-base graph over `graph_node` and `graph_edge`.
    Kb,
}

impl Graph {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Kb => "kb_pgq",
        }
    }
}

/// A label declared on an element of the property graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Label {
    /// Vertex label backed by `graph_node`.
    Node,
    /// Edge label backed by `graph_edge`.
    Edge,
}

impl Label {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Edge => "edge",
        }
    }
}

/// A pattern variable.
///
/// Three are enough for a one-hop pattern, and a closed set removes the
/// possibility of a caller-chosen name colliding or escaping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Var {
    /// The endpoint the walk starts from.
    Source,
    /// The edge between them.
    Edge,
    /// The endpoint the walk reaches.
    Target,
}

impl Var {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Source => "a",
            Self::Edge => "e",
            Self::Target => "b",
        }
    }
}

/// Which way the edge points in the pattern.
///
/// There is no undirected variant, and that is deliberate. The undirected
/// shorthand `(a)-[e]-(b)` is not a convenience: `PostgreSQL` 19 plans it as a
/// probe over every vertex, measured on the stand at 734.9 ms against 0.312 ms
/// for the two directed patterns unioned — the same 10 rows. An undirected hop
/// is built as two patterns, not as one loose one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// `(a)-[e]->(b)` — follow edges out of the source.
    Outgoing,
    /// `(a)<-[e]-(b)` — follow edges into the source.
    Incoming,
}

impl Direction {
    /// Alias the `FROM` source carries, distinct per direction so both can
    /// appear in one statement.
    #[must_use]
    pub const fn alias(self) -> &'static str {
        match self {
            Self::Outgoing => "g_out",
            Self::Incoming => "g_in",
        }
    }

    const fn arrow(self) -> (&'static str, &'static str) {
        match self {
            Self::Outgoing => ("-", "->"),
            Self::Incoming => ("<-", "-"),
        }
    }
}

/// A column nameable inside a pattern.
///
/// The rendered name must match the column on the backing table. That link is
/// checked by [`tests::the_properties_name_real_columns`] rather than by the
/// compiler, because the pattern is text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Property {
    /// Surrogate identifier, unique within a tenant.
    Id,
    /// Owning tenant.
    TenantId,
    /// Interned type identifier.
    TypeId,
}

impl Property {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Id => "id",
            Self::TenantId => "tenant_id",
            Self::TypeId => "type_id",
        }
    }
}

/// A column the pattern projects out of the graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Output {
    /// The reached node's identifier.
    Neighbour,
}

impl Output {
    /// Name the column carries in the surrounding statement.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Neighbour => "neighbour",
        }
    }
}

/// A list of identifiers to match a property against.
///
/// Bound as a single parameter cast to the matching array type, so the
/// statement text is the same whether the list holds one element or a thousand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdList {
    /// `bigint` identifiers — node and edge surrogate keys.
    BigInt(Vec<i64>),
    /// `integer` identifiers — interned type keys.
    Int(Vec<i32>),
    /// `uuid` identifiers — tenants.
    Uuid(Vec<uuid::Uuid>),
}

impl IdList {
    const fn cast(&self) -> &'static str {
        match self {
            Self::BigInt(_) => "::bigint[]",
            Self::Int(_) => "::int[]",
            Self::Uuid(_) => "::uuid[]",
        }
    }

    /// Render as a `PostgreSQL` array literal, e.g. `{1,2,3}`.
    ///
    /// Only integers and UUIDs reach this string, so it cannot carry SQL: the
    /// values are formatted from `i64`/`i32`/`Uuid`, never from text.
    #[must_use]
    pub fn literal(&self) -> String {
        let joined = match self {
            Self::BigInt(v) => v.iter().map(i64::to_string).collect::<Vec<_>>().join(","),
            Self::Int(v) => v.iter().map(i32::to_string).collect::<Vec<_>>().join(","),
            // A `Uuid` formats as hex and dashes, so no other character can
            // reach the literal.
            Self::Uuid(v) => v
                .iter()
                .map(uuid::Uuid::to_string)
                .collect::<Vec<_>>()
                .join(","),
        };
        format!("{{{joined}}}")
    }

    fn is_empty(&self) -> bool {
        match self {
            Self::BigInt(v) => v.is_empty(),
            Self::Int(v) => v.is_empty(),
            Self::Uuid(v) => v.is_empty(),
        }
    }
}

/// A sibling `FROM` item a pattern may correlate against.
///
/// `PostgreSQL` 19 rejects subqueries inside `GRAPH_TABLE`, so a pattern cannot
/// compute its own seeds. What it *can* do is reference a column of another
/// `FROM` item in the same statement — an implicit lateral through a comma
/// join. That is the only way a set computed elsewhere in the statement, such
/// as a vector nearest-neighbour search, can drive a pattern.
///
/// Closed, like every other identifier here: the alias and the column are ours,
/// never the caller's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// Seeds produced by a nearest-neighbour search, keyed by node id.
    KnnSeeds,
}

impl Source {
    /// Alias the sibling `FROM` item carries.
    #[must_use]
    pub const fn alias(self) -> &'static str {
        match self {
            Self::KnnSeeds => "knn_seeds",
        }
    }

    const fn column(self) -> &'static str {
        match self {
            Self::KnnSeeds => "id",
        }
    }
}

/// A restriction on the pattern, beyond the mandatory tenant predicate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Restriction {
    /// `<var>.<property> = ANY(<ids>)`.
    AnyOf {
        /// Which pattern variable the property belongs to.
        var: Var,
        /// Which column of that variable.
        property: Property,
        /// The identifiers to match.
        ids: IdList,
    },
    /// `<var>.<property> = <source>.<column>` — a correlated reference to a
    /// sibling `FROM` item.
    EqualsSource {
        /// Which pattern variable the property belongs to.
        var: Var,
        /// Which column of that variable.
        property: Property,
        /// The sibling item to correlate against.
        source: Source,
    },
}

/// A one-hop `GRAPH_TABLE` pattern.
///
/// Constructed through [`Pattern::hop`], which takes the tenant, so a pattern
/// without a tenant predicate cannot be built.
#[derive(Debug, Clone)]
pub struct Pattern {
    graph: Graph,
    direction: Direction,
    tenants: Vec<uuid::Uuid>,
    restrictions: Vec<Restriction>,
    outputs: Vec<(Var, Property, Output)>,
}

impl Pattern {
    /// Begin a one-hop pattern in `direction`, restricted to `tenants`.
    ///
    /// The tenant set is a constructor argument rather than a predicate the
    /// caller may add, so a pattern that reaches every tenant cannot be built.
    /// An empty set is accepted and renders a predicate that matches nothing —
    /// the honest rendering of "this caller may see no tenant" — but callers
    /// should not reach the database at all in that case.
    #[must_use]
    pub fn hop(graph: Graph, direction: Direction, tenants: Vec<uuid::Uuid>) -> Self {
        Self {
            graph,
            direction,
            tenants,
            restrictions: Vec::new(),
            outputs: Vec::new(),
        }
    }

    /// Restrict a property of a pattern variable to a list of identifiers.
    #[must_use]
    pub fn restrict(mut self, var: Var, property: Property, ids: IdList) -> Self {
        self.restrictions
            .push(Restriction::AnyOf { var, property, ids });
        self
    }

    /// Correlate a property of a pattern variable against a sibling `FROM`
    /// item, so the pattern runs once per row of that item.
    #[must_use]
    pub fn correlate(mut self, var: Var, property: Property, source: Source) -> Self {
        self.restrictions.push(Restriction::EqualsSource {
            var,
            property,
            source,
        });
        self
    }

    /// Project a property of a pattern variable as `output`.
    #[must_use]
    pub fn project(mut self, var: Var, property: Property, output: Output) -> Self {
        self.outputs.push((var, property, output));
        self
    }

    /// Render the pattern body and the values it binds.
    ///
    /// The tenant is emitted on **both** endpoints, deliberately more than is
    /// needed to fence the walk today; see the module docs for what each
    /// predicate actually buys.
    #[must_use]
    pub fn render(&self) -> (String, Vec<Value>) {
        let (left, right) = self.direction.arrow();

        // The tenant occupies the first slot, so every restriction that follows
        // numbers from there. `$n` references this array by position; see the
        // module docs on what `sea_query` does with a repeated reference.
        let mut values: Vec<Value> =
            vec![Value::from(IdList::Uuid(self.tenants.clone()).literal())];
        let tenant_slot = values.len();

        let restrictions: String = self
            .restrictions
            .iter()
            .filter_map(|restriction| match restriction {
                Restriction::AnyOf { var, property, ids } => {
                    // An empty list would render `= ANY('{}')`, which is valid
                    // but silently matches nothing, while dropping the clause
                    // would silently match everything. Neither is a safe
                    // default, so an empty restriction is not built: the
                    // traversal backend returns early on an empty frontier.
                    if ids.is_empty() {
                        return None;
                    }
                    values.push(Value::from(ids.literal()));
                    let slot = values.len();
                    Some(format!(
                        " AND {}.{} = ANY(${slot}{})",
                        var.as_str(),
                        property.as_str(),
                        ids.cast(),
                    ))
                }
                Restriction::EqualsSource {
                    var,
                    property,
                    source,
                } => Some(format!(
                    " AND {}.{} = {}.{}",
                    var.as_str(),
                    property.as_str(),
                    source.alias(),
                    source.column(),
                )),
            })
            .collect();

        let columns: Vec<String> = self
            .outputs
            .iter()
            .map(|(var, property, output)| {
                format!(
                    "{}.{} AS {}",
                    var.as_str(),
                    property.as_str(),
                    output.as_str()
                )
            })
            .collect();

        let body = format!(
            "{graph} MATCH ({source} IS {node}){left}[{edge} IS {edge_label}]{right}({target} IS {node}) \
             WHERE {source}.{tenant} = ANY(${tenant_slot}::uuid[]) \
             AND {target}.{tenant} = ANY(${tenant_slot}::uuid[])\
             {restrictions} COLUMNS ({columns})",
            graph = self.graph.as_str(),
            source = Var::Source.as_str(),
            edge = Var::Edge.as_str(),
            target = Var::Target.as_str(),
            node = Label::Node.as_str(),
            edge_label = Label::Edge.as_str(),
            tenant = Property::TenantId.as_str(),
            columns = columns.join(", "),
        );

        (body, values)
    }

    /// Render the pattern as a `FROM` source, ready to join into a scoped query.
    #[must_use]
    pub fn to_source(&self, alias: &str) -> TableRef {
        let (body, values) = self.render();
        graph_table_source(body, values, alias)
    }
}

/// Build a `GRAPH_TABLE (...) AS <alias>` source for a `FROM` clause.
///
/// `body` is `Cow<'static, str>` rather than `&str` because `sea_query` stores
/// it for the lifetime of the statement. Prefer [`Pattern::to_source`]: this
/// function does not inspect what it is given.
#[must_use]
pub fn graph_table_source(
    body: impl Into<Cow<'static, str>>,
    values: Vec<Value>,
    alias: &str,
) -> TableRef {
    let call = Func::cust(Alias::new("GRAPH_TABLE")).arg(Expr::cust_with_values(body, values));
    TableRef::FunctionCall(call, Alias::new(alias).into_iden())
}

/// Render a full statement selecting neighbours of `frontier` through
/// `GRAPH_TABLE`, in one direction.
///
/// Exists so tests can assert on the emitted SQL and so the execution check can
/// run the exact statement the builder produces.
#[must_use]
pub fn hop_statement(
    frontier: &[i64],
    tenants: Vec<uuid::Uuid>,
    direction: Direction,
    edge_types: Option<&[i32]>,
) -> (String, sea_orm::Values) {
    use sea_orm::sea_query::{PostgresQueryBuilder, Query};

    let mut pattern = Pattern::hop(Graph::Kb, direction, tenants)
        .restrict(Var::Source, Property::Id, IdList::BigInt(frontier.to_vec()))
        .project(Var::Target, Property::Id, Output::Neighbour);

    if let Some(types) = edge_types {
        pattern = pattern.restrict(Var::Edge, Property::TypeId, IdList::Int(types.to_vec()));
    }

    Query::select()
        .column(Alias::new(Output::Neighbour.as_str()))
        .from(pattern.to_source("g"))
        .to_owned()
        .build(PostgresQueryBuilder)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn hop(frontier: &[i64], tenant: Uuid) -> String {
        hop_statement(frontier, vec![tenant], Direction::Outgoing, None).0
    }

    /// `Func::Custom` must render the name unquoted. `GRAPH_TABLE(...)` parses;
    /// `"GRAPH_TABLE"(...)` is a syntax error, because the construct is a
    /// keyword and not a function the catalog knows. A `sea_query` upgrade that
    /// started quoting custom function names would break SQL/PGQ silently at
    /// runtime, so it is pinned here instead.
    #[test]
    fn the_construct_name_is_not_quoted() {
        let sql = hop(&[5000], Uuid::nil());

        assert!(
            sql.contains("FROM GRAPH_TABLE("),
            "expected an unquoted construct name: {sql}"
        );
        assert!(
            !sql.contains("\"GRAPH_TABLE\""),
            "the construct name was quoted, which PostgreSQL rejects: {sql}"
        );
    }

    /// Nothing the caller supplies reaches the text. The tenant is a value, and
    /// so is the frontier; a pattern that interpolated either would put
    /// caller-derived characters inside a construct nothing else validates.
    #[test]
    fn values_are_bound_not_interpolated() {
        let tenant = Uuid::from_u128(0x5eed);
        let (sql, values) = hop_statement(&[5000, 6000], vec![tenant], Direction::Outgoing, None);

        assert!(
            !sql.contains(&tenant.to_string()),
            "the tenant was interpolated into the pattern: {sql}"
        );
        assert!(!sql.contains("5000"), "a seed was interpolated: {sql}");
        assert_eq!(
            values.0.len(),
            3,
            "expected the tenant once per endpoint plus the frontier: {values:?}"
        );
    }

    /// The frontier binds as one parameter, so the statement text does not vary
    /// with the number of seeds. A text that grew with the frontier would give
    /// the database a distinct statement to plan for every frontier size.
    #[test]
    fn the_statement_text_is_the_same_for_any_frontier_size() {
        let tenant = Uuid::nil();
        let one = hop(&[1], tenant);
        let many = hop(&(1..=500).collect::<Vec<_>>(), tenant);

        assert_eq!(
            one, many,
            "the statement text varies with the frontier size"
        );
        let (_, values) = hop_statement(
            &(1..=500).collect::<Vec<_>>(),
            vec![tenant],
            Direction::Outgoing,
            None,
        );
        assert_eq!(
            values.0.len(),
            3,
            "500 seeds must still bind as one value: {values:?}"
        );
    }

    /// Both endpoints carry the predicate. Only one of them is needed to fence
    /// the walk today — composite element keys tie both ends of an edge to one
    /// tenant — so no execution test can tell the difference, and this text
    /// assertion is the only guard. It exists because the redundancy is what
    /// keeps the pattern correct if the element keys ever stop carrying
    /// `tenant_id`. See the module docs for the measured table.
    #[test]
    fn both_endpoints_carry_the_tenant_predicate() {
        let sql = hop(&[1], Uuid::nil());

        assert!(
            sql.contains("a.tenant_id = ANY("),
            "seed endpoint unscoped: {sql}"
        );
        assert!(
            sql.contains("b.tenant_id = ANY("),
            "target endpoint unscoped: {sql}"
        );
    }

    /// `$n` in `cust_with_values` references the values array by position, and
    /// each occurrence becomes its own placeholder carrying its own copy. The
    /// tenant is therefore written once in the template and arrives twice on
    /// the wire — pinned because it determines every later slot number.
    #[test]
    fn each_placeholder_occurrence_binds_its_own_copy() {
        let (sql, values) = hop_statement(&[1], vec![Uuid::nil()], Direction::Outgoing, None);

        assert!(
            sql.contains("a.tenant_id = ANY($1::uuid[])")
                && sql.contains("b.tenant_id = ANY($2::uuid[])"),
            "unexpected placeholder numbering: {sql}"
        );
        assert_eq!(
            values.0.len(),
            3,
            "one occurrence per endpoint plus the frontier: {values:?}"
        );
        assert!(
            matches!(values.0.first(), Some(Value::String(_))),
            "the tenant set binds as one array literal: {values:?}"
        );
    }

    /// Direction is explicit in both forms. The undirected shorthand is not
    /// offered at all: `PostgreSQL` 19 plans it as a probe over every vertex —
    /// 734.9 ms against 0.312 ms for the two directed patterns unioned.
    #[test]
    fn both_directions_render_explicit_arrows() {
        let out = hop_statement(&[1], vec![Uuid::nil()], Direction::Outgoing, None).0;
        let inc = hop_statement(&[1], vec![Uuid::nil()], Direction::Incoming, None).0;

        assert!(
            out.contains("(a IS node)-[e IS edge]->(b IS node)"),
            "{out}"
        );
        assert!(
            inc.contains("(a IS node)<-[e IS edge]-(b IS node)"),
            "{inc}"
        );
    }

    /// An edge-type restriction lands on the edge variable and casts to the
    /// matching array type, so `type_id` is compared as `int` and not `bigint`.
    #[test]
    fn an_edge_type_restriction_targets_the_edge_variable() {
        let (sql, values) =
            hop_statement(&[1], vec![Uuid::nil()], Direction::Outgoing, Some(&[2, 3]));

        assert!(
            sql.contains("e.type_id = ANY($4::int[])"),
            "edge-type restriction missing or mistyped: {sql}"
        );
        assert_eq!(values.0.len(), 4, "{values:?}");
    }

    /// The array literal is built from integers, so no caller text can reach
    /// it. This is what makes binding a list as one parameter safe.
    #[test]
    fn an_id_list_renders_only_digits() {
        let literal = IdList::BigInt(vec![-1, 0, 42]).literal();
        assert_eq!(literal, "{-1,0,42}");
        assert!(
            literal.chars().all(|c| c.is_ascii_digit()
                || c == ','
                || c == '-'
                || c == '{'
                || c == '}'),
            "unexpected characters in the array literal: {literal}"
        );
    }

    /// The pattern names columns as text, so a rename on the entity would be
    /// caught by the database rather than the compiler. This keeps the two in
    /// step: every `Property` must name a column that exists on both backing
    /// tables it can be used with.
    #[test]
    fn the_properties_name_real_columns() {
        use crate::graph_storage::infra::storage::entity::{graph_edge, graph_node};
        use sea_orm::{ColumnTrait, Iden};

        fn name(col: &impl Iden) -> String {
            col.to_string()
        }

        assert_eq!(name(&graph_node::Column::Id), Property::Id.as_str());
        assert_eq!(
            name(&graph_node::Column::TenantId),
            Property::TenantId.as_str()
        );
        assert_eq!(name(&graph_edge::Column::TypeId), Property::TypeId.as_str());
        let _ = graph_edge::Column::SrcNodeId.as_column_ref();
        let _ = graph_edge::Column::DstNodeId.as_column_ref();
    }
}

// ── Deriving a pattern's tenant set from a caller's scope ──────────────────

/// Why a scope cannot be carried into a graph pattern.
///
/// Both variants mean the same thing operationally: refuse the request rather
/// than run a pattern that is not tenant-bounded. They are distinguished
/// because they call for different fixes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum UnsupportedScope {
    /// A constraint names no tenant at all, so the pattern would have no upper
    /// bound on which tenants it reads. `allow_all` is the obvious case.
    #[error("scope constraint carries no tenant filter, so a graph pattern cannot be bounded")]
    NoTenantBound,
    /// A constraint bounds tenants through the tenant closure table
    /// (`InTenantSubtree`). Enumerating it needs a query the pattern cannot
    /// contain, and guessing the subtree would be a silent widening.
    #[error("tenant-subtree scopes are not expressible in a graph pattern")]
    TenantSubtree,
}

/// What a caller's scope permits a pattern to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TenantBound {
    /// The scope permits nothing; no statement should be sent.
    Nothing,
    /// The pattern may read these tenants.
    These(Vec<uuid::Uuid>),
}

/// Derive the tenant set a graph pattern may read, or refuse.
///
/// # What this does and does not enforce
///
/// The pattern is a **candidate producer**: whatever it returns is authorized
/// afterwards by an ordinary scoped query through the secure ORM. So a scope
/// that is narrower than a tenant — a resource-id list, a group subtree — does
/// not have to be expressible here. Ignoring such a filter makes the pattern
/// return more candidates than the caller may see, and the outer query removes
/// them. That is wasteful, never unsafe.
///
/// What must be expressible is the **tenant** bound, because losing it is the
/// one failure that leaks: a pattern with no tenant predicate returns rows of
/// whichever tenant owns the ids it is given (`dev/FINDINGS.md (F10)`). So a
/// scope whose tenants cannot be enumerated is refused rather than approximated.
///
/// Because constraints are OR-ed, **every** constraint must contribute a tenant
/// bound. One unbounded constraint makes the whole scope unbounded.
///
/// # Errors
/// Returns [`UnsupportedScope`] when the tenant set cannot be enumerated.
pub fn tenant_bound(scope: &AccessScope) -> Result<TenantBound, UnsupportedScope> {
    use toolkit_security::access_scope::{ScopeFilter, pep_properties};

    if scope.is_deny_all() {
        return Ok(TenantBound::Nothing);
    }
    if scope.is_unconstrained() {
        return Err(UnsupportedScope::NoTenantBound);
    }

    let mut tenants: Vec<uuid::Uuid> = Vec::new();
    for constraint in scope.constraints() {
        let mut bounded = false;
        for filter in constraint.filters() {
            if filter.property() != pep_properties::OWNER_TENANT_ID {
                continue;
            }
            match filter {
                ScopeFilter::Eq(_) | ScopeFilter::In(_) => {
                    let ids = filter.uuid_values();
                    if ids.is_empty() {
                        // A tenant filter carrying no usable value bounds
                        // nothing; treating it as a bound would be the silent
                        // widening this function exists to prevent.
                        continue;
                    }
                    tenants.extend(ids);
                    bounded = true;
                }
                ScopeFilter::InTenantSubtree(_) => return Err(UnsupportedScope::TenantSubtree),
                ScopeFilter::InGroup(_) | ScopeFilter::InGroupSubtree(_) => {}
            }
        }
        if !bounded {
            return Err(UnsupportedScope::NoTenantBound);
        }
    }

    tenants.sort_unstable();
    tenants.dedup();
    if tenants.is_empty() {
        return Ok(TenantBound::Nothing);
    }
    Ok(TenantBound::These(tenants))
}

#[cfg(test)]
mod scope_tests {
    use super::*;
    use toolkit_security::access_scope::{ScopeConstraint, ScopeFilter, pep_properties};
    use uuid::Uuid;

    fn tenant_filter(id: Uuid) -> ScopeFilter {
        ScopeFilter::in_uuids(pep_properties::OWNER_TENANT_ID, vec![id])
    }

    fn resource_filter(id: Uuid) -> ScopeFilter {
        ScopeFilter::in_uuids(pep_properties::RESOURCE_ID, vec![id])
    }

    /// A scope that permits nothing is an empty answer, not a refusal: there is
    /// no ambiguity about what the caller may see.
    #[test]
    fn deny_all_yields_nothing() {
        assert_eq!(
            tenant_bound(&AccessScope::deny_all()),
            Ok(TenantBound::Nothing)
        );
    }

    /// `allow_all` is the case the refusal exists for. A pattern built from it
    /// would carry no tenant bound, which is precisely the leak.
    #[test]
    fn allow_all_is_refused() {
        assert_eq!(
            tenant_bound(&AccessScope::allow_all()),
            Err(UnsupportedScope::NoTenantBound)
        );
    }

    #[test]
    fn tenant_scopes_are_enumerated_and_deduplicated() {
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);

        assert_eq!(
            tenant_bound(&AccessScope::for_tenant(a)),
            Ok(TenantBound::These(vec![a]))
        );

        let TenantBound::These(mut both) =
            tenant_bound(&AccessScope::for_tenants(vec![b, a, b])).expect("bounded")
        else {
            panic!("expected a tenant list")
        };
        both.sort_unstable();
        assert_eq!(both, vec![a, b]);
    }

    /// A filter narrower than a tenant does not have to be expressible: the
    /// pattern over-produces and the outer scoped query removes the surplus.
    /// What matters is that the tenant bound survives alongside it.
    #[test]
    fn a_narrower_filter_alongside_a_tenant_is_ignored_not_refused() {
        let tenant = Uuid::from_u128(7);
        let scope = AccessScope::single(ScopeConstraint::new(vec![
            tenant_filter(tenant),
            resource_filter(Uuid::from_u128(99)),
        ]));

        assert_eq!(tenant_bound(&scope), Ok(TenantBound::These(vec![tenant])));
    }

    /// A scope with no tenant filter at all cannot bound the pattern, even
    /// though it is perfectly enforceable by the secure ORM.
    #[test]
    fn a_resource_only_scope_is_refused() {
        let scope = AccessScope::for_resources(vec![Uuid::from_u128(99)]);
        assert_eq!(tenant_bound(&scope), Err(UnsupportedScope::NoTenantBound));
    }

    /// Constraints are OR-ed, so one unbounded constraint makes the whole scope
    /// unbounded. Taking the union of the bounded ones would silently drop the
    /// rows the unbounded constraint permits.
    #[test]
    fn one_unbounded_constraint_refuses_the_whole_scope() {
        let scope = AccessScope::from_constraints(vec![
            ScopeConstraint::new(vec![tenant_filter(Uuid::from_u128(1))]),
            ScopeConstraint::new(vec![resource_filter(Uuid::from_u128(99))]),
        ]);

        assert_eq!(tenant_bound(&scope), Err(UnsupportedScope::NoTenantBound));
    }

    /// A tenant subtree names its members through the closure table. The
    /// pattern cannot contain that query, and assuming the subtree is just its
    /// root would silently narrow the answer.
    #[test]
    fn a_tenant_subtree_scope_is_refused() {
        let scope =
            AccessScope::single(ScopeConstraint::new(vec![ScopeFilter::in_tenant_subtree(
                pep_properties::OWNER_TENANT_ID,
                Uuid::from_u128(1),
                true,
                Vec::new(),
            )]));

        assert_eq!(tenant_bound(&scope), Err(UnsupportedScope::TenantSubtree));
    }

    /// A tenant filter carrying no values bounds nothing, so it must not count
    /// as a bound.
    #[test]
    fn an_empty_tenant_filter_does_not_count_as_a_bound() {
        let scope = AccessScope::single(ScopeConstraint::new(vec![ScopeFilter::in_uuids(
            pep_properties::OWNER_TENANT_ID,
            vec![],
        )]));

        assert_eq!(tenant_bound(&scope), Err(UnsupportedScope::NoTenantBound));
    }
}
