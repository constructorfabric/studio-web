/* ── Which namespace each project gets in each environment (ADR-0062) ────────
 *
 * A cluster that does not let Studio create namespaces gives it some, and an
 * organization administrator says which project deploys into which -- and
 * where its build runs, when that is not the same namespace. Studio records
 * the namespace a run made by itself too (`assigned_by: studio`).
 * `GET`/`PUT /studio-environments/v1/namespace-assignments`.
 *
 * Pure: the rows, the checks and the suggestion. The view is
 * `namespace-assignments-view.tsx`. */

import type { DeployEnvironment, NamespaceAssignment } from "./api";
import { namespaceFor } from "./environments";

/** A Kubernetes namespace name: a DNS label. */
const LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export interface AssignmentInput {
  project_id: string;
  environment_id: string;
  namespace: string;
  /** Empty: the build runs in the namespace itself. */
  build_namespace: string;
}

/** What is wrong with the form, the first thing; `null` when it can be saved. */
export function assignmentProblem(a: AssignmentInput, environments: readonly DeployEnvironment[]): string | null {
  if (!a.project_id) return "Pick the project.";
  if (!a.environment_id) return "Pick the environment.";
  const env = environments.find((e) => e.id === a.environment_id);
  if (env?.kind === "research") return `${env.name} runs on Constructor Research, which has no namespaces.`;
  const ns = a.namespace.trim();
  if (!ns) return "Name the namespace.";
  if (!LABEL.test(ns)) return `“${ns}” is not a namespace name: a–z, 0–9 and -, at most 63, starting and ending with a letter or digit.`;
  const build = a.build_namespace.trim();
  if (build && !LABEL.test(build)) return `“${build}” is not a namespace name.`;
  if (env?.namespaces?.length && !env.namespaces.includes(ns))
    return `The cluster gives ${env.name} only ${env.namespaces.join(", ")}.`;
  return null;
}

/** The namespace the environment's pattern would give the project: what the
 *  form suggests before anybody types. */
export function suggestedNamespace(env: DeployEnvironment | undefined, projectName: string): string {
  if (!env) return "";
  if (env.namespaces?.length === 1) return env.namespaces[0];
  return namespaceFor(env.namespace_pattern ?? "", projectName, env.name);
}

export interface AssignmentRow {
  key: string;
  project: string;
  environment: string;
  namespace: string;
  /** Shown only when it differs from the namespace. */
  build: string | null;
  /** Who gave it: a person, or "a run" for one Studio made itself. */
  by: string;
  at: string | null;
  assignment: NamespaceAssignment;
}

/** The assignments as rows with names, by project and then environment. */
export function assignmentRows(
  items: readonly NamespaceAssignment[],
  projectName: (id: string) => string,
  environmentName: (id: string) => string,
): AssignmentRow[] {
  return items
    .map((a) => ({
      key: `${a.project_id}/${a.environment_id}`,
      project: projectName(a.project_id),
      environment: environmentName(a.environment_id),
      namespace: a.namespace,
      build: a.build_namespace && a.build_namespace !== a.namespace ? a.build_namespace : null,
      by: a.assigned_by === "studio" ? "a run (Studio made it)" : a.assigned_by || "—",
      at: a.assigned_at ?? null,
      assignment: a,
    }))
    .sort((x, y) => x.project.localeCompare(y.project) || x.environment.localeCompare(y.environment));
}

/** The form for an existing row, or an empty one. */
export function assignmentInput(a?: NamespaceAssignment | null): AssignmentInput {
  return {
    project_id: a?.project_id ?? "",
    environment_id: a?.environment_id ?? "",
    namespace: a?.namespace ?? "",
    build_namespace: a?.build_namespace && a.build_namespace !== a.namespace ? a.build_namespace : "",
  };
}
