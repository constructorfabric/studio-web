//! `studio-backend gts-audit` — the three-way diff against a live deployment
//! (ADR-0013 §6.3).
//!
//! # Why a third check
//!
//! [`crate::gts_inventory`] proves what the *code* declares, offline, on every
//! PR. It cannot prove anything about a running cluster: a pod on an older
//! image, a profile that lost a config entry, a tenant whose graph ontology was
//! never populated, a type somebody registered by hand — none of that shows up
//! in `cargo test`. This command reads both registries through their own list
//! APIs and compares three sets:
//!
//! 1. what this binary would register (the committed inventory),
//! 2. what the platform **types-registry** actually holds
//!    (`GET /types-registry/v1/entities`),
//! 3. what **graph-storage** actually holds for the caller's tenant
//!    (`GET /graph-storage/v1/types`).
//!
//! It exits non-zero on any disagreement, so it can gate a deploy rather than
//! only inform a human.
//!
//! # Scope of the comparison
//!
//! Only `cf.studio.*` types are compared. The platform's own vocabulary
//! (`cf.core.*`, `cf.mini_chat.*`, `cf.toolkit.*`) is not ours to police, and a
//! deployment legitimately carries types from gears this binary does not
//! contain.
//!
//! A gear that stands down in a profile takes its types with it: `dev.yaml`
//! configures no database for `studio-documents`, so the nine `cf.studio.doc.*`
//! types are legitimately absent there and the audit says so by name. That is
//! the point — the alternative is finding out from an empty screen.
//!
//! Graph-storage is optional: an assembly built without the `graph` feature has
//! no such gear, and the audit reports that as *unavailable* rather than as a
//! disagreement — a deployment that never had a graph cannot disagree with one.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail};
use serde_json::Value;

use crate::gts_inventory;

/// Where to audit, and as whom.
pub struct Target {
    /// Deployment base URL **including the route prefix** — the profiles mount
    /// everything under one (`prefix_path: "/cf"` in `config/dev.yaml`), and
    /// hitting the root instead gives 404 on every path.
    pub base_url: String,
    /// Bearer token. Both list endpoints are `.authenticated()`.
    pub token: Option<String>,
    /// Tenant for the graph-storage read, sent as `X-Tenant-ID`. Graph-storage
    /// types are registered per tenant, so "which tenant" is part of the
    /// question; omitted means whatever the token's own context selects.
    pub tenant: Option<String>,
}

/// What one registry answered.
enum Side {
    /// Ids the registry holds, narrowed to `cf.studio.*`.
    Present(BTreeSet<String>),
    /// The gear is not in this deployment (404) — not a disagreement.
    Unavailable(String),
}

/// Run the audit, print the report, and fail if the three sets disagree.
///
/// # Errors
///
/// Returns an error when a registry cannot be read (other than a 404, which is
/// reported as unavailable) or when any disagreement was found.
pub async fn run(target: &Target) -> Result<()> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60))
        .build()?;
    let base = target.base_url.trim_end_matches('/');

    let registry = fetch_registry(&client, base, target).await?;
    let graph = fetch_graph(&client, base, target).await?;

    // What this binary would register, keyed by the leaf both registries
    // share. The value is the exact id the code sends where it knows it; a
    // plugin whose id the toolkit composes at runtime from a segment is known
    // by leaf only, so there is nothing exact to compare it against.
    let schemas = gts_inventory::schemas();
    let mut expect_registry: BTreeMap<String, Option<String>> = BTreeMap::new();
    for e in schemas
        .iter()
        .filter(|e| e["registry"] == gts_inventory::TYPES_REGISTRY)
    {
        if let Some(id) = e["type_id"].as_str() {
            expect_registry.insert(leaf(id), Some(id.to_owned()));
        }
    }
    for (_, id) in gts_inventory::config_declared_types() {
        expect_registry.insert(leaf(id), Some(id.to_owned()));
    }
    for e in gts_inventory::plugin_instances() {
        if let Some(id) = e["instance_id"].as_str() {
            expect_registry.insert(leaf(id), Some(id.to_owned()));
        }
    }
    for e in gts_inventory::plugin_instance_segments() {
        if let Some(seg) = e["segment"].as_str() {
            expect_registry.entry(leaf(seg)).or_insert(None);
        }
    }
    let expect_graph: BTreeMap<String, Option<String>> = schemas
        .iter()
        .filter(|e| e["registry"] == gts_inventory::GRAPH_STORAGE)
        .filter_map(|e| e["type_id"].as_str())
        .map(|id| (leaf(id), Some(id.to_owned())))
        .collect();

    println!("GTS audit of {base}");
    println!(
        "  this binary declares {} catalog and {} graph types ({} of them cf.studio.*)",
        expect_registry.len(),
        expect_graph.len(),
        expect_registry
            .keys()
            .chain(expect_graph.keys())
            .filter(|leaf| is_ours(leaf))
            .count(),
    );

    let mut disagreements = 0usize;
    disagreements += report("types-registry", &expect_registry, &registry);
    disagreements += report("graph-storage", &expect_graph, &graph);
    disagreements += report_cross_registry(&registry, &graph);

    if disagreements == 0 {
        println!("\nAll three agree.");
        return Ok(());
    }
    bail!(
        "{disagreements} disagreement(s) between the code and the live \
         deployment — see the report above"
    );
}

/// True for a type this binary is responsible for. Platform-owned vocabulary is
/// out of scope: a deployment carries types from gears we do not link.
fn is_ours(id: &str) -> bool {
    id.contains("cf.studio.")
}

/// The logical id of a type, i.e. its last `~`-segment. The two registries
/// carry the same type under different ancestry — a catalog entry is
/// `gts.cf.studio.kg.file.v1~`, the graph type is that leaf under the
/// `owned_node` family chain — so the leaf is the only key both sides share.
fn leaf(id: &str) -> String {
    id.rsplit('~')
        .find(|s| !s.is_empty())
        .unwrap_or(id)
        .trim_start_matches("gts.")
        .to_owned()
}

/// Print one side's diff, returning how many disagreements it found.
///
/// Comparison is on the leaf — the only key the two registries share — with the
/// exact id checked on top wherever the code knows it. That separates three
/// different findings: a type nobody registered, a type registered under other
/// ancestry than the code builds, and a type in the deployment that this binary
/// knows nothing about.
fn report(name: &str, expected: &BTreeMap<String, Option<String>>, side: &Side) -> usize {
    println!(
        "
── {name} ──"
    );
    let live = match side {
        Side::Unavailable(why) => {
            println!("  not present in this deployment ({why}) — nothing to compare");
            return 0;
        }
        Side::Present(ids) => ids,
    };
    let ours: BTreeMap<&String, &Option<String>> =
        expected.iter().filter(|(l, _)| is_ours(l)).collect();
    let live_by_leaf: BTreeMap<String, &String> = live.iter().map(|i| (leaf(i), i)).collect();
    println!(
        "  holds {} cf.studio.* ids; this binary declares {}",
        live.len(),
        ours.len()
    );

    let mut missing: Vec<&String> = Vec::new();
    let mut mismatched: Vec<(&String, &String)> = Vec::new();
    for (leaf_key, exact) in &ours {
        match live_by_leaf.get(*leaf_key) {
            None => missing.push(leaf_key),
            Some(live_id) => {
                if let Some(exact) = exact
                    && exact != *live_id
                {
                    mismatched.push((exact, live_id));
                }
            }
        }
    }
    let extra: Vec<&String> = live
        .iter()
        .filter(|i| !expected.contains_key(&leaf(i)))
        .collect();

    if missing.is_empty() && mismatched.is_empty() && extra.is_empty() {
        println!("  agrees with this binary");
        return 0;
    }
    if !missing.is_empty() {
        println!("  declared by this binary, NOT registered here:");
        for l in &missing {
            println!("    - {l}");
        }
    }
    if !mismatched.is_empty() {
        println!("  registered under different ancestry than this binary builds:");
        for (want, got) in &mismatched {
            println!(
                "    ! want {want}
      got  {got}"
            );
        }
    }
    if !extra.is_empty() {
        println!("  registered here, NOT declared by this binary:");
        for id in &extra {
            println!("    + {id}");
        }
    }
    missing.len() + mismatched.len() + extra.len()
}

/// The live form of ADR-0013's completeness invariant: a type in the graph with
/// no catalog entry is a registry that disagrees with the data, whatever the
/// code says either of them should hold.
fn report_cross_registry(registry: &Side, graph: &Side) -> usize {
    println!("\n── graph-storage vs types-registry (live) ──");
    let (Side::Present(cat), Side::Present(gph)) = (registry, graph) else {
        println!("  skipped — one of the two is not present in this deployment");
        return 0;
    };
    let cataloged: BTreeSet<String> = cat.iter().map(|i| leaf(i)).collect();
    let orphans: Vec<&String> = gph
        .iter()
        .filter(|i| !cataloged.contains(&leaf(i)))
        .collect();
    if orphans.is_empty() {
        println!("  every graph type has a catalog entry");
        return 0;
    }
    println!("  graph types with no catalog entry:");
    for id in &orphans {
        println!("    - {id}");
    }
    orphans.len()
}

/// `GET /types-registry/v1/entities` — the whole catalog, narrowed to ours.
async fn fetch_registry(client: &reqwest::Client, base: &str, t: &Target) -> Result<Side> {
    let url = format!("{base}/types-registry/v1/entities");
    let Some(body) = get_json(client, &url, t, false).await? else {
        return Ok(Side::Unavailable(
            "404 on /types-registry/v1/entities".into(),
        ));
    };
    let items = body
        .get("entities")
        .and_then(Value::as_array)
        .with_context(|| format!("{url}: response has no `entities` array"))?;
    Ok(Side::Present(collect_ids(items)))
}

/// `GET /graph-storage/v1/types` for both kinds. The route takes `kind`,
/// `pattern` and `limit` but no cursor, so a truncated listing is reported
/// rather than silently compared: a partial set would invent disagreements.
async fn fetch_graph(client: &reqwest::Client, base: &str, t: &Target) -> Result<Side> {
    let mut ids = BTreeSet::new();
    for kind in ["node", "edge"] {
        let url = format!("{base}/graph-storage/v1/types?kind={kind}&limit=1000");
        let Some(body) = get_json(client, &url, t, true).await? else {
            return Ok(Side::Unavailable(
                "404 on /graph-storage/v1/types (built without the `graph` feature?)".into(),
            ));
        };
        let items = body
            .get("items")
            .and_then(Value::as_array)
            .with_context(|| format!("{url}: response has no `items` array"))?;
        ids.extend(collect_ids(items));
        if body.get("next_cursor").is_some_and(|c| !c.is_null()) {
            bail!(
                "{url}: the listing is truncated (next_cursor set) and the route takes \
                 no cursor — raise `limit` or narrow with `pattern`; comparing a partial \
                 set would report disagreements that do not exist"
            );
        }
    }
    Ok(Side::Present(ids))
}

/// Pull the GTS id out of a list item, whichever of the shapes it uses, and
/// keep only ours. Defensive on the key name on purpose: the two gears name
/// the field differently (`gts_id` / `type_id`) and both have a v1 and a v2
/// surface.
fn collect_ids(items: &[Value]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for item in items {
        for key in ["gts_id", "gtsId", "type_id", "typeId", "id", "$id"] {
            if let Some(id) = item.get(key).and_then(Value::as_str) {
                let id = id.trim_start_matches("gts://");
                if is_ours(id) {
                    out.insert(id.to_owned());
                }
                break;
            }
        }
    }
    out
}

/// One authenticated GET. `Ok(None)` means 404 — the gear is not here.
async fn get_json(
    client: &reqwest::Client,
    url: &str,
    t: &Target,
    with_tenant: bool,
) -> Result<Option<Value>> {
    let mut req = client.get(url);
    if let Some(token) = &t.token {
        req = req.bearer_auth(token);
    }
    if with_tenant && let Some(tenant) = &t.tenant {
        req = req.header("X-Tenant-ID", tenant);
    }
    let res = req
        .send()
        .await
        .with_context(|| format!("GET {url} failed — is the deployment reachable?"))?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        // 401/403 is the common mistake: both list endpoints are authenticated.
        bail!("GET {url} returned {status}: {}", text.trim());
    }
    Ok(Some(serde_json::from_str(&text).with_context(|| {
        format!("GET {url}: response is not JSON: {}", text.trim())
    })?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_leaf_is_the_key_both_registries_share() {
        assert_eq!(
            leaf("gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~cf.studio.kg.file.v1~"),
            "cf.studio.kg.file.v1"
        );
        assert_eq!(leaf("gts.cf.studio.kg.file.v1~"), "cf.studio.kg.file.v1");
        // A catalog entry under the tenant-metadata envelope and its bare form
        // collapse to the same key, which is what lets the two be compared.
        assert_eq!(
            leaf("gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~"),
            "cf.studio.access.config.v1"
        );
    }

    #[test]
    fn only_studio_types_are_in_scope() {
        assert!(is_ours("gts.cf.studio.domain.team.v1~"));
        assert!(is_ours(
            "gts.cf.core.am.tenant_metadata.v1~cf.studio.project.config.v1~"
        ));
        assert!(!is_ours("gts.cf.core.am.tenant.v1~"));
        assert!(!is_ours("cf.mini_chat._.chat_create.v1~"));
    }

    #[test]
    fn ids_are_collected_from_either_field_name() {
        let items = vec![
            serde_json::json!({ "gts_id": "gts.cf.studio.domain.team.v1~" }),
            serde_json::json!({ "type_id": "gts://gts.cf.studio.kg.file.v1~" }),
            serde_json::json!({ "gts_id": "cf.core.am.user_update.v1~" }),
        ];
        let ids = collect_ids(&items);
        assert_eq!(
            ids.len(),
            2,
            "the platform-owned id is out of scope: {ids:?}"
        );
        assert!(ids.contains("gts.cf.studio.kg.file.v1~"), "{ids:?}");
    }

    #[test]
    fn an_absent_gear_is_not_a_disagreement() {
        let expected = BTreeMap::from([(
            "cf.studio.kg.file.v1".to_owned(),
            Some("gts.cf.studio.kg.file.v1~".to_owned()),
        )]);
        assert_eq!(
            report("graph-storage", &expected, &Side::Unavailable("404".into())),
            0
        );
    }

    #[test]
    fn a_type_registered_under_other_ancestry_is_one_finding_not_two() {
        let expected = BTreeMap::from([(
            "cf.studio.kg.file.v1".to_owned(),
            Some("gts.cf.studio.kg.file.v1~".to_owned()),
        )]);
        let live = Side::Present(
            [
                "gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~cf.studio.kg.file.v1~"
                    .to_owned(),
            ]
            .into(),
        );
        // The leaf matches, so it is neither missing nor extra — it is one
        // ancestry mismatch, which is what an operator has to act on.
        assert_eq!(report("types-registry", &expected, &live), 1);
    }

    #[test]
    fn an_instance_known_only_by_its_segment_matches_on_the_leaf() {
        // The toolkit composes a plugin instance id from a segment plus the
        // contract it derives from, so the code has no exact id to compare —
        // only the leaf, and that must not read as a disagreement.
        let expected = BTreeMap::from([("cf.studio.authz_resolver.plugin.v1".to_owned(), None)]);
        let live = Side::Present(
            ["gts.cf.toolkit.plugins.plugin.v1~cf.core.authz_resolver.plugin.v1~cf.studio.authz_resolver.plugin.v1"
                .to_owned()]
            .into(),
        );
        assert_eq!(report("types-registry", &expected, &live), 0);
    }

    #[test]
    fn a_type_nobody_registered_is_reported_missing() {
        let expected = BTreeMap::from([(
            "cf.studio.doc.adr.v1".to_owned(),
            Some("gts.cf.studio.doc.adr.v1~".to_owned()),
        )]);
        assert_eq!(
            report("types-registry", &expected, &Side::Present(BTreeSet::new())),
            1
        );
    }
}
