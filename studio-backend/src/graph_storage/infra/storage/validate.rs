//! Payload admission: shape, ceiling, and schema.
//!
//! This is the first slice of ADR-0003
//! (`cpt-cf-graph-storage-adr-metadata-partitioning`). What it does now:
//! rejects payloads that are not objects, enforces the size ceiling, and
//! validates against the type's registered JSON Schema when it has one.
//!
//! What it deliberately does not do yet: walk the GTS derivation chain so a
//! derived type inherits its ancestors' constraints, and read the
//! `x-gts-indexed` / `x-gts-vectorized` annotations. Validating against the
//! leaf type is strictly better than not validating and does not contradict the
//! final behaviour — a payload that satisfies the full chain also satisfies the
//! leaf.

use serde_json::Value;

use crate::graph_storage::domain::error::DomainError;

/// Reject a payload that is not a JSON object, or that exceeds the ceiling.
///
/// `key` names the row in the error, so a producer sending a large batch learns
/// which one was refused rather than that "a" payload was too big.
///
/// # Errors
/// Returns [`DomainError::PayloadNotAnObject`] or
/// [`DomainError::PayloadTooLarge`].
pub fn check_shape_and_size(key: &str, payload: &Value, max_bytes: u32) -> Result<(), DomainError> {
    if !payload.is_object() {
        return Err(DomainError::PayloadNotAnObject(key.to_owned()));
    }

    // Measured on the serialized form, which is what the column stores and what
    // index maintenance pays for — not on the in-memory tree.
    let size = serde_json::to_vec(payload)
        .map_err(|e| DomainError::Storage(format!("payload of {key} is not serializable: {e}")))?
        .len();

    if size > max_bytes as usize {
        return Err(DomainError::PayloadTooLarge {
            node_key: key.to_owned(),
            limit: max_bytes,
            actual: size,
        });
    }
    Ok(())
}

/// Validate a payload against a type's registered schema.
///
/// An empty schema (`{}`) means the type declares no constraints and everything
/// passes — which is what every type registered before schemas existed carries,
/// so this is additive rather than a migration.
///
/// # Errors
/// Returns [`DomainError::PayloadInvalid`] carrying the JSON pointer of the
/// first violation, as DESIGN requires of payload validation errors.
pub fn check_against_schema(key: &str, payload: &Value, schema: &Value) -> Result<(), DomainError> {
    if schema.as_object().is_none_or(serde_json::Map::is_empty) {
        return Ok(());
    }

    let validator = jsonschema::validator_for(schema).map_err(|e| {
        // A malformed schema is the ontology's fault, not the producer's, and
        // must not read as "your payload is wrong".
        DomainError::Storage(format!("registered schema is not usable: {e}"))
    })?;

    if let Some(first) = validator.iter_errors(payload).next() {
        return Err(DomainError::PayloadInvalid {
            node_key: key.to_owned(),
            pointer: first.instance_path().to_string(),
            message: first.to_string(),
        });
    }
    Ok(())
}

/// Reject an embedding whose length does not match the column.
///
/// # Errors
/// Returns [`DomainError::EmbeddingDimensionMismatch`].
pub fn check_embedding(key: &str, embedding: &[f32], expected: u16) -> Result<(), DomainError> {
    if embedding.len() != expected as usize {
        return Err(DomainError::EmbeddingDimensionMismatch {
            node_key: key.to_owned(),
            expected,
            actual: embedding.len(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_non_object_payload_is_refused() {
        assert!(matches!(
            check_shape_and_size("n", &json!([1, 2]), 1024),
            Err(DomainError::PayloadNotAnObject(_))
        ));
        assert!(check_shape_and_size("n", &json!({}), 1024).is_ok());
    }

    /// The ceiling is measured on the serialized form, and the error names the
    /// row — a producer sending a thousand nodes needs to know which one.
    #[test]
    fn the_ceiling_names_the_offending_row() {
        let big = json!({ "blob": "x".repeat(200) });
        match check_shape_and_size("file:big", &big, 64) {
            Err(DomainError::PayloadTooLarge {
                node_key,
                limit,
                actual,
            }) => {
                assert_eq!(node_key, "file:big");
                assert_eq!(limit, 64);
                assert!(actual > 64);
            }
            other => panic!("expected a ceiling error, got {other:?}"),
        }
    }

    /// An empty schema is what every type registered before schemas existed
    /// carries, so it has to admit everything.
    #[test]
    fn an_empty_schema_admits_anything() {
        assert!(check_against_schema("n", &json!({ "a": 1 }), &json!({})).is_ok());
    }

    #[test]
    fn a_violation_reports_its_json_pointer() {
        let schema = json!({
            "type": "object",
            "properties": { "size": { "type": "integer" } }
        });
        match check_against_schema("f", &json!({ "size": "big" }), &schema) {
            Err(DomainError::PayloadInvalid { pointer, .. }) => assert_eq!(pointer, "/size"),
            other => panic!("expected a schema violation, got {other:?}"),
        }
    }

    #[test]
    fn a_wrong_length_embedding_is_refused() {
        assert!(check_embedding("n", &[0.0; 3], 384).is_err());
        assert!(check_embedding("n", &[0.0; 384], 384).is_ok());
    }
}
