//! GTS identifiers for the connector subsystem.
//!
//! The provider *driver* is a plugin: it registers a `PluginV1` instance
//! under the connector plugin contract and publishes a scoped
//! [`super::driver::ConnectorDriver`] client under the same GTS id, exactly
//! like the IdP / authn / authz plugin families.
//!
//! The type schemas themselves are declared in the deployment profile
//! (`config/*.yaml`, `types-registry.static_entities`) rather than through
//! `#[gts_type_schema]`, matching how this crate already declares
//! `cf.studio.workspace.settings.v1`. Runtime behaviour is identical — the
//! registry stores the same documents — and the assembly crate stays free of
//! the GTS macro toolchain.

/// Plugin contract every connector driver derives from.
pub const CONNECTOR_PLUGIN_TYPE: &str =
    "gts.cf.toolkit.plugins.plugin.v1~cf.studio.connector.plugin.v1~";

/// Driver instance ids. One per provider; the connector gear resolves its
/// scoped client by this string, so a provider whose plugin gear is absent
/// from the assembly simply reports as unavailable.
pub const GITLAB_INSTANCE_ID: &str = "gts.cf.toolkit.plugins.plugin.v1~cf.studio.connector.plugin.v1~cf.studio._.gitlab_connector.v1";
pub const GITHUB_INSTANCE_ID: &str = "gts.cf.toolkit.plugins.plugin.v1~cf.studio.connector.plugin.v1~cf.studio._.github_connector.v1";
pub const BITBUCKET_INSTANCE_ID: &str = "gts.cf.toolkit.plugins.plugin.v1~cf.studio.connector.plugin.v1~cf.studio._.bitbucket_connector.v1";
pub const ANTHROPIC_INSTANCE_ID: &str = "gts.cf.toolkit.plugins.plugin.v1~cf.studio.connector.plugin.v1~cf.studio._.anthropic_connector.v1";
pub const OPENAI_INSTANCE_ID: &str = "gts.cf.toolkit.plugins.plugin.v1~cf.studio.connector.plugin.v1~cf.studio._.openai_connector.v1";

/// Tenant-metadata schema holding the connection catalogue of one tenant.
/// Connections are configuration, not secrets: the token lives in credstore
/// and only its reference is stored here.
///
/// NB the segment shape. A GTS segment is `vendor.package.namespace.type.vN`
/// (gts-spec §"gts-segment"), i.e. five dot-separated parts — the earlier
/// `cf.studio.connections.v1` had four and the registry rejected it at boot
/// with a bare `invalid_argument: Request validation failed`. `catalogue`
/// rather than `connection` because one row holds the whole list; the
/// singular id belongs to the REST error resource type.
pub const CONNECTIONS_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.connector.catalogue.v1~";

/// Build the `PluginV1` registration document for a driver.
///
/// Hand-built rather than via `PluginV1::build_registration` because that
/// helper needs a `gts::GtsSchema` spec type, which in turn needs the GTS
/// derive macros in this crate. The emitted document is byte-compatible.
pub fn plugin_registration(instance_id: &str, vendor: &str, priority: i16) -> serde_json::Value {
    // The registry would reject a document whose id does not derive from the
    // contract, but only at boot and with a message about GTS chains. Catch a
    // mistyped instance id here instead, where the fix is obvious.
    debug_assert!(
        instance_id.starts_with(CONNECTOR_PLUGIN_TYPE),
        "connector driver instance id must derive from {CONNECTOR_PLUGIN_TYPE}, got {instance_id}"
    );
    serde_json::json!({
        "id": instance_id,
        "vendor": vendor,
        "priority": priority,
        "properties": {},
    })
}

// ── The repository knowledge graph ────────────────────────────────────────
// The types [`super::graph_sync`] writes when it walks a connected repository.
// They live here, with the subsystem's other identifiers, rather than next to
// the walk itself: `graph_sync` is behind the `graph` feature, and the GTS
// inventory (`crate::gts_inventory`) must enumerate every document this
// assembly registers whether that feature is on or off.

/// The graph-storage families this producer's types derive from.
///
/// Derivation is not decoration: `family` is declared required with no default
/// on the two bases, so a type deriving straight from a base resolves no family
/// and cannot be instantiated. Repositories, directories and files are *owned*
/// nodes — the graph is their system of record here — and the relations are
/// *static* edges, replaced wholesale by a re-sync.
pub(crate) const OWNED_NODE: &str = "gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~";
pub(crate) const STATIC_EDGE: &str = "gts.cf.core.graph.edge.v1~cf.core.graph.static_edge.v1~";

/// Node types this producer writes.
pub(crate) const T_REPOSITORY: &str = "cf.studio.kg.repository.v1~";
pub(crate) const T_DIRECTORY: &str = "cf.studio.kg.directory.v1~";
pub(crate) const T_FILE: &str = "cf.studio.kg.file.v1~";
pub(crate) const T_PERSON: &str = "cf.studio.kg.person.v1~";
pub(crate) const T_PROJECT: &str = "cf.studio.kg.project.v1~";

/// Edge types this producer writes.
pub(crate) const T_CONTAINS: &str = "cf.studio.kg.contains.v1~";
pub(crate) const T_CONTRIBUTED_TO: &str = "cf.studio.kg.contributed_to.v1~";
pub(crate) const T_INCLUDES: &str = "cf.studio.kg.includes.v1~";

/// The registered identifier of one of this producer's types: the family chain
/// followed by the leaf.
pub(crate) fn graph_type_id(leaf: &str, family: &str) -> String {
    format!("{family}{leaf}")
}

/// One producer type: a schema deriving from its family, with the searchable
/// payload paths declared as a trait so the gear composes the search text
/// itself rather than taking a producer-supplied string.
fn schema_of(leaf: &str, family: &str, search_paths: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "$id": format!("gts://{}", graph_type_id(leaf, family)),
        "$schema": "http://json-schema.org/draft-07/schema#",
        "x-gts-traits": { "full_text_search": search_paths },
        "type": "object",
        "allOf": [{ "$ref": format!("gts://{family}") }],
    })
}

/// The same types as **platform types-registry** catalog entries.
///
/// Free-form (`type: object`), like every other studio catalog document, so
/// registration never trips the closed-envelope narrowing check. Registered so
/// the platform registry catalogs everything this gear puts in the graph —
/// without these the repository knowledge graph existed only in graph-storage
/// and the two registries disagreed (`crate::gts_inventory` now asserts they
/// do not).
pub(crate) fn catalog_type_schemas() -> Vec<serde_json::Value> {
    [
        (
            T_REPOSITORY,
            "Repository",
            "A source repository walked into the knowledge graph.",
        ),
        (
            T_DIRECTORY,
            "Directory",
            "A directory in a repository tree.",
        ),
        (T_FILE, "File", "A file in a repository tree."),
        (
            T_PERSON,
            "Person",
            "A contributor account, keyed per provider until its owner proves control of it.",
        ),
        (
            T_PROJECT,
            "Project",
            "The Studio project a repository was walked for.",
        ),
        (
            T_CONTAINS,
            "Contains",
            "A repository or directory and what it contains.",
        ),
        (
            T_CONTRIBUTED_TO,
            "ContributedTo",
            "A person and a repository they contributed to.",
        ),
        (
            T_INCLUDES,
            "Includes",
            "A project and a repository attached to it.",
        ),
    ]
    .into_iter()
    .map(|(leaf, title, description)| {
        serde_json::json!({
            // `leaf` already carries its trailing `~`, so the catalog id is the
            // leaf under the `gts.` prefix every registered id starts with.
            "$id": format!("gts://gts.{leaf}"),
            "$schema": "http://json-schema.org/draft-07/schema#",
            "title": title,
            "description": description,
            "type": "object",
        })
    })
    .collect()
}

/// Every type the repository walk registers, in the order it registers them.
///
/// The graph gear rejects an ingest naming an unregistered type, and rejects it
/// wholesale, so nothing the walk writes may be missing from this list.
pub(crate) fn graph_type_schemas() -> Vec<serde_json::Value> {
    [
        (T_REPOSITORY, OWNED_NODE, &["/payload/full_path"][..]),
        (T_DIRECTORY, OWNED_NODE, &["/payload/path"][..]),
        (
            T_FILE,
            OWNED_NODE,
            &["/payload/path", "/payload/extension"][..],
        ),
        (T_PERSON, OWNED_NODE, &["/payload/login"][..]),
        (T_PROJECT, OWNED_NODE, &[][..]),
        (T_CONTAINS, STATIC_EDGE, &[][..]),
        (T_CONTRIBUTED_TO, STATIC_EDGE, &[][..]),
        (T_INCLUDES, STATIC_EDGE, &[][..]),
    ]
    .into_iter()
    .map(|(leaf, family, search)| schema_of(leaf, family, search))
    .collect()
}
