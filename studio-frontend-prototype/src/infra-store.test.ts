import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type InfraService } from "./api";
import { infraStore, projectListStore } from "./infra-store";

const item = { passport: { name: "keycloak", provides: {} } } as unknown as InfraService;

afterEach(() => vi.restoreAllMocks());

describe("the infra services' store", () => {
  it("reads and writes the project's list, whole and without revisions", async () => {
    const read = vi.spyOn(api, "infraServices").mockResolvedValue({ items: [item], total: 1 });
    const write = vi.spyOn(api, "putInfraServices").mockResolvedValue({ items: [item], total: 1 });
    const store = projectListStore("t", "p");
    expect(await store.load()).toEqual({ items: [item], source: "project-list", revision: null });
    expect(await store.save([item], 7)).toEqual({ items: [item], source: "project-list", revision: null });
    expect(read).toHaveBeenCalledWith("t", "p");
    expect(write).toHaveBeenCalledWith("t", "p", [item]);
  });

  it("is the project's list for now", () => {
    expect(infraStore("t", "p").source).toBe("project-list");
  });
});
