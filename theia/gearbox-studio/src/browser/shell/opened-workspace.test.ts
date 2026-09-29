/**
 * @jest-environment jsdom
 */
import "reflect-metadata";

(globalThis as { DragEvent?: unknown }).DragEvent ??= class DragEvent {};
if (typeof document !== "undefined") {
  (document as unknown as { queryCommandSupported: () => boolean }).queryCommandSupported = () => false;
}

// The real one reads the frontend application's configuration at load time;
// the store only needs the token to inject by.
jest.mock("@theia/workspace/lib/browser/workspace-service", () => ({ WorkspaceService: class WorkspaceService {} }));

import { ProductStore } from "../product-store";
import { announceOpenedWorkspace } from "./opened-workspace";

/** The folder as Theia names it on Windows: drive letter lower-case, colon escaped. */
const WINDOWS_FOLDER = "file:///c%3A/gbxv/studio-web";

function workspace(uri = WINDOWS_FOLDER) {
  return { ready: Promise.resolve(), workspace: { resource: { toString: () => uri } } };
}

describe("the opened folder, told to the backend", () => {
  it("passes Theia's own URI through, for the backend to turn into C:\\gbxv\\studio-web", async () => {
    const useOpenedWorkspace = jest.fn(async () => undefined);
    await announceOpenedWorkspace({ useOpenedWorkspace }, workspace());
    expect(useOpenedWorkspace).toHaveBeenCalledWith(WINDOWS_FOLDER);
  });

  it("waits for the workspace to be ready, and survives a backend that refuses", async () => {
    let ready!: () => void;
    const later = { ready: new Promise<void>((r) => (ready = r)), workspace: workspace().workspace };
    const useOpenedWorkspace = jest.fn(async () => {
      throw new Error("an older backend");
    });
    const said = announceOpenedWorkspace({ useOpenedWorkspace }, later);
    await Promise.resolve();
    expect(useOpenedWorkspace).not.toHaveBeenCalled();
    ready();
    await expect(said).resolves.toBeUndefined();
    expect(useOpenedWorkspace).toHaveBeenCalledTimes(1);
  });

  it("is said before products are listed, so the Start screen's early discovery lists the opened repository", async () => {
    const calls: string[] = [];
    const product = { path: "C:\\gbxv\\studio-web\\products\\shop\\product.gdl", label: "products\\shop\\product.gdl" };
    const service = {
      useOpenedWorkspace: jest.fn(async (uri: string | undefined) => {
        calls.push(`opened ${uri}`);
      }),
      listProducts: jest.fn(async () => {
        calls.push("list");
        return [product];
      }),
    };
    const store = new ProductStore();
    Object.assign(store, {
      service,
      workspaceService: workspace(),
      selection: { select: () => undefined },
      engine: { onDidChange: () => ({ dispose: () => undefined }) },
    });

    await store.discover();

    expect(calls).toEqual([`opened ${WINDOWS_FOLDER}`, "list"]);
    expect(store.current.products).toEqual([product]);
  });
});
