// Constructor Studio: Build and Run, under Generate's Apply.
//
// Drawn from plain props so what it offers in each state is tested without the
// widget; the widget does the asking (the backend for the toolchain and the
// Postgres, the terminals for the commands). The rules are in
// `common/run-product.ts`.

import React from "@theia/core/shared/react";

import {
  LOCAL_POSTGRES,
  dbNameOf,
  urlOf,
  type RunTarget,
  type ToolchainVerdict,
} from "../../common/run-product";

export type PostgresState = "unknown" | "answers" | "none";

export interface RunPanelProps {
  /** Whether the generated tree is on disk (applied, or nothing left to write). */
  readonly generated: boolean;
  /** `undefined` while the backend is being asked. */
  readonly verdict: ToolchainVerdict | undefined;
  readonly targets: readonly RunTarget[];
  readonly chosen: RunTarget | undefined;
  readonly postgres: PostgresState;
  readonly docker: boolean;
  readonly startingPostgres: boolean;
  readonly onChoose: (app: string) => void;
  readonly onBuild: () => void;
  readonly onRun: () => void;
  readonly onLinkedGears: () => void;
  readonly onStartPostgres: () => void;
  readonly onOpen: (url: string) => void;
  /** "Get protoc": Studio fetches it into its tools folder. */
  readonly onFetchProtoc?: () => void;
  readonly fetchingProtoc?: boolean;
  /** Create the missing databases in the Postgres that already answers. */
  readonly onCreateDatabases?: () => void;
  readonly creatingDatabases?: boolean;
  /** "Debug configurations": write the product's CodeLLDB configurations into launch.json, so F5 starts what Run starts. */
  readonly onAddDebugConfigurations?: () => void;
  readonly addingDebugConfigurations?: boolean;
}

export function RunPanel(props: RunPanelProps): React.ReactElement {
  const { verdict, chosen } = props;
  return (
    <div className="gbx-generate-run" data-generate-run>
      <div className="gbx-group-label">Build and run</div>
      {!props.generated ? (
        <p className="gbx-waiting" data-run-state="not-generated">
          Apply writes the tree; Build and Run work on it once it is on disk.
        </p>
      ) : verdict === undefined ? (
        <p className="gbx-waiting" data-run-state="checking">
          Checking for cargo…
        </p>
      ) : !verdict.ready ? (
        <p className="gbx-inline-error" role="alert" data-run-state="no-toolchain">
          {verdict.reason}{" "}
          {verdict.help !== undefined && (
            <a href={verdict.help.url} target="_blank" rel="noreferrer">
              {verdict.help.label}
            </a>
          )}
        </p>
      ) : props.targets.length === 0 || chosen === undefined ? (
        <p className="gbx-waiting" data-run-state="nothing-to-run">
          This profile has no application Run can start on its own: its processes are workers a host spawns.
        </p>
      ) : (
        <>
          {props.targets.length > 1 && (
            <label className="gbx-generate-run-app">
              Application{" "}
              <select data-run-app value={chosen.app} onChange={(e) => props.onChoose(e.target.value)}>
                {props.targets.map((target) => (
                  <option key={target.app} value={target.app}>
                    {target.app}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="gbx-generate-actions" data-run-state="ready">
            <button type="button" className="gbx-start-primary" data-run-build onClick={props.onBuild} title={`cargo build --bin ${chosen.bin}`}>
              Build
            </button>
            <button type="button" className="gbx-start-primary" data-run-run onClick={props.onRun} title={`Run ${chosen.bin} with ${chosen.dbGears.length > 0 ? chosen.localConfig : chosen.config}`}>
              Run
            </button>
            {props.onAddDebugConfigurations !== undefined && (
              <button
                type="button"
                className="gbx-choice"
                data-run-debug
                disabled={props.addingDebugConfigurations}
                onClick={props.onAddDebugConfigurations}
                title="Add a CodeLLDB configuration per application to .vscode/launch.json, so F5 builds and starts it under the debugger as Run does"
              >
                {props.addingDebugConfigurations ? "Adding…" : "Debug configurations"}
              </button>
            )}
            <button type="button" className="gbx-choice" data-run-linked onClick={props.onLinkedGears} title="List the gears linked into the binary, without starting it">
              Linked gears
            </button>
            {chosen.address !== undefined && (
              <span className="gbx-generate-run-address" data-run-address={chosen.address}>
                listens on <code>{urlOf(chosen.address)}</code>{" "}
                <button type="button" className="gbx-choice" data-run-open onClick={() => props.onOpen(urlOf(chosen.address as string))}>
                  Open
                </button>
              </span>
            )}
          </div>
          {chosen.cautions?.map((caution) => (
            <p key={caution} className="gbx-inline-error" role="alert" data-run-caution>
              {caution}
            </p>
          ))}
          {verdict.missing?.map((missing) => (
            <p key={missing.tool} className="gbx-generate-run-tool" data-run-missing={missing.tool}>
              {missing.reason}{" "}
              {missing.fetchable && props.onFetchProtoc !== undefined && (
                <button type="button" className="gbx-choice" data-run-fetch-protoc disabled={props.fetchingProtoc} onClick={props.onFetchProtoc}>
                  {props.fetchingProtoc ? "Getting protoc…" : "Get protoc"}
                </button>
              )}
              {missing.help !== undefined && (
                <a href={missing.help.url} target="_blank" rel="noreferrer">
                  {missing.help.label}
                </a>
              )}
            </p>
          ))}
          {chosen.dbGears.length > 0 && <DatabaseNote {...props} target={chosen} />}
        </>
      )}
    </div>
  );
}

function DatabaseNote(props: RunPanelProps & { readonly target: RunTarget }): React.ReactElement {
  const { target } = props;
  const names = target.dbGears.map(dbNameOf).join(", ");
  const where = `${LOCAL_POSTGRES.host}:${LOCAL_POSTGRES.port}`;
  return (
    <div className="gbx-generate-run-db" data-run-db={props.postgres}>
      <p>
        {target.dbGears.join(", ")} {target.dbGears.length === 1 ? "needs" : "need"} a database, which the generated
        configuration does not describe. Run uses <code>{target.localConfig}</code>: the same configuration with a
        Postgres at <code>{where}</code> (user <code>{LOCAL_POSTGRES.user}</code>, password from{" "}
        <code>{LOCAL_POSTGRES.passwordEnv}</code>) and the databases {names}.
      </p>
      {props.postgres === "answers" && (
        <p data-run-db-state="answers">
          A Postgres answers on {where}; its databases {names} have to exist in it.{" "}
          {props.docker && props.onCreateDatabases !== undefined && (
            <button type="button" className="gbx-choice" data-run-create-databases disabled={props.creatingDatabases} onClick={props.onCreateDatabases}>
              {props.creatingDatabases ? "Creating…" : "Create the databases"}
            </button>
          )}
        </p>
      )}
      {props.postgres === "none" &&
        (props.docker ? (
          <p data-run-db-state="none">
            Nothing answers on {where}.{" "}
            <button type="button" className="gbx-choice" data-run-start-postgres disabled={props.startingPostgres} onClick={props.onStartPostgres}>
              {props.startingPostgres ? "Starting Postgres…" : "Start a local Postgres"}
            </button>{" "}
            runs <code>postgres:18-alpine</code> in docker on {where} and creates {names}.
          </p>
        ) : (
          <p className="gbx-inline-error" data-run-db-state="no-docker">
            Nothing answers on {where}, and docker is not available to start one. Start a Postgres there and create{" "}
            {names}.
          </p>
        ))}
    </div>
  );
}
