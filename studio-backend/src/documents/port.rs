//! What another gear may ask studio-documents to do.
//!
//! One seam, deliberately. `studio-artifact-ingest` walks a repository and
//! ends up holding every file's path and text; this gear owns the type
//! catalogue and decides what each file is. Neither can answer alone and
//! neither should learn the other's job, so the seam between them is a trait
//! this gear declares and the ingest gear calls.
//!
//! Published on the ClientHub rather than reached for directly: the documents
//! gear stands down when it has no database, and a consumer that resolves the
//! client and finds nothing simply does not classify — rather than failing a
//! repository sync over it.

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

/// One file offered for classification, as the gear that walked it has it.
#[derive(Debug, Clone)]
pub struct IngestedDocument {
    /// Instance id of the `gts.cf.studio.artifact.file` node holding the bytes.
    pub node_id: String,
    /// Repo-relative path, e.g. `docs/adr/0007-shell-tokens.md`.
    pub path: String,
    /// The file's text. Read to classify and validate; never stored here.
    ///
    /// Empty for a file whose path is not prose. The verdict for one is the
    /// path alone, so the walker does not copy a repository's source bytes to
    /// be told what its own extensions already say.
    pub content: String,
}

/// What a classification pass did.
#[derive(Debug, Clone, Copy, Default)]
pub struct ClassifiedCounts {
    /// Files given a type, or left undetermined for a person to settle.
    pub classified: usize,
    /// Files recorded as not documents, by their path.
    pub not_documents: usize,
    /// Files left exactly as they were, because a person had already ruled on
    /// them or Spec Quality had paid for the answer.
    pub kept: usize,
    /// Typed documents whose text is new or different since the last sync.
    pub changed_documents: usize,
    /// Spec Quality runs queued for them, which record their own results.
    pub analyses_queued: usize,
}

#[async_trait]
pub trait DocumentClassifier: Send + Sync + 'static {
    /// Decide what each file is and record it, against the workspace's
    /// effective type catalogue.
    ///
    /// Idempotent by `(tenant, project, node)`: running it again after a
    /// re-sync updates the same rows, and never overturns a verdict a person
    /// settled or a detector paid for.
    async fn classify_ingested(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Option<Uuid>,
        files: Vec<IngestedDocument>,
    ) -> anyhow::Result<ClassifiedCounts>;

    /// Forget files the repository no longer has: delete this scope's
    /// bindings for `node_ids` and return how many rows went.
    ///
    /// On this trait rather than a sibling because it is the other half of the
    /// same job. The walker is the only gear that can tell a file is gone, and
    /// `classify_ingested` only ever hears about the files that are there, so
    /// without this a binding outlives its file for good.
    ///
    /// Scoped exactly as `classify_ingested` writes: `(tenant, project, node)`
    /// with the same `project_id`, so a project's sync never deletes a binding
    /// the workspace itself recorded. A node with no binding is not an error.
    async fn forget_ingested(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Option<Uuid>,
        node_ids: Vec<String>,
    ) -> anyhow::Result<usize>;
}

/// How much a project has in it, as this gear counts it.
///
/// Separate from [`DocumentClassifier`] because it is a different seam: the
/// classifier is this gear doing work for another, and this is another gear
/// asking this one a question about its own rows. Both are published the same
/// way, and both stand down the same way when the gear has no database.
///
/// The portfolio needs one number per project and nothing else, so the trait
/// returns a number rather than a page. A caller that receives `Ok(n)` knows
/// `n`; a caller that receives `Err` knows NOTHING, which is not the same as
/// zero and must not be rendered as one.
#[async_trait]
pub trait DocumentCounter: Send + Sync + 'static {
    /// Document bindings recorded for this project.
    ///
    /// `workspace_id` is the PARENT workspace: bindings are stored against it
    /// and scoped to the project, which is the pairing the Documents section
    /// uses and the one the rollup has to repeat to count the same rows.
    async fn count_bindings(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> anyhow::Result<u32>;

    /// How this project's specs stand: how many, how many written in Studio,
    /// how many checked and how many of those fail. Same pairing of
    /// `workspace_id` and `project_id` as [`Self::count_bindings`].
    async fn spec_summary(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> anyhow::Result<SpecSummary>;
}

pub use super::spec_rows::SpecSummary;

/// Whether a path could hold a specification document at all.
///
/// Re-exported because a caller holding a whole repository wants to filter
/// before it copies the text of every file into a request — and filtering by a
/// second, drifting copy of this rule is how the two ends start disagreeing
/// about what a document is.
pub use super::classify::is_prose_path;

/// What each ingested file was decided to BE CALLED, for whoever lists what
/// happened to it.
///
/// The Activity feed names a check by the document it is about. A
/// `spec_finding` node carries its subject's node id and, usually, its path —
/// but the binding is the record that says which file this project decided
/// that node is, and it is the better name when both exist. The browser used
/// to read all the bindings itself to build this map, beside the two graph
/// walks it was already doing.
///
/// Absent is a normal state: losing the names leaves rows reading by path,
/// which is worse than a name and very much better than no feed.
#[async_trait]
pub trait BindingNames: Send + Sync + 'static {
    /// `node id -> display name` for every binding in this project.
    ///
    /// The name is the path's last segment, which is what a reader recognises
    /// — the same rule the Specs list uses, so one file does not read as two
    /// different things on two screens.
    ///
    /// The PROJECT alone: bindings are stored against its parent workspace and
    /// scoped to it, and a caller asking what a file is called should not have
    /// to know that. Resolving the parent is this gear's job because it is
    /// this gear's storage layout.
    async fn names_for(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
    ) -> anyhow::Result<std::collections::HashMap<String, String>>;
}

/// Records a detector's gate verdict on a document, for a stage to read.
///
/// The REST `PUT …/analyses/{detector}` routes do the same for a caller that
/// read the verdict itself. This is the seam for a Spec Quality run that
/// records its own results as each document finishes, so a stage gate is
/// answered even for an analysis nobody was watching.
#[async_trait]
pub trait AnalysisRecorder: Send + Sync + 'static {
    async fn record_detector_verdict(&self, verdict: DetectorVerdict) -> anyhow::Result<()>;
}

/// One detector's gate verdict on one document.
#[derive(Debug, Clone)]
pub struct DetectorVerdict {
    pub workspace_id: Uuid,
    /// Exactly one of `binding_id` (a repository document) and `document_id`
    /// (one written in Studio) names the document.
    pub binding_id: Option<Uuid>,
    pub document_id: Option<Uuid>,
    pub detector: String,
    /// `pending`, `passed` or `failed`.
    pub state: String,
    /// The upstream task the verdict was read from.
    pub task_id: Option<String>,
    pub summary: String,
}

pub use super::model::Capability;

/// The capability vocabulary an organization publishes: the platform's, with
/// the organization's own over it. The catalogue's registry passes it to a
/// model so a suggested capability is always one of these keys (ADR-0041 P4).
#[async_trait]
pub trait CapabilityVocabulary: Send + Sync + 'static {
    async fn organization_vocabulary(
        &self,
        ctx: &SecurityContext,
        organization_id: Uuid,
    ) -> anyhow::Result<Vec<Capability>>;
}

/// The platform's built-in vocabulary, for a reader without the documents
/// gear.
pub fn builtin_vocabulary() -> Vec<Capability> {
    super::model::builtin_capabilities()
}
pub use super::service::{CapabilitySource, DeclaredCapability, DeclaredRequirement};

/// What a project's specifications need, as the documents gear indexes them,
/// for the spec-mapping gear (`crate::spec_mapping`). The documents are read as
/// written: front matter when it says, the functional requirements otherwise.
#[async_trait]
pub trait SpecNeeds: Send + Sync + 'static {
    /// The project's parent workspace, after checking the caller reaches both.
    /// `None` when the caller does not, or there is no such project: one
    /// answer, so a caller learns nothing about a project not theirs.
    async fn project_workspace(
        &self,
        ctx: &SecurityContext,
        project_id: Uuid,
    ) -> anyhow::Result<Option<Uuid>>;

    /// The workspace's effective capability vocabulary.
    async fn vocabulary(
        &self,
        ctx: &SecurityContext,
        workspace_id: Uuid,
    ) -> anyhow::Result<Vec<Capability>>;

    /// The capabilities the project's documents need, and their
    /// non-functional statements, each with the document that says it.
    async fn needs(
        &self,
        workspace_id: Uuid,
        project_id: Uuid,
    ) -> anyhow::Result<(Vec<DeclaredCapability>, Vec<DeclaredRequirement>)>;
}
