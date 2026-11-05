/* The way a project's product goes out: Product composes it, then Releases
 * builds and publishes it and installs it in an environment (ADR-0056 §4).
 * Releases' builds and its deploys each open on one line saying where the
 * project stands and what comes next, and a button to the tab that does it;
 * Product's own line is `nextStep` in components-flow.ts. Derived from what
 * the tab already read. */

import type { Deployment } from "./api";
import { BUILD_STAGES, WHERE_WORD, buildStages, failureCause, failureLine, isLost, type IdeBuild } from "./builds";
import { STATE_LABELS } from "./environments";

/** The project tabs a line can send a person to. */
export type PipelineTab = "components" | "releases";

export interface PipelineHint {
  text: string;
  /** `todo`: something to do; `done`: nothing is waiting; `failed`: what
   *  failed is the next thing to look at. */
  tone: "todo" | "done" | "failed";
  /** The tab that does what comes next, when it is another one. */
  go?: PipelineTab;
}

/** The stage a build is in or stopped at, in words. */
function stageWord(b: IdeBuild): string {
  const stages = buildStages(b);
  const at = BUILD_STAGES.find((s) => stages[s] === "running" || stages[s] === "failed");
  return at === "prepare" ? "preparing" : at === "publish" ? "publishing" : "building the images";
}

/** Where the builds stand: its newest product build, or how to make one.
 *  `canBuildInStudio`: an environment has a registry login to push with. */
export function buildsHint(builds: readonly IdeBuild[], canBuildInStudio: boolean, now = Date.now()): PipelineHint {
  const latest = builds.find((b) => b.action !== "run");
  if (!latest) {
    return {
      text: canBuildInStudio
        ? "Nothing built yet: Build in Studio below, open the project in the IDE, or propose a CI workflow."
        : "Nothing built yet. Building in Studio needs an environment with a registry connection (Organization › Infrastructure); the IDE and CI build without one.",
      tone: "todo",
    };
  }
  const where = WHERE_WORD[latest.where] ?? latest.where;
  if (isLost(latest, now)) {
    return {
      text:
        latest.status === "failed" && latest.failure
          ? `Studio build ${latest.buildId} is lost: ${failureLine(latest.failure)}`
          : `Studio build ${latest.buildId} is lost: no word from its Job since ${new Date(latest.startedAt ?? 0).toLocaleString()}. Build again.`,
      tone: "failed",
    };
  }
  switch (latest.status) {
    case "running":
      return latest.where === "ci"
        ? { text: `A CI build is running; it shows here as it ends, with the next sync of the project's sources.`, tone: "todo" }
        : { text: `${where} build ${latest.buildId} is ${stageWord(latest)}; this page follows it.`, tone: "todo" };
    case "failed": {
      const cause = failureCause(latest, now);
      const stage = latest.where === "ci" && !latest.failureStep ? "" : ` while ${stageWord(latest)}`;
      return {
        text: `The last ${where} build failed${stage}${latest.failure ? `: ${failureLine(latest.failure)}` : "."} ${cause.next}`,
        tone: "failed",
      };
    }
    case "passed":
      return latest.chartRef && latest.chartVersion
        ? { text: `${latest.chartVersion} is published. Next: deploy it.`, tone: "done", go: "releases" }
        : {
            text: "The last build passed and published no chart, so there is nothing to deploy: build in Studio, or publish from the IDE.",
            tone: "todo",
          };
    default:
      return { text: `The last build ended ${latest.status}. Build again.`, tone: "todo" };
  }
}

/** Where the deploys stand: an environment to deploy to, a profile bound
 *  to it, a published build, and what the newest deploy did. */
export function deploysHint(s: {
  environments: number;
  bound: number;
  deployable: number;
  deployments: readonly Deployment[];
}): PipelineHint {
  if (s.environments === 0) {
    return {
      text: "No environment to deploy to yet: an organization administrator adds one under Organization › Infrastructure.",
      tone: "todo",
    };
  }
  if (s.bound === 0) {
    return { text: "Bind the product's profile to an environment below, under Environments of this project.", tone: "todo" };
  }
  const latest = [...s.deployments].sort((a, b) => b.requested_at.localeCompare(a.requested_at))[0];
  if (!latest) {
    return s.deployable === 0
      ? { text: "Nothing published to deploy yet: build it first.", tone: "todo", go: "releases" }
      : { text: "A published build is ready: Deploy a build… in an environment.", tone: "todo" };
  }
  const where = `${latest.environment_name} (${latest.namespace})`;
  if (latest.preview) {
    const name = `Preview ${latest.preview.name} in ${latest.environment_name}`;
    if (latest.preview.removed_at) return { text: `${name} is removed.`, tone: "done" };
    switch (latest.state) {
      case "succeeded":
        return {
          text: latest.preview.host ? `${name} runs at ${latest.preview.host}.` : `${name} runs in ${latest.namespace}.`,
          tone: "done",
        };
      case "failed":
        return { text: `${name} failed${latest.outcome ? `: ${latest.outcome}` : ""}.`, tone: "failed" };
      default:
        return { text: `${STATE_LABELS[latest.state] ?? latest.state}: ${name}.`, tone: "todo" };
    }
  }
  switch (latest.state) {
    case "succeeded":
      return latest.action === "uninstall"
        ? { text: `Uninstalled from ${where}.`, tone: "done" }
        : { text: `Runs in ${where}${latest.chart_version ? `: ${latest.chart_version}` : ""}.`, tone: "done" };
    case "failed":
      return { text: `The last deploy to ${where} failed${latest.reason ? `: ${latest.reason}` : ""}.`, tone: "failed" };
    default:
      return { text: `${STATE_LABELS[latest.state] ?? latest.state}: ${where}.`, tone: "todo" };
  }
}
