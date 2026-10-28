/**
 * studio-documents wire types. Each names the backend DTO it mirrors
 * (`studio-backend/src/documents/rest.rs`, ADR-0020 §8); a narrowed one says
 * which part it keeps.
 */

/**
 * One stage, as the catalogue serves it.
 *
 * What comes back is already the EFFECTIVE list for that workspace: the platform
 * catalogue, overlaid by the organization, overlaid by the workspace, tombstones
 * removed, in catalogue order. A caller must not re-sort it, and must not assume
 * `intent` is present — a workspace may have replaced it.
 */
export interface JourneyStage {
  key: string;
  label: string;
  required: boolean;
  position: number;
  /** Document-type keys this stage is not complete without. */
  requires: string[];
  /** `builtin` | `organization` | `workspace` — which level defined it. */
  owner: string;
  owner_tenant_id?: string | null;
}

export interface StageListDto {
  items: JourneyStage[];
}

/** Mirrors `DocumentTypeDto` — the fields this MFE reads. */
export interface DocumentTypeDto {
  key: string;
  name: string;
}

/** Mirrors `DocumentTypeListDto`: the workspace's effective catalogue. */
export interface DocumentTypeListDto {
  items: DocumentTypeDto[];
}

/** Mirrors `DocumentDto` — the fields this MFE reads. */
export interface DocumentDto {
  id: string;
  type_key: string;
  title: string;
  inherited: boolean;
  created_at: string;
  updated_at: string;
}

/** Mirrors `DocumentListDto`. `total` counts every page. */
export interface DocumentListDto {
  items: DocumentDto[];
  total: number;
}

/**
 * Mirrors `CreateDocumentDto`, without `answers`: a document is created here
 * from text, never from the type's questionnaire.
 */
export interface CreateDocumentDto {
  type_key: string;
  title: string;
  /** Verbatim. Omitted, the document starts from the type's template. */
  content?: string;
}

/** Mirrors `BindingState`. */
export type BindingState = 'detected' | 'confirmed' | 'manual' | 'unknown' | 'not_a_document';

/** Mirrors `DocumentBindingDto` — the fields this MFE reads. */
export interface DocumentBindingDto {
  id: string;
  type_key: string | null;
  state: BindingState;
}

/**
 * Mirrors `DecideBindingDto`, narrowed to a person's decision: `source`,
 * `confidence` and `content` are for recording a detector's verdict.
 */
export type DecideBindingDto =
  | { action: 'confirm' | 'reject' | 'reset' }
  | { action: 'set'; type_key: string };

/** The detectors `POST …/quality/{detector}` accepts (`quality::Detector::parse`). */
export type QualityDetector = 'purpose' | 'leak' | 'bloat' | 'traceability';

/**
 * Mirrors `AnalyzeBindingsRequest`, without `documents`: the texts an editor
 * holds unsaved. The server reads every file and document named here itself.
 */
export interface AnalyzeBindingsRequest {
  binding_ids: string[];
  document_ids: string[];
}

/** Mirrors `AnalyzeEnqueuedDto` (documents): the run doing the check. */
export interface AnalyzeEnqueuedDto {
  run_id: string;
  /**
   * The backend's own path to the run, without the gateway's `/cf`, so not
   * fetchable as is. Follow `run_id` through `StudioTasksApiService`, as a
   * sync's run is.
   */
  poll: string;
  /** Documents the run will analyse — fewer than asked when a checkout lacks one. */
  documents: number;
}

/** Mirrors `SpecRowDto`: one spec, a repository file or a document written in Studio. */
export interface SpecRowDto {
  /**
   * The binding id for a bound repository file, the document id for an
   * authored one, `candidate:<node_id>` for a file nothing has classified —
   * which names no record and is accepted by neither write.
   */
  id: string;
  origin: 'repository' | 'authored';
  name: string;
  /** Empty for an authored document. */
  path: string;
  /** Null while nothing has decided a type. */
  type_key: string | null;
  /** The file's graph node, for a repository row. */
  node_id: string | null;
  /** Null for an authored document, whose type nobody decides, and for a file nothing has classified. */
  state: BindingState | null;
  /** `draft` | `review` | `approved` for an authored row; null otherwise. */
  status: string | null;
  conforms: boolean | null;
  updated_at: string;
  /** The repo node the file came from. Empty for an authored row. */
  repo: string;
  /**
   * That repository's `full_path`. Empty for an authored row, and for a
   * repository whose path is unknown — see `sources`.
   */
  repo_full_path: string;
  /** The type's confidence: meaningful while `detected`, `1.0` for `manual`. */
  confidence: number | null;
  /**
   * RFC 3339 time of the newest verdict from ANY detector, `bloat` and
   * `traceability` included. Null with `findings > 0` means checked before
   * verdicts were dated: read `findings` first.
   */
  checked_at: string | null;
  /** Findings placed in the text, across every verdict of the document. */
  findings: number;
  /** Out of `not-scanned`, `needs-review`, `bound`, `not-documents`. */
  queues: string[];
}

/** Mirrors `SpecCountDto`. */
export interface SpecCountDto {
  /** `not-scanned`, `needs-review`, `bound`, `not-documents` or `all`. */
  queue: string;
  count: number;
}

/** Mirrors `SpecRowsSourcesDto`: which reads behind the rows succeeded. */
export interface SpecRowsSourcesDto {
  /** False: the never-classified files could not be read, not "there are none". */
  files_known: boolean;
  /** False: every row's `checked_at` and `findings` are unknown, not "never checked". */
  reviews_known: boolean;
  /** False: an empty `repo_full_path` is unknown, not a repository that is gone. */
  repos_known: boolean;
  counts: SpecCountDto[];
}

/** Mirrors `SpecRowListDto`. Not paged: every row of the project. */
export interface SpecRowListDto {
  items: SpecRowDto[];
  total: number;
  sources: SpecRowsSourcesDto;
}

/** Mirrors `SpecsPerSourceDto`. */
export interface SpecsPerSourceDto {
  /** The repo node's instance id. */
  repo: string;
  /** Files somebody decided are documents. */
  specs: number;
}

/** Mirrors `SpecsPerSourceListDto`. A repository it does not list has none. */
export interface SpecsPerSourceListDto {
  items: SpecsPerSourceDto[];
  total: number;
  /** False: every count is missing rather than zero, rendered `—`. */
  files_known: boolean;
}
