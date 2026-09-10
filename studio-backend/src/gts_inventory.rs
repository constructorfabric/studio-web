//! Every GTS document this assembly registers, built offline.
//!
//! # Why this exists
//!
//! A GTS document is validated where it is registered, at boot, and nowhere
//! else. A segment with the wrong token count, a derived type that forgot to
//! compose its family, a type the code names but the deployment profile does
//! not declare — each of those surfaces as `post-init failed for gear …` on a
//! pod (CrashLoopBackOff in a cluster), never as a red check on the pull
//! request that introduced it. That has happened repeatedly: see
//! `docs/gears-rust-issues.md` §1 (the registry reports a bare "Request
//! validation failed"), `docs/graph-storage-handover.md` §4 (ten free-form
//! types refused at once by gts 0.12) and `src/connectors/gts.rs`
//! (`cf.studio.connections.v1` — four name tokens where the grammar wants
//! five).
//!
//! This module rebuilds the same documents from the code alone — no registry,
//! no database, no config file, no HTTP listener — so that:
//!
//! * `studio-backend gts-types` can print them, and
//! * the tests below can assert offline what a registry would otherwise
//!   discover at 3am.
//!
//! `docs/gts-types.json` is the committed snapshot. When a type legitimately
//! changes, regenerate it with
//!
//! ```text
//! cargo run --quiet -- gts-types > docs/gts-types.json
//! ```
//!
//! and let the diff be the review. Note that graph-storage treats a registered
//! type's schema as immutable, so a *changed* schema under an unchanged type id
//! is a migration, not an edit — the snapshot diff is where that gets caught.
//!
//! # What is in scope
//!
//! Only what the code itself registers. The types a deployment profile declares
//! (`types-registry.config.entities` in `config/*.yaml`) belong to the profile,
//! not here; [`config_declared_types`] lists the ones the code *names* so
//! [`tests`] can prove every profile declares them.

// Only the profile scan and the tests below need it.
#[cfg(test)]
use std::collections::BTreeSet;

use serde_json::{Value, json};

/// The platform types-registry — the catalog every gear registers into at
/// `init`. Documents here are deliberately free-form (`type: object`): the
/// `tenant_metadata` / `tenant_type` bases are closed envelopes, and under the
/// GTS inclusion check a derived document that narrows one is refused.
pub const TYPES_REGISTRY: &str = "types-registry";

/// The graph-storage ontology — a second document set for the same logical
/// types. Documents here must derive from one of the graph families: a type
/// deriving straight from a base fixes no `family` and cannot be instantiated,
/// and a free-form type has no chain to validate against at all.
pub const GRAPH_STORAGE: &str = "graph-storage";

/// What a refused registration does to the boot. Not cosmetic: it is the
/// difference between a deployment that fails loudly and one that comes up
/// with a silently missing type, and today it is not the same for every gear
/// (`studio-documents` warns where the others abort). Recorded per document so
/// the committed snapshot shows the inconsistency instead of hiding it.
const BOOT_FAILS: &str = "boot_fails";
const WARN_AND_CONTINUE: &str = "warn_and_continue";

/// One registered document, as the snapshot records it.
fn entry(registry: &str, gear: &str, on_refusal: &str, schema: Value) -> Value {
    let type_id = schema
        .get("$id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim_start_matches("gts://")
        .to_owned();
    json!({
        "registry": registry,
        "gear": gear,
        "type_id": type_id,
        "on_refusal": on_refusal,
        "schema": schema,
    })
}

/// Every type schema the assembly registers, sorted by
/// `(registry, gear, type_id)` so the snapshot is stable across runs.
///
/// Feature-independent on purpose: the graph-storage documents are built by
/// plain functions in each gear's `gts` module, not by the feature-gated
/// backends that send them, so `--no-default-features` and a full build emit
/// the same inventory.
pub fn schemas() -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();

    // ── studio-artifact-ingest ────────────────────────────────────────────
    let gear = "studio-artifact-ingest";
    for s in crate::artifact_ingest::gts::type_schemas() {
        out.push(entry(TYPES_REGISTRY, gear, BOOT_FAILS, s));
    }
    for s in crate::artifact_ingest::gts::graph_node_type_schemas()
        .into_iter()
        .chain(crate::artifact_ingest::gts::graph_edge_type_schemas())
    {
        out.push(entry(GRAPH_STORAGE, gear, BOOT_FAILS, s));
    }

    // ── studio-components-catalog ─────────────────────────────────────────
    let gear = "studio-components-catalog";
    for s in crate::components_catalog::gts::type_schemas() {
        out.push(entry(TYPES_REGISTRY, gear, BOOT_FAILS, s));
    }
    for s in crate::components_catalog::gts::graph_node_type_schemas()
        .into_iter()
        .chain(crate::components_catalog::gts::graph_edge_type_schemas())
    {
        out.push(entry(GRAPH_STORAGE, gear, BOOT_FAILS, s));
    }

    // ── studio-documents ──────────────────────────────────────────────────
    // The one gear that logs and continues when the registry refuses a
    // document (`documents/mod.rs`): document types are also stored in its own
    // PostgreSQL tables, so the registration is a catalog entry rather than the
    // system of record.
    for s in crate::documents::gts::type_schemas() {
        out.push(entry(
            TYPES_REGISTRY,
            "studio-documents",
            WARN_AND_CONTINUE,
            s,
        ));
    }

    // ── studio-domain-model ───────────────────────────────────────────────
    // Derived from the embedded ontology (`ontology.core.json`), so a model
    // edit that adds an entity shows up in the snapshot diff as a new type.
    let gear = "studio-domain-model";
    let ontology = crate::domain_model::ontology::Ontology::load();
    for nt in ontology.node_types() {
        out.push(entry(
            TYPES_REGISTRY,
            gear,
            BOOT_FAILS,
            crate::domain_model::gts::catalog_schema(&nt.type_id, &nt.title, &nt.description),
        ));
        out.push(entry(
            GRAPH_STORAGE,
            gear,
            BOOT_FAILS,
            crate::domain_model::gts::derived_node_schema(&nt.type_id),
        ));
    }
    for et in ontology.edge_types() {
        out.push(entry(
            TYPES_REGISTRY,
            gear,
            BOOT_FAILS,
            crate::domain_model::gts::catalog_schema(
                &et.type_id,
                &et.relation_kind,
                crate::domain_model::gts::EDGE_CATALOG_DESCRIPTION,
            ),
        ));
        out.push(entry(
            GRAPH_STORAGE,
            gear,
            BOOT_FAILS,
            crate::domain_model::gts::derived_schema(&et.type_id),
        ));
    }
    // The meta layer: the model's own structure as a graph (object_type nodes
    // joined by inherits / declares), cataloged on both sides like every other
    // type.
    for (id, title, description) in crate::domain_model::gts::META_CATALOG_DOCS {
        out.push(entry(
            TYPES_REGISTRY,
            gear,
            BOOT_FAILS,
            crate::domain_model::gts::catalog_schema(id, title, description),
        ));
    }
    for (_, schema) in crate::domain_model::gts::meta_type_registrations() {
        out.push(entry(GRAPH_STORAGE, gear, BOOT_FAILS, schema));
    }

    // ── studio-connector: the repository knowledge graph ──────────────────
    let gear = "studio-connector";
    for s in crate::connectors::gts::catalog_type_schemas() {
        out.push(entry(TYPES_REGISTRY, gear, BOOT_FAILS, s));
    }
    for s in crate::connectors::gts::graph_type_schemas() {
        out.push(entry(GRAPH_STORAGE, gear, BOOT_FAILS, s));
    }

    out.sort_by_key(sort_key);
    out
}

/// `(registry, gear, type_id)` — the snapshot's total order.
fn sort_key(e: &Value) -> (String, String, String) {
    let s = |k: &str| {
        e.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    (s("registry"), s("gear"), s("type_id"))
}

/// Plugin instances the assembly publishes, as full GTS ids.
///
/// A driver plugin is addressed by this string: the gear resolves its scoped
/// client from the client hub by the same id it registered, so a typo here is
/// not a validation error but a provider that silently reports as unavailable.
pub fn plugin_instances() -> Vec<Value> {
    use crate::connectors::gts as connectors;
    [
        ("studio-connector", connectors::GITLAB_INSTANCE_ID),
        ("studio-connector", connectors::GITHUB_INSTANCE_ID),
        ("studio-connector", connectors::BITBUCKET_INSTANCE_ID),
        ("studio-connector", connectors::ANTHROPIC_INSTANCE_ID),
        ("studio-connector", connectors::OPENAI_INSTANCE_ID),
        ("studio-connector", connectors::SLACK_INSTANCE_ID),
        ("studio-connector", connectors::SLACK_WEBHOOK_INSTANCE_ID),
        ("studio-connector", connectors::ZULIP_INSTANCE_ID),
        ("studio-connector", connectors::ZULIP_WEBHOOK_INSTANCE_ID),
        ("studio-connector", connectors::DISCORD_INSTANCE_ID),
        ("studio-connector", connectors::DISCORD_WEBHOOK_INSTANCE_ID),
    ]
    .into_iter()
    .map(|(gear, instance_id)| json!({ "gear": gear, "instance_id": instance_id }))
    .collect()
}

/// Plugin instances whose id the toolkit composes at runtime from a segment
/// plus the contract it derives from (`PluginV1::build_registration`), so only
/// the segment is a constant in this crate.
pub fn plugin_instance_segments() -> Vec<Value> {
    [
        (
            "studio-authz-plugin",
            crate::studio_authz_plugin::INSTANCE_ID,
        ),
        ("studio-credstore-pg", crate::credstore_pg::INSTANCE_SEGMENT),
    ]
    .into_iter()
    .map(|(gear, segment)| json!({ "gear": gear, "segment": segment }))
    .collect()
}

/// Types the code names but the **deployment profile** declares
/// (`types-registry.config.entities`).
///
/// The code cannot register these — account-management owns the envelope they
/// derive from — so a profile that omits one produces no validation error at
/// all: the gear that reads the metadata just finds nothing, and behaves as if
/// the tenant had never been configured. `config/postgres.yaml` was missing
/// `cf.studio.access.config.v1~` exactly that way. Listed here so the tests
/// below can prove every shipped profile declares every one of them.
pub fn config_declared_types() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "studio-connector",
            crate::connectors::gts::CONNECTOR_PLUGIN_TYPE,
        ),
        (
            "studio-connector",
            crate::connectors::gts::CONNECTIONS_METADATA_TYPE,
        ),
        // The same id is also spelled out in `identity_directory` and
        // `user_profile`; one constant per gear is a leftover, not a design.
        (
            "studio-authz-plugin",
            crate::studio_authz_plugin::ACCESS_METADATA_TYPE,
        ),
        (
            "studio-kits",
            crate::kit_registry::service::INSTALLATIONS_METADATA_TYPE,
        ),
        // Declared by the profile and consumed by account-management and the
        // portal rather than by a constant in this crate: the four tenant types
        // that shape the org / workspace / project hierarchy, and the two
        // metadata envelopes the portal writes. Listed so the per-profile guard
        // covers the whole set a deployment needs, not only the part the code
        // happens to name.
        (
            "account-management",
            "gts.cf.core.am.tenant_type.v1~cf.core.am.platform.v1~",
        ),
        (
            "account-management",
            "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.organization.v1~",
        ),
        (
            "account-management",
            "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~",
        ),
        (
            "account-management",
            "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.project.v1~",
        ),
        (
            "studio-workspace-settings",
            "gts.cf.core.am.tenant_metadata.v1~cf.studio.workspace.settings.v1~",
        ),
        (
            "studio-projects",
            "gts.cf.core.am.tenant_metadata.v1~cf.studio.project.config.v1~",
        ),
    ]
}

/// The whole inventory as one document.
pub fn inventory() -> Value {
    json!({
        "schemas": schemas(),
        "plugin_instances": plugin_instances(),
        "plugin_instance_segments": plugin_instance_segments(),
        "config_declared_types": config_declared_types()
            .into_iter()
            .map(|(gear, type_id)| json!({ "gear": gear, "type_id": type_id }))
            .collect::<Vec<_>>(),
    })
}

/// The inventory in its canonical on-disk form: pretty JSON with a trailing
/// newline, byte-identical to `docs/gts-types.json`.
///
/// # Errors
///
/// Returns an error only if the document cannot be serialized, which would
/// mean a non-string map key somewhere in a schema.
pub fn to_pretty_json() -> anyhow::Result<String> {
    Ok(format!("{}\n", serde_json::to_string_pretty(&inventory())?))
}

/// The GTS ids a deployment profile declares under
/// `types-registry.config.entities`.
///
/// Textual rather than parsed: the profiles carry `${VAR}` placeholders that
/// are expanded at boot (see `main::load_config`), and every declaration in
/// every profile is written in the one `"$id": "gts://…"` form this scan
/// matches. A profile rewritten in another style would read as zero ids, so
/// [`tests::every_profile_declares_the_types_the_code_expects`] pins that the
/// scan finds something in each.
#[cfg(test)]
fn declared_ids(profile_text: &str) -> BTreeSet<String> {
    const MARKER: &str = "\"$id\": \"gts://";
    let mut out = BTreeSet::new();
    for (_, tail) in profile_text
        .match_indices(MARKER)
        .map(|(i, m)| (i, &profile_text[i + m.len()..]))
    {
        if let Some(id) = tail.split('"').next() {
            out.insert(id.to_owned());
        }
    }
    out
}

/// The gears a deployment profile gives a database of their own.
///
/// Line-based rather than a YAML parse, for the same reason [`declared_ids`] is:
/// the profiles are the input to a gear runtime this module deliberately does
/// not start, and a dependency on a YAML crate to read two indentation levels
/// would buy nothing. Only the `gears:` block is considered -- the profiles also
/// carry a top-level `database:` for the server itself.
#[cfg(test)]
fn gears_with_a_database(profile_text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut in_gears = false;
    let mut gear: Option<&str> = None;

    for line in profile_text.lines() {
        if !line.starts_with(char::is_whitespace) && !line.trim().is_empty() {
            in_gears = line.trim_end() == "gears:";
            gear = None;
            continue;
        }
        if !in_gears {
            continue;
        }
        // `  gear-name:` opens a gear; `    database:` inside one claims a
        // database. Anything deeper belongs to whatever was opened last.
        if let Some(name) = line
            .strip_prefix("  ")
            .filter(|rest| !rest.starts_with(' '))
            .and_then(|rest| rest.strip_suffix(':'))
        {
            gear = Some(name.trim());
        } else if line.trim_end() == "    database:"
            && let Some(name) = gear
        {
            out.insert(name.to_owned());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    //! What these guard, in one line each: the snapshot is current; every
    //! profile declares what the code expects and the same set as its
    //! siblings; graph-storage documents derive from a family and
    //! types-registry documents do not narrow their base; every id is a legal
    //! GTS segment; and no two documents in one registry claim the same id.

    use super::*;

    /// The shipped deployment profiles, embedded so the test needs no cwd.
    const PROFILES: [(&str, &str); 5] = [
        ("dev.yaml", include_str!("../config/dev.yaml")),
        ("docker.yaml", include_str!("../config/docker.yaml")),
        ("oidc.yaml", include_str!("../config/oidc.yaml")),
        ("postgres.yaml", include_str!("../config/postgres.yaml")),
        ("k8s.yaml", include_str!("../config/k8s.yaml")),
    ];

    #[test]
    fn snapshot_matches_the_committed_inventory() -> anyhow::Result<()> {
        let committed = include_str!("../docs/gts-types.json");
        assert_eq!(
            to_pretty_json()?,
            committed,
            "the GTS inventory changed — regenerate the snapshot with \
             `cargo run --quiet -- gts-types > docs/gts-types.json` and review \
             the diff. A changed schema under an unchanged type id is a \
             graph-storage migration, not an edit: graph-storage treats a \
             registered type's schema as immutable."
        );
        Ok(())
    }

    /// Gears a profile deliberately gives no database, and why.
    ///
    /// A gear without a `database:` section STANDS DOWN: it registers no routes
    /// and logs a warning nobody reads. That is not a boot error, so an
    /// omission looks exactly like a decision — `studio-documents` was missing
    /// from `postgres.yaml` for precisely that reason, and the whole document
    /// and catalogue surface was absent from that profile without anyone
    /// noticing.
    ///
    /// Every entry here is a claim somebody wrote down. An unlisted omission
    /// fails the test, and so does a listed one that no longer applies -- which
    /// is how the fourth entry left: `studio-user` was recorded here as an open
    /// question, the question was answered, and the test demanded the entry go
    /// with it.
    const DATABASE_OMISSIONS: [(&str, &str, &str); 5] = [
        (
            "dev.yaml",
            "studio-credstore-pg",
            "on purpose, and the profile says so: the seeds there are real values \
             read from the file, and the persistent store would win vendor \
             selection and orphan them",
        ),
        (
            "postgres.yaml",
            "studio-credstore-pg",
            "same reason as dev.yaml, and stated in the same words there",
        ),
        (
            "dev.yaml",
            "studio-documents",
            "its migrations are PostgreSQL only (ADR-0014), so a SQLite database \
             here would fail the gear's init rather than enable it",
        ),
        (
            "dev.yaml",
            "studio-tasks",
            "background work runs on the PostgreSQL outbox (see \
             docs/background-work.md); this profile is for poking at the API \
             without a database to hand, and the three routes that enqueue a \
             run answer 503 there with that reason",
        ),
        (
            "dev.yaml",
            "studio-scheduler",
            "nothing to schedule where studio-tasks stands down, and it keeps \
             its own state in the same PostgreSQL outbox family",
        ),
    ];

    #[test]
    fn every_profile_gives_the_same_gears_a_database_or_records_why_not() {
        // The reference is the union rather than one chosen profile: a gear
        // added to a single profile is as much a discrepancy as one missing
        // from a single profile, and picking a "complete" profile would hide
        // the first case entirely.
        let everywhere: BTreeSet<String> = PROFILES
            .iter()
            .flat_map(|(_, text)| gears_with_a_database(text))
            .collect();
        assert!(
            everywhere.len() > 5,
            "parsed {} gears with a database across every profile, which cannot \
             be right — teach `gears_with_a_database` about the shape the \
             profiles now use",
            everywhere.len()
        );

        for (name, text) in PROFILES {
            let present = gears_with_a_database(text);
            let missing: BTreeSet<&String> = everywhere.difference(&present).collect();

            for gear in &missing {
                assert!(
                    DATABASE_OMISSIONS
                        .iter()
                        .any(|(profile, omitted, _)| *profile == name && *omitted == gear.as_str()),
                    "{name} gives no database to `{gear}`, which every other \
                     profile does. The gear will stand down there and serve \
                     nothing. Add the section, or record the reason in \
                     DATABASE_OMISSIONS"
                );
            }

            for (profile, omitted, _) in DATABASE_OMISSIONS {
                if profile != name {
                    continue;
                }
                assert!(
                    !present.contains(omitted),
                    "{name} now gives `{omitted}` a database, but \
                     DATABASE_OMISSIONS still claims it deliberately does not. \
                     Drop that entry"
                );
                assert!(
                    everywhere.contains(omitted),
                    "DATABASE_OMISSIONS records `{omitted}` as omitted from \
                     {name}, but no profile configures it at all — the entry is \
                     stale"
                );
            }
        }
    }

    #[test]
    fn every_profile_declares_the_types_the_code_expects() {
        for (name, text) in PROFILES {
            let declared = declared_ids(text);
            assert!(
                !declared.is_empty(),
                "{name}: no `\"$id\": \"gts://…\"` declaration found at all — if the \
                 profile now declares its entities in another form, teach \
                 `declared_ids` about it"
            );
            for (gear, type_id) in config_declared_types() {
                assert!(
                    declared.contains(type_id),
                    "{name} does not declare {type_id}, which {gear} reads at runtime; \
                     a missing tenant-metadata type is not a boot error — the gear \
                     just finds nothing"
                );
            }
        }
    }

    #[test]
    fn every_profile_declares_the_same_type_set() {
        let (base_name, base_text) = PROFILES[0];
        let base = declared_ids(base_text);
        for (name, text) in PROFILES.iter().skip(1) {
            let other = declared_ids(text);
            let missing: Vec<&String> = base.difference(&other).collect();
            let extra: Vec<&String> = other.difference(&base).collect();
            assert!(
                missing.is_empty() && extra.is_empty(),
                "{name} declares a different type set than {base_name}: \
                 missing {missing:?}, extra {extra:?}. The profiles are copies of \
                 one list; a difference is drift until a comment says otherwise"
            );
        }
    }

    #[test]
    fn graph_storage_documents_derive_from_a_family() {
        for e in schemas() {
            if e["registry"] != GRAPH_STORAGE {
                continue;
            }
            let type_id = e["type_id"].as_str().unwrap_or_default();
            let refs: Vec<&str> = e["schema"]["allOf"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|r| r["$ref"].as_str())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            assert_eq!(
                refs.len(),
                1,
                "{type_id}: a graph-storage type must compose exactly one family \
                 (`allOf: [{{$ref: gts://<family>}}]`); a free-form type has no \
                 chain to validate against and is refused"
            );
            let family = refs[0].trim_start_matches("gts://");
            assert!(
                type_id.starts_with(family),
                "{type_id}: derives from {family} but its id does not carry that \
                 ancestry — graph-storage stores a derived type under the family \
                 chain plus the leaf"
            );
        }
    }

    #[test]
    fn types_registry_documents_stay_free_form() {
        for e in schemas() {
            if e["registry"] != TYPES_REGISTRY {
                continue;
            }
            assert!(
                e["schema"].get("allOf").is_none(),
                "{}: a types-registry document must stay free-form — narrowing a \
                 closed envelope trips the GTS inclusion check and the whole ready \
                 commit fails",
                e["type_id"]
            );
        }
    }

    /// Assert the segment grammar over one id. A GTS segment is
    /// `vendor.package.namespace.type.vN` — five dot-separated tokens.
    /// `cf.studio.connections.v1` had four and the registry rejected the whole
    /// boot with a bare "Request validation failed" (see `connectors/gts.rs`).
    fn assert_studio_segments(id: &str, what: &str) {
        for segment in id.trim_end_matches('~').split('~') {
            if !segment.starts_with("cf.studio") && !segment.starts_with("gts.cf.studio") {
                continue; // platform-owned segment: not ours to police
            }
            let tokens: Vec<&str> = segment.trim_start_matches("gts.").split('.').collect();
            assert!(
                tokens.len() == 5 && tokens[4].starts_with('v'),
                "{what} {id}: segment `{segment}` is not \
                 vendor.package.namespace.type.vN — got {tokens:?}"
            );
        }
    }

    #[test]
    fn every_studio_segment_is_a_valid_gts_segment() {
        for e in schemas() {
            assert_studio_segments(e["type_id"].as_str().unwrap_or_default(), "type");
        }
    }

    /// The same grammar over the ids of *plugin instances*, which the schema
    /// scan above does not reach.
    ///
    /// These are the riskier half. A plugin instance id is never written in a
    /// profile and never checked by a test that reads one: it is a constant in
    /// this crate that the gear registers at boot and then resolves its own
    /// ClientHub client by. Get the grammar wrong and the registration is
    /// refused; get the *contract prefix* wrong and registration succeeds
    /// against nothing, leaving a provider that silently reports as
    /// unavailable — which is the failure a person notices weeks later, from
    /// the UI, with no log line to point at.
    #[test]
    fn every_plugin_instance_id_is_a_valid_derived_gts_id() {
        let instances = plugin_instances();
        assert!(
            !instances.is_empty(),
            "no plugin instances at all — the list is the point of this test"
        );
        for e in instances {
            let id = e["instance_id"].as_str().unwrap_or_default();
            assert_studio_segments(id, "plugin instance");
            // The contract prefix belongs to a family, so it is asserted per
            // gear rather than over the whole list: another gear's plugins
            // would derive from their own contract, and this test must not
            // stand in the way of adding one.
            if e["gear"] == "studio-connector" {
                assert!(
                    id.starts_with(crate::connectors::gts::CONNECTOR_PLUGIN_TYPE),
                    "plugin instance {id} does not derive from the connector plugin \
                     contract {} — the registry would refuse it, and a scoped client \
                     registered under it would resolve for nobody",
                    crate::connectors::gts::CONNECTOR_PLUGIN_TYPE
                );
            }
        }
    }

    /// Types that live in the platform catalog and nowhere else, with the
    /// reason. Documents and the catalogues that describe them are stored in
    /// the gear's own PostgreSQL tables, not in the graph, so they have no
    /// graph-storage counterpart today.
    ///
    /// `process.` joined `doc.` with the journey-stage catalogue (ADR-0014
    /// section 5). ADR-0014 section 6 does intend a per-tenant graph projection
    /// for both, and the day it lands these prefixes shrink rather than grow --
    /// which is exactly why this list is a decision written down and not a
    /// filter that quietly widens.
    const CATALOG_ONLY_PREFIXES: [&str; 2] = ["gts.cf.studio.doc.", "gts.cf.studio.process."];

    #[test]
    fn every_graph_type_is_also_in_the_platform_catalog() {
        // The direction that matters: graph-storage holds a subset of what the
        // platform registry catalogs. A graph type with no catalog entry is a
        // type that exists in the data but not in the registry the rest of the
        // platform reads — the two disagree, and nothing at boot notices.
        let cataloged: BTreeSet<String> = schemas()
            .into_iter()
            .filter(|e| e["registry"] == TYPES_REGISTRY)
            .map(|e| e["type_id"].as_str().unwrap_or_default().to_owned())
            .collect();
        for e in schemas() {
            if e["registry"] != GRAPH_STORAGE {
                continue;
            }
            let graph_id = e["type_id"].as_str().unwrap_or_default();
            // A derived id carries its family chain; the logical id is the leaf
            // segment under the `gts.` prefix every registered id starts with.
            let logical = graph_id
                .rsplit('~')
                .find(|s| !s.is_empty())
                .map(|leaf| format!("gts.{leaf}~"))
                .unwrap_or_default();
            assert!(
                cataloged.contains(&logical),
                "{graph_id} lives in graph-storage but {logical} is not in the platform catalog: register it in that gear's `type_schemas()` so the two registries agree"
            );
        }
    }

    #[test]
    fn catalog_only_types_are_the_documented_exceptions() {
        // The other direction is deliberately not equality: some types are
        // cataloged without living in the graph. Pin which, so a new one is a
        // decision somebody wrote down rather than an accident.
        let graph_logical: BTreeSet<String> = schemas()
            .into_iter()
            .filter(|e| e["registry"] == GRAPH_STORAGE)
            .filter_map(|e| {
                e["type_id"]
                    .as_str()?
                    .rsplit('~')
                    .find(|s| !s.is_empty())
                    .map(|leaf| format!("gts.{leaf}~"))
            })
            .collect();
        for e in schemas() {
            if e["registry"] != TYPES_REGISTRY {
                continue;
            }
            let id = e["type_id"].as_str().unwrap_or_default();
            if graph_logical.contains(id) {
                continue;
            }
            assert!(
                CATALOG_ONLY_PREFIXES.iter().any(|p| id.starts_with(p)),
                "{id} is cataloged but has no graph-storage type. If that is intended, add its prefix to CATALOG_ONLY_PREFIXES with the reason; otherwise register it with graph-storage too"
            );
        }
    }

    #[test]
    fn no_two_documents_in_one_registry_claim_the_same_id() {
        let mut seen: BTreeSet<(String, String)> = BTreeSet::new();
        for e in schemas() {
            let key = (
                e["registry"].as_str().unwrap_or_default().to_owned(),
                e["type_id"].as_str().unwrap_or_default().to_owned(),
            );
            assert!(
                seen.insert(key.clone()),
                "{} is registered twice in {} — two gears would race to define \
                 the same type",
                key.1,
                key.0
            );
        }
    }
}
