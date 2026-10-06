//! `Idempotency-Key`: the request header that makes starting work safe to repeat.
//!
//! Every operation that answers `202` with a `run_id` starts a studio-tasks run
//! (docs/api-conventions.md D1). A client whose request timed out cannot tell
//! "never arrived" from "arrived, answer lost", so the only safe retry is one
//! the server recognises. The header is how it recognises it: its value becomes
//! the run's `idempotency_key`, and `tasks::service::TaskService::enqueue`
//! hands back the run already recorded under that key in the tenant instead of
//! queueing a second one. A replay therefore answers the same `202` with the
//! same `run_id`.
//!
//! A client sends one fresh value per user action (`crypto.randomUUID()`) and
//! reuses it only for that action's own retry. Absent, the request starts new
//! work every time, exactly as before.
//!
//! Parsed here once so every gear refuses a bad key with the same words, and
//! declared here once so every operation documents it the same way.

use axum::http::HeaderMap;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::ParamSpec;
use toolkit_canonical_errors::resource_error;

/// The header name, as the OpenAPI document and the portals spell it.
pub const HEADER: &str = "Idempotency-Key";

/// Longest key accepted. A UUID is 36; the ceiling exists so a key cannot be
/// used to park arbitrary text in the run table.
pub const MAX_LEN: usize = 255;

/// A malformed `Idempotency-Key`: the caller's to fix, never a server fault.
#[resource_error(gts_id!("cf.studio._.idempotency.v1~"))]
pub struct IdempotencyKeyError;

/// The key a request carries, validated: `Ok(None)` when it carries none.
///
/// Trimmed, then 1–255 visible ASCII characters (`!`..=`~`). A header that is
/// present but empty, too long, not ASCII, or sent twice is a 400
/// `invalid_argument` rather than a silently ignored key — a client that meant
/// to make its retry safe and did not is exactly the client that must hear it.
pub fn key(headers: &HeaderMap) -> ApiResult<Option<String>> {
    parse(headers).map_err(|why| {
        IdempotencyKeyError::invalid_argument()
            .with_field_violation(HEADER, why, "INVALID_IDEMPOTENCY_KEY")
            .create()
    })
}

/// [`key`] without the error type, so the rule can be tested on its own.
fn parse(headers: &HeaderMap) -> Result<Option<String>, &'static str> {
    let mut values = headers.get_all(HEADER).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err("send Idempotency-Key once");
    }
    let raw = value
        .to_str()
        .map_err(|_| "Idempotency-Key must be visible ASCII")?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Idempotency-Key must not be empty");
    }
    if trimmed.len() > MAX_LEN {
        return Err("Idempotency-Key is at most 255 characters");
    }
    if !trimmed.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("Idempotency-Key must be visible ASCII, without spaces");
    }
    Ok(Some(trimmed.to_owned()))
}

/// The header, declared on an operation: `.param(idempotency::param())`.
pub fn param() -> ParamSpec {
    ParamSpec::header(HEADER).description(
        "Optional. One fresh value per user action (a UUID), reused only for that action's \
         own retry. A repeat with the same key in the same tenant answers the same 202 and \
         the same run_id instead of starting the work again. Trimmed; 1-255 visible ASCII \
         characters, otherwise 400 invalid_argument.",
    )
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn with(values: &[&str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for value in values {
            headers.append(HEADER, HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    #[test]
    fn absent_is_no_key() {
        assert_eq!(parse(&HeaderMap::new()), Ok(None));
    }

    #[test]
    fn a_key_is_trimmed() {
        assert_eq!(
            parse(&with(&["  3f2c9a1e-0b7d-4c1a-9e55-1d2f3a4b5c6d "])),
            Ok(Some("3f2c9a1e-0b7d-4c1a-9e55-1d2f3a4b5c6d".to_owned()))
        );
    }

    #[test]
    fn the_name_is_case_insensitive() {
        let mut headers = HeaderMap::new();
        headers.insert("idempotency-key", HeaderValue::from_static("abc"));
        assert_eq!(parse(&headers), Ok(Some("abc".to_owned())));
    }

    #[test]
    fn empty_is_refused() {
        assert!(parse(&with(&["   "])).is_err());
    }

    #[test]
    fn the_length_is_bounded() {
        assert!(parse(&with(&[&"k".repeat(MAX_LEN)])).is_ok());
        assert!(parse(&with(&[&"k".repeat(MAX_LEN + 1)])).is_err());
    }

    #[test]
    fn spaces_and_non_ascii_are_refused() {
        assert!(parse(&with(&["a b"])).is_err());
        let mut headers = HeaderMap::new();
        headers.insert(HEADER, HeaderValue::from_bytes("ключ".as_bytes()).unwrap());
        assert!(parse(&headers).is_err());
    }

    #[test]
    fn a_repeated_header_is_refused() {
        assert!(parse(&with(&["a", "b"])).is_err());
    }

    #[test]
    fn a_bad_key_is_refused_and_a_good_one_passes() {
        assert!(key(&with(&[" "])).is_err());
        assert!(matches!(key(&with(&["abc"])), Ok(Some(k)) if k == "abc"));
    }
}
