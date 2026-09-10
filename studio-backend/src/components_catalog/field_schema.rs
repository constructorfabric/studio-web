//! What a component of a given type is *made of*: the fields a page shows for
//! it, the group they sit in, and where each one comes from.
//!
//! A component type is a GTS type. A field schema is data **about** that type,
//! so it belongs beside the type rather than inside a screen — that is the
//! whole point of this module. It used to be a JSON file compiled into the
//! prototype, which meant a micro-frontend rendered against the gear schema
//! (sixty-two fields, eleven of them ever filled) and no tenant could change
//! either without a release.
//!
//! # Where a schema lives
//!
//! Not in the types-registry. ADR-0013 makes that registry the catalogue of
//! *meaning* — a title and a description written for people — and the studio's
//! catalogue types are registered there as free-form `type: object`. A test
//! (`types_registry_documents_stay_free_form`) pins that, because narrowing a
//! closed envelope trips the GTS inclusion check. A field schema is not the
//! type's meaning and cannot become its `properties`.
//!
//! # What the node holds
//!
//! Two things about a type, not one: the field schema above, and whether this
//! organization treats the type as a **component** at all. They share a node
//! because they share an identity — "what the studio says about this GTS type"
//! — and splitting them would mean two overlays and two reverts for one
//! answer.
//!
//! The GTS id stayed `catalog.field_schema.v1~` even though the node outgrew
//! the name. A registered type id is immutable (ADR-0013); minting
//! `type_profile.v1~` would leave `field_schema.v1~` in the deployment-wide
//! catalogue forever as a type nothing writes. A slightly narrow name costs
//! less than a dead one, and the next version bump can carry the rename.
//!
//! It lives in **graph-storage**, one node per described type, exactly the
//! shape [`super::gts::GEAR_PROFILE_TYPE`] already uses for editable
//! per-component metadata — one level up, describing a type instead of an
//! instance. Graph-storage is tenant-scoped, so a tenant's node is that
//! tenant's schema and the built-ins below are what it falls back to: the
//! overlay is `builtin → this tenant`, and reverting is deleting the node.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::gts::{FRONTX_TYPE, GEAR_TYPE, KIT_TYPE};
/// A document type is a component, but studio-documents owns it and keeps its
/// identity: the catalogue lists it, it does not annex it (see ADR-0014).
use crate::documents::gts::DOCUMENT_TYPE;

/// The gear schema: sixty-two fields across nine groups, the delivery model the
/// gears-catalog playground argues over. It moved here from the prototype so
/// there is one copy of it and the server is the one that has it.
const GEAR_SCHEMA_JSON: &str = include_str!("field_schemas/gear.json");

/// Where a field's value comes from, as the page's source glossary names it:
/// `repo`, `api`, `manual` or `none`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldSource {
    pub class: String,
    /// The file, endpoint or tree the value is read from. `ref` is a Rust
    /// keyword, so the field is spelled out and renamed on the wire.
    #[serde(rename = "ref")]
    pub reference: String,
}

/// One field: what it is called, how it renders, and whether it is judged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Field {
    pub key: String,
    pub label: String,
    /// `text`, `label`, `docstate`, `bool`, `metric` or `status`.
    pub kind: String,
    /// Whether an unmet expectation on this field lights a lamp.
    #[serde(default)]
    pub lamp: bool,
    pub source: FieldSource,
    /// A sample value, shown as placeholder text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,
    /// The rule a lamp is judged against. Open on purpose: the rules differ
    /// per field and a closed shape here would be a migration per rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<Value>,
}

/// A titled set of fields — one card on the component page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub title: String,
    pub icon: String,
    pub fields: Vec<Field>,
}

/// One band of the composition bar (spec / code / tests / …).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompositionPart {
    pub key: String,
    pub label: String,
    pub color: String,
}

/// A source class as the page's glossary explains it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceClassDoc {
    pub label: String,
    pub hint: String,
}

/// The presentation of one component type.
///
/// `describes` is a GTS type id, and it is the identity: there is at most one
/// schema per type per tenant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeFieldSchema {
    /// The GTS type this schema is the presentation of.
    #[serde(default)]
    pub describes: String,
    pub groups: Vec<Group>,
    #[serde(default)]
    pub composition: Vec<CompositionPart>,
    #[serde(default)]
    pub status_legend: BTreeMap<String, String>,
    #[serde(default)]
    pub doc_state_legend: BTreeMap<String, String>,
    #[serde(default)]
    pub source_classes: BTreeMap<String, SourceClassDoc>,
    /// `builtin` or `tenant` — filled on read, never taken from the caller, so
    /// a screen can say where a schema came from and offer to revert it.
    #[serde(default = "builtin_owner")]
    pub owner: String,
    /// A tenant node with `hidden` set removes an inherited built-in rather
    /// than replacing it: a deployment that does not use kits should not have
    /// to keep a kit schema it cannot delete.
    #[serde(default)]
    pub hidden: bool,
    /// Whether this organization treats the type as a **component**: something
    /// the Components page lists and a project can take.
    ///
    /// The graph holds far more types than that — files, chunks, commits,
    /// domain entities — and which of them are building blocks is a judgement
    /// about the organization's model, not a fact about storage. So it is a
    /// mark an organization sets, with the built-ins below as the opening
    /// position rather than the answer.
    #[serde(default)]
    pub component: bool,
}

fn builtin_owner() -> String {
    "builtin".to_string()
}

impl TypeFieldSchema {
    /// Every field in the schema, in group order.
    pub fn fields(&self) -> impl Iterator<Item = &Field> {
        self.groups.iter().flat_map(|g| g.fields.iter())
    }
}

/// The gear schema, parsed from the committed JSON.
///
/// Panics on a malformed file, which is the right failure: it is compiled in,
/// so a bad one is a build-time mistake and a test below catches it before a
/// deployment does.
fn gear_schema() -> TypeFieldSchema {
    let mut schema: TypeFieldSchema = serde_json::from_str(GEAR_SCHEMA_JSON)
        .expect("the committed gear field schema parses (see field_schemas/gear.json)");
    schema.describes = GEAR_TYPE.to_string();
    // The deployment ships a page for it, so it is a component out of the box
    // -- the same statement `schema_from` makes for the derived schemas, which
    // this one does not go through because it is parsed rather than built.
    schema.component = true;
    schema
}

/// A field of the gear schema by key, so another type's schema reuses a label
/// and a source rather than restating them and drifting from it.
fn pick(index: &BTreeMap<String, Field>, keys: &[&str]) -> Vec<Field> {
    keys.iter().filter_map(|k| index.get(*k).cloned()).collect()
}

/// A field a type has and the gear schema does not.
fn own(key: &str, label: &str, kind: &str, reference: &str) -> Field {
    Field {
        key: key.to_string(),
        label: label.to_string(),
        kind: kind.to_string(),
        lamp: false,
        source: FieldSource {
            class: "repo".to_string(),
            reference: reference.to_string(),
        },
        example: None,
        domain: None,
    }
}

/// A group of an inherited type, keeping the gear schema's title and icon so
/// two component pages put the same kind of thing under the same heading.
fn group(id: &str, title: &str, icon: &str, fields: Vec<Field>) -> Group {
    Group {
        id: id.to_string(),
        title: title.to_string(),
        icon: icon.to_string(),
        fields,
    }
}

/// The parts that are the same whatever the type: the legends and the source
/// glossary a reader needs to interpret any cell at all.
fn schema_from(describes: &str, gear: &TypeFieldSchema, groups: Vec<Group>) -> TypeFieldSchema {
    TypeFieldSchema {
        describes: describes.to_string(),
        groups,
        composition: Vec::new(),
        status_legend: gear.status_legend.clone(),
        doc_state_legend: gear.doc_state_legend.clone(),
        source_classes: gear.source_classes.clone(),
        owner: builtin_owner(),
        hidden: false,
        // A type this deployment shipped a component page for is a component
        // out of the box. An organization can still unmark it.
        component: true,
    }
}

/// The schemas this deployment ships with — one per component type the
/// catalogue knows by name.
///
/// A type that is not here renders against the gear schema, which is the only
/// honest default: it is the one that describes a crate, and a type we do not
/// know is more likely to be a new crate-shaped thing than a new shape.
pub fn builtin_schemas() -> Vec<TypeFieldSchema> {
    let gear = gear_schema();
    let index: BTreeMap<String, Field> =
        gear.fields().map(|f| (f.key.clone(), f.clone())).collect();

    // A micro-frontend fills eleven keys. Rendering one against the gear
    // schema is a page of "no data" with its handful of real values lost in
    // it: crates, migrations, supported databases and published versions are
    // not things an npm package in a monorepo has.
    let frontx = schema_from(
        FRONTX_TYPE,
        &gear,
        vec![
            group(
                "summary",
                "Summary",
                "S",
                pick(&index, &["description", "category", "path", "version"]),
            ),
            group("contracts", "Contracts and dependencies", "C", {
                let mut f = pick(&index, &["deps", "openapi"]);
                f.push(own("deps_names", "Dependencies", "text", "package.json"));
                f
            }),
            group("qa", "Quality assurance", "Q", pick(&index, &["unitmods"])),
            group("ops", "Operations", "O", pick(&index, &["guideline"])),
            group(
                "security",
                "Security and compliance",
                "K",
                pick(&index, &["licence"]),
            ),
            group(
                "delivery",
                "Delivery health",
                "D",
                pick(&index, &["lastchange"]),
            ),
        ],
    );

    // A kit is a repository, a ref and a manifest — and it keeps them on the
    // node itself rather than in an editable profile, because for a kit the
    // manifest is what a profile is for a gear.
    let kit = schema_from(
        KIT_TYPE,
        &gear,
        vec![
            group("summary", "Summary", "S", {
                let mut f = pick(&index, &["description"]);
                f.push(own("publisher", "Publisher", "text", ".cf-studio-kit.toml"));
                f
            }),
            group(
                "source",
                "Source",
                "C",
                vec![
                    own("repository", "Repository", "text", "catalogue source"),
                    own("git_ref", "Git ref", "label", "catalogue source"),
                    own("manifest_path", "Manifest", "text", "repository tree"),
                ],
            ),
        ],
    );

    // A document type is a template, a checklist and a questionnaire. It has
    // no repository and no version, and saying so by omission is the point.
    let document = schema_from(
        DOCUMENT_TYPE,
        &gear,
        vec![group("summary", "Summary", "S", {
            let mut f = pick(&index, &["description"]);
            f.push(own("owner", "Defined at", "label", "studio-documents"));
            f.push(own("sections", "Sections", "metric", "type template"));
            f
        })],
    );

    vec![gear, frontx, kit, document]
}

/// The built-ins with this tenant's own records laid over them.
///
/// A tenant node that carries groups **replaces** the built-in layout
/// wholesale: a schema is a layout, and merging two layouts field by field
/// produces a third that neither side chose. `hidden` removes an inherited
/// built-in instead.
///
/// A tenant node with **no groups** is a different statement. It is what
/// marking a type as a component writes — an opinion about what the type is,
/// with none about how it looks — so it keeps the inherited layout and only
/// its mark is taken. Without this rule, ticking a box on the Objects page
/// would silently blank the gear schema, which is the kind of quiet damage a
/// wholesale replace is otherwise right to do loudly.
pub fn overlay(
    builtins: Vec<TypeFieldSchema>,
    stored: Vec<TypeFieldSchema>,
) -> Vec<TypeFieldSchema> {
    let mut by_type: BTreeMap<String, TypeFieldSchema> = builtins
        .into_iter()
        .map(|s| (s.describes.clone(), s))
        .collect();
    for mut s in stored {
        match by_type.get(&s.describes) {
            Some(builtin) if s.groups.is_empty() => {
                let mut merged = builtin.clone();
                merged.component = s.component;
                merged.hidden = s.hidden;
                by_type.insert(s.describes.clone(), merged);
            }
            _ => {
                // `owner` answers "who authored this layout", so a record with
                // no layout does not claim one. Marking a type the deployment
                // never described must not make the tenant the author of a
                // page that does not exist.
                s.owner = if s.groups.is_empty() {
                    builtin_owner()
                } else {
                    "tenant".to_string()
                };
                by_type.insert(s.describes.clone(), s);
            }
        }
    }
    by_type.into_values().filter(|s| !s.hidden).collect()
}

impl TypeFieldSchema {
    /// Whether storing this record would change anything for the tenant,
    /// given what it would otherwise inherit.
    ///
    /// The comparison matters, and a plain "is it empty?" would get it wrong
    /// in both directions. Unmarking a built-in component stores
    /// `component: false`, which looks empty and is not — dropping it would
    /// hand the type straight back. Marking a type with no built-in stores
    /// `component: true`, which is the whole record. So the question is never
    /// "is this record blank" but "does it differ from the inheritance".
    pub fn adds_anything(&self, inherited_component: bool) -> bool {
        !self.groups.is_empty() || self.hidden || self.component != inherited_component
    }

    /// This record with only the mark kept — what reverting a layout leaves.
    pub fn without_layout(&self) -> Self {
        Self {
            describes: self.describes.clone(),
            groups: Vec::new(),
            composition: Vec::new(),
            status_legend: BTreeMap::new(),
            doc_state_legend: BTreeMap::new(),
            source_classes: BTreeMap::new(),
            owner: builtin_owner(),
            hidden: self.hidden,
            component: self.component,
        }
    }

    /// An empty record for one type — the starting point for a first mark.
    pub fn empty_for(describes: &str) -> Self {
        Self {
            describes: describes.to_string(),
            groups: Vec::new(),
            composition: Vec::new(),
            status_legend: BTreeMap::new(),
            doc_state_legend: BTreeMap::new(),
            source_classes: BTreeMap::new(),
            owner: builtin_owner(),
            hidden: false,
            component: false,
        }
    }
}

/// Whether the deployment ships this type as a component. What a stored
/// record is compared against before it is kept or pruned.
pub fn builtin_component(describes: &str) -> bool {
    builtin_schemas()
        .into_iter()
        .any(|s| s.describes == describes && s.component)
}

/// The stored payload for one schema. `name` is what graph-storage titles the
/// node with, and the described type is the most useful thing to see there.
pub fn to_payload(schema: &TypeFieldSchema) -> anyhow::Result<Value> {
    let mut value = serde_json::to_value(schema)?
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("a field schema serializes to an object"))?;
    value.insert("name".to_string(), Value::String(schema.describes.clone()));
    // `owner` is decided on read — a stored node is by definition the tenant's.
    value.remove("owner");
    Ok(Value::Object(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The committed JSON is compiled in, so a malformed one is a build-time
    /// mistake — but only if something parses it before a request does.
    #[test]
    fn the_committed_gear_schema_parses() {
        let gear = gear_schema();
        assert_eq!(gear.describes, GEAR_TYPE);
        assert_eq!(gear.groups.len(), 9);
        assert_eq!(gear.fields().count(), 62);
        assert!(gear.source_classes.contains_key("repo"));
        assert!(gear.status_legend.contains_key("good"));
    }

    /// Every type the catalogue registers a node for and renders a page of.
    #[test]
    fn there_is_a_schema_for_every_named_component_type() {
        let described: Vec<String> = builtin_schemas().into_iter().map(|s| s.describes).collect();
        for expected in [GEAR_TYPE, FRONTX_TYPE, KIT_TYPE, DOCUMENT_TYPE] {
            assert!(
                described.iter().any(|d| d == expected),
                "no field schema describes {expected}"
            );
        }
    }

    /// `pick` resolves against the gear schema, so a typo in a key would
    /// silently shrink a schema rather than fail. Count what survived.
    #[test]
    fn every_picked_key_resolved() {
        let by_type: BTreeMap<String, TypeFieldSchema> = builtin_schemas()
            .into_iter()
            .map(|s| (s.describes.clone(), s))
            .collect();
        assert_eq!(by_type[FRONTX_TYPE].fields().count(), 11);
        assert_eq!(by_type[KIT_TYPE].fields().count(), 5);
        assert_eq!(by_type[DOCUMENT_TYPE].fields().count(), 3);
    }

    /// The bug this module exists to fix, stated as a test: a micro-frontend
    /// page must not ask about things an npm package cannot have.
    #[test]
    fn a_micro_frontend_is_not_asked_about_crates_or_migrations() {
        let frontx = builtin_schemas()
            .into_iter()
            .find(|s| s.describes == FRONTX_TYPE)
            .expect("frontx schema");
        for absent in ["crates", "migrations", "dbs", "downloads", "published"] {
            assert!(
                !frontx.fields().any(|f| f.key == absent),
                "the micro-frontend schema still asks for `{absent}`"
            );
        }
    }

    /// A picked field keeps the gear schema's label and source, which is why
    /// two pages can be read side by side at all.
    #[test]
    fn a_picked_field_keeps_its_label_and_source() {
        let frontx = builtin_schemas()
            .into_iter()
            .find(|s| s.describes == FRONTX_TYPE)
            .expect("frontx schema");
        let description = frontx
            .fields()
            .find(|f| f.key == "description")
            .expect("description is picked");
        assert_eq!(description.label, "Description");
        assert_eq!(description.source.reference, "gear.toml");
    }

    fn stub(describes: &str, group_title: &str, hidden: bool) -> TypeFieldSchema {
        TypeFieldSchema {
            groups: vec![group(
                "only",
                group_title,
                "S",
                vec![own("k", "K", "text", "somewhere")],
            )],
            hidden,
            component: true,
            ..TypeFieldSchema::empty_for(describes)
        }
    }

    /// What marking a type on the Objects page writes: an opinion about what
    /// the type is, and none about how it looks.
    fn mark(describes: &str, component: bool) -> TypeFieldSchema {
        TypeFieldSchema {
            component,
            ..TypeFieldSchema::empty_for(describes)
        }
    }

    #[test]
    fn every_builtin_schema_is_a_builtin_component() {
        assert!(builtin_schemas().iter().all(|s| s.component));
    }

    /// The rule that makes the Objects page safe: a mark carries no layout, so
    /// it must not take one away.
    #[test]
    fn marking_a_type_keeps_the_layout_it_inherited() {
        let out = overlay(builtin_schemas(), vec![mark(GEAR_TYPE, false)]);
        let gear = out
            .iter()
            .find(|s| s.describes == GEAR_TYPE)
            .expect("gear survives");
        assert_eq!(gear.fields().count(), 62, "the mark blanked the layout");
        assert!(!gear.component, "the mark was not taken");
        assert_eq!(gear.owner, "builtin", "nobody authored a layout here");
    }

    /// A type with no built-in becomes a component with no layout of its own,
    /// which is exactly what the client's fallback is for.
    #[test]
    fn marking_a_type_with_no_builtin_leaves_it_without_a_layout() {
        let novel = "gts.cf.acme.catalog.dataset.v1~";
        let out = overlay(builtin_schemas(), vec![mark(novel, true)]);
        let dataset = out
            .iter()
            .find(|s| s.describes == novel)
            .expect("the marked type is listed");
        assert!(dataset.component);
        assert_eq!(dataset.groups.len(), 0);
    }

    /// A stored record is worth keeping exactly when it differs from what the
    /// tenant would inherit — not when it is non-empty.
    #[test]
    fn a_record_is_kept_only_when_it_differs_from_the_inheritance() {
        // Nothing said, nothing inherited.
        assert!(!TypeFieldSchema::empty_for(GEAR_TYPE).adds_anything(false));
        // Unmarking a built-in component is a real statement, and the record
        // that carries it looks blank.
        assert!(mark(GEAR_TYPE, false).adds_anything(true));
        // Marking a type nothing shipped is the whole record.
        assert!(mark(GEAR_TYPE, true).adds_anything(false));
        // Agreeing with the inheritance is not a statement.
        assert!(!mark(GEAR_TYPE, true).adds_anything(true));
        // A layout always is.
        assert!(stub(GEAR_TYPE, "Ours", false).adds_anything(true));
        assert!(
            !stub(GEAR_TYPE, "Ours", false)
                .without_layout()
                .adds_anything(true),
            "reverting a layout that agreed with the inheritance leaves nothing"
        );
        assert!(
            TypeFieldSchema {
                component: false,
                ..stub(GEAR_TYPE, "Ours", false)
            }
            .without_layout()
            .adds_anything(true),
            "reverting a layout must not throw away the mark"
        );
    }

    #[test]
    fn a_tenant_schema_replaces_the_builtin_for_its_type() {
        let out = overlay(builtin_schemas(), vec![stub(FRONTX_TYPE, "Ours", false)]);
        let frontx = out
            .iter()
            .find(|s| s.describes == FRONTX_TYPE)
            .expect("frontx survives");
        assert_eq!(frontx.groups[0].title, "Ours");
        assert_eq!(frontx.owner, "tenant");
        // and it replaced exactly one thing
        assert_eq!(out.len(), builtin_schemas().len());
        assert_eq!(
            out.iter().find(|s| s.describes == GEAR_TYPE).unwrap().owner,
            "builtin"
        );
    }

    #[test]
    fn a_hidden_schema_drops_the_builtin_rather_than_replacing_it() {
        let out = overlay(builtin_schemas(), vec![stub(KIT_TYPE, "gone", true)]);
        assert!(!out.iter().any(|s| s.describes == KIT_TYPE));
        assert_eq!(out.len(), builtin_schemas().len() - 1);
    }

    /// A type the deployment has never heard of is a schema like any other —
    /// that is what makes this extensible without a release.
    #[test]
    fn a_tenant_can_add_a_schema_for_a_type_that_has_no_builtin() {
        let novel = "gts.cf.studio.catalog.dataset.v1~";
        let out = overlay(builtin_schemas(), vec![stub(novel, "Dataset", false)]);
        assert_eq!(out.len(), builtin_schemas().len() + 1);
        assert!(out.iter().any(|s| s.describes == novel));
    }

    /// The stored payload round-trips, and does not carry an `owner` the read
    /// side would then have to distrust.
    #[test]
    fn a_payload_round_trips_without_carrying_its_owner() {
        let schema = stub(KIT_TYPE, "Ours", false);
        let payload = to_payload(&schema).expect("payload");
        assert_eq!(payload["name"], Value::String(KIT_TYPE.to_string()));
        assert!(payload.get("owner").is_none());
        let back: TypeFieldSchema = serde_json::from_value(payload).expect("parses back");
        assert_eq!(back.groups, schema.groups);
        assert_eq!(back.owner, "builtin", "the read side decides the owner");
    }
}
