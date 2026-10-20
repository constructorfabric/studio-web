//! The documents against the product: what a project's documents ask for
//! that its code is not made of, as findings on the documents.
//!
//! Three rules, all mechanical (`docs/project-and-product.md`):
//! - `product.missing`: a capability the documents need, and no component
//!   the code depends on fills it;
//! - `product.decided_not_built`: a member confirmed a gear for a
//!   capability, and the code does not depend on it;
//! - `product.immature`: the capability is filled, but only by gears still
//!   in `design` or `experimental` (gears-rust #5275) -- the design rests on
//!   platform state that is not built yet, and may move under it.
//!
//! A finding sits on the documents that ask, because that is where the intent
//! is written; the code is what is compared against it.

use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest, Sha256};

use super::plan::{PastDecision, PlanRow};
use crate::documents::port::{CapabilitySource, DeclaredCapability};

pub const MISSING: &str = "product.missing";
pub const DECIDED_NOT_BUILT: &str = "product.decided_not_built";
pub const IMMATURE: &str = "product.immature";

/// The maturities a capability should not rest on: what they promise can
/// still change without notice. `preview` is past that.
const IMMATURE_LEVELS: [&str; 2] = ["design", "experimental"];

/// One document a finding rests on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Side {
    /// `file` (a bound repository file) or `document` (held by Studio).
    pub kind: String,
    /// A file's repository path, or a Studio document's title.
    pub path: String,
    /// What in the document asks: the first requirement that implies the
    /// capability, or its front matter.
    pub quote: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    /// Stable while the capability and gear are the same, however the
    /// documents behind them change.
    pub fingerprint: String,
    pub rule: String,
    /// `high` or `medium`.
    pub severity: String,
    pub capability: String,
    /// The confirmed gear the code does not depend on, for
    /// `product.decided_not_built`.
    pub gear: Option<String>,
    pub message: String,
    pub sides: Vec<Side>,
    /// What the code has instead, or what could fill the capability.
    pub candidates: Vec<String>,
}

/// A crate name as a dependency and a catalogue entry both spell it.
fn crate_key(name: &str) -> String {
    name.trim().to_ascii_lowercase().replace('_', "-")
}

/// The capabilities `needs` declares that `in_code` does not fill, and the
/// confirmed gears it does not depend on. `rows` are the plan's rows for the
/// same capabilities; `decisions` are newest first, as the plan reads them.
pub fn findings(
    needs: &[DeclaredCapability],
    rows: &[PlanRow],
    in_code: &BTreeSet<String>,
    decisions: &[PastDecision],
) -> Vec<Finding> {
    let in_code: BTreeSet<String> = in_code.iter().map(|n| crate_key(n)).collect();
    let row_of: BTreeMap<&str, &PlanRow> =
        rows.iter().map(|r| (r.capability.as_str(), r)).collect();
    let mut out = Vec::new();
    for need in needs {
        let Some(row) = row_of.get(need.key.as_str()) else {
            continue;
        };
        if row.nonfunctional || need.sources.is_empty() {
            continue;
        }
        let filled_by: Vec<String> = row
            .providers
            .iter()
            .map(|p| p.name.clone())
            .chain(row.candidates.iter().map(|c| c.name.clone()))
            .filter(|n| in_code.contains(&crate_key(n)))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let sides: Vec<Side> = need.sources.iter().map(side).collect();

        // Filled, but only by what is not ready to be relied on. One mature
        // gear among them is enough: the capability rests on that one.
        let maturity: BTreeMap<String, &str> = row
            .providers
            .iter()
            .filter_map(|p| Some((crate_key(&p.name), p.maturity.as_deref()?)))
            .chain(
                row.candidates
                    .iter()
                    .filter_map(|c| Some((crate_key(&c.name), c.maturity.as_deref()?))),
            )
            .collect();
        let immature = |n: &str| {
            maturity
                .get(&crate_key(n))
                .is_some_and(|m| IMMATURE_LEVELS.contains(m))
        };
        if !filled_by.is_empty() && filled_by.iter().all(|n| immature(n)) {
            let levels: Vec<String> = filled_by
                .iter()
                .map(|n| format!("`{n}` is {}", maturity[&crate_key(n)]))
                .collect();
            let ready: Vec<String> = row
                .providers
                .iter()
                .filter(|p| {
                    p.maturity
                        .as_deref()
                        .is_some_and(|m| m == "preview" || m == "stable")
                })
                .take(3)
                .map(|p| p.name.clone())
                .collect();
            let instead = if ready.is_empty() {
                String::new()
            } else {
                format!(" Further along: {}.", names(&ready))
            };
            out.push(Finding {
                fingerprint: fingerprint(IMMATURE, &need.key, &filled_by.join(",")),
                rule: IMMATURE.to_owned(),
                severity: "medium".to_owned(),
                capability: need.key.clone(),
                gear: filled_by.first().cloned(),
                message: format!(
                    "The documents rest `{}` on gears not ready to be relied on: {}. What they promise can still change.{instead}",
                    need.key,
                    levels.join(", ")
                ),
                sides: sides.clone(),
                candidates: ready,
            });
        }

        let confirmed = confirmed_gears(decisions, &need.key);
        let unbuilt: Vec<&str> = confirmed
            .iter()
            .copied()
            .filter(|g| !in_code.contains(&crate_key(g)))
            .collect();
        for gear in &unbuilt {
            let instead = if filled_by.is_empty() {
                String::new()
            } else {
                format!(
                    " It depends on {} for it instead: the decision or the code is out of date.",
                    names(&filled_by)
                )
            };
            out.push(Finding {
                fingerprint: fingerprint(DECIDED_NOT_BUILT, &need.key, gear),
                rule: DECIDED_NOT_BUILT.to_owned(),
                severity: "high".to_owned(),
                capability: need.key.clone(),
                gear: Some((*gear).to_owned()),
                message: format!(
                    "A member confirmed `{gear}` for `{}`, and the code does not depend on it.{instead}",
                    need.key
                ),
                sides: sides.clone(),
                candidates: filled_by.clone(),
            });
        }
        // A confirmed gear not built already says the capability is missing,
        // and says more.
        if !filled_by.is_empty() || !unbuilt.is_empty() {
            continue;
        }
        let offered: Vec<String> = row
            .candidates
            .iter()
            .take(3)
            .map(|c| c.name.clone())
            .collect();
        let could = if offered.is_empty() {
            " Nothing in the catalogue provides it either.".to_owned()
        } else {
            format!(" It could be filled by {}.", names(&offered))
        };
        // Declared in a document a person stands behind, it is asked for; read
        // from the requirements' words, it is a reading that may be wrong.
        let stated = need.sources.iter().any(|s| !s.inferred && s.confirmed);
        out.push(Finding {
            fingerprint: fingerprint(MISSING, &need.key, ""),
            rule: MISSING.to_owned(),
            severity: if stated { "high" } else { "medium" }.to_owned(),
            capability: need.key.clone(),
            gear: None,
            message: format!(
                "The documents ask for `{}`, and the code depends on no gear that provides it.{could}",
                need.key
            ),
            sides,
            candidates: offered,
        });
    }
    out
}

/// The gears whose newest decision for `capability` is a confirmation still
/// standing: its document has not changed since.
fn confirmed_gears<'a>(decisions: &'a [PastDecision], capability: &str) -> Vec<&'a str> {
    let mut seen = BTreeSet::new();
    decisions
        .iter()
        .filter(|d| d.capability == capability && !d.gear.trim().is_empty())
        .filter(|d| seen.insert(d.gear.as_str()))
        .filter(|d| d.decision == "confirmed" && !d.document_changed)
        .map(|d| d.gear.as_str())
        .collect()
}

fn side(s: &CapabilitySource) -> Side {
    let quote = if s.inferred {
        match (s.because.first(), s.requirements) {
            (Some(first), n) if n > 1 => format!("{first} (and {} more requirements)", n - 1),
            (Some(first), _) => first.clone(),
            (None, _) => "functional requirements".to_owned(),
        }
    } else {
        "front matter: capabilities".to_owned()
    };
    Side {
        kind: s.kind.clone(),
        path: s.label.clone(),
        quote,
    }
}

fn names(list: &[String]) -> String {
    list.iter()
        .map(|n| format!("`{n}`"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn fingerprint(rule: &str, capability: &str, gear: &str) -> String {
    let mut hasher = Sha256::new();
    for part in [rule, capability, gear] {
        hasher.update(part.as_bytes());
        hasher.update([0x1e]);
    }
    hex::encode(&hasher.finalize()[..12])
}

#[cfg(test)]
#[path = "product_tests.rs"]
mod tests;
