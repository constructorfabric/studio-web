//! A save never strips what the product had (ADR-0060 §4).
//!
//! On 2026-11-04 a save through `/product/preview` with `write` and only
//! `gears` and `config` wrote revisions without the `frontx_product` block,
//! and a composition whose engine no longer described the project's own
//! gears would have written a description without them. A save now
//!
//! - composes from the whole product record -- gears, configuration and
//!   frontend -- with the request's fields only overriding
//!   ([`compose_request`]);
//! - and is refused when the text would still drop what the latest revision
//!   had and the record still picks ([`stripped`]): a gear the engine cannot
//!   see, or a frontend the engine is not told about.

use serde_json::Value;

/// What a save composes from: the request's fields where it gives them,
/// the record's otherwise.
#[derive(Debug, Clone, PartialEq)]
pub struct Composed {
    pub gears: Vec<String>,
    pub config: Option<Value>,
}

/// The request's `gears` and `config` laid over the record's: an empty pick
/// list or an absent configuration is "as the record has it", not "none".
pub fn compose_request(
    gears: &[String],
    config: Option<&Value>,
    record: Option<&Value>,
) -> Composed {
    let gears = if gears.is_empty() {
        record.and_then(super::port::picks_of).unwrap_or_default()
    } else {
        gears.to_vec()
    };
    let config = config
        .cloned()
        .or_else(|| record.and_then(|r| r.get("config")).cloned())
        .filter(|c| !c.is_null());
    Composed { gears, config }
}

/// Whether a description has a frontend block.
pub fn has_frontend(gdl: &str) -> bool {
    gdl.lines()
        .map(|l| l.split_once('#').map_or(l, |(code, _)| code))
        .any(|l| l.contains("frontx_product("))
}

/// What the new text `new` drops that the latest revision `previous` had and
/// the record still wants, one sentence each; empty when nothing is.
///
/// - A gear `previous` names and the picks still hold that the new text
///   does not name: the engine no longer describes it (`not_described`).
/// - A frontend `previous` has that `new` lacks, while the record still has
///   one (`frontend_kept`): the record's frontend was not written.
pub fn stripped(previous: &str, new: &str, picks: &[String], frontend_kept: bool) -> Vec<String> {
    let had = super::project_roots::describe(previous).gears;
    let has = super::project_roots::describe(new).gears;
    let mut out = Vec::new();
    let lost: Vec<&String> = had
        .iter()
        .filter(|g| !has.contains(g))
        .filter(|g| {
            picks
                .iter()
                .any(|p| p == *g || p.ends_with(&format!("-{g}")))
        })
        .collect();
    if !lost.is_empty() {
        let names = lost
            .iter()
            .map(|g| format!("`{g}`"))
            .collect::<Vec<_>>()
            .join(", ");
        out.push(format!(
            "it would drop {names}, which the latest revision names and the product still picks: \
             the engine does not describe them now -- is the project's repository readable?"
        ));
    }
    if frontend_kept && has_frontend(previous) && !has_frontend(new) {
        out.push(
            "it would drop the frontend the latest revision has: this Studio's engine is not \
             told about frontends (STUDIO_GEARBOX_FRONTX), or the product's frontend could not \
             be read"
                .to_owned(),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const WITH: &str = r#"product(
    id = "studioweb",
    frontend = frontx_product(
        source = "studio-web",
        shell = path("studio-frontend"),
    ),
    gears = [
        use_gear("api-gateway", source = "gears-rust"),
        use_gear("studio-documents", source = "studio-web"),
    ],
)"#;

    /// Issue 12: a save with only `gears` and `config`.
    const WITHOUT: &str = r#"product(
    id = "studioweb",
    gears = [
        use_gear("api-gateway", source = "gears-rust"),
    ],
)"#;

    #[test]
    fn a_save_with_only_gears_and_config_keeps_the_records_frontend_and_config() {
        let record = json!({
            "gears": ["api-gateway", "studio-documents"],
            "config": {"api-gateway": {"bind_addr": "0.0.0.0:8080"}},
            "frontend": {"shell": {"repo": "acme/studio-web", "path": "studio-frontend"}},
        });
        let c = compose_request(&[], None, Some(&record));
        assert_eq!(c.gears, ["api-gateway", "studio-documents"]);
        assert_eq!(c.config, Some(record["config"].clone()));
        let c = compose_request(&["api-gateway".to_owned()], Some(&json!({})), Some(&record));
        assert_eq!(c.gears, ["api-gateway"], "the request's picks override");
        assert_eq!(c.config, Some(json!({})), "and so does its configuration");
        assert_eq!(compose_request(&[], None, None).gears, Vec::<String>::new());
    }

    #[test]
    fn a_save_that_would_lose_the_frontend_or_a_picked_gear_is_refused() {
        let picks = vec!["api-gateway".to_owned(), "studio-documents".to_owned()];
        let why = stripped(WITH, WITHOUT, &picks, true);
        assert_eq!(why.len(), 2, "{why:?}");
        assert!(why[0].contains("`studio-documents`"));
        assert!(why[1].contains("frontend"));
        // Unpicked, a gear's going is the person's choice; a frontend taken
        // away on the record is too.
        assert!(stripped(WITH, WITHOUT, &["api-gateway".to_owned()], false).is_empty());
        // Nothing lost: nothing said.
        assert!(stripped(WITH, WITH, &picks, true).is_empty());
        assert!(has_frontend(WITH) && !has_frontend(WITHOUT));
        assert!(!has_frontend("# frontend = frontx_product(\nproduct()"));
    }
}
