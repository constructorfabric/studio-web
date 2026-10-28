/**
 * @jest-environment jsdom
 */
// The Product view's status strip: what it says about the resolution and the
// draft, and that Apply and Discard reach the one draft there is -- through the
// real ProductEditService, against a fake engine.
import "reflect-metadata";

jest.mock("@theia/core/lib/browser", () => ({ ConfirmDialog: class {} }));
jest.mock("@theia/monaco/lib/browser/monaco-text-model-service", () => ({ MonacoTextModelService: class {} }));
jest.mock("../shell/unsaved", () => ({ hasUnsavedEdits: () => false }));
jest.mock("../product-store", () => ({ ProductStore: class {} }));
jest.mock("../catalogue-store", () => ({ CatalogueStore: class {} }));
jest.mock("../shell/product-session-service", () => ({ ProductSessionService: class {} }));
jest.mock("../shell/engine-connection-service", () => ({ EngineConnectionService: class {} }));
jest.mock("../shell/studio-context-service", () => ({ StudioContextService: class {} }));

import React from "@theia/core/shared/react";
// react-dom's client ships no typings in this tree (no @types/react-dom), so the
// two calls used here are typed by hand.
interface Root {
  render(node: React.ReactNode): void;
  unmount(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRoot } = require("@theia/core/shared/react-dom/client") as { createRoot(host: Element): Root };

import type { EditGearResult } from "../../common/generated/EditGearResult";
import type { ProductEdit } from "../../common/generated/ProductEdit";
import { ProductEditService } from "../product-edit-service";
import {
  ProductStatusStrip,
  draftStateOf,
  productStatusOf,
  type ProductStatusStripProps,
} from "./product-status-strip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (fn: () => void | Promise<void>) => Promise<void> }).act;

describe("what the strip says about the resolution", () => {
  it("says it is working while the product is read or resolved", () => {
    expect(productStatusOf("loading", 3, true)).toEqual({ kind: "working" });
    expect(productStatusOf("resolving", 0, false)).toEqual({ kind: "working" });
  });

  it("counts errors before claiming resolved", () => {
    expect(productStatusOf("ready", 2, true)).toEqual({ kind: "conflicts", count: 2 });
    expect(productStatusOf("error", 1, false)).toEqual({ kind: "conflicts", count: 1 });
  });

  it("says resolved only with a lock, and nothing otherwise", () => {
    expect(productStatusOf("ready", 0, true)).toEqual({ kind: "resolved" });
    expect(productStatusOf("ready", 0, false)).toBeUndefined();
    expect(productStatusOf("idle", 0, false)).toBeUndefined();
  });
});

describe("what the strip offers for the draft", () => {
  const base = { count: 0, writeUnknown: false, engineConnected: true, busy: false };

  it("says Saved with nothing queued", () => {
    expect(draftStateOf(base)).toEqual({ kind: "saved" });
  });

  it("offers Apply for a pending draft", () => {
    expect(draftStateOf({ ...base, count: 2 })).toEqual({ kind: "pending", count: 2, applyRefusal: undefined });
  });

  it("keeps Apply but refuses it, saying why, with the engine gone or the product being read", () => {
    const down = draftStateOf({ ...base, count: 1, engineConnected: false });
    expect(down).toMatchObject({ kind: "pending", count: 1 });
    expect(down.kind === "pending" && down.applyRefusal).toMatch(/engine is not running/);
    const busy = draftStateOf({ ...base, count: 1, busy: true });
    expect(busy.kind === "pending" && busy.applyRefusal).toMatch(/being read/);
  });

  it("does not call a draft pending after a write nobody heard back from", () => {
    expect(draftStateOf({ ...base, count: 3, writeUnknown: true })).toEqual({ kind: "unverified", count: 3 });
  });
});

describe("the strip, drawn", () => {
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

  async function draw(props: Partial<ProductStatusStripProps>): Promise<void> {
    const all: ProductStatusStripProps = {
      status: undefined,
      draft: { kind: "saved" },
      actions: [],
      onApply: () => undefined,
      onDiscard: () => undefined,
      onShowConflicts: () => undefined,
      onRun: () => undefined,
      ...props,
    };
    await act(() => root.render(<ProductStatusStrip {...all} />));
  }

  const q = (selector: string): HTMLElement | null => host.querySelector<HTMLElement>(selector);

  it("shows no Apply or Discard with nothing to apply", async () => {
    await draw({});
    expect(q("[data-draft-state]")?.textContent).toBe("Saved");
    expect(q("[data-draft-apply]")).toBeNull();
    expect(q("[data-draft-discard]")).toBeNull();
  });

  it("draws the count beside Apply and Discard, and each runs its own", async () => {
    const onApply = jest.fn();
    const onDiscard = jest.fn();
    await draw({ draft: { kind: "pending", count: 2, applyRefusal: undefined }, onApply, onDiscard });
    expect(q("[data-draft-state]")?.textContent).toBe("2 pending changes");
    await act(() => q("[data-draft-apply]")?.click());
    await act(() => q("[data-draft-discard]")?.click());
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("disables Apply with the reason as its title", async () => {
    await draw({ draft: { kind: "pending", count: 1, applyRefusal: "The Gearbox engine is not running; reconnect first" } });
    const apply = q("[data-draft-apply]") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(apply.title).toMatch(/not running/);
  });

  it("offers only Discard for a draft of unknown state", async () => {
    await draw({ draft: { kind: "unverified", count: 1 } });
    expect(q("[data-draft-apply]")).toBeNull();
    expect(q("[data-draft-discard]")).not.toBeNull();
    expect(q("[data-draft-unverified]")?.textContent).toMatch(/unknown state/);
  });

  it("makes the conflict count lead to the conflicts", async () => {
    const onShowConflicts = jest.fn();
    await draw({ status: { kind: "conflicts", count: 1 }, onShowConflicts });
    expect(q("[data-status=conflicts]")?.textContent).toBe("1 conflict");
    await act(() => q("[data-status=conflicts]")?.click());
    expect(onShowConflicts).toHaveBeenCalled();
  });

  it("draws Resolve and Close from the registry's answer, disabled when it says so", async () => {
    const onRun = jest.fn();
    await draw({
      actions: [
        { id: "gearbox.product.resolve", label: "Resolve", title: "Gearbox: Resolve Product", enabled: false },
        { id: "gearbox.product.close", label: "Close", title: "Gearbox: Close Product", enabled: true },
      ],
      onRun,
    });
    expect((q("[data-command='gearbox.product.resolve']") as HTMLButtonElement).disabled).toBe(true);
    await act(() => q("[data-command='gearbox.product.close']")?.click());
    expect(onRun).toHaveBeenCalledWith("gearbox.product.close");
  });
});

/**
 * The fake engine: `applyEdits` records what it was asked and answers as the
 * engine does -- `before` is the file, `after` the file with the batch.
 */
class FakeEngine {
  calls: Array<{ edits: readonly ProductEdit[]; dryRun: boolean; expectedBefore: string | undefined }> = [];
  file = "product(gears = [])\n";

  async applyEdits(
    _path: string,
    edits: readonly ProductEdit[],
    dryRun: boolean,
    expectedBefore?: string,
  ): Promise<EditGearResult> {
    this.calls.push({ edits, dryRun, expectedBefore });
    const after = `${this.file}# ${edits.length} edit(s)\n`;
    const result = { changed: true, before: this.file, after } as unknown as EditGearResult;
    if (!dryRun) this.file = after;
    return result;
  }
}

class TestEdits extends ProductEditService {
  confirmed = 0;
  protected override async confirmEdit(): Promise<boolean> {
    this.confirmed += 1;
    return true;
  }
  protected override isDirty(): boolean {
    return false;
  }
}

function service(engine: FakeEngine): { edits: TestEdits; reloads: () => number; said: string[] } {
  const edits = new TestEdits();
  let reloads = 0;
  const said: string[] = [];
  const store = {
    revision: 1,
    current: { open: { path: "/w/products/p/product.gdl", label: "p" }, intent: { display_name: "P" } },
    reload: async () => {
      reloads += 1;
    },
  };
  const messages = {
    info: (m: string) => said.push(m),
    warn: (m: string) => said.push(m),
    error: (m: string) => said.push(m),
  };
  Object.assign(edits, { service: engine, product: store, messages, engine: { markDisconnected: () => undefined } });
  return { edits, reloads: () => reloads, said };
}

describe("Apply and Discard, through the strip, against a fake engine", () => {
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

  async function drawFor(edits: TestEdits): Promise<void> {
    const render = () =>
      root.render(
        <ProductStatusStrip
          status={undefined}
          draft={draftStateOf({ count: edits.draftEdits().length, writeUnknown: false, engineConnected: true, busy: false })}
          actions={[]}
          onApply={() => void edits.applyDraft()}
          onDiscard={() => edits.discardDraft()}
          onShowConflicts={() => undefined}
          onRun={() => undefined}
        />,
      );
    edits.onDraftChanged(() => render());
    await act(() => render());
  }

  const setConfig: ProductEdit = { kind: "set_config", gear: "api-gateway", key: "cors_enabled", value: true };

  it("writes the draft once: a dry run, the confirmation, a second dry run, the write with the approved text", async () => {
    const engine = new FakeEngine();
    const { edits, reloads } = service(engine);
    expect(edits.queueDraft(setConfig)).toBe(true);
    await drawFor(edits);
    expect(host.querySelector("[data-draft-state]")?.textContent).toBe("1 pending change");

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-draft-apply]")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(engine.calls.map((c) => c.dryRun)).toEqual([true, true, false]);
    expect(engine.calls.every((c) => c.edits.length === 1 && c.edits[0] === setConfig)).toBe(true);
    // The commit is checked against the text the person approved.
    expect(engine.calls[2]?.expectedBefore).toBe("product(gears = [])\n");
    expect(edits.confirmed).toBe(1);
    expect(reloads()).toBe(1);
    expect(edits.hasDraft()).toBe(false);
    expect(host.querySelector("[data-draft-state]")?.textContent).toBe("Saved");
  });

  it("discards without asking the engine, and remounts the controls", async () => {
    const engine = new FakeEngine();
    const { edits } = service(engine);
    edits.queueDraft(setConfig);
    const epoch = edits.epoch;
    await drawFor(edits);

    await act(() => host.querySelector<HTMLButtonElement>("[data-draft-discard]")?.click());

    expect(engine.calls).toEqual([]);
    expect(edits.hasDraft()).toBe(false);
    expect(edits.epoch).toBe(epoch + 1);
    expect(host.querySelector("[data-draft-state]")?.textContent).toBe("Saved");
  });

  it("keeps the draft when the engine refuses the dry run, and says why", async () => {
    const engine = new FakeEngine();
    engine.applyEdits = async () => {
      throw Object.assign(new Error("could not be edited"), {
        data: { diagnostics: [{ code: "GBX0113", message: "mode is a string" }] },
      });
    };
    const { edits, said } = service(engine);
    edits.queueDraft(setConfig);
    await drawFor(edits);

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-draft-apply]")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(edits.hasDraft()).toBe(true);
    expect(said.join("\n")).toMatch(/GBX0113 mode is a string/);
  });
});
