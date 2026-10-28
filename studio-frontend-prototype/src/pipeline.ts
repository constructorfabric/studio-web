/* The way a project's product goes out, tab by tab: Product composes it,
 * Builds builds and publishes it, Deploys installs it in an environment. Each
 * of the two later tabs opens on one line saying where the project stands and
 * what comes next, and a button to the tab that does it; Product's own line is
 * `nextStep` in components-flow.ts. Derived from what the tab already read. */

import type { Deployment } from "./api";
import { BUILD_STAGES, buildStages, type IdeBuild } from "./builds";
import { STATE_LABELS } from "./environments";

/** The project tabs a line can send a person to. */
export type PipelineTab = "components" | "builds" | "deploys";

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

/** Where the Builds tab stands: its newest product build, or how to make one.
 *  `canBuildInStudio`: an environment has a registry login to push with. */
export function buildsHint(builds: readonly IdeBuild[], canBuildInStudio: boolean): PipelineHint {
  const latest = builds.find((b) => b.action !== "run");
  if (!latest) {
    return {
      text: canBuildInStudio
        ? "Nothing built yet: Build in Studio below, open the project in the IDE, or propose a CI workflow."
        : "Nothing built yet. Building in Studio needs an environment with a registry connection (Organization › Environments); the IDE and CI build without one.",
      tone: "todo",
    };
  }
  switch (latest.status) {
    case "running":
      return { text: `Build ${latest.buildId} is ${stageWord(latest)}; this page follows it.`, tone: "todo" };
    case "failed":
      return {
        text: `The last build failed while ${stageWord(latest)}${latest.failure ? `: ${latest.failure.split("\n")[0]}` : ""}. Fix it and build again.`,
        tone: "failed",
      };
    case "passed":
      return latest.chartRef && latest.chartVersion
        ? { text: `${latest.chartVersion} is published. Next: deploy it.`, tone: "done", go: "deploys" }
        : {
            text: "The last build passed and published no chart, so there is nothing to deploy: build in Studio, or publish from the IDE.",
            tone: "todo",
          };
    default:
      return { text: `The last build ended ${latest.status}. Build again.`, tone: "todo" };
  }
}

/** Where the Deploys tab stands: an environment to deploy to, a profile bound
 *  to it, a published build, and what the newest deploy did. */
export function deploysHint(s: {
  environments: number;
  bound: number;
  deployable: number;
  deployments: readonly Deployment[];
}): PipelineHint {
  if (s.environments === 0) {
    return {
      text: "No environment to deploy to yet: an organization administrator adds one under Organization › Environments.",
      tone: "todo",
    };
  }
  if (s.bound === 0) {
    return { text: "Bind the product's profile to an environment below, under Environments.", tone: "todo" };
  }
  const latest = [...s.deployments].sort((a, b) => b.requested_at.localeCompare(a.requested_at))[0];
  if (!latest) {
    return s.deployable === 0
      ? { text: "Nothing published to deploy yet: build it first.", tone: "todo", go: "builds" }
      : { text: "A published build is ready: Deploy a build… in an environment.", tone: "todo" };
  }
  const where = `${latest.environment_name} (${latest.namespace})`;
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
