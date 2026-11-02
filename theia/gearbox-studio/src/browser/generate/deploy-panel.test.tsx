/**
 * @jest-environment jsdom
 */
// Deploy under Generate, for a kubernetes profile: what is offered in each state.
import "reflect-metadata";

import React from "@theia/core/shared/react";

import { DeployPanel, failureLine, groupDeployments, type DeployPanelProps } from "./deploy-panel";

interface Root {
  render(node: React.ReactNode): void;
  unmount(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRoot } = require("@theia/core/shared/react-dom/client") as { createRoot(host: Element): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (fn: () => void | Promise<void>) => Promise<void> }).act;

describe("the Deploy panel", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  async function draw(over: Partial<DeployPanelProps>): Promise<void> {
    const props: DeployPanelProps = {
      generated: true,
      ready: true,
      images: [{ app: "api-gateway", image: "gbx-api-gateway:0.1.0" }],
      chart: "helm/shop",
      registry: undefined,
      namespace: "shop",
      docker: true,
      helm: "v4.2.3",
      environments: [],
      contexts: ["kind-local", "dev"],
      target: { kind: "context", name: "kind-local" },
      onTarget: () => undefined,
      onBuildImages: () => undefined,
      onPush: () => undefined,
      onTemplate: () => undefined,
      onDeploy: () => undefined,
      ...over,
    };
    await act(() => root.render(<DeployPanel {...props} />));
  }

  const q = (selector: string): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(selector);

  it("waits for Apply, then for the backend", async () => {
    await draw({ generated: false });
    expect(host.querySelector("[data-deploy-state=not-generated]")).not.toBeNull();
    await draw({ ready: undefined });
    expect(host.querySelector("[data-deploy-state=checking]")).not.toBeNull();
  });

  it("says the tree has nothing to deploy rather than offering buttons", async () => {
    await draw({ images: [], chart: undefined });
    expect(host.querySelector("[data-deploy-state=no-plan]")).not.toBeNull();
    expect(q("[data-deploy-install]")).toBeNull();
  });

  it("builds, previews and deploys into the chosen context, and pushes only with a registry", async () => {
    const onBuildImages = jest.fn();
    const onTemplate = jest.fn();
    const onDeploy = jest.fn();
    await draw({ onBuildImages, onTemplate, onDeploy });
    expect(q("[data-deploy-push]")?.disabled).toBe(true);
    expect(host.querySelector("[data-deploy-images]")?.textContent).toMatch(/stay in this machine's Docker/);
    await act(() => q("[data-deploy-build]")?.click());
    await act(() => q("[data-deploy-template]")?.click());
    await act(() => q("[data-deploy-install]")?.click());
    expect(onBuildImages).toHaveBeenCalled();
    expect(onTemplate).toHaveBeenCalled();
    expect(onDeploy).toHaveBeenCalled();

    const onPush = jest.fn();
    await draw({ registry: "ghcr.io/acme", onPush });
    expect(host.querySelector("[data-deploy-images]")?.textContent).toMatch(/pushed to ghcr.io\/acme/);
    await act(() => q("[data-deploy-push]")?.click());
    expect(onPush).toHaveBeenCalled();
  });

  it("says helm is missing and offers no Deploy without it", async () => {
    await draw({ helm: undefined });
    expect(host.querySelector("[data-deploy-missing=helm]")).not.toBeNull();
    expect(q("[data-deploy-install]")?.disabled).toBe(true);
    expect(q("[data-deploy-template]")?.disabled).toBe(true);
  });

  it("lists the organization's environments above the kube contexts and deploys there without helm", async () => {
    const onTarget = jest.fn();
    const onDeploy = jest.fn();
    const prod = { id: "e-prod", name: "prod", namespace: "shop-prod", registry: "ghcr.io/acme", protected: true };
    await draw({ environments: [prod], target: { kind: "environment", id: "e-prod" }, helm: undefined, registry: "ghcr.io/acme", onTarget, onDeploy });
    const groups = [...host.querySelectorAll("[data-deploy-target] optgroup")].map((g) => g.getAttribute("label"));
    expect(groups).toEqual(["The organization's environments", "Kube contexts on this machine"]);
    expect(host.querySelector("[data-deploy-environment=prod]")?.textContent).toMatch(/approves it first/);
    expect(host.querySelector("[data-deploy-missing=helm]")).toBeNull();
    expect(q("[data-deploy-install]")?.disabled).toBe(false);
    await act(() => q("[data-deploy-install]")?.click());
    expect(onDeploy).toHaveBeenCalled();

    const select = host.querySelector<HTMLSelectElement>("[data-deploy-target]");
    await act(() => {
      if (select) {
        select.value = "ctx:dev";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(onTarget).toHaveBeenCalledWith({ kind: "context", name: "dev" });
  });

  it("says what the server answered, and does not ask twice at once", async () => {
    const prod = { id: "e-prod", name: "prod", namespace: "shop-prod", registry: "", protected: false };
    await draw({ environments: [prod], target: { kind: "environment", id: "e-prod" }, requesting: true, note: "queued" });
    expect(q("[data-deploy-install]")?.disabled).toBe(true);
    expect(host.querySelector("[data-deploy-note]")?.textContent).toBe("queued");
  });

  describe("builds and deploys, as Studio records them", () => {
    const prod = { id: "e-prod", name: "prod", namespace: "shop-prod", registry: "ghcr.io/acme", protected: false, registryLogin: true };
    const build = {
      buildId: "studio-1", where: "studio", status: "passed" as const, product: "shop", profile: "prod", shortSha: "abcdef0",
      branch: "main", startedAt: "2026-10-28T10:00:00Z", failure: undefined, failureStep: undefined, step: undefined,
      chartRef: "oci://ghcr.io/acme/charts/shop", chartVersion: "0.0.0-studio.1",
      images: [{ app: "api", image: "ghcr.io/acme/gbx-api:studio-1" }],
    };

    it("show what is next, what each build published, and deploy a published build by its id", async () => {
      const onDeployBuild = jest.fn();
      await draw({
        environments: [prod],
        target: { kind: "environment", id: "e-prod" },
        onDeployBuild,
        flow: {
          next: { text: "0.0.0-studio.1 is published. Next: Deploy this build.", tone: "todo" },
          builds: [build, { ...build, buildId: "b-0", status: "failed", failure: "protoc missing\nmore", failureStep: "build", chartRef: undefined, chartVersion: undefined, images: [] }],
          deployments: [{ id: "d1", environmentId: "e-prod", environmentName: "prod", namespace: "shop-prod", profile: "prod", product: "shop",
            action: "install", build: "b-old", chartVersion: "0.0.0-old", state: "failed", reason: "ImagePullBackOff", requestedAt: "2026-10-27T10:00:00Z", requestedBy: "Ann" }],
        },
      });
      expect(host.querySelector("[data-deploy-next]")?.textContent).toMatch(/Next: Deploy this build/);
      expect(host.querySelector("[data-deploy-build-id=studio-1] [data-deploy-build-published]")?.textContent).toMatch(
        /ghcr\.io\/acme\/gbx-api:studio-1; chart oci:\/\/ghcr\.io\/acme\/charts\/shop:0\.0\.0-studio\.1/,
      );
      expect(host.querySelector("[data-deploy-build-id=b-0] [data-deploy-stage=images]")?.getAttribute("data-deploy-stage-state")).toBe("failed");
      expect(host.querySelector("[data-deploy-build-id=b-0] [data-deploy-build-failure]")?.textContent).toBe("protoc missing");
      // Only a build that published a chart can be deployed by its id.
      expect(q("[data-deploy-this-build=b-0]")).toBeNull();
      await act(() => q("[data-deploy-this-build=studio-1]")?.click());
      expect(onDeployBuild).toHaveBeenCalledWith("studio-1");
      expect(host.querySelector("[data-deploy-history=d1]")?.textContent).toMatch(/Failed · prod \(shop-prod\) · 0\.0\.0-old · build b-old · Ann -- ImagePullBackOff/);
    });

    it("offer to bind an unbound profile, and say when Studio could not be asked", async () => {
      const onBind = jest.fn();
      await draw({
        environments: [prod],
        target: { kind: "environment", id: "e-prod" },
        onBind,
        flow: { next: { text: "Bind this profile", tone: "todo" }, builds: [], deployments: [], unbound: "prod" },
      });
      expect(q("[data-deploy-bind-apply]")?.disabled).toBe(true);
      await act(() => {
        const select = host.querySelector<HTMLSelectElement>('[aria-label="Environment for the prod profile"]');
        if (select) {
          select.value = "e-prod";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      await act(() => q("[data-deploy-bind-apply]")?.click());
      expect(onBind).toHaveBeenCalledWith("e-prod");
      await draw({ environments: [prod], flow: { next: { text: "x", tone: "todo" }, builds: [], deployments: [], error: "HTTP 503" } });
      expect(host.querySelector("[data-deploy-flow-error]")?.textContent).toMatch(/HTTP 503/);
      expect(host.querySelector("[data-deploy-next]")).toBeNull();
    });

    const succeeded = {
      id: "d2", environmentId: "e-prod", environmentName: "prod", namespace: "shop-prod", profile: "prod", product: "shop",
      action: "install", build: "studio-1", chartVersion: "0.0.0-studio.1", state: "succeeded", reason: undefined,
      requestedAt: "2026-10-28T10:00:00Z", requestedBy: "Ann",
    };

    it("read a succeeded deploy's live status: pods ready of desired, and the hosts it answers on", async () => {
      const onStatus = jest.fn();
      const onOpen = jest.fn();
      await draw({
        environments: [prod],
        target: { kind: "environment", id: "e-prod" },
        onStatus,
        onOpen,
        flow: { next: { text: "Runs in prod", tone: "done" }, builds: [], deployments: [succeeded] },
        statuses: { d2: { kind: "status", status: { workloads: [{ name: "shop-api", ready: 1, desired: 2, images: [] }], hosts: ["shop.example.com"] } } },
      });
      await act(() => q("[data-deploy-status=d2]")?.click());
      expect(onStatus).toHaveBeenCalledWith("d2");
      expect(host.querySelector("[data-deploy-workload=shop-api]")?.textContent).toMatch(/shop-api · 1\/2 ready/);
      expect(host.querySelector("[data-deploy-workload=shop-api]")?.getAttribute("data-deploy-workload-ready")).toBe("false");
      await act(() => q("[data-deploy-host='shop.example.com']")?.click());
      expect(onOpen).toHaveBeenCalledWith("https://shop.example.com");
    });

    it("say why a failed deploy's release does not start, and offer its status", async () => {
      const onStatus = jest.fn();
      const failed = { ...succeeded, state: "failed", outcome: "the release could not start" };
      await draw({
        environments: [prod],
        target: { kind: "environment", id: "e-prod" },
        onStatus,
        flow: { next: { text: "x", tone: "todo" }, builds: [], deployments: [failed] },
        statuses: {
          d2: {
            kind: "status",
            status: {
              workloads: [{ name: "shop-api", ready: 0, desired: 1, images: [] }],
              hosts: [],
              problems: ['pod shop-api-7c9 container api: CreateContainerConfigError: secret "shop-db" not found'],
            },
          },
        },
      });
      expect(q("[data-deploy-status=d2]")).not.toBeNull();
      const problems = host.querySelectorAll("[data-deploy-problem]");
      expect(problems).toHaveLength(1);
      expect(problems[0]?.textContent).toMatch(/CreateContainerConfigError: secret "shop-db" not found/);
    });

    it("read a deploy's container logs, headed by pod and container, the crashed run's open", async () => {
      const onLogs = jest.fn();
      const failed = { ...succeeded, state: "failed" };
      await draw({
        environments: [prod],
        target: { kind: "environment", id: "e-prod" },
        onLogs,
        flow: { next: { text: "x", tone: "todo" }, builds: [], deployments: [failed] },
        logs: {
          d2: {
            kind: "logs",
            logs: [
              { pod: "shop-api-7c9", container: "api", previous: false, text: "" },
              { pod: "shop-api-7c9", container: "api", previous: true, text: "Error: GEARS_PG_PASSWORD is not set\n" },
            ],
          },
        },
      });
      await act(() => q("[data-deploy-logs=d2]")?.click());
      expect(onLogs).toHaveBeenCalledWith("d2");
      expect(q("[data-deploy-logs=d2]")?.textContent).toBe("Hide logs");
      const blocks = host.querySelectorAll("[data-deploy-log]");
      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.textContent).toMatch(/shop-api-7c9 · api\(empty\)/);
      expect(blocks[0]?.hasAttribute("open")).toBe(false);
      expect(blocks[1]?.textContent).toMatch(/the run before its last restart/);
      expect(blocks[1]?.textContent).toMatch(/GEARS_PG_PASSWORD is not set/);
      expect(blocks[1]?.hasAttribute("open")).toBe(true);
    });

    it("say when the logs could not be read, and offer none for an uninstall", async () => {
      const onLogs = jest.fn();
      await draw({
        environments: [prod],
        target: { kind: "environment", id: "e-prod" },
        onLogs,
        flow: { next: { text: "x", tone: "todo" }, builds: [], deployments: [{ ...succeeded, id: "d3", action: "uninstall" }, succeeded] },
        logs: { d2: { kind: "error", error: "ENVIRONMENT_CLUSTER_UNREACHABLE" } },
      });
      expect(q("[data-deploy-logs=d3]")).toBeNull();
      expect(host.querySelector("[data-deploy-logs-error]")?.textContent).toMatch(/could not be read: ENVIRONMENT_CLUSTER_UNREACHABLE/);
    });

    it("propose the CI workflow, and set and remove a secret of the chosen environment without showing values", async () => {
      const onProposeWorkflow = jest.fn();
      const onSecret = jest.fn();
      await draw({
        environments: [prod],
        target: { kind: "environment", id: "e-prod" },
        onProposeWorkflow,
        onSecret,
        secrets: ["STRIPE_KEY"],
        workflow: { path: ".github/workflows/studio-build-shop.yml", branch: "studio/build-shop", prUrl: "https://github.com/a/b/pull/7" },
        flow: { next: { text: "x", tone: "todo" }, builds: [], deployments: [] },
      });
      await act(() => q("[data-deploy-propose-workflow]")?.click());
      expect(onProposeWorkflow).toHaveBeenCalled();
      expect(host.querySelector("[data-deploy-workflow-proposed]")?.textContent).toMatch(/studio-build-shop\.yml on studio\/build-shop/);
      await act(() => q('[aria-label="Remove the secret STRIPE_KEY"]')?.click());
      expect(onSecret).toHaveBeenCalledWith("STRIPE_KEY", undefined);
      const type = (label: string, value: string): void => {
        const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
        if (!input) return;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      // A name an environment variable cannot have is not offered.
      await act(() => type("Secret name", "1BAD"));
      await act(() => type("Secret value", "s3cret"));
      expect(q("[data-deploy-secret-set]")?.disabled).toBe(true);
      await act(() => type("Secret name", "DB_PASSWORD"));
      await act(() => q("[data-deploy-secret-set]")?.click());
      expect(onSecret).toHaveBeenCalledWith("DB_PASSWORD", "s3cret");
      expect(host.textContent).not.toMatch(/s3cret/);
    });

    it("is not drawn where the IDE cannot ask Studio", async () => {
      await draw({});
      expect(host.querySelector("[data-deploy-flow]")).toBeNull();
    });
  });
});

describe("the Deploy panel's history", () => {
  const deploy = (id: string, state = "failed") => ({
    id,
    environmentId: "e",
    environmentName: "dev",
    namespace: "studio-web-dev",
    profile: "prod",
    product: "studio-web",
    action: "install",
    build: "b-1",
    chartVersion: "0.0.0-desktop.be5c7a4",
    state,
    reason: undefined,
    requestedAt: "2026-10-30T10:00:00Z",
    requestedBy: "A",
  });

  it("is one row for the same deploy asked again with the same end", () => {
    const rows = groupDeployments([deploy("5"), deploy("4"), deploy("3"), deploy("2", "succeeded"), deploy("1")]);
    expect(rows.map((r) => [r.deployment.id, r.times])).toEqual([["5", 3], ["2", 1], ["1", 1]]);
  });

  it("says a build's failure in one line, without gearbox's help and evidence", () => {
    const failure =
      "gearbox generate failed: error [GBX0322] gear `tenant-resolver` carries consumes · help: add consume(...) · evidence: libs/x.rs\nmore";
    expect(failureLine(failure)).toBe("gearbox generate failed: error [GBX0322] gear `tenant-resolver` carries consumes");
    expect(failureLine("x".repeat(300))).toHaveLength(241);
    expect(failureLine("\n\nsecond line")).toBe("second line");
    expect(failureLine('helm upgrade failed: Release "shop" does not exist. Installing it now.\nError: context deadline exceeded')).toBe(
      "Error: context deadline exceeded",
    );
  });
});
