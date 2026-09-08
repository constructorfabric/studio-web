//! A tiny, resumable step engine for provisioning flows.
//!
//! Project creation is not one atomic backend call — it is a sequence of writes
//! across account-management and the connector gear (ADR-0010: two-plus
//! non-atomic requests, and the shape invariants now live in the client). A
//! half-finished sequence leaves a "zombie" project (a tenant with no config,
//! or config with no source). This engine makes the sequence **idempotent and
//! resumable**: each step can first `check()` whether it is already satisfied
//! (by probing real backend state) and only `run()` when it is not, so re-running
//! the same plan after a failure heals the project instead of duplicating work.
//!
//! The engine is deliberately UI- and API-agnostic: steps close over whatever
//! they need. Callers get progress via `onProgress` and can re-invoke
//! `runProvision` with the same context to retry from the first unsatisfied step.

export type StepStatus = "pending" | "running" | "done" | "failed";

/** One idempotent unit of work in a provisioning plan. */
export interface ProvisionStep<C> {
  /** Stable identifier, used to correlate progress rows across retries. */
  key: string;
  /** Human label shown in the checklist. */
  label: string;
  /**
   * Optional probe: return `true` when the step is already satisfied (so `run`
   * is skipped). Use it to read backend state — e.g. "does this tenant already
   * exist?", "is the source already registered?" — so a retry resumes cleanly.
   * A step with no `check` always runs (fine when `run` is itself idempotent,
   * like an overwriting PUT).
   */
  check?: (ctx: C) => Promise<boolean> | boolean;
  /** Perform the work. Throwing marks the step failed and stops the plan. */
  run: (ctx: C) => Promise<void>;
}

/** A snapshot of one step's progress, emitted to `onProgress`. */
export interface StepState {
  key: string;
  label: string;
  status: StepStatus;
  /** Present only when `status === "failed"`. */
  error?: string;
}

export interface ProvisionResult<C> {
  /** True when every step finished (`done`); false when one failed. */
  ok: boolean;
  /** The (mutated) context after the run — carries ids resolved along the way. */
  ctx: C;
  states: StepState[];
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Execute `steps` in order against a shared, mutable `ctx`.
 *
 * Steps run sequentially (each may depend on ids the previous one wrote into
 * `ctx`). A step whose `check` resolves truthy is marked `done` without running.
 * The first step to throw is marked `failed`, the run stops there, and every
 * later step stays `pending` — call `runProvision` again with the same `ctx` to
 * resume: already-satisfied steps short-circuit through `check`.
 *
 * `onProgress` is invoked with a fresh copy of the state array on every
 * transition, so a React caller can `setState` straight from it.
 */
export async function runProvision<C>(
  steps: ProvisionStep<C>[],
  ctx: C,
  onProgress?: (states: StepState[]) => void,
): Promise<ProvisionResult<C>> {
  const states: StepState[] = steps.map((s) => ({
    key: s.key,
    label: s.label,
    status: "pending",
  }));
  const emit = () => onProgress?.(states.map((x) => ({ ...x })));
  emit();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      if (step.check && (await step.check(ctx))) {
        states[i] = { key: step.key, label: step.label, status: "done" };
        emit();
        continue;
      }
      states[i] = { key: step.key, label: step.label, status: "running" };
      emit();
      await step.run(ctx);
      states[i] = { key: step.key, label: step.label, status: "done" };
      emit();
    } catch (e) {
      states[i] = {
        key: step.key,
        label: step.label,
        status: "failed",
        error: messageOf(e),
      };
      emit();
      return { ok: false, ctx, states };
    }
  }

  return { ok: true, ctx, states };
}
