//! Checking an object against the type the model says it is.
//!
//! The registered graph type is open on purpose — that is what makes extending
//! a type a pure ontology edit — so nothing downstream enforces the model's
//! `required`, its declared types or its enums. Without this the model
//! *describes* objects without saying anything about them, which is the same
//! hole `create_relation` used to have for relations.
//!
//! Two deliberate limits:
//!
//! - **An undeclared field is never a violation.** The payload is open by
//!   design; a field the model has not caught up with is reported, not refused.
//! - **A type expression is checked only where it is unambiguous.** The model
//!   uses ~100 domain type names (`Money`, `RetryPolicy`, `WorkflowGraph`),
//!   most of them once. Inventing a shape for those would reject valid objects
//!   on a guess, so they are carried, not checked.

use serde_json::Value;

use super::ontology::EffectiveProperty;

/// How hard a write is checked against the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ValidateMode {
    /// Do not check at all.
    Off,
    /// Check and report; write anyway. The default, because the model declares
    /// fields no caller supplies (see [`PLATFORM_SUPPLIED`]) and a model with
    /// 560 required fields would otherwise refuse almost every object.
    #[default]
    Warn,
    /// Check and refuse the write if anything is violated.
    Strict,
}

impl ValidateMode {
    /// Parse the request's value. Unknown text is an error rather than a silent
    /// downgrade: a caller asking for `strict` and getting `warn` would be told
    /// its objects are fine when nothing checked them.
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            "" | "warn" => Ok(Self::Warn),
            "off" => Ok(Self::Off),
            "strict" => Ok(Self::Strict),
            other => Err(format!(
                "unknown validate mode `{other}` — expected off, warn or strict"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Warn => "warn",
            Self::Strict => "strict",
        }
    }
}

/// One way an object disagrees with its type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub field: String,
    /// `missing` | `type` | `enum`.
    pub kind: &'static str,
    pub detail: String,
}

/// What checking one payload found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub violations: Vec<Violation>,
    /// Fields the payload carries that the type does not declare. Legal — the
    /// payload is open — and worth surfacing: it is the model noticing it has
    /// fallen behind what is actually stored.
    pub undeclared: Vec<String>,
}

impl Report {
    pub fn is_clean(&self) -> bool {
        self.violations.is_empty()
    }
}

/// Fields the graph supplies on the node row rather than in the payload, so a
/// type declaring them required is satisfied without the caller sending them:
/// `tenant_id` and `id` are the node's tenant and key, and the timestamps are
/// its audit envelope.
const PLATFORM_SUPPLIED: [&str; 4] = ["tenant_id", "id", "created_at", "updated_at"];

/// Check `payload` against a type's effective properties.
pub fn check(properties: &[EffectiveProperty], payload: &Value) -> Report {
    let mut report = Report::default();
    let Some(object) = payload.as_object() else {
        report.violations.push(Violation {
            field: String::new(),
            kind: "type",
            detail: "the payload is not a JSON object".to_string(),
        });
        return report;
    };

    for property in properties {
        let value = object.get(&property.name);
        let present = value.is_some_and(|v| !v.is_null());
        if !present {
            if property.required && !PLATFORM_SUPPLIED.contains(&property.name.as_str()) {
                report.violations.push(Violation {
                    field: property.name.clone(),
                    kind: "missing",
                    detail: format!(
                        "required by {} ({})",
                        property.declared_by, property.type_expr
                    ),
                });
            }
            continue;
        }
        if let Some(violation) = check_value(property, value.expect("present")) {
            report.violations.push(violation);
        }
    }

    let declared: std::collections::HashSet<&str> =
        properties.iter().map(|p| p.name.as_str()).collect();
    report.undeclared = object
        .keys()
        // `_`-prefixed keys are the gear's own (`_scope`), not the caller's.
        .filter(|k| !k.starts_with('_') && !declared.contains(k.as_str()))
        .cloned()
        .collect();
    report.undeclared.sort();
    report
}

fn check_value(property: &EffectiveProperty, value: &Value) -> Option<Violation> {
    let expr = TypeExpr::parse(&property.type_expr);
    let violation = |kind: &'static str, detail: String| {
        Some(Violation {
            field: property.name.clone(),
            kind,
            detail,
        })
    };

    if expr.array {
        let Some(items) = value.as_array() else {
            return violation("type", format!("expected an array of {}", expr.base));
        };
        return items
            .iter()
            .find_map(|item| check_scalar(&expr, item))
            .and_then(|detail| violation(expr.kind_of_failure(), detail));
    }
    check_scalar(&expr, value).and_then(|detail| violation(expr.kind_of_failure(), detail))
}

/// `None` when the value fits, otherwise what was expected.
fn check_scalar(expr: &TypeExpr, value: &Value) -> Option<String> {
    if let Some(alternatives) = &expr.enumeration {
        let text = value.as_str()?;
        return (!alternatives.iter().any(|a| a == text))
            .then(|| format!("expected one of {}", alternatives.join(" | ")));
    }
    match expr.kind {
        Kind::Text if !value.is_string() => Some(format!("expected a string ({})", expr.base)),
        Kind::Number if !value.is_number() => Some(format!("expected a number ({})", expr.base)),
        Kind::Boolean if !value.is_boolean() => Some("expected a boolean".to_string()),
        _ => None,
    }
}

/// A parsed declared type: `Name`, `Name?`, `Name[]`, `a | b | c`.
struct TypeExpr {
    base: String,
    array: bool,
    enumeration: Option<Vec<String>>,
    kind: Kind,
}

#[derive(PartialEq, Eq)]
enum Kind {
    Text,
    Number,
    Boolean,
    /// One of the model's ~100 domain type names, or a shape this does not
    /// read. Carried, not checked.
    Unchecked,
}

impl TypeExpr {
    fn parse(raw: &str) -> Self {
        let mut base = raw.trim();
        // `?` is nullability, and absence is already handled by the caller.
        base = base.strip_suffix('?').unwrap_or(base).trim();
        let array = base.ends_with("[]");
        if array {
            base = base.trim_end_matches("[]").trim();
        }
        // A closed value set. Split before anything else reads the text as a
        // name: `draft | active | retired` is not a type called "draft ".
        let enumeration = base.contains('|').then(|| {
            base.split('|')
                .map(|a| a.trim().trim_end_matches('?').trim().to_string())
                .filter(|a| !a.is_empty())
                .collect()
        });
        let kind = if enumeration.is_some() {
            Kind::Text
        } else {
            kind_of(base)
        };
        Self {
            base: base.to_string(),
            array,
            enumeration,
            kind,
        }
    }

    fn kind_of_failure(&self) -> &'static str {
        if self.enumeration.is_some() {
            "enum"
        } else {
            "type"
        }
    }
}

/// The JSON shape a declared name implies, where it implies one unambiguously.
///
/// The `Id`/`Ref` suffixes are the model's own convention for an identifier or
/// a pointer, and both are carried as strings — that covers `EntityId`,
/// `EntityRef`, `TypeId`, `ActorRef` and the rest of the long tail without
/// naming each. Everything else is left unchecked rather than guessed at.
fn kind_of(base: &str) -> Kind {
    match base {
        "string" | "timestamp" | "TextContent" | "URL" | "URI" | "Email" | "MIME" | "regex"
        | "Locale" | "SHA" | "Hash" | "Signature" | "duration" => Kind::Text,
        "integer" | "int" | "number" | "decimal" => Kind::Number,
        "boolean" => Kind::Boolean,
        _ if base.ends_with("Id") || base.ends_with("Ref") => Kind::Text,
        _ => Kind::Unchecked,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn property(name: &str, type_expr: &str, required: bool) -> EffectiveProperty {
        EffectiveProperty {
            name: name.to_string(),
            type_expr: type_expr.to_string(),
            required,
            description: String::new(),
            declared_by: "team".to_string(),
        }
    }

    #[test]
    fn a_missing_required_field_is_a_violation_unless_the_graph_supplies_it() {
        let props = [
            property("name", "string", true),
            property("tenant_id", "TenantId", true),
            property("note", "string", false),
        ];
        let report = check(&props, &json!({}));
        assert_eq!(report.violations.len(), 1);
        assert_eq!(report.violations[0].field, "name");
        assert_eq!(report.violations[0].kind, "missing");
    }

    #[test]
    fn declared_shapes_are_checked_and_unknown_ones_are_not() {
        let props = [
            property("name", "string", false),
            property("count", "integer", false),
            property("active", "boolean", false),
            property("owner", "EntityRef", false),
            property("budget", "Money", false),
        ];
        let report = check(
            &props,
            &json!({
                "name": 7,
                "count": "many",
                "active": "yes",
                "owner": 1,
                // `Money` is one of the model's ~100 domain names — carried, not guessed at.
                "budget": {"amount": 10},
            }),
        );
        let fields: Vec<&str> = report.violations.iter().map(|v| v.field.as_str()).collect();
        assert_eq!(fields, ["name", "count", "active", "owner"]);
        assert!(report.violations.iter().all(|v| v.kind == "type"));
    }

    #[test]
    fn an_enum_admits_only_its_alternatives() {
        let props = [property("status", "planned | active | archived", false)];
        assert!(check(&props, &json!({ "status": "active" })).is_clean());
        let report = check(&props, &json!({ "status": "started" }));
        assert_eq!(report.violations[0].kind, "enum");
        assert!(
            report.violations[0]
                .detail
                .contains("planned | active | archived")
        );
    }

    #[test]
    fn arrays_are_checked_element_by_element() {
        let props = [property("tags", "string[]", false)];
        assert!(check(&props, &json!({ "tags": ["a", "b"] })).is_clean());
        assert_eq!(check(&props, &json!({ "tags": "a" })).violations.len(), 1);
        assert_eq!(
            check(&props, &json!({ "tags": ["a", 2] })).violations.len(),
            1
        );
    }

    #[test]
    fn an_optional_declared_null_is_absent_not_wrong() {
        let props = [property("started_at", "timestamp?", false)];
        assert!(check(&props, &json!({ "started_at": null })).is_clean());
    }

    #[test]
    fn an_undeclared_field_is_reported_and_never_a_violation() {
        let props = [property("name", "string", false)];
        let report = check(
            &props,
            &json!({ "name": "x", "cost_center": "CC-42", "_scope": "w1" }),
        );
        assert!(report.is_clean());
        // `_scope` is ours, not the caller's.
        assert_eq!(report.undeclared, ["cost_center"]);
    }

    #[test]
    fn a_mode_that_was_asked_for_is_never_silently_downgraded() {
        assert_eq!(ValidateMode::parse("strict"), Ok(ValidateMode::Strict));
        assert_eq!(ValidateMode::parse(""), Ok(ValidateMode::Warn));
        assert!(ValidateMode::parse("lenient").is_err());
    }
}
