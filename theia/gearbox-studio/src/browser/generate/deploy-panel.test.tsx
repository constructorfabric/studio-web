/**
 * @jest-environment jsdom
 */
// Deploy under Generate, for a kubernetes profile: what is offered in each state.
import "reflect-metadata";

import React from "@theia/core/shared/react";

import { DeployPanel, type DeployPanelProps } from "./deploy-panel";

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

    it("is not drawn where the IDE cannot ask Studio", async () => {
      await draw({});
      expect(host.querySelector("[data-deploy-flow]")).toBeNull();
    });
  });
});
