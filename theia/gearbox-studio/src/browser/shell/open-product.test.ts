/**
 * @jest-environment jsdom
 */
// Opening a product end to end -- the real CatalogueStore, ProductStore and
// ProductSessionService -- against a fake engine that behaves like the real one
// where it matters: `catalogue/load` answers at once and the projection then
// streams, and the engine answers one request at a time, so `product/load`
// sent during the projection is answered only when it ends.
//
// The regression this guards (desktop, 2026-09-29): an open that reached the
// store while the projection was still running sat on "Reading the
// description…" for as long as the projection took, with nothing moving -- read
// as a hang. The open now waits for the projection in its own `catalogue` step,
// with progress, and stops with a reason if the projection stops moving.
import "reflect-metadata";

(globalThis as { DragEvent?: unknown }).DragEvent ??= class DragEvent {};
jest.mock("@theia/monaco/lib/browser/monaco-text-model-service", () => ({ MonacoTextModelService: class MonacoTextModelService {} }));
jest.mock("@theia/workspace/lib/browser/workspace-service", () => ({ WorkspaceService: class WorkspaceService {} }));

import { Container } from "@theia/core/shared/inversify";
import { MessageService } from "@theia/core/lib/common/message-service";
import { PreferenceService } from "@theia/core/lib/common/preferences/preference-service";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { StorageService } from "@theia/core/lib/browser/storage-service";
import { URI } from "@theia/core/lib/common/uri";
import { MonacoTextModelService } from "@theia/monaco/lib/browser/monaco-text-model-service";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";

import { GearboxService, type GearboxClient } from "../../common/protocol";
import { CatalogueStore } from "../catalogue-store";
import { ProductStore } from "../product-store";
import { EngineConnectionService } from "./engine-connection-service";
import { GearSessionService } from "./gear-session-service";
import { ProductSessionService, type OpeningState } from "./product-session-service";
import { SelectionService } from "./selection-service";

const PRODUCT = "/w/products/shop/product.gdl";
const GEARS = ["api-gateway", "bss-pricing", "resource-group", "gear-orchestrator"];

/**
 * The engine, faked at the RPC surface. `stallAfter` stops the projection after
 * that many gears; `step` is the time per projected gear.
 */
class FakeEngine {
  client: GearboxClient | undefined;
  projecting: Promise<void> = Promise.resolve();
  calls: string[] = [];
  constructor(readonly step: number, readonly stallAfter = Infinity) {}

  useOpenedWorkspace = async (): Promise<void> => undefined;
  useConfiguredRoots = async (): Promise<void> => undefined;
  listProducts = async () => [{ path: PRODUCT, label: "products/shop/product.gdl" }];
  initialize = async (session?: { roots: string[] }) => {
    this.calls.push(`initialize ${session?.roots.join(",") ?? "boot"}`);
    this.projecting = Promise.resolve();
    return {
      server_info: { name: "gearbox", version: "0.1.0" },
      capabilities: { generate: true },
      roots: [{ id: "gears-rust", path: "/w/gears-rust" }],
      failed_roots: [],
    };
  };
  loadCatalogue = async () => {
    this.calls.push("loadCatalogue");
    const client = this.client as GearboxClient;
    // Answered at the S1/S2 boundary; the projection streams afterwards, and
    // every later request queues behind it.
    this.projecting = (async () => {
      for (let i = 0; i < GEARS.length; i++) {
        if (i >= this.stallAfter) return new Promise<void>(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, this.step));
        const id = GEARS[i] as string;
        client.onCatalogueChanged({ gear: { id, display_name: id, source: "gears-rust", gdl_path: `gears/${id}/gear.gdl` } as never, replaces: `gears/${id}/gear.gdl` });
        client.onProgress({ token: "catalogue", completed: i + 1, total: GEARS.length, done: i + 1 === GEARS.length });
      }
    })();
    return {
      total: GEARS.length,
      pending: GEARS.map((id) => ({ source: "gears-rust", gdl_path: `gears/${id}/gear.gdl`, stage: "discovered", display_name: id })),
      diagnostics: [],
    };
  };
  loadProduct = async () => {
    this.calls.push("loadProduct");
    await this.projecting;
    return {
      intent: {
        id: "shop",
        display_name: "Shop",
        sources: { "gears-rust": { kind: "path", at: "/w/gears-rust" } },
        profiles: { dev: { profile: "embedded" } },
        default_profile: "dev",
        selected_gears: GEARS.map((gear) => ({ gear, source: "gears-rust" })),
      },
      source: "",
      diagnostics: [],
    };
  };
  resolve = async () => {
    this.calls.push("resolve");
    await this.projecting;
    return { product: { applications: [], gears: {} }, diagnostics: [] };
  };
}

function harness(engine: FakeEngine) {
  const root = URI.fromFilePath("/w");
  const workspace = { ready: Promise.resolve(), workspace: { resource: root }, tryGetRoots: () => [{ resource: root }] };
  const said: string[] = [];
  const container = new Container();
  container.bind(GearboxService).toConstantValue(engine as never);
  container.bind(WorkspaceService).toConstantValue(workspace as never);
  const say = (m: string): void => void said.push(m);
  container.bind(MessageService).toConstantValue({ info: say, warn: say, error: say } as never);
  container.bind(MonacoTextModelService).toConstantValue({ models: [] } as never);
  // Every declared root is on this machine here, so no configured checkout stands in.
  container.bind(FileService).toConstantValue({ exists: async () => true } as never);
  // The settings read: whether plugins are grouped, and the configured checkouts; their defaults.
  container.bind(PreferenceService).toConstantValue({
    ready: Promise.resolve(), get: (_: string, fallback: unknown) => fallback, onPreferenceChanged: () => ({ dispose() {} }),
  } as never);
  const storage = new Map<string, unknown>();
  container.bind(StorageService).toConstantValue({
    getData: async (key: string) => storage.get(key),
    setData: async (key: string, value: unknown) => void storage.set(key, value),
  } as never);
  for (const cls of [SelectionService, EngineConnectionService, CatalogueStore, ProductStore, GearSessionService, ProductSessionService]) {
    container.bind(cls as never).toSelf().inSingletonScope();
  }
  const catalogue = container.get(CatalogueStore);
  engine.client = catalogue as unknown as GearboxClient;
  const products = container.get(ProductStore);
  const session = container.get(ProductSessionService);
  const openings: OpeningState[] = [];
  session.onDidChangeOpening((state) => openings.push(state));
  // What the Product view would draw for the store: the moment it first shows
  // the product "loading", and whether the gears were projected by then.
  let catalogueAtLoading: string | undefined;
  products.onChanged(() => {
    if (catalogueAtLoading === undefined && products.current.open !== undefined && products.current.status === "loading") {
      catalogueAtLoading = catalogue.current.status;
    }
  });
  return { catalogue, products, session, openings, said, catalogueAtLoading: () => catalogueAtLoading };
}

describe("opening a product, end to end", () => {
  it("reaches `ready`, waiting for the projection in its own step, with progress", async () => {
    const engine = new FakeEngine(30);
    const h = harness(engine);
    void h.catalogue.load();
    const opened = await h.session.open({ path: PRODUCT, label: "shop" });

    expect(opened).toBe(true);
    expect(h.products.current.status).toBe("ready");
    expect(h.products.current.open?.path).toBe(PRODUCT);
    // The store was handed the product only once the gears were in, so its
    // requests were answered at once rather than behind the projection.
    expect(h.catalogueAtLoading()).toBe("ready");
    const progress = h.openings.flatMap((s) => (s.status === "opening" && s.stage === "catalogue" && s.progress ? [s.progress.completed] : []));
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(Math.max(...progress)).toBeGreaterThanOrEqual(GEARS.length - 1);
    expect(progress.length).toBeGreaterThan(1);
    expect(h.openings[h.openings.length - 1]).toEqual({ status: "idle" });
  }, 20000);

  it("stops with a reason, and puts the session back, when the projection stops moving", async () => {
    const engine = new FakeEngine(10, 2);
    const h = harness(engine);
    (h.session as unknown as { projectionStallMs: number }).projectionStallMs = 1500;
    const opened = await h.session.open({ path: PRODUCT, label: "shop" });

    expect(opened).toBe(false);
    const failed = h.openings.find((s) => s.status === "failed");
    expect(failed).toMatchObject({ status: "failed", stage: "catalogue" });
    expect(failed?.status === "failed" && failed.reason).toMatch(/shop's gears stopped loading: 2 of 4 read/);
    expect(h.said.join("\n")).toMatch(/stopped loading/);
    // Nothing was handed to the store, so the Product view is not left "loading".
    expect(h.products.current.open).toBeUndefined();
    // The session the open replaced (the boot one) was asked for again.
    expect(engine.calls.filter((c) => c === "initialize boot").length).toBeGreaterThanOrEqual(1);
  }, 20000);
});
