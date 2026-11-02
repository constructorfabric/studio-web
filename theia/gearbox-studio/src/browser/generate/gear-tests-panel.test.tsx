/**
 * @jest-environment jsdom
 */
// The product's tests under Build and Run: what is offered, and how each gear went.
import "reflect-metadata";

import React from "@theia/core/shared/react";

import type { GearTestTarget } from "../../common/gear-tests";
import { GearTestsPanel, type GearTestsPanelProps } from "./gear-tests-panel";

interface Root {
  render(node: React.ReactNode): void;
  unmount(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRoot } = require("@theia/core/shared/react-dom/client") as { createRoot(host: Element): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (fn: () => void | Promise<void>) => Promise<void> }).act;

const pricing: GearTestTarget = { gear: "bss-pricing", crate: "bss-pricing", manifest: "/corpus/bss-pricing/Cargo.toml" };
const registry: GearTestTarget = { gear: "types-registry", crate: "cf-types-registry" };

describe("the Tests panel", () => {
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

  async function draw(over: Partial<GearTestsPanelProps>): Promise<void> {
    const props: GearTestsPanelProps = {
      targets: [pricing, registry],
      states: {},
      runningAll: false,
      onRun: () => undefined,
      onRunAll: () => undefined,
      ...over,
    };
    await act(() => root.render(<GearTestsPanel {...props} />));
  }

  const q = (selector: string): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(selector);
  const row = (gear: string): HTMLElement | null => host.querySelector<HTMLElement>(`[data-test-gear="${gear}"]`);

  it("says when there is nothing to test", async () => {
    await draw({ targets: [] });
    expect(host.querySelector("[data-tests-state=no-gears]")).not.toBeNull();
    expect(q("[data-tests-run-all]")).toBeNull();
  });

  it("lists every gear, not yet run, and runs one or all", async () => {
    const onRun = jest.fn();
    const onRunAll = jest.fn();
    await draw({ onRun, onRunAll });
    expect(row("bss-pricing")?.dataset.testStatus).toBe("not-run");
    expect(row("types-registry")?.dataset.testStatus).toBe("not-run");
    expect(host.querySelector("[data-tests-tally]")).toBeNull();
    await act(() => row("types-registry")?.querySelector<HTMLButtonElement>("[data-test-run]")?.click());
    expect(onRun).toHaveBeenCalledWith("types-registry");
    await act(() => q("[data-tests-run-all]")?.click());
    expect(onRunAll).toHaveBeenCalled();
  });

  it("shows how each gear went, with the counts and the failing tests", async () => {
    await draw({
      states: {
        "bss-pricing": { status: "passed", passed: 12, failed: 0, ignored: 1 },
        "types-registry": { status: "failed", passed: 3, failed: 2, ignored: 0, failing: ["store::put", "store::get"] },
      },
    });
    expect(row("bss-pricing")?.dataset.testStatus).toBe("passed");
    expect(row("bss-pricing")?.querySelector("[data-test-state]")?.textContent).toBe("12 passed, 1 ignored");
    expect(row("types-registry")?.dataset.testStatus).toBe("failed");
    expect(row("types-registry")?.querySelector("[data-test-state]")?.textContent).toBe("3 passed, 2 failed");
    expect([...(row("types-registry")?.querySelectorAll("[data-test-failing] li") ?? [])].map((li) => li.textContent)).toEqual(["store::put", "store::get"]);
    expect(host.querySelector("[data-tests-tally]")?.textContent).toBe("1 passed, 1 failed");
  });

  it("says why a gear failed when no test did", async () => {
    await draw({ states: { "bss-pricing": { status: "failed", why: "error[E0425]: cannot find value" } } });
    expect(row("bss-pricing")?.querySelector("[data-test-state]")?.textContent).toBe("error[E0425]: cannot find value");
    expect(row("bss-pricing")?.querySelector("[data-test-failing]")).toBeNull();
  });

  it("offers nothing more to run while tests run", async () => {
    await draw({ states: { "bss-pricing": { status: "running" } } });
    expect(row("bss-pricing")?.querySelector("[data-test-state]")?.textContent).toBe("running…");
    expect(row("bss-pricing")?.querySelector(".codicon-modifier-spin")).not.toBeNull();
    expect(q("[data-tests-run-all]")?.disabled).toBe(true);
    expect(row("types-registry")?.querySelector<HTMLButtonElement>("[data-test-run]")?.disabled).toBe(true);

    await draw({ runningAll: true });
    expect(q("[data-tests-run-all]")?.textContent).toBe("Running all…");
    expect(q("[data-test-run]")?.disabled).toBe(true);
  });
});
