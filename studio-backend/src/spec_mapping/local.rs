//! The project's own gears, offered beside the catalogue's.
//!
//! A project that writes gears of its own -- Studio itself, whose backend
//! declares two dozen in `studio-backend/src` -- needs them among the
//! candidates: a capability one of them fills is not a gap. The components
//! catalogue reads them out of the project's repository
//! (`ComponentCatalog::project_gears`); this module puts them into the set the
//! rules match against, and labels every candidate that lives in the
//! repository so a person can tell "use this" from "you already have this".
//!
//! A gear in both places is ONE candidate, under the catalogue's name and with
//! the catalogue's facts (versions, what the engine says, a member's values),
//! because those are more than a repository read gives. It is labelled as in
//! this repository all the same, and when the catalogue has no profile for it
//! the repository's reading stands in, so it is not ranked as unscanned when
//! the code is right there.

use std::collections::BTreeMap;

use serde_json::{Map, Value};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::rest::CandidateDto;
use crate::components_catalog::port::{
    ComponentCatalog, Registry, RegistryEntry, STATE_DEPRECATED, TIER_PROJECT, offered,
    project_gears_of,
};

/// What the organization's registry says of each of its entries, by name
/// (case-folded): the state, and for a deprecated one its replacement.
pub(super) type RegistryStates = BTreeMap<String, (String, Option<String>)>;

/// Every entry's state, by case-folded name.
pub(super) fn registry_states(entries: &[RegistryEntry]) -> RegistryStates {
    entries
        .iter()
        .map(|e| {
            let replaced_by = (e.entry.state == STATE_DEPRECATED)
                .then(|| e.entry.replaced_by.clone())
                .flatten();
            (
                e.entry.name.to_ascii_lowercase(),
                (e.entry.state.clone(), replaced_by),
            )
        })
        .collect()
}

/// A repository read without the registry, less what the registry withholds:
/// a gear the organization rejected, or merged into another, is not offered
/// even when the project's code still declares it.
fn withhold(
    (gears, mut profiles): (Vec<Value>, Map<String, Value>),
    states: &RegistryStates,
) -> (Vec<Value>, Map<String, Value>) {
    let withheld = |name: &str| {
        states
            .get(&name.to_ascii_lowercase())
            .is_some_and(|(state, _)| !offered(state))
    };
    let gears = gears
        .into_iter()
        .filter(|g| {
            let name = g.get("name").and_then(Value::as_str).unwrap_or_default();
            if withheld(name) {
                profiles.remove(name);
                false
            } else {
                true
            }
        })
        .collect();
    (gears, profiles)
}

/// The project's own gears, or none when they cannot be read: they add to the
/// catalogue's answer, which stands without them.
///
/// Taken from the organization's registry (ADR-0041) when it has found
/// anything in the project -- kept between reads, so a plan no longer reads
/// the repositories -- and otherwise read on demand, as before. Either way in
/// the same shape: `origin: project` and the `path` in the repository.
///
/// Also answers what the registry says of each of its entries, so the plan
/// can mark the candidates it backs ([`mark_registry_state`]). A gear the
/// registry rejected or merged into another is not offered either way.
pub(super) async fn project_gears(
    catalog: &dyn ComponentCatalog,
    registry: Option<&dyn Registry>,
    ctx: &SecurityContext,
    project_id: Uuid,
) -> ((Vec<Value>, Map<String, Value>), RegistryStates) {
    let mut states = RegistryStates::new();
    if let Some(registry) = registry {
        match registry.project_entries(ctx, project_id).await {
            Ok(entries) => {
                states = registry_states(&entries);
                let found = project_gears_of(&entries, project_id);
                if !found.0.is_empty() {
                    return (found, states);
                }
                // Nothing found in this project yet; what the organization
                // decided about a name still holds for an on-demand read.
                if let Ok(all) = registry.entries(ctx, ctx.subject_tenant_id()).await {
                    states = registry_states(&all);
                }
            }
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "spec-mapping: the registry unreadable; reading the project's repositories");
            }
        }
    }
    let read = catalog
        .project_gears(ctx, &project_id.to_string())
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(error = %format!("{e:#}"), "spec-mapping: the project's own gears unreadable");
            (Vec::new(), Map::new())
        });
    (withhold(read, &states), states)
}

/// Mark the candidates the registry backs -- the project's own gears it has
/// an entry for -- with that entry's state, and a deprecated one with what
/// replaces it. Every other candidate stays unmarked.
pub(super) fn mark_registry_state<'a>(
    candidates: impl IntoIterator<Item = &'a mut CandidateDto>,
    in_repo: &BTreeMap<String, String>,
    states: &RegistryStates,
) {
    for candidate in candidates {
        if !in_repo.contains_key(&candidate.name) {
            continue;
        }
        if let Some((state, replaced_by)) = states.get(&candidate.name.to_ascii_lowercase()) {
            candidate.registry_state = Some(state.clone());
            candidate.replaced_by = replaced_by.clone();
        }
    }
}

/// Add the project's gears to the catalogue's, one entry per gear. Answers
/// the name every candidate in the repository goes by, with its path there.
pub(super) fn with_project_gears(
    components: &mut Vec<Value>,
    profiles: &mut Map<String, Value>,
    (gears, mut gear_profiles): (Vec<Value>, Map<String, Value>),
) -> BTreeMap<String, String> {
    let mut in_repo = BTreeMap::new();
    for gear in gears {
        let Some(name) = gear.get("name").and_then(Value::as_str).map(str::to_owned) else {
            continue;
        };
        let path = gear
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let profile = gear_profiles.remove(&name);
        // A catalogued gear the project's code declares too is the
        // project's (ADR-0042): it ranks, and is labelled, as such.
        let catalogued = components.iter_mut().find_map(|c| {
            let found = c
                .get("name")
                .and_then(Value::as_str)
                .filter(|n| n.eq_ignore_ascii_case(&name))
                .map(str::to_owned)?;
            if let Some(obj) = c.as_object_mut() {
                obj.insert("tier".to_owned(), Value::String(TIER_PROJECT.to_owned()));
            }
            Some(found)
        });
        let key = match catalogued {
            Some(catalogued) => catalogued,
            None => {
                components.push(gear);
                name
            }
        };
        if let Some(profile) = profile
            && !profiles.contains_key(&key)
        {
            profiles.insert(key.clone(), profile);
        }
        in_repo.insert(key, path);
    }
    in_repo
}

/// Label the candidates that live in the project's repository.
pub(super) fn mark_in_repo<'a>(
    candidates: impl IntoIterator<Item = &'a mut CandidateDto>,
    in_repo: &BTreeMap<String, String>,
) {
    for candidate in candidates {
        if let Some(path) = in_repo.get(&candidate.name) {
            candidate.origin = "project".to_owned();
            TIER_PROJECT.clone_into(&mut candidate.tier);
            candidate.path = (!path.is_empty()).then(|| path.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec_mapping::plan::{self, BuildState, Vocabulary};
    use serde_json::json;

    fn local(name: &str, path: &str, description: &str) -> (Value, Value) {
        (
            json!({ "name": name, "kind": "gear", "description": description,
                    "origin": "project", "path": path }),
            json!({ "gear_name": name, "auto": { "gear_status": "built" } }),
        )
    }

    fn gears(items: &[(Value, Value)]) -> (Vec<Value>, Map<String, Value>) {
        (
            items.iter().map(|(n, _)| n.clone()).collect(),
            items
                .iter()
                .map(|(n, p)| (n["name"].as_str().unwrap().to_owned(), p.clone()))
                .collect(),
        )
    }

    #[test]
    fn a_gear_only_the_repository_has_becomes_a_candidate() {
        let mut components = vec![json!({ "name": "cf-gears-ledger", "kind": "gear",
                                           "description": "double-entry ledger" })];
        let mut profiles = Map::new();
        let in_repo = with_project_gears(
            &mut components,
            &mut profiles,
            gears(&[local(
                "studio-spec-mapping",
                "studio-backend/src/spec_mapping",
                "from a project's specification to the gears that build it",
            )]),
        );
        assert_eq!(components.len(), 2);
        assert_eq!(
            in_repo["studio-spec-mapping"],
            "studio-backend/src/spec_mapping"
        );

        let rows = plan::plan(
            &["specification".to_owned()],
            &components,
            &profiles,
            &Vocabulary::default(),
        );
        let candidate = &rows[0].candidates[0];
        assert_eq!(candidate.name, "studio-spec-mapping");
        assert_eq!(candidate.built, BuildState::Built);
        assert!(!rows[0].gap);
    }

    #[test]
    fn a_gear_the_catalogue_also_has_is_one_candidate_under_its_catalogue_name() {
        let mut components = vec![json!({ "name": "cf-gears-ledger", "kind": "gear",
                                           "description": "ledger", "newest_version": "1.2.0" })];
        let mut profiles = Map::new();
        let in_repo = with_project_gears(
            &mut components,
            &mut profiles,
            gears(&[local("CF-Gears-Ledger", "gears/ledger", "a ledger")]),
        );
        assert_eq!(components.len(), 1, "no second entry for the same gear");
        assert_eq!(components[0]["newest_version"], "1.2.0");
        assert_eq!(in_repo["cf-gears-ledger"], "gears/ledger");
        // No catalogue profile: the repository's reading stands in.
        assert_eq!(profiles["cf-gears-ledger"]["auto"]["gear_status"], "built");
    }

    #[test]
    fn the_catalogues_profile_is_kept_over_the_repositorys() {
        let mut components = vec![json!({ "name": "cf-gears-ledger", "kind": "gear" })];
        let mut profiles = Map::new();
        profiles.insert(
            "cf-gears-ledger".into(),
            json!({ "auto": { "gear_status": "docs-only", "gdl_runs": { "s": "good" } } }),
        );
        with_project_gears(
            &mut components,
            &mut profiles,
            gears(&[local("cf-gears-ledger", "gears/ledger", "")]),
        );
        assert_eq!(
            profiles["cf-gears-ledger"]["auto"]["gear_status"],
            "docs-only"
        );
    }

    #[test]
    fn only_candidates_in_the_repository_are_labelled() {
        let candidate = |name: &str| CandidateDto {
            name: name.into(),
            kind: "gear".into(),
            step: "evidence".into(),
            contracts: Vec::new(),
            passage: None,
            cites: None,
            version: None,
            decision: None,
            declared: false,
            score: 1,
            why: Vec::new(),
            built: "built".into(),
            composable: "undescribed".into(),
            composable_why: None,
            origin: "catalogue".into(),
            path: None,
            registry_state: None,
            replaced_by: None,
            tier: "platform".into(),
        };
        let mut candidates = [candidate("mine"), candidate("theirs")];
        let in_repo = BTreeMap::from([("mine".to_owned(), "src/mine".to_owned())]);
        mark_in_repo(candidates.iter_mut(), &in_repo);
        assert_eq!(candidates[0].origin, "project");
        assert_eq!(candidates[0].path.as_deref(), Some("src/mine"));
        assert_eq!(candidates[1].origin, "catalogue");
        assert_eq!(candidates[1].path, None);
        // In the repository, so the project's: whatever tier the catalogue
        // said.
        assert_eq!(candidates[0].tier, "project");
        assert_eq!(candidates[1].tier, "platform");
    }

    /// ADR-0042 §3: a catalogued gear the project's code declares too is the
    /// project's, and ranks before the platform's on equal keys.
    #[test]
    fn a_catalogued_gear_in_the_repository_is_the_projects() {
        let mut components = vec![
            json!({ "name": "cf-gears-ledger", "kind": "gear", "tier": "platform",
                    "description": "a ledger" }),
            json!({ "name": "aa-ledger", "kind": "gear", "tier": "platform",
                    "description": "a ledger" }),
        ];
        let mut profiles = Map::new();
        with_project_gears(
            &mut components,
            &mut profiles,
            gears(&[local("cf-gears-ledger", "gears/ledger", "a ledger")]),
        );
        assert_eq!(components[0]["tier"], "project");
        assert_eq!(components[1]["tier"], "platform");
        let rows = plan::plan(
            &["ledger".to_owned()],
            &components,
            &profiles,
            &Vocabulary::default(),
        );
        let names: Vec<&str> = rows[0].candidates.iter().map(|c| c.name.as_str()).collect();
        let tiers: Vec<&str> = rows[0].candidates.iter().map(|c| c.tier.as_str()).collect();
        // Equal on every other key only when both are equally unscanned; the
        // project's has a profile saying it is built, so it is first anyway.
        assert_eq!(names[0], "cf-gears-ledger");
        assert_eq!(tiers[0], "project");
    }

    #[test]
    fn a_deprecated_registry_gear_is_marked_and_a_rejected_one_withheld() {
        let states = RegistryStates::from([
            (
                "old-ledger".to_owned(),
                ("deprecated".to_owned(), Some("ledger".to_owned())),
            ),
            ("scratch".to_owned(), ("rejected".to_owned(), None)),
            ("ledger-v0".to_owned(), ("merged".to_owned(), None)),
            ("ledger".to_owned(), ("registered".to_owned(), None)),
        ]);
        let (kept, profiles) = withhold(
            gears(&[
                local("Old-Ledger", "src/old", "a ledger"),
                local("scratch", "src/scratch", "helpers"),
                local("ledger-v0", "src/v0", "a ledger"),
                local("ledger", "src/ledger", "a ledger"),
            ]),
            &states,
        );
        let names: Vec<&str> = kept.iter().filter_map(|g| g["name"].as_str()).collect();
        assert_eq!(names, ["Old-Ledger", "ledger"]);
        assert!(!profiles.contains_key("scratch") && !profiles.contains_key("ledger-v0"));

        let candidate = |name: &str| CandidateDto {
            name: name.into(),
            kind: "gear".into(),
            step: "evidence".into(),
            contracts: Vec::new(),
            passage: None,
            cites: None,
            version: None,
            decision: None,
            declared: false,
            score: 1,
            why: Vec::new(),
            built: "built".into(),
            composable: "undescribed".into(),
            composable_why: None,
            origin: "catalogue".into(),
            path: None,
            registry_state: None,
            replaced_by: None,
            tier: "platform".into(),
        };
        let mut candidates = [
            candidate("Old-Ledger"),
            candidate("ledger"),
            candidate("cf-gears-ledger"),
        ];
        let in_repo = BTreeMap::from([
            ("Old-Ledger".to_owned(), "src/old".to_owned()),
            ("ledger".to_owned(), "src/ledger".to_owned()),
        ]);
        mark_registry_state(candidates.iter_mut(), &in_repo, &states);
        assert_eq!(candidates[0].registry_state.as_deref(), Some("deprecated"));
        assert_eq!(candidates[0].replaced_by.as_deref(), Some("ledger"));
        assert_eq!(candidates[1].registry_state.as_deref(), Some("registered"));
        assert_eq!(candidates[1].replaced_by, None);
        // Not the registry's: no mark.
        assert_eq!(candidates[2].registry_state, None);
    }
}
