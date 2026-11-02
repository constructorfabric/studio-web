// Constructor Studio: the product's tests, gear by gear, under Build and Run.
//
// Drawn from plain props, as `RunPanel` is: the widget runs the tests in
// terminals (`ProductTerminals.run`) and hands back how each ended. The
// rules -- which command, how the output is read -- are in
// `common/gear-tests.ts`.
//
// A section of the Run & Deploy view rather than Theia's Test view: the
// bundled `@theia/test` is there only as a dependency of the plugin host, on
// the desktop, and this package does not depend on it.

import React from "@theia/core/shared/react";

import { testTally, type GearTestState, type GearTestTarget } from "../../common/gear-tests";

export interface GearTestsPanelProps {
  readonly targets: readonly GearTestTarget[];
  readonly states: Readonly<Record<string, GearTestState | undefined>>;
  /** Run all is going through the gears one after another. */
  readonly runningAll: boolean;
  readonly onRun: (gear: string) => void;
  readonly onRunAll: () => void;
}

function stateLine(state: GearTestState | undefined): string {
  if (state === undefined) return "";
  if (state.status === "running") return "running…";
  const counts =
    state.passed !== undefined
      ? `${state.passed} passed${state.failed ? `, ${state.failed} failed` : ""}${state.ignored ? `, ${state.ignored} ignored` : ""}`
      : undefined;
  if (state.status === "passed") return counts ?? "passed";
  return [counts, state.why].filter((part) => part !== undefined).join(" — ") || "failed";
}

const ICON: Record<GearTestState["status"], string> = { running: "loading", passed: "pass", failed: "error" };

export function GearTestsPanel(props: GearTestsPanelProps): React.ReactElement {
  const tally = testTally(props.states);
  const busy = props.runningAll || tally.running > 0;
  return (
    <div className="gbx-generate-tests" data-gear-tests>
      <div className="gbx-group-label">Tests</div>
      {props.targets.length === 0 ? (
        <p className="gbx-waiting" data-tests-state="no-gears">
          The product has no gears to test yet.
        </p>
      ) : (
        <>
          <div className="gbx-generate-actions">
            <button type="button" className="gbx-choice" data-tests-run-all disabled={busy} onClick={props.onRunAll} title="Run every gear's tests, one gear after another">
              {props.runningAll ? "Running all…" : "Run all"}
            </button>
            {tally.passed + tally.failed > 0 && (
              <span className="gbx-generate-tests-tally" data-tests-tally>
                {tally.passed} passed, {tally.failed} failed
              </span>
            )}
          </div>
          <ul className="gbx-generate-tests-list">
            {props.targets.map((target) => {
              const state = props.states[target.gear];
              return (
                <li key={target.gear} data-test-gear={target.gear} data-test-status={state?.status ?? "not-run"}>
                  <span className={`gbx-generate-tests-icon gbx-generate-tests-${state?.status ?? "not-run"}`}>
                    {state !== undefined && <span className={`codicon codicon-${ICON[state.status]}${state.status === "running" ? " codicon-modifier-spin" : ""}`} />}
                  </span>
                  <span className="gbx-generate-tests-gear" title={target.manifest ?? `${target.crate}, tested in the generated tree`}>
                    {target.gear}
                  </span>
                  <span className="gbx-generate-tests-state" data-test-state>
                    {stateLine(state)}
                  </span>
                  <button
                    type="button"
                    className="gbx-choice"
                    data-test-run
                    disabled={busy}
                    onClick={() => props.onRun(target.gear)}
                    title={`cargo test for ${target.crate}`}
                  >
                    Run tests
                  </button>
                  {state?.failing !== undefined && state.failing.length > 0 && (
                    <ul className="gbx-generate-tests-failing" data-test-failing>
                      {state.failing.map((name) => (
                        <li key={name}>
                          <code>{name}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
