//! The organization's registry of its components (ADR-0041, phase P1), and
//! the catalogue sources it keeps on the server.
//!
//! Three things live here:
//!
//! - **Sources.** The repositories the catalogue reads, one
//!   `gts.cf.studio.catalog.source.v1~` node each, per organization. They
//!   replace the browser's `cf.components.sources`; a `catalog.sync` whose
//!   body names no repositories reads these.
//! - **The walk** (`catalog.registry`). Every project of the organization
//!   (`organizations::port::ProjectsOf`) not excluded, each repository it
//!   resolves to exactly as `project_gears` does (the gear repository, else
//!   the `project.config` `sources[]`), read again only when the fingerprint
//!   of the files discovery reads moved since the stored one
//!   (`registry_read` nodes, so a restart does not read everything again).
//! - **The registry.** One `registry_entry` per component name, one
//!   `occurrence` per place it was found, joined by `found_in`.
//!
//! The rules -- what a walk writes, retires and marks orphaned, and that
//! discovery moves no state but candidate to declared -- are [`plan`], a pure function;
//! the rest is reading and writing around it.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::candidates::{Candidate, kebab};
pub use super::candidates::{DETECTED, Evidence};
use super::gts::{self, GtsEdge, GtsNode};
use super::project_gears::LocalGear;
use super::repo_enrich::ProjectGearsRead;
use super::service::{CatalogService, ProjectRepo, RepoSource};
use crate::tasks::sdk::SyncReporter;

/// Code that looks like a gear, with evidence (P3). Discovery writes it.
pub const STATE_CANDIDATE: &str = "candidate";
/// The repository declares it. Discovery writes it, and moves a candidate here.
pub const STATE_DECLARED: &str = "declared";
/// Accepted as the organization's component (P2, a person).
pub const STATE_REGISTERED: &str = "registered";
/// Released for others to depend on (P2, a person).
pub const STATE_PUBLISHED: &str = "published";
/// A candidate the organization decided is not a gear (P2, a person).
pub const STATE_REJECTED: &str = "rejected";
/// Still present, no longer to be chosen (P2, a person).
pub const STATE_DEPRECATED: &str = "deprecated";
/// Folded into another entry: one component found under two names (P2, a
/// person). Its occurrences and later findings belong to the entry it was
/// merged into, which carries its name among its `aliases`.
pub const STATE_MERGED: &str = "merged";

/// Every lifecycle state, in the order the lifecycle runs.
pub const STATES: [&str; 7] = [
    STATE_CANDIDATE,
    STATE_DECLARED,
    STATE_REGISTERED,
    STATE_PUBLISHED,
    STATE_REJECTED,
    STATE_DEPRECATED,
    STATE_MERGED,
];

/// The states whose descriptive fields discovery still owns: nobody has
/// decided anything about such an entry, so what the repository says now is
/// the best answer. Past them a person owns the entry, and a walk only says
/// when it saw it last.
fn discovery_owns(state: &str) -> bool {
    matches!(state, STATE_CANDIDATE | STATE_DECLARED)
}

/// A registry entry, as stored.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EntryRecord {
    pub organization_id: Uuid,
    pub name: String,
    /// `gear`, `plugin`, `frontx` or `kit`.
    pub kind: String,
    /// One of [`STATES`].
    pub state: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    /// Who answers for it: a person or a team. Set by a person's decision.
    #[serde(default, deserialize_with = "owner_of")]
    pub owner: Option<Owner>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Other names the same component was found under, merged into this one.
    /// A walk puts what it finds under any of them onto this entry.
    #[serde(default)]
    pub aliases: Vec<String>,
    /// For a `merged` entry, the entry it was folded into.
    #[serde(default)]
    pub merged_into: Option<String>,
    /// For a `deprecated` entry, the entry to use instead, when one was named.
    #[serde(default)]
    pub replaced_by: Option<String>,
    /// For a `published` entry, the version published, when one was named.
    #[serde(default)]
    pub version: Option<String>,
    /// No occurrence is left. Kept, with its state: a registered component
    /// whose repository moved is still the organization's.
    #[serde(default)]
    pub orphaned: bool,
    /// RFC 3339: when a walk first found it.
    #[serde(default)]
    pub first_seen: Option<String>,
    /// RFC 3339: the last walk that read a repository declaring it. A
    /// repository skipped as unchanged does not move it.
    #[serde(default)]
    pub last_seen: Option<String>,
    /// The fingerprint of the repository files it was last read from.
    #[serde(default)]
    pub fingerprint: Option<String>,
    /// For a candidate: the sum of its evidence's weights, at its best
    /// occurrence (P3).
    #[serde(default)]
    pub score: Option<u32>,
    /// For a candidate: why it looks like a gear, at its best occurrence.
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    /// For a candidate: the fingerprints of the code it was found in, one per
    /// occurrence. Frozen while it is `rejected`; a walk that finds it in code
    /// with any other fingerprint proposes it again.
    #[serde(default)]
    pub candidate_fingerprints: Vec<String>,
    /// The pull request that gave it to the platform (ADR-0042 §4), opened by
    /// a `publish` decision. The entry stays `registered` until the
    /// platform's catalogue has it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contribution: Option<Contribution>,
    /// The projects that use it without declaring it: by a Cargo dependency
    /// or by their product's picks (P4). The walk keeps it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consumers: Vec<Consumer>,
    /// What a model last proposed for it (P4). Never a state change:
    /// applying it is an `edit` decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<Suggestion>,
}

/// A gear given to the platform: the pull request into the platform's gear
/// repository (ADR-0042 §4).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contribution {
    /// The platform's gear repository, `owner/name`.
    pub repo: String,
    /// `contribute/<organization>/<name>`.
    pub branch: String,
    #[serde(default)]
    pub pr_url: Option<String>,
    /// Where the gear's files went in the platform's repository.
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub files: usize,
    /// RFC 3339.
    pub at: String,
    /// Who published it: their Studio id, else the token's subject.
    pub by: String,
    #[serde(default)]
    pub by_name: Option<String>,
}

/// A project that uses an entry it does not declare (P4).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Consumer {
    pub project_id: Uuid,
    pub project_name: String,
    /// `cargo` (a Cargo dependency of its code), `product` (its product's
    /// picks), or both.
    pub via: Vec<String>,
}

/// What a model proposed for an entry (P4).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Suggestion {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    /// Keys of the organization's capability vocabulary only.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// RFC 3339.
    pub at: String,
    /// `provider:model`.
    pub model: String,
}

/// Who answers for an entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Owner {
    /// `person` or `team`.
    pub kind: String,
    /// The person's Studio id, or the team's key, when known.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
}

/// An owner as stored: the object, or -- written before owners had a shape --
/// a bare name, read as a team of that name.
fn owner_of<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Owner>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Stored {
        Shaped(Owner),
        Named(String),
    }
    Ok(match Option::<Stored>::deserialize(d)? {
        Some(Stored::Shaped(o)) => Some(o),
        Some(Stored::Named(name)) if !name.trim().is_empty() => Some(Owner {
            kind: "team".to_owned(),
            id: None,
            name,
        }),
        _ => None,
    })
}

/// Where an entry was found, as stored. Carries what the repository said
/// there, so a project's own gears can be answered from the registry in the
/// shape `project_gears` answers them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct OccurrenceRecord {
    pub organization_id: Uuid,
    /// The entry's name.
    pub entry: String,
    pub entry_id: String,
    #[serde(default)]
    pub project_id: Option<Uuid>,
    #[serde(default)]
    pub project_name: Option<String>,
    /// `owner/name`.
    pub repo: String,
    /// The reader's key (tenant, connection, repository, ref): the unit a
    /// walk reads and prunes by.
    pub repo_key: String,
    #[serde(default)]
    pub git_ref: Option<String>,
    pub path: String,
    #[serde(default)]
    pub commit: Option<String>,
    /// `gear.toml`, `gear.gdl`, `attribute`, `package` or `kit`; `detected`
    /// for a candidate nothing declares.
    pub declared_in: String,
    /// The file that declares it, relative to the repository root.
    pub declared_file: String,
    pub kind: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub runtime: Vec<String>,
    #[serde(default)]
    pub built: bool,
    /// The README's path and opening, as `project_gears` read it.
    #[serde(default)]
    pub doc_path: Option<String>,
    #[serde(default)]
    pub doc_text: Option<String>,
    pub fingerprint: String,
    pub seen_at: String,
    /// The tenant whose connection reads the repository, and the connection:
    /// where Declare it writes.
    #[serde(default)]
    pub tenant: Option<Uuid>,
    #[serde(default)]
    pub connection_id: Option<Uuid>,
    /// For a candidate (`declared_in: detected`): its score here.
    #[serde(default)]
    pub score: Option<u32>,
    /// For a candidate: what fired here.
    #[serde(default)]
    pub evidence: Vec<Evidence>,
    /// For a candidate: the fingerprint of the module's own files.
    #[serde(default)]
    pub module_fingerprint: Option<String>,
    /// `organization` for an occurrence in the organization's gear repository
    /// (ADR-0042 §2), which belongs to no project; absent for a project's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// Who a decision the platform's sync makes is by.
pub const PLATFORM_SYNC: &str = "platform-sync";

/// The scope of an occurrence found in the organization's gear repository.
pub const SCOPE_ORGANIZATION: &str = "organization";
/// The scope of an occurrence found in a project's repository.
pub const SCOPE_PROJECT: &str = "project";

impl OccurrenceRecord {
    /// Found by a detector, not declared.
    pub fn detected(&self) -> bool {
        self.declared_in == DETECTED
    }

    /// Found in the organization's gear repository, not in a project's.
    pub fn in_organization(&self) -> bool {
        self.scope.as_deref() == Some(SCOPE_ORGANIZATION)
    }

    /// `project` or `organization`.
    pub fn scope_name(&self) -> &'static str {
        if self.in_organization() {
            SCOPE_ORGANIZATION
        } else {
            SCOPE_PROJECT
        }
    }

    /// Whose read it belongs to: its project, or -- for the organization's
    /// gear repository -- the organization `org`, which a walk keys its read
    /// by in the project's place.
    fn walked_by(&self, org: Uuid) -> Option<Uuid> {
        self.project_id
            .or_else(|| self.in_organization().then_some(org))
    }

    /// The gear as `project_gears` found it here.
    pub fn local_gear(&self) -> LocalGear {
        LocalGear {
            name: self.entry.clone(),
            kind: self.kind.clone(),
            description: self.description.clone(),
            category: self.category.clone(),
            path: self.path.clone(),
            declared_in: self.declared_file.clone(),
            repo: self.repo.clone(),
            capabilities: self.capabilities.clone(),
            runtime: self.runtime.clone(),
            built: self.built,
            doc: match (&self.doc_path, &self.doc_text) {
                (Some(path), Some(text)) => Some((path.clone(), text.clone())),
                _ => None,
            },
        }
    }
}

/// One repository of one project a walk read, with the fingerprint it read
/// it under.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReadRecord {
    pub organization_id: Uuid,
    pub project_id: Uuid,
    pub repo: String,
    pub repo_key: String,
    pub git_ref: String,
    pub fingerprint: String,
    #[serde(default)]
    pub commit: Option<String>,
    pub read_at: String,
    /// The crates its `Cargo.toml` files depend on at run time, as read under
    /// `fingerprint` (P4): a repository skipped as unchanged keeps its
    /// consumers by them.
    #[serde(default)]
    pub cargo_deps: Vec<String>,
}

/// One entry with every place it was found: what the registry answers.
#[derive(Clone, Debug, PartialEq)]
pub struct RegistryEntry {
    pub entry: EntryRecord,
    pub occurrences: Vec<OccurrenceRecord>,
}

/// What a declaration is, from the file that makes it.
pub fn declared_in_of(file: &str) -> &'static str {
    let name = file.rsplit('/').next().unwrap_or(file);
    match name {
        "gear.toml" => "gear.toml",
        "gear.gdl" => "gear.gdl",
        "package.json" => "package",
        ".cf-studio-kit.toml" => "kit",
        _ => "attribute",
    }
}

/// One repository a walk read anew.
#[derive(Clone, Debug, Default)]
pub struct RepoRead {
    /// The project it is a repository of; for the organization's gear
    /// repository, the organization itself (see `organization`).
    pub project_id: Uuid,
    /// The organization's gear repository (ADR-0042 §2): what it finds
    /// belongs to no project, and its occurrences say `scope: organization`.
    pub organization: bool,
    pub project_name: String,
    pub repo: String,
    pub repo_key: String,
    pub git_ref: String,
    pub commit: Option<String>,
    pub fingerprint: String,
    pub gears: Vec<LocalGear>,
    /// What looks like a gear here (P3), the copy signal applied.
    pub candidates: Vec<Candidate>,
    /// The tenant whose connection reads it, and the connection.
    pub tenant: Option<Uuid>,
    pub connection_id: Option<Uuid>,
    /// The crates its Cargo manifests depend on (P4).
    pub cargo_deps: Vec<String>,
}

/// What a walk saw.
#[derive(Clone, Debug, Default)]
pub struct Walk {
    pub org: Uuid,
    /// RFC 3339.
    pub now: String,
    /// The repositories read anew (their fingerprint moved, or none was
    /// stored).
    pub reads: Vec<RepoRead>,
    /// Every `(project, repository)` the walk resolved: read anew, skipped as
    /// unchanged, or failed to read. What a walk did not read keeps its
    /// occurrences; what a project no longer names loses them.
    pub resolved: BTreeSet<(Uuid, String)>,
    /// The projects whose repositories resolved. A project whose repositories
    /// could not be listed at all is not among them, and nothing of it is
    /// pruned: "could not tell" is not "none".
    pub projects_resolved: BTreeSet<Uuid>,
    /// A full walk: the projects in scope. An occurrence in any other
    /// project (excluded, or gone from the organization) is retired. `None`
    /// for a walk over named projects, which leaves the others alone.
    pub in_scope: Option<BTreeSet<Uuid>>,
    /// Each project's product picks (studio-product's record, P4): read this
    /// walk, or carried from the last one for a project not read now.
    pub product_picks: BTreeMap<Uuid, Vec<String>>,
    /// Each project's name, for its consumer records.
    pub project_names: BTreeMap<Uuid, String>,
    /// The platform's components (ADR-0042) by folded name, each with its
    /// newest version when known. `None` when the platform's tier was not
    /// read: nothing is found published then.
    pub platform: Option<BTreeMap<String, Option<String>>>,
}

/// What a walk writes.
#[derive(Debug, Default)]
pub struct Plan {
    pub upsert: Vec<GtsNode>,
    pub edges: Vec<GtsEdge>,
    /// Instance ids to retire: occurrences and registry reads.
    pub retire: Vec<String>,
    pub created: usize,
    pub updated: usize,
    pub occurrences_written: usize,
    pub occurrences_removed: usize,
    pub orphaned: usize,
    /// Candidate findings written (P3).
    pub candidates_found: usize,
    /// Candidates found declared, now `declared`.
    pub declared_from_candidates: usize,
    /// Rejected candidates whose code changed, proposed again.
    pub reproposed: usize,
    /// Contributed entries the platform's catalogue now has, now `published`:
    /// `(entry id, name, version)`. The caller records a decision for each.
    pub published: Vec<(String, String, Option<String>)>,
}

/// Whether a stored `(project, repository)` pair is gone, by what the walk
/// saw. The organization's gear repository is the pair `(organization,
/// repository)`: on a full walk it is in scope only while it is set.
pub(super) fn pair_gone(walk: &Walk, project: Option<Uuid>, repo_key: &str) -> bool {
    let Some(project) = project else {
        return false;
    };
    if let Some(scope) = &walk.in_scope
        && !scope.contains(&project)
    {
        return true;
    }
    walk.projects_resolved.contains(&project)
        && !walk.resolved.contains(&(project, repo_key.to_string()))
}

/// Every alias (case-folded) to the id of the entry that carries it. A merged
/// entry's own aliases moved with it, so only live entries are asked.
pub fn aliases_of(entries: &[(String, EntryRecord)]) -> HashMap<String, String> {
    entries
        .iter()
        .filter(|(_, e)| e.state != STATE_MERGED)
        .flat_map(|(id, e)| {
            e.aliases
                .iter()
                .map(move |a| (a.trim().to_ascii_lowercase(), id.clone()))
        })
        .collect()
}

/// Every live entry by its name folded as candidate names are ([`kebab`]):
/// `spec_mapping` declared and `spec-mapping` detected are one component.
fn folded_of(entries: &[(String, EntryRecord)]) -> HashMap<String, String> {
    entries
        .iter()
        .filter(|(_, e)| e.state != STATE_MERGED)
        .map(|(id, e)| (kebab(&e.name), id.clone()))
        .collect()
}

/// What a read found at one place.
#[derive(Clone, Copy)]
enum Finding<'a> {
    /// The repository declares it.
    Declared(&'a LocalGear),
    /// A detector found it (P3).
    Detected(&'a Candidate),
}

impl Finding<'_> {
    fn name(&self) -> &str {
        match self {
            Finding::Declared(g) => &g.name,
            Finding::Detected(c) => &c.name,
        }
    }

    fn path(&self) -> &str {
        match self {
            Finding::Declared(g) => &g.path,
            Finding::Detected(c) => &c.path,
        }
    }
}

/// The candidate fields of an entry, from its best finding and every
/// fingerprint it is found under.
fn propose(entry: &mut EntryRecord, best: &Candidate, prints: &[String]) {
    entry.state = STATE_CANDIDATE.to_string();
    entry.score = Some(best.score);
    entry.evidence = best.evidence.clone();
    entry.candidate_fingerprints = prints.to_vec();
    if entry.description.is_none() {
        entry.description = best.description.clone();
    }
}

/// What a walk changes in the registry. Pure: the stored entries,
/// occurrences and reads (each with its instance id) and what the walk saw,
/// to the nodes to write and the ids to retire.
///
/// - A component a repository declares, found anew, is `declared`; one only
///   a detector found (P3) is a `candidate`, with its score and evidence.
/// - Discovery owns `candidate` and `declared`, so a candidate later found
///   declared becomes `declared`. Every other state is a person's and stays:
///   a `rejected` entry is not resurrected by a declaration.
/// - A `rejected` candidate is proposed again (back to `candidate`) only when
///   a detector finds it in code whose fingerprint is not among the ones it
///   was rejected under.
/// - Discovery refreshes what an entry says (kind, description, category,
///   capabilities) only while nobody owns it ([`discovery_owns`]).
/// - The occurrences of a repository read anew are what that read found;
///   the ones it no longer has are retired. So are the occurrences of a
///   repository a project no longer names, and of a project out of scope.
/// - An entry with no occurrence left is `orphaned` and kept.
/// - A component found under a name merged into another entry (one of its
///   `aliases`) is that entry's: its occurrence is written under it. A name
///   spelled differently (`spec_mapping`, `spec-mapping`) is the same entry.
pub fn plan(
    walk: &Walk,
    entries: &[(String, EntryRecord)],
    occurrences: &[(String, OccurrenceRecord)],
    reads: &[(String, ReadRecord)],
) -> Plan {
    let org = walk.org.to_string();
    let mut out = Plan::default();
    let read_now: BTreeSet<(Uuid, &str)> = walk
        .reads
        .iter()
        .map(|r| (r.project_id, r.repo_key.as_str()))
        .collect();

    // The entries by id, and the name each goes by.
    let mut by_id: BTreeMap<String, EntryRecord> = entries.iter().cloned().collect();
    let originals: BTreeMap<String, EntryRecord> = by_id.clone();
    // A name merged into another entry is that entry's: what a read finds
    // under it lands there, never on the merged entry.
    let alias_of = aliases_of(entries);
    let mut folded = folded_of(entries);

    // What the reads found, keyed by occurrence id; the first finding of a
    // component at one place in one read wins, as in `project_gears`.
    let mut produced: BTreeMap<String, OccurrenceRecord> = BTreeMap::new();
    let mut declared_by_entry: BTreeMap<String, (&RepoRead, &LocalGear)> = BTreeMap::new();
    let mut detected_by_entry: BTreeMap<String, Vec<&Candidate>> = BTreeMap::new();
    let mut first_read: BTreeMap<String, &RepoRead> = BTreeMap::new();
    // The name an entry goes by: the stored one, else the first spelling
    // found. `Studio-Tasks` in one project and `studio-tasks` in another are
    // one entry under one name.
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    for read in &walk.reads {
        let project = read.project_id.to_string();
        let findings = read
            .gears
            .iter()
            .map(Finding::Declared)
            .chain(read.candidates.iter().map(Finding::Detected));
        for finding in findings {
            let found_name = finding.name();
            let entry_id = alias_of
                .get(&found_name.trim().to_ascii_lowercase())
                .cloned()
                .or_else(|| {
                    let exact = gts::registry_entry_instance_id(&org, found_name);
                    originals.contains_key(&exact).then_some(exact)
                })
                .or_else(|| folded.get(&kebab(found_name)).cloned())
                .unwrap_or_else(|| gts::registry_entry_instance_id(&org, found_name));
            folded
                .entry(kebab(found_name))
                .or_insert_with(|| entry_id.clone());
            let name = names
                .entry(entry_id.clone())
                .or_insert_with(|| {
                    originals
                        .get(&entry_id)
                        .map(|e| e.name.clone())
                        .unwrap_or_else(|| found_name.to_string())
                })
                .clone();
            let id = gts::occurrence_instance_id(&entry_id, &project, &read.repo, finding.path());
            if produced.contains_key(&id) {
                continue;
            }
            first_read.entry(entry_id.clone()).or_insert(read);
            let base = OccurrenceRecord {
                organization_id: walk.org,
                entry: name,
                entry_id: entry_id.clone(),
                project_id: (!read.organization).then_some(read.project_id),
                project_name: Some(read.project_name.clone()),
                scope: read.organization.then(|| SCOPE_ORGANIZATION.to_string()),
                repo: read.repo.clone(),
                repo_key: read.repo_key.clone(),
                git_ref: Some(read.git_ref.clone()).filter(|r| !r.is_empty()),
                path: finding.path().to_string(),
                commit: read.commit.clone(),
                fingerprint: read.fingerprint.clone(),
                seen_at: walk.now.clone(),
                tenant: read.tenant,
                connection_id: read.connection_id,
                ..OccurrenceRecord::default()
            };
            let occ = match finding {
                Finding::Declared(gear) => {
                    declared_by_entry
                        .entry(entry_id.clone())
                        .or_insert((read, gear));
                    OccurrenceRecord {
                        declared_in: declared_in_of(&gear.declared_in).to_string(),
                        declared_file: gear.declared_in.clone(),
                        kind: gear.kind.clone(),
                        description: gear.description.clone(),
                        category: gear.category.clone(),
                        capabilities: gear.capabilities.clone(),
                        runtime: gear.runtime.clone(),
                        built: gear.built,
                        doc_path: gear.doc.as_ref().map(|(p, _)| p.clone()),
                        doc_text: gear.doc.as_ref().map(|(_, t)| t.clone()),
                        ..base
                    }
                }
                Finding::Detected(candidate) => {
                    detected_by_entry
                        .entry(entry_id.clone())
                        .or_default()
                        .push(candidate);
                    out.candidates_found += 1;
                    OccurrenceRecord {
                        declared_in: DETECTED.to_string(),
                        declared_file: candidate.main_file.clone(),
                        kind: "gear".to_string(),
                        description: candidate.description.clone(),
                        built: true,
                        score: Some(candidate.score),
                        evidence: candidate.evidence.clone(),
                        module_fingerprint: Some(candidate.fingerprint.clone()),
                        ..base
                    }
                }
            };
            produced.insert(id, occ);
        }
    }

    // The stored occurrences that stay, and the ones that go.
    let mut remaining: BTreeMap<String, usize> = BTreeMap::new();
    // The fingerprints of the code each entry is still detected in.
    let mut prints: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    // The projects each entry is declared (or detected) in: a project that
    // declares a component is not its consumer.
    let mut declarers: BTreeMap<String, BTreeSet<Uuid>> = BTreeMap::new();
    // The stored occurrences kept, by id: with what the walk found, what the
    // copy evidence is settled from at the end.
    let mut kept: BTreeMap<String, OccurrenceRecord> = BTreeMap::new();
    for (id, occ) in occurrences {
        if produced.contains_key(id) {
            continue;
        }
        let owner = occ.walked_by(walk.org);
        let reread = owner.is_some_and(|p| read_now.contains(&(p, occ.repo_key.as_str())));
        if reread || pair_gone(walk, owner, &occ.repo_key) {
            out.retire.push(id.clone());
            out.occurrences_removed += 1;
        } else {
            kept.insert(id.clone(), occ.clone());
            if let Some(p) = occ.project_id {
                declarers.entry(occ.entry_id.clone()).or_default().insert(p);
            }
            *remaining.entry(occ.entry_id.clone()).or_default() += 1;
            if let Some(print) = occ.module_fingerprint.as_ref().filter(|_| occ.detected()) {
                prints
                    .entry(occ.entry_id.clone())
                    .or_default()
                    .insert(print.clone());
            }
        }
    }
    for occ in produced.values() {
        if let Some(p) = occ.project_id {
            declarers.entry(occ.entry_id.clone()).or_default().insert(p);
        }
        *remaining.entry(occ.entry_id.clone()).or_default() += 1;
        if let Some(print) = &occ.module_fingerprint {
            prints
                .entry(occ.entry_id.clone())
                .or_default()
                .insert(print.clone());
        }
    }

    // The entries the reads found: new ones declared or proposed, known ones
    // seen again.
    for (entry_id, read) in &first_read {
        let declared = declared_by_entry.get(entry_id);
        let detected: &[&Candidate] = detected_by_entry
            .get(entry_id)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let best = detected
            .iter()
            .copied()
            .max_by(|a, b| a.score.cmp(&b.score).then_with(|| b.path.cmp(&a.path)));
        let entry_prints: Vec<String> = prints
            .get(entry_id)
            .map(|p| p.iter().cloned().collect())
            .unwrap_or_default();
        let read_print = declared.map_or(&read.fingerprint, |(r, _)| &r.fingerprint);
        match by_id.get_mut(entry_id) {
            Some(entry) => {
                entry.last_seen = Some(walk.now.clone());
                entry.fingerprint = Some(read_print.clone());
                if let Some((_, gear)) = declared {
                    // Discovery owns both, so a candidate found declared is
                    // declared now: the Declare it pull request merged.
                    if entry.state == STATE_CANDIDATE {
                        entry.state = STATE_DECLARED.to_string();
                        out.declared_from_candidates += 1;
                    }
                    if discovery_owns(&entry.state) {
                        entry.kind = gear.kind.clone();
                        entry.description = gear.description.clone().or(entry.description.take());
                        entry.category = gear.category.clone().or(entry.category.take());
                        if !gear.capabilities.is_empty() {
                            entry.capabilities = gear.capabilities.clone();
                        }
                        entry.score = None;
                        entry.evidence.clear();
                        entry.candidate_fingerprints.clear();
                    }
                } else if let Some(best) = best {
                    if entry.state == STATE_CANDIDATE {
                        propose(entry, best, &entry_prints);
                    } else if entry.state == STATE_REJECTED
                        && !entry.candidate_fingerprints.is_empty()
                        && detected
                            .iter()
                            .any(|c| !entry.candidate_fingerprints.contains(&c.fingerprint))
                    {
                        // The code it was rejected in changed: ask again.
                        propose(entry, best, &entry_prints);
                        out.reproposed += 1;
                    }
                }
            }
            None => {
                let name = names
                    .get(entry_id)
                    .cloned()
                    .unwrap_or_else(|| entry_id.clone());
                let mut entry = EntryRecord {
                    organization_id: walk.org,
                    name,
                    first_seen: Some(walk.now.clone()),
                    last_seen: Some(walk.now.clone()),
                    fingerprint: Some(read_print.clone()),
                    ..EntryRecord::default()
                };
                if let Some((_, gear)) = declared {
                    entry.kind = gear.kind.clone();
                    entry.state = STATE_DECLARED.to_string();
                    entry.description = gear.description.clone();
                    entry.category = gear.category.clone();
                    entry.capabilities = gear.capabilities.clone();
                } else if let Some(best) = best {
                    entry.kind = "gear".to_string();
                    propose(&mut entry, best, &entry_prints);
                } else {
                    continue;
                }
                by_id.insert(entry_id.clone(), entry);
                out.created += 1;
            }
        }
    }

    // Copy evidence settled again from what the registry keeps now (P3):
    // an occurrence retired -- its project excluded, its repository no
    // longer named, the organization's gear repository changed -- is no
    // copy any more, though the repositories still holding the candidate
    // were not read again. A candidate entry whose occurrences moved takes
    // its score and evidence from its best one, as Declare it picks it.
    {
        let mut ids: Vec<(bool, String)> = Vec::new();
        let mut live: Vec<&OccurrenceRecord> = Vec::new();
        for (id, occ) in &produced {
            ids.push((true, id.clone()));
            live.push(occ);
        }
        for (id, occ) in &kept {
            ids.push((false, id.clone()));
            live.push(occ);
        }
        let changes = super::candidates::refreshed_copies(&live, |o| o.walked_by(walk.org));
        let mut touched: BTreeSet<String> = BTreeSet::new();
        for (i, evidence, score) in changes {
            let (is_produced, id) = &ids[i];
            let occ = if *is_produced {
                produced.get_mut(id)
            } else {
                kept.get_mut(id)
            };
            let Some(occ) = occ else { continue };
            occ.evidence = evidence;
            occ.score = Some(score);
            touched.insert(occ.entry_id.clone());
            if !*is_produced {
                out.edges.push(gts::found_in_edge(&occ.entry_id, id));
                if let Ok(value) = serde_json::to_value(&*occ) {
                    out.upsert.push(gts::occurrence_node(id.clone(), value));
                    out.occurrences_written += 1;
                }
            }
        }
        for entry_id in &touched {
            let Some(entry) = by_id.get_mut(entry_id) else {
                continue;
            };
            if entry.state != STATE_CANDIDATE {
                continue;
            }
            let best = produced
                .values()
                .chain(kept.values())
                .filter(|o| &o.entry_id == entry_id && o.detected())
                .max_by(|a, b| a.score.cmp(&b.score).then_with(|| b.path.cmp(&a.path)));
            if let Some(best) = best {
                entry.score = best.score;
                entry.evidence.clone_from(&best.evidence);
            }
        }
    }

    // Orphaned is a count, settled for every entry -- but a merged entry
    // is never orphaned: what it was found as is its target's now, so its
    // having no occurrence of its own is the merge, not a loss.
    for (id, entry) in &mut by_id {
        entry.orphaned =
            entry.state != STATE_MERGED && remaining.get(id).copied().unwrap_or(0) == 0;
    }

    // Who uses each entry (P4), and which contributions the platform has
    // taken (ADR-0042 §4).
    let uses = super::registry_consumers::project_uses(walk, reads, &read_now);
    let names_seen = super::registry_consumers::names_from(occurrences, &by_id);
    for (id, entry) in &mut by_id {
        if entry.state == STATE_MERGED {
            entry.consumers.clear();
        } else {
            entry.consumers = super::registry_consumers::consumers_of(
                entry,
                &uses,
                declarers.get(id),
                walk,
                &names_seen,
            );
        }
        if let Some(platform) = &walk.platform
            && let Some(version) = super::registry_consumers::platform_version(platform, entry)
        {
            if entry.state == STATE_REGISTERED && entry.contribution.is_some() {
                entry.state = STATE_PUBLISHED.to_string();
                entry.version.clone_from(&version);
                out.published
                    .push((id.clone(), entry.name.clone(), version));
            } else if entry.state == STATE_PUBLISHED && version.is_some() {
                entry.version = version;
            }
        }
    }
    for (id, entry) in &by_id {
        if entry.orphaned {
            out.orphaned += 1;
        }
        let changed = originals.get(id) != Some(entry);
        if !changed {
            continue;
        }
        if originals.contains_key(id) {
            out.updated += 1;
        }
        if let Ok(value) = serde_json::to_value(entry) {
            out.upsert
                .push(gts::registry_entry_node(&org, &entry.name, value));
        }
    }

    // The occurrences found, each joined to its entry.
    for (id, occ) in produced {
        out.edges.push(gts::found_in_edge(&occ.entry_id, &id));
        if let Ok(value) = serde_json::to_value(&occ) {
            out.upsert.push(gts::occurrence_node(id, value));
            out.occurrences_written += 1;
        }
    }

    // The fingerprints read, and the reads of what is gone.
    for read in &walk.reads {
        let record = ReadRecord {
            organization_id: walk.org,
            project_id: read.project_id,
            repo: read.repo.clone(),
            repo_key: read.repo_key.clone(),
            git_ref: read.git_ref.clone(),
            fingerprint: read.fingerprint.clone(),
            commit: read.commit.clone(),
            read_at: walk.now.clone(),
            cargo_deps: read.cargo_deps.clone(),
        };
        if let Ok(value) = serde_json::to_value(&record) {
            out.upsert.push(gts::registry_read_node(
                gts::registry_read_instance_id(&org, &read.project_id.to_string(), &read.repo_key),
                value,
            ));
        }
    }
    for (id, read) in reads {
        if pair_gone(walk, Some(read.project_id), &read.repo_key) {
            out.retire.push(id.clone());
        }
    }
    out
}

/// The registry narrowed as `GET /registry` asks: by state, by a project the
/// entry was found in, and by text in its name or description. Sorted by
/// name.
pub fn filter_entries(
    mut entries: Vec<RegistryEntry>,
    state: Option<&str>,
    project_id: Option<Uuid>,
    q: Option<&str>,
) -> Vec<RegistryEntry> {
    let q = q
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);
    entries.retain(|e| {
        state.is_none_or(|s| e.entry.state.eq_ignore_ascii_case(s))
            && project_id.is_none_or(|p| e.occurrences.iter().any(|o| o.project_id == Some(p)))
            && q.as_deref().is_none_or(|q| {
                e.entry.name.to_lowercase().contains(q)
                    || e.entry
                        .description
                        .as_deref()
                        .is_some_and(|d| d.to_lowercase().contains(q))
            })
    });
    entries.sort_by(|a, b| {
        a.entry
            .name
            .to_lowercase()
            .cmp(&b.entry.name.to_lowercase())
    });
    entries
}

/// Entries with their occurrences, joined by entry id. An occurrence whose
/// entry is gone is dropped; occurrences are ordered by project, repository
/// and path.
pub fn join(
    entries: Vec<(String, EntryRecord)>,
    occurrences: Vec<OccurrenceRecord>,
) -> Vec<RegistryEntry> {
    let mut by_entry: HashMap<String, Vec<OccurrenceRecord>> = HashMap::new();
    for occ in occurrences {
        by_entry.entry(occ.entry_id.clone()).or_default().push(occ);
    }
    entries
        .into_iter()
        .map(|(id, entry)| {
            let mut occurrences = by_entry.remove(&id).unwrap_or_default();
            occurrences.sort_by(|a, b| {
                (&a.project_name, &a.repo, &a.path).cmp(&(&b.project_name, &b.repo, &b.path))
            });
            RegistryEntry { entry, occurrences }
        })
        .collect()
}

/// The sources as a request names them: blank repositories dropped, a
/// repository named twice (same ref and mode) kept once, the mode defaulted.
pub fn normalize_sources(sources: Vec<RepoSource>) -> Vec<RepoSource> {
    let mut seen = BTreeSet::new();
    sources
        .into_iter()
        .filter_map(|mut s| {
            s.repo = s.repo.trim().trim_start_matches('/').to_string();
            s.git_ref = s.git_ref.trim().to_string();
            s.mode = match s.mode.trim() {
                "" => "gears".to_string(),
                m => m.to_ascii_lowercase(),
            };
            if s.repo.is_empty() {
                return None;
            }
            seen.insert((
                s.repo.to_ascii_lowercase(),
                s.git_ref.clone(),
                s.mode.clone(),
            ))
            .then_some(s)
        })
        .collect()
}

/// A stored source, read back.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct SourceRecord {
    organization_id: Uuid,
    tenant: Uuid,
    #[serde(default)]
    connection_id: Option<Uuid>,
    repo: String,
    #[serde(default)]
    git_ref: String,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    position: usize,
}

/// The organization's registry settings, as stored.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct SettingsRecord {
    #[serde(default)]
    organization_id: Option<Uuid>,
    #[serde(default)]
    excluded_project_ids: Vec<Uuid>,
    /// What the last walk saw of each project it read, so a person can tell
    /// a project with no components from one the walk could not read.
    #[serde(default)]
    last_walk: Vec<ProjectWalk>,
    /// The crates.io keyword the catalogue syncs with. Kept for the
    /// platform's catalogue (ADR-0042), whose sync a schedule starts and so
    /// cannot be handed the keyword by a page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    crates_io_keyword: Option<String>,
    /// The organization's gear repository (ADR-0042 §2): where "Create a
    /// gear" writes by default, and a repository the walk reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    gear_repository: Option<GearRepository>,
}

/// The organization's gear repository, as stored (ADR-0042 §2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GearRepository {
    /// The tenant whose catalogue holds the connection: the organization
    /// itself. A connection inherited from above it (the platform's root) is
    /// refused when the setting is made, and ignored when read.
    pub tenant: Uuid,
    pub connection_id: Uuid,
    /// `owner/name`.
    pub repo: String,
    /// The branch new gears go back to.
    pub branch: String,
    /// The connection's label and provider, as they were when it was set,
    /// so the page can say which connection without another read.
    #[serde(default)]
    pub connection_label: Option<String>,
    /// Who set it (a Studio person id, else the token's subject) and when,
    /// RFC 3339.
    #[serde(default)]
    pub set_by: Option<String>,
    #[serde(default)]
    pub set_at: Option<String>,
}

/// What a request asks the gear repository to be.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GearRepositoryInput {
    pub connection_id: Uuid,
    pub repo: String,
    pub branch: Option<String>,
}

/// Why a gear repository was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GearRepositoryError {
    /// `owner/name` is not one.
    InvalidRepo(String),
    /// The organization does not see the connection.
    UnknownConnection(Uuid),
    /// The connection's token is not readable where the repository is read
    /// and written: its scope, and what to do instead.
    NotShared { scope: String, hint: String },
    /// The connection is held by another tenant than the organization --
    /// the platform's root, which the organization inherits it from, or a
    /// workspace. The gear repository is the organization's, written with
    /// the organization's own token, never one it only inherits.
    NotOwned { tenant: Uuid },
    /// The repository or its branch could not be read through the
    /// connection: what the provider said.
    Unreadable {
        repo: String,
        branch: String,
        error: String,
    },
}

impl std::fmt::Display for GearRepositoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRepo(repo) => {
                write!(f, "`{repo}` is not a repository: name it as owner/name")
            }
            Self::UnknownConnection(id) => write!(
                f,
                "the organization has no connection {id}: connect the repository on the organization's Connections page"
            ),
            Self::NotShared { scope, hint } => {
                write!(f, "the connection is {scope}-scoped. {hint}")
            }
            Self::NotOwned { tenant } => write!(
                f,
                "the connection belongs to tenant {tenant}, not to the organization: it is inherited (the platform's, or another tenant's), and the organization's gear repository is written with the organization's own connection. Add a connection on the organization's Connections page"
            ),
            Self::Unreadable {
                repo,
                branch,
                error,
            } => write!(
                f,
                "`{repo}` at `{branch}` could not be read through the connection: {error}"
            ),
        }
    }
}

/// What to say about a connection the organization's gear repository cannot
/// use. The walk reads it as the service, on a schedule nobody is signed in
/// to, and a project's "Create a gear" writes it from below the organization;
/// only an organization-scope connection's token is readable to both.
/// `None` for an organization-scope connection.
pub fn gear_repository_scope_refusal(scope: &str) -> Option<String> {
    match scope.trim().to_ascii_lowercase().as_str() {
        "organization" | "org" | "shared" => None,
        "personal" => Some(format!(
            "{PERSONAL_TOKEN_HINT} The organization's gear repository needs a connection shared with the organization."
        )),
        _ => Some(
            "A workspace's connection is readable only in that workspace, and the organization's gear repository is read by the registry's background walk and written from every project. Connect the repository on the organization with organization scope."
                .to_owned(),
        ),
    }
}

/// `owner/name`, trimmed, or `None` when it is not one.
pub fn normalize_repo(repo: &str) -> Option<String> {
    let repo = repo
        .trim()
        .trim_start_matches("https://github.com/")
        .trim_matches('/')
        .trim_end_matches(".git");
    let mut parts = repo.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(owner), Some(name), None)
            if !owner.trim().is_empty()
                && !name.trim().is_empty()
                && !repo.contains(char::is_whitespace) =>
        {
            Some(repo.to_owned())
        }
        _ => None,
    }
}

/// The gear repository the organization `org` sets, from the connection it
/// sees (`found`: the tenant holding it, its scope and label), or why not.
/// The connection must be the organization's own: one found by walking up
/// to the platform's root is refused ([`GearRepositoryError::NotOwned`]).
/// Pure.
pub fn gear_repository_of(
    input: &GearRepositoryInput,
    org: Uuid,
    found: Option<(Uuid, &str, &str)>,
    by: Option<String>,
    at: String,
) -> Result<GearRepository, GearRepositoryError> {
    let repo = normalize_repo(&input.repo)
        .ok_or_else(|| GearRepositoryError::InvalidRepo(input.repo.trim().to_owned()))?;
    let (tenant, scope, label) =
        found.ok_or(GearRepositoryError::UnknownConnection(input.connection_id))?;
    if tenant != org {
        return Err(GearRepositoryError::NotOwned { tenant });
    }
    if let Some(hint) = gear_repository_scope_refusal(scope) {
        return Err(GearRepositoryError::NotShared {
            scope: if scope.trim().is_empty() {
                "workspace".to_owned()
            } else {
                scope.trim().to_ascii_lowercase()
            },
            hint,
        });
    }
    let branch = input
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .unwrap_or("main")
        .trim_start_matches("refs/heads/")
        .to_owned();
    Ok(GearRepository {
        tenant,
        connection_id: input.connection_id,
        repo,
        branch,
        connection_label: Some(label.to_owned()).filter(|l| !l.is_empty()),
        set_by: by,
        set_at: Some(at),
    })
}

/// A connection as the gear repository's checks need it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FoundConnection {
    /// The tenant whose catalogue holds it.
    pub tenant: Uuid,
    pub scope: String,
    pub label: String,
    pub provider: String,
}

/// What setting the organization's gear repository reads and writes through:
/// the connectors in production, a table in tests.
#[async_trait::async_trait]
pub trait GearRepositoryAccess: Send + Sync {
    /// The connection `id` as `org` sees it -- its own, or inherited from a
    /// tenant above it -- or `None`.
    async fn connection(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Uuid,
    ) -> Option<FoundConnection>;

    /// Read `repo` at `branch` through the connection: a tree listing, so a
    /// repository or branch that is not there (or not readable with the
    /// token) is an error now rather than at the first walk.
    async fn probe(
        &self,
        ctx: &SecurityContext,
        connection: &FoundConnection,
        connection_id: Uuid,
        repo: &str,
        branch: &str,
    ) -> anyhow::Result<()>;

    /// Create a repository through the connection: its `owner/name` and
    /// default branch.
    #[allow(clippy::too_many_arguments)]
    async fn create(
        &self,
        ctx: &SecurityContext,
        connection: &FoundConnection,
        connection_id: Uuid,
        owner: Option<&str>,
        is_org: bool,
        name: &str,
        private: bool,
    ) -> anyhow::Result<(String, String)>;
}

/// [`GearRepositoryAccess`] through the connector service.
pub struct ConnectorAccess(pub Arc<crate::connectors::sdk::ConnectorService>);

#[async_trait::async_trait]
impl GearRepositoryAccess for ConnectorAccess {
    async fn connection(
        &self,
        ctx: &SecurityContext,
        org: Uuid,
        id: Uuid,
    ) -> Option<FoundConnection> {
        let (found, c) = self.0.nearest_by_id(ctx, org, id).await?;
        // The row's holder, not where it was found: an organization without
        // a catalogue of its own lists the root's as if they were its own.
        let tenant = crate::connectors::sdk::holder_of_row(&c, found);
        Some(FoundConnection {
            tenant,
            scope: c.scope,
            label: c.label,
            provider: c.provider,
        })
    }

    async fn probe(
        &self,
        ctx: &SecurityContext,
        connection: &FoundConnection,
        connection_id: Uuid,
        repo: &str,
        branch: &str,
    ) -> anyhow::Result<()> {
        let repository = crate::connectors::sdk::Repository::open(
            &self.0,
            ctx,
            connection.tenant,
            Some(connection_id),
            &connection.provider,
            repo,
            Some(branch),
        )
        .await?;
        repository.tree().await.map(|_| ())
    }

    async fn create(
        &self,
        ctx: &SecurityContext,
        connection: &FoundConnection,
        connection_id: Uuid,
        owner: Option<&str>,
        is_org: bool,
        name: &str,
        private: bool,
    ) -> anyhow::Result<(String, String)> {
        let created = crate::connectors::sdk::create_repository(
            &self.0,
            ctx,
            connection.tenant,
            Some(connection_id),
            &connection.provider,
            owner,
            is_org,
            name,
            private,
        )
        .await?;
        Ok((created.full_name, created.default_branch))
    }
}

/// What the last walk saw of one project.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ProjectWalk {
    pub project_id: Uuid,
    pub project_name: String,
    /// RFC 3339.
    pub at: String,
    /// Set when the project's repositories could not be listed at all.
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub repos: Vec<RepoWalk>,
    /// The gears the project's product picks, as studio-product recorded
    /// them when the walk read the project (P4): what its `product`
    /// consumers are found by. `None` when there was no record to read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_gears: Option<Vec<String>>,
}

/// What the last walk did with one repository of a project.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RepoWalk {
    pub repo: String,
    /// `read` (read anew), `unchanged` (its fingerprint matched) or `failed`.
    pub status: String,
    /// Components found in it: read anew, or still recorded for it.
    #[serde(default)]
    pub components: usize,
    #[serde(default)]
    pub error: Option<String>,
    /// What a person can do about `error`, when the walk knows.
    #[serde(default)]
    pub hint: Option<String>,
}

/// `base` acting in `tenant`: the same subject, kind, scopes and bearer, with
/// the tenant a project's credentials are readable from.
pub fn in_tenant(base: &SecurityContext, tenant: Uuid) -> anyhow::Result<SecurityContext> {
    let mut b = SecurityContext::builder()
        .subject_id(base.subject_id())
        .subject_tenant_id(tenant)
        .token_scopes(base.token_scopes().to_vec());
    if let Some(kind) = base.subject_type() {
        b = b.subject_type(kind);
    }
    if let Some(token) = base.bearer_token() {
        b = b.bearer_token(token.clone());
    }
    b.build()
        .map_err(|e| anyhow!("cannot act in tenant {tenant}: {e}"))
}

/// Why a personal token does not serve the registry: the opening of what a
/// person is told about one, by the walk and by the gear repository setting.
const PERSONAL_TOKEN_HINT: &str = "The repository is connected with a personal token, which the registry's background read cannot use.";

/// What a person can do about a repository the walk could not read.
///
/// The walk runs as the service, on a schedule nobody is signed in to, so a
/// repository connected with someone's personal token is not readable to it --
/// by design: an organization-wide job must not borrow one person's
/// credential. The fix is to share the connection, not to impersonate.
pub fn read_failure_hint(error: &str) -> Option<String> {
    let e = error.to_ascii_lowercase();
    if e.contains("personal") || e.contains("not readable") {
        return Some(format!(
            "{PERSONAL_TOKEN_HINT} Share the connection with the workspace or the organization, or connect the repository with a shared token."
        ));
    }
    if e.contains("401") || e.contains("403") || e.contains("bad credentials") {
        return Some(
            "The connection's token was refused by the provider: renew it on the Connections page."
                .to_owned(),
        );
    }
    if e.contains("404") || e.contains("not found") {
        return Some("The repository or branch was not found with this connection: check the project's Sources.".to_owned());
    }
    None
}

/// The last walk's statuses after `walked`: a full walk replaces them, a walk
/// over named projects replaces only theirs.
pub fn merge_walks(
    previous: Vec<ProjectWalk>,
    walked: Vec<ProjectWalk>,
    full: bool,
) -> Vec<ProjectWalk> {
    if full {
        return walked;
    }
    let mut out: Vec<ProjectWalk> = previous
        .into_iter()
        .filter(|p| !walked.iter().any(|w| w.project_id == p.project_id))
        .collect();
    out.extend(walked);
    out.sort_by(|a, b| a.project_name.cmp(&b.project_name));
    out
}

/// What a registry walk counted. The run's result.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RegistryCounts {
    #[serde(default)]
    pub projects: usize,
    #[serde(default)]
    pub projects_excluded: usize,
    #[serde(default)]
    pub repos_read: usize,
    #[serde(default)]
    pub repos_unchanged: usize,
    #[serde(default)]
    pub repos_failed: usize,
    #[serde(default)]
    pub entries_created: usize,
    #[serde(default)]
    pub entries_updated: usize,
    #[serde(default)]
    pub occurrences_written: usize,
    #[serde(default)]
    pub occurrences_removed: usize,
    #[serde(default)]
    pub orphaned: usize,
    /// Candidate findings (P3).
    #[serde(default)]
    pub candidates: usize,
    /// Rejected candidates proposed again because their code changed.
    #[serde(default)]
    pub reproposed: usize,
    /// Contributed entries the platform's catalogue now has (ADR-0042 §4).
    #[serde(default)]
    pub published: usize,
}

pub(super) fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

/// Typed records of one node type, each with its instance id. A payload that
/// does not read as `T` is skipped and logged.
pub(super) fn records<T: serde::de::DeserializeOwned>(nodes: Vec<GtsNode>) -> Vec<(String, T)> {
    nodes
        .into_iter()
        .filter_map(|n| match serde_json::from_value::<T>(n.value) {
            Ok(r) => Some((n.instance_id, r)),
            Err(e) => {
                tracing::warn!(instance_id = %n.instance_id, error = %e, "components-catalog: a registry node does not read; skipped");
                None
            }
        })
        .collect()
}

impl CatalogService {
    /// The organization's catalogue sources, in the order they were saved.
    pub async fn list_sources(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<RepoSource>> {
        let org = ctx.subject_tenant_id();
        let mut stored: Vec<SourceRecord> =
            records::<SourceRecord>(self.sink.list(ctx, Some(gts::SOURCE_TYPE)).await?)
                .into_iter()
                .map(|(_, r)| r)
                .filter(|r| r.organization_id == org)
                .collect();
        stored.sort_by_key(|r| r.position);
        Ok(stored
            .into_iter()
            .map(|r| RepoSource {
                tenant: r.tenant,
                connection_id: r.connection_id,
                repo: r.repo,
                git_ref: r.git_ref,
                mode: r.mode,
            })
            .collect())
    }

    /// Replace the organization's catalogue sources with `sources`.
    pub async fn replace_sources(
        &self,
        ctx: &SecurityContext,
        sources: Vec<RepoSource>,
    ) -> anyhow::Result<Vec<RepoSource>> {
        self.sink.register_types(ctx).await?;
        let org = ctx.subject_tenant_id();
        let org_s = org.to_string();
        let sources = normalize_sources(sources);
        let mut nodes = Vec::with_capacity(sources.len());
        for (position, s) in sources.iter().enumerate() {
            let id = gts::source_instance_id(&org_s, &s.repo, &s.git_ref, &s.mode);
            let value = serde_json::to_value(SourceRecord {
                organization_id: org,
                tenant: s.tenant,
                connection_id: s.connection_id,
                repo: s.repo.clone(),
                git_ref: s.git_ref.clone(),
                mode: s.mode.clone(),
                position,
            })?;
            nodes.push(gts::source_node(id, value));
        }
        let keep: BTreeSet<String> = nodes.iter().map(|n| n.instance_id.clone()).collect();
        self.sink.upsert(ctx, &nodes, &[]).await?;
        for node in self.sink.list(ctx, Some(gts::SOURCE_TYPE)).await? {
            if !keep.contains(&node.instance_id) {
                self.sink.delete(ctx, &node.instance_id).await?;
            }
        }
        Ok(sources)
    }

    async fn settings(&self, ctx: &SecurityContext) -> anyhow::Result<SettingsRecord> {
        let id = gts::registry_settings_instance_id(&ctx.subject_tenant_id().to_string());
        Ok(records::<SettingsRecord>(
            self.sink
                .list(ctx, Some(gts::REGISTRY_SETTINGS_TYPE))
                .await?,
        )
        .into_iter()
        .find(|(i, _)| *i == id)
        .map(|(_, s)| s)
        .unwrap_or_default())
    }

    /// The projects the walk skips.
    pub async fn excluded_projects(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<Uuid>> {
        Ok(self.settings(ctx).await?.excluded_project_ids)
    }

    /// What the last walk saw of each project it read.
    pub async fn last_walk(&self, ctx: &SecurityContext) -> anyhow::Result<Vec<ProjectWalk>> {
        Ok(self.settings(ctx).await?.last_walk)
    }

    /// Replace the projects the walk skips. Deduplicated, in the order given.
    pub async fn set_excluded_projects(
        &self,
        ctx: &SecurityContext,
        project_ids: Vec<Uuid>,
    ) -> anyhow::Result<Vec<Uuid>> {
        self.sink.register_types(ctx).await?;
        let org = ctx.subject_tenant_id();
        let mut seen = BTreeSet::new();
        let ids: Vec<Uuid> = project_ids
            .into_iter()
            .filter(|p| seen.insert(*p))
            .collect();
        let mut settings = self.settings(ctx).await?;
        settings.organization_id = Some(org);
        settings.excluded_project_ids = ids.clone();
        let value = serde_json::to_value(settings)?;
        self.sink
            .upsert(
                ctx,
                &[gts::registry_settings_node(&org.to_string(), value)],
                &[],
            )
            .await?;
        Ok(ids)
    }

    /// The crates.io keyword this tenant's catalogue syncs with, when one was
    /// saved.
    pub async fn stored_keyword(&self, ctx: &SecurityContext) -> anyhow::Result<Option<String>> {
        Ok(self.settings(ctx).await?.crates_io_keyword)
    }

    /// Save the crates.io keyword this tenant's catalogue syncs with; empty
    /// or `None` means no crates.io source.
    pub async fn set_stored_keyword(
        &self,
        ctx: &SecurityContext,
        keyword: Option<String>,
    ) -> anyhow::Result<Option<String>> {
        self.sink.register_types(ctx).await?;
        let org = ctx.subject_tenant_id();
        let keyword = keyword
            .map(|k| k.trim().to_owned())
            .filter(|k| !k.is_empty());
        let mut settings = self.settings(ctx).await?;
        settings.organization_id = Some(org);
        settings.crates_io_keyword.clone_from(&keyword);
        self.sink
            .upsert(
                ctx,
                &[gts::registry_settings_node(
                    &org.to_string(),
                    serde_json::to_value(settings)?,
                )],
                &[],
            )
            .await?;
        Ok(keyword)
    }

    /// The organization's gear repository, when one is set (ADR-0042 §2).
    ///
    /// A setting whose connection is not the organization's own -- stored
    /// before that was checked, with a connection inherited from the
    /// platform's root -- is not answered: nothing reads or writes through
    /// it, and the page shows none until an administrator sets it again.
    pub async fn gear_repository(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<Option<GearRepository>> {
        let org = ctx.subject_tenant_id();
        Ok(self.settings(ctx).await?.gear_repository.filter(|r| {
            let owned = r.tenant == org;
            if !owned {
                tracing::warn!(organization_id = %org, tenant = %r.tenant, repo = %r.repo, "components-catalog: the organization's gear repository names a connection the organization does not own; it is ignored until set again");
            }
            owned
        }))
    }

    /// Store `repo` as the organization's gear repository, or clear it with
    /// `None`. What was checked is the caller's business: see
    /// [`Self::set_gear_repository`].
    pub async fn store_gear_repository(
        &self,
        ctx: &SecurityContext,
        repo: Option<GearRepository>,
    ) -> anyhow::Result<Option<GearRepository>> {
        self.sink.register_types(ctx).await?;
        let org = ctx.subject_tenant_id();
        let mut settings = self.settings(ctx).await?;
        settings.organization_id = Some(org);
        settings.gear_repository.clone_from(&repo);
        self.sink
            .upsert(
                ctx,
                &[gts::registry_settings_node(
                    &org.to_string(),
                    serde_json::to_value(settings)?,
                )],
                &[],
            )
            .await?;
        Ok(repo)
    }

    /// Set the organization's gear repository: the connection must be the
    /// organization's own (never one inherited from the platform's root),
    /// organization-scoped ([`gear_repository_scope_refusal`]), and the
    /// repository readable at the branch through it. `Ok(Err(_))` is a
    /// refusal.
    pub async fn set_gear_repository(
        &self,
        ctx: &SecurityContext,
        input: &GearRepositoryInput,
        by: Option<String>,
        access: &dyn GearRepositoryAccess,
    ) -> anyhow::Result<Result<GearRepository, GearRepositoryError>> {
        let org = ctx.subject_tenant_id();
        let found = access.connection(ctx, org, input.connection_id).await;
        let repo = match gear_repository_of(
            input,
            org,
            found
                .as_ref()
                .map(|c| (c.tenant, c.scope.as_str(), c.label.as_str())),
            by,
            now(),
        ) {
            Ok(repo) => repo,
            Err(refused) => return Ok(Err(refused)),
        };
        let Some(connection) = found else {
            return Ok(Err(GearRepositoryError::UnknownConnection(
                input.connection_id,
            )));
        };
        if let Err(e) = access
            .probe(
                ctx,
                &connection,
                repo.connection_id,
                &repo.repo,
                &repo.branch,
            )
            .await
        {
            return Ok(Err(GearRepositoryError::Unreadable {
                repo: repo.repo,
                branch: repo.branch,
                error: format!("{e:#}"),
            }));
        }
        self.store_gear_repository(ctx, Some(repo.clone())).await?;
        tracing::info!(organization_id = %org, repo = %repo.repo, branch = %repo.branch, "components-catalog: the organization's gear repository was set");
        Ok(Ok(repo))
    }

    /// Create a repository through the connection and set it as the
    /// organization's gear repository. The connection is checked first --
    /// the organization's own, organization-scoped -- so a connection the
    /// setting would refuse creates nothing. `Ok(Err(_))` is a refusal.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_gear_repository(
        &self,
        ctx: &SecurityContext,
        connection_id: Uuid,
        owner: Option<&str>,
        is_org: bool,
        name: &str,
        private: bool,
        by: Option<String>,
        access: &dyn GearRepositoryAccess,
    ) -> anyhow::Result<Result<GearRepository, GearRepositoryError>> {
        let org = ctx.subject_tenant_id();
        let Some(connection) = access.connection(ctx, org, connection_id).await else {
            return Ok(Err(GearRepositoryError::UnknownConnection(connection_id)));
        };
        if connection.tenant != org {
            return Ok(Err(GearRepositoryError::NotOwned {
                tenant: connection.tenant,
            }));
        }
        if let Some(hint) = gear_repository_scope_refusal(&connection.scope) {
            return Ok(Err(GearRepositoryError::NotShared {
                scope: connection.scope.clone(),
                hint,
            }));
        }
        let (full_name, default_branch) = access
            .create(
                ctx,
                &connection,
                connection_id,
                owner,
                is_org,
                name,
                private,
            )
            .await?;
        let input = GearRepositoryInput {
            connection_id,
            repo: full_name,
            branch: Some(default_branch),
        };
        let repo = match gear_repository_of(
            &input,
            org,
            Some((connection.tenant, &connection.scope, &connection.label)),
            by,
            now(),
        ) {
            Ok(repo) => repo,
            Err(refused) => return Ok(Err(refused)),
        };
        self.store_gear_repository(ctx, Some(repo.clone())).await?;
        tracing::info!(organization_id = %org, repo = %repo.repo, "components-catalog: a gear repository was created for the organization");
        Ok(Ok(repo))
    }

    /// Every entry of the organization's registry, with its occurrences.
    pub async fn registry_entries(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<Vec<RegistryEntry>> {
        let org = ctx.subject_tenant_id();
        let entries: Vec<(String, EntryRecord)> =
            records::<EntryRecord>(self.sink.list(ctx, Some(gts::REGISTRY_ENTRY_TYPE)).await?)
                .into_iter()
                .filter(|(_, e)| e.organization_id == org)
                .collect();
        if entries.is_empty() {
            return Ok(Vec::new());
        }
        let occurrences: Vec<OccurrenceRecord> =
            records::<OccurrenceRecord>(self.sink.list(ctx, Some(gts::OCCURRENCE_TYPE)).await?)
                .into_iter()
                .map(|(_, o)| o)
                .filter(|o| o.organization_id == org)
                .collect();
        Ok(join(entries, occurrences))
    }

    /// One entry, by name (case-blind).
    pub async fn registry_entry(
        &self,
        ctx: &SecurityContext,
        name: &str,
    ) -> anyhow::Result<Option<RegistryEntry>> {
        let wanted = name.trim();
        Ok(self
            .registry_entries(ctx)
            .await?
            .into_iter()
            .find(|e| e.entry.name.eq_ignore_ascii_case(wanted)))
    }

    /// The platform's components as folded names with their versions
    /// (`registry_consumers::platform_components`), best effort: `None` when
    /// there is no platform tier to read from here, or it did not answer.
    pub(super) async fn platform_components(
        &self,
        ctx: &SecurityContext,
    ) -> Option<BTreeMap<String, Option<String>>> {
        let pctx = self.platform_ctx(ctx)?;
        match self.sink.list(&pctx, Some(gts::GEAR_TYPE)).await {
            Ok(nodes) => Some(super::registry_consumers::platform_components(&nodes)),
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "components-catalog: registry: the platform's catalogue did not answer; nothing is found published this walk");
                None
            }
        }
    }

    /// An organization's projects, from the organizations gear.
    fn projects_of(&self) -> anyhow::Result<Arc<dyn crate::organizations::port::ProjectsOf>> {
        self.hub
            .get()
            .and_then(|hub| hub.get::<dyn crate::organizations::port::ProjectsOf>().ok())
            .ok_or_else(|| {
                anyhow!("the registry cannot list the organization's projects: studio-organizations is not part of this deployment")
            })
    }

    /// Read the organization's gear repository into `walk`, when one is set:
    /// in the organization's own tenant, under its own key, its findings
    /// `scope: organization`. Its status joins the projects' as one more
    /// row, named after the organization.
    async fn walk_gear_repository(
        &self,
        ctx: &SecurityContext,
        stored: &HashMap<(Uuid, String), String>,
        held: &HashMap<(Uuid, String), usize>,
        walk: &mut Walk,
        counts: &mut RegistryCounts,
        statuses: &mut Vec<ProjectWalk>,
    ) {
        let org = ctx.subject_tenant_id();
        let repo = match self.gear_repository(ctx).await {
            Ok(Some(repo)) => repo,
            Ok(None) => return,
            Err(e) => {
                // Unknown is not unset: keep what was found there.
                tracing::warn!(organization_id = %org, error = %format!("{e:#}"), "components-catalog: registry: the gear repository setting could not be read");
                if let Some(scope) = walk.in_scope.as_mut() {
                    scope.insert(org);
                }
                return;
            }
        };
        if let Some(scope) = walk.in_scope.as_mut() {
            scope.insert(org);
        }
        let name = self.organization_name(ctx, org).await;
        let mut status = ProjectWalk {
            project_id: org,
            project_name: name.clone(),
            at: walk.now.clone(),
            ..ProjectWalk::default()
        };
        // Its stored tenant is the organization (see `gear_repository`); the
        // connection itself must be held there or below, never above.
        let holder = self
            .connection_holder(ctx, repo.tenant, Some(repo.connection_id))
            .await
            .unwrap_or(repo.tenant);
        let target = ProjectRepo {
            tenant: repo.tenant,
            holder,
            connection_id: Some(repo.connection_id),
            repo: repo.repo.clone(),
            branch: repo.branch.clone(),
            owned: true,
        };
        if !self.tenant_within(ctx, org, holder).await {
            tracing::warn!(organization_id = %org, %holder, repo = %repo.repo, "components-catalog: registry: the gear repository's connection is not the organization's; not read");
            counts.repos_failed += 1;
            status
                .repos
                .push(super::ownership::refused_walk(&repo.repo, holder));
            walk.projects_resolved.insert(org);
            statuses.push(status);
            return;
        }
        let readers = match self.enrichers(vec![target]) {
            Ok(readers) => readers,
            Err(e) => {
                let error = format!("{e:#}");
                status.repos.push(RepoWalk {
                    repo: repo.repo.clone(),
                    status: "failed".to_owned(),
                    hint: read_failure_hint(&error),
                    error: Some(error),
                    ..RepoWalk::default()
                });
                statuses.push(status);
                return;
            }
        };
        walk.projects_resolved.insert(org);
        for (target, reader) in readers {
            let key = reader.repo_key();
            walk.resolved.insert((org, key.clone()));
            let known = stored.get(&(org, key.clone())).map(String::as_str);
            let components = held.get(&(org, key.clone())).copied().unwrap_or(0);
            match reader
                .project_gears_unless(ctx, &self.project_gears, known, true)
                .await
            {
                Ok(ProjectGearsRead::Unchanged) => {
                    counts.repos_unchanged += 1;
                    status.repos.push(RepoWalk {
                        repo: target.repo.clone(),
                        status: "unchanged".to_owned(),
                        components,
                        ..RepoWalk::default()
                    });
                }
                Ok(ProjectGearsRead::Read {
                    fingerprint,
                    gears,
                    candidates,
                }) => {
                    counts.repos_read += 1;
                    status.repos.push(RepoWalk {
                        repo: target.repo.clone(),
                        status: "read".to_owned(),
                        components: gears.len(),
                        ..RepoWalk::default()
                    });
                    walk.reads.push(RepoRead {
                        project_id: org,
                        organization: true,
                        project_name: name.clone(),
                        repo: target.repo.clone(),
                        repo_key: key,
                        git_ref: reader.git_ref().to_string(),
                        commit: reader.head_commit(ctx).await,
                        fingerprint,
                        gears: gears.as_ref().clone(),
                        candidates: candidates.as_ref().clone(),
                        tenant: Some(target.tenant),
                        connection_id: target.connection_id,
                        // The organization's gear repository is no project:
                        // what it depends on makes nobody a consumer.
                        cargo_deps: Vec::new(),
                    });
                }
                Err(e) => {
                    counts.repos_failed += 1;
                    tracing::warn!(organization_id = %org, repo = %target.repo, error = %format!("{e:#}"), "components-catalog: registry: the organization's gear repository could not be read; its occurrences are kept");
                    let error = format!("{e:#}");
                    status.repos.push(RepoWalk {
                        repo: target.repo.clone(),
                        status: "failed".to_owned(),
                        components,
                        hint: read_failure_hint(&error),
                        error: Some(error),
                    });
                }
            }
        }
        statuses.push(status);
    }

    /// The organization's name, as account-management says; "Organization"
    /// when it cannot.
    pub(super) async fn organization_name(&self, ctx: &SecurityContext, org: Uuid) -> String {
        match self.account_management.get() {
            Some(am) => am
                .get_tenant(ctx, org)
                .await
                .ok()
                .map(|t| t.name)
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| "Organization".to_owned()),
            None => "Organization".to_owned(),
        }
    }

    /// The registry walk: every project of the context's organization not
    /// excluded -- or, with `only`, those of them named -- read for the
    /// components its repositories declare, and the registry brought in line
    /// with what was read (see [`plan`]).
    pub async fn run_registry(
        &self,
        ctx: &SecurityContext,
        only: &[Uuid],
        progress: &SyncReporter,
    ) -> anyhow::Result<RegistryCounts> {
        self.sink.register_types(ctx).await?;
        let org = ctx.subject_tenant_id();
        let mut counts = RegistryCounts::default();
        progress.set("registry: listing the organization's projects…");
        let projects = self.projects_of()?.projects_of(ctx, org).await?;
        let excluded: BTreeSet<Uuid> = self.excluded_projects(ctx).await?.into_iter().collect();
        let in_scope: Vec<_> = projects
            .into_iter()
            .filter(|p| {
                if excluded.contains(&p.id) {
                    counts.projects_excluded += 1;
                    return false;
                }
                only.is_empty() || only.contains(&p.id)
            })
            .collect();
        counts.projects = in_scope.len();

        let entries =
            records::<EntryRecord>(self.sink.list(ctx, Some(gts::REGISTRY_ENTRY_TYPE)).await?);
        let occurrences =
            records::<OccurrenceRecord>(self.sink.list(ctx, Some(gts::OCCURRENCE_TYPE)).await?);
        let reads =
            records::<ReadRecord>(self.sink.list(ctx, Some(gts::REGISTRY_READ_TYPE)).await?);
        let stored: HashMap<(Uuid, String), String> = reads
            .iter()
            .filter(|(_, r)| r.organization_id == org)
            .map(|(_, r)| ((r.project_id, r.repo_key.clone()), r.fingerprint.clone()))
            .collect();

        let mut walk = Walk {
            org,
            now: now(),
            in_scope: only
                .is_empty()
                .then(|| in_scope.iter().map(|p| p.id).collect()),
            project_names: in_scope.iter().map(|p| (p.id, p.name.clone())).collect(),
            platform: self.platform_components(ctx).await,
            ..Walk::default()
        };
        // Each project's product picks as the last walk read them: kept for a
        // project this walk does not read again, replaced for one it does.
        let previous = self.last_walk(ctx).await.unwrap_or_default();
        for p in &previous {
            if let Some(picks) = &p.product_gears {
                walk.product_picks.insert(p.project_id, picks.clone());
                walk.project_names
                    .entry(p.project_id)
                    .or_insert_with(|| p.project_name.clone());
            }
        }
        let products = self.products.get().and_then(|p| p.get());
        let total = in_scope.len();
        let mut statuses: Vec<ProjectWalk> = Vec::with_capacity(total);
        // Components still recorded per (project, repository): what an
        // unchanged repository holds.
        let mut held: HashMap<(Uuid, String), usize> = HashMap::new();
        for (_, o) in occurrences.iter().filter(|(_, o)| o.organization_id == org) {
            if let Some(p) = o.walked_by(org) {
                *held.entry((p, o.repo_key.clone())).or_default() += 1;
            }
        }
        // The organization's gear repository (ADR-0042 §2) is read like a
        // project's, keyed by the organization, by a full walk only: a walk
        // over named projects (a push) is about them.
        if only.is_empty() {
            self.walk_gear_repository(ctx, &stored, &held, &mut walk, &mut counts, &mut statuses)
                .await;
        }
        for (i, project) in in_scope.iter().enumerate() {
            let mut status = ProjectWalk {
                project_id: project.id,
                project_name: project.name.clone(),
                at: walk.now.clone(),
                ..ProjectWalk::default()
            };
            progress.set_with(
                format!("registry: {} ({}/{total})", project.name, i + 1),
                serde_json::to_value(&counts).unwrap_or(Value::Null),
            );
            // A project's repositories are read in the project's own tenant:
            // its connection and token belong to it or to the workspace above
            // it, and a token is readable down the tree, never up. Read from
            // the organization's tenant, every workspace connection answers
            // "not readable". The registry's own nodes stay the organization's.
            let pctx = match in_tenant(ctx, project.id) {
                Ok(pctx) => pctx,
                Err(e) => {
                    status.error = Some(format!("{e:#}"));
                    status.product_gears = walk.product_picks.get(&project.id).cloned();
                    statuses.push(status);
                    continue;
                }
            };
            // What its product picks (P4): read now, else what was read last.
            status.product_gears = match &products {
                Some(products) => {
                    match products.product_gears(&pctx, &project.id.to_string()).await {
                        Ok(picks) => picks,
                        Err(e) => {
                            tracing::warn!(project_id = %project.id, error = %format!("{e:#}"), "components-catalog: registry: a project's product could not be read; its last picks are kept");
                            walk.product_picks.get(&project.id).cloned()
                        }
                    }
                }
                None => walk.product_picks.get(&project.id).cloned(),
            };
            match &status.product_gears {
                Some(picks) => {
                    walk.product_picks.insert(project.id, picks.clone());
                }
                None => {
                    walk.product_picks.remove(&project.id);
                }
            }
            // Read only through a connection the organization owns: one held
            // above it (the platform's root) is refused and said so, and what
            // was read through it before loses its occurrences.
            let repos = match self
                .project_repos(&pctx, ctx, &project.id.to_string())
                .await
            {
                Ok((repos, refused)) => {
                    counts.repos_failed += refused.len();
                    status.repos.extend(refused);
                    repos
                }
                Err(e) => {
                    tracing::warn!(project_id = %project.id, error = %format!("{e:#}"), "components-catalog: registry: a project's repositories could not be resolved");
                    status.error = Some(format!("{e:#}"));
                    statuses.push(status);
                    continue;
                }
            };
            let readers = match self.enrichers(repos) {
                Ok(readers) => readers,
                Err(e) => {
                    tracing::warn!(project_id = %project.id, error = %format!("{e:#}"), "components-catalog: registry: a project's repositories cannot be read");
                    let error = format!("{e:#}");
                    status.repos.push(RepoWalk {
                        repo: String::new(),
                        status: "failed".to_owned(),
                        hint: read_failure_hint(&error),
                        error: Some(error),
                        ..RepoWalk::default()
                    });
                    statuses.push(status);
                    continue;
                }
            };
            walk.projects_resolved.insert(project.id);
            for (target, reader) in readers {
                let key = reader.repo_key();
                walk.resolved.insert((project.id, key.clone()));
                let known = stored.get(&(project.id, key.clone())).map(String::as_str);
                match reader
                    .project_gears_unless(&pctx, &self.project_gears, known, true)
                    .await
                {
                    Ok(ProjectGearsRead::Unchanged) => {
                        counts.repos_unchanged += 1;
                        status.repos.push(RepoWalk {
                            repo: target.repo.clone(),
                            status: "unchanged".to_owned(),
                            components: held.get(&(project.id, key.clone())).copied().unwrap_or(0),
                            ..RepoWalk::default()
                        });
                    }
                    Ok(ProjectGearsRead::Read {
                        fingerprint,
                        gears,
                        candidates,
                    }) => {
                        counts.repos_read += 1;
                        status.repos.push(RepoWalk {
                            repo: target.repo.clone(),
                            status: "read".to_owned(),
                            components: gears.len(),
                            ..RepoWalk::default()
                        });
                        // What its code depends on (P4): kept on the read,
                        // so an unchanged repository keeps its consumers.
                        let cargo_deps = match reader.cargo_dependencies(&pctx).await {
                            Ok(deps) => deps.into_iter().collect(),
                            Err(e) => {
                                tracing::warn!(project_id = %project.id, repo = %target.repo, error = %format!("{e:#}"), "components-catalog: registry: a repository's Cargo dependencies could not be read");
                                Vec::new()
                            }
                        };
                        walk.reads.push(RepoRead {
                            cargo_deps,
                            project_id: project.id,
                            organization: false,
                            project_name: project.name.clone(),
                            repo: target.repo.clone(),
                            repo_key: key,
                            git_ref: reader.git_ref().to_string(),
                            commit: reader.head_commit(&pctx).await,
                            fingerprint,
                            gears: gears.as_ref().clone(),
                            candidates: candidates.as_ref().clone(),
                            tenant: Some(target.tenant),
                            connection_id: target.connection_id,
                        });
                    }
                    Err(e) => {
                        counts.repos_failed += 1;
                        tracing::warn!(project_id = %project.id, repo = %target.repo, error = %format!("{e:#}"), "components-catalog: registry: a repository could not be read; its occurrences are kept");
                        let error = format!("{e:#}");
                        status.repos.push(RepoWalk {
                            repo: target.repo.clone(),
                            status: "failed".to_owned(),
                            components: held.get(&(project.id, key.clone())).copied().unwrap_or(0),
                            hint: read_failure_hint(&error),
                            error: Some(error),
                        });
                    }
                }
            }
            statuses.push(status);
        }

        let entries: Vec<_> = entries
            .into_iter()
            .filter(|(_, e)| e.organization_id == org)
            .collect();
        let occurrences: Vec<_> = occurrences
            .into_iter()
            .filter(|(_, o)| o.organization_id == org)
            .collect();
        let reads: Vec<_> = reads
            .into_iter()
            .filter(|(_, r)| r.organization_id == org)
            .collect();
        // The one signal across projects, then the threshold.
        super::candidates::apply_copies(&mut walk.reads, &occurrences);
        let mut plan = plan(&walk, &entries, &occurrences, &reads);
        // A contribution the platform took is `published` by the platform's
        // sync, and recorded as its decision (ADR-0042 §4).
        for (entry_id, name, version) in &plan.published {
            if let Some((node, edge)) = super::registry_decisions::decision_node(
                super::registry_decisions::DecisionRecord {
                    organization_id: org,
                    entry: name.clone(),
                    entry_id: entry_id.clone(),
                    action: "published".to_owned(),
                    from: STATE_REGISTERED.to_owned(),
                    to: STATE_PUBLISHED.to_owned(),
                    by: PLATFORM_SYNC.to_owned(),
                    by_name: Some("platform sync".to_owned()),
                    at: walk.now.clone(),
                    reason: Some("the platform's catalogue has it".to_owned()),
                    details: serde_json::json!({ "version": version }),
                },
            ) {
                plan.upsert.push(node);
                plan.edges.push(edge);
            }
        }
        self.sink.upsert(ctx, &plan.upsert, &plan.edges).await?;
        for id in &plan.retire {
            if let Err(e) = self.sink.delete(ctx, id).await {
                tracing::warn!(instance_id = %id, error = %format!("{e:#}"), "components-catalog: registry: a gone node could not be retired");
            }
        }
        // What each project's read came to, for the page's project list.
        let mut settings = self.settings(ctx).await?;
        settings.organization_id = Some(org);
        settings.last_walk = merge_walks(
            std::mem::take(&mut settings.last_walk),
            statuses,
            only.is_empty(),
        );
        self.sink
            .upsert(
                ctx,
                &[gts::registry_settings_node(
                    &org.to_string(),
                    serde_json::to_value(&settings)?,
                )],
                &[],
            )
            .await?;
        counts.entries_created = plan.created;
        counts.entries_updated = plan.updated;
        counts.occurrences_written = plan.occurrences_written;
        counts.occurrences_removed = plan.occurrences_removed;
        counts.orphaned = plan.orphaned;
        counts.candidates = plan.candidates_found;
        counts.reproposed = plan.reproposed;
        counts.published = plan.published.len();
        tracing::info!(organization_id = %org, ?counts, "components-catalog: registry walked");
        progress.set_with(
            "registry: done",
            serde_json::to_value(&counts).unwrap_or(Value::Null),
        );
        Ok(counts)
    }
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "registry_candidates_tests.rs"]
mod candidate_tests;
