import { describe, expect, it } from "vitest";

import { componentOf, componentTitle, groupByComponent, onlyComponent } from "./api-docs";
import type { OpenApiDoc } from "./api-docs";

describe("componentOf", () => {
  it("is the first path segment", () => {
    expect(componentOf("/studio-git/v1/workspaces/{workspace_id}/sources/{source}/info/refs")).toBe("studio-git");
    expect(componentOf("/account-management/v1/tenants")).toBe("account-management");
  });
  it("looks under a shared mount", () => {
    expect(componentOf("/api/file-storage/v1/files")).toBe("file-storage");
  });
});

describe("componentTitle", () => {
  it("drops the studio prefix and spells acronyms", () => {
    expect(componentTitle("studio-artifact-ingest")).toBe("Artifact Ingest");
    expect(componentTitle("authz-resolver")).toBe("AuthZ Resolver");
  });
});

describe("groupByComponent", () => {
  const doc: OpenApiDoc = {
    openapi: "3.1.0",
    paths: {
      "/account-management/v1/tenants": { get: { tags: ["Tenants"] }, post: { tags: ["Tenants"] } },
      "/account-management/v1/users": { get: { tags: ["Identity"] } },
      "/authz-resolver/v1/evaluate": { post: {} },
      "/studio-git/v1/sources": { get: { tags: ["StudioGit"] }, parameters: [] },
      "/studio-spec-quality/v1/capabilities": { get: { tags: ["SpecQuality"] } },
      "/studio-spec-quality/v1/status": { get: { tags: ["SpecQuality"] } },
      "/studio-spec-quality/v1/verdicts": { get: { tags: ["SpecQuality"] } },
    },
  };
  const out = groupByComponent(doc);

  it("groups tags by the component that serves them, platform first", () => {
    expect(out["x-tagGroups"]).toEqual([
      { name: "Platform · Account Management", tags: ["Identity", "Tenants"] },
      { name: "Platform · AuthZ Resolver", tags: ["AuthZ Resolver"] },
      { name: "Studio · Git", tags: ["StudioGit"] },
      { name: "Studio · Spec Quality", tags: ["SpecQuality"] },
    ]);
  });

  it("tags an untagged operation with its component", () => {
    const op = out.paths!["/authz-resolver/v1/evaluate"].post as { tags: string[] };
    expect(op.tags).toEqual(["AuthZ Resolver"]);
  });

  it("gives a Studio CamelCase tag a readable name and keeps the tag", () => {
    expect(out.tags!.find((t) => t.name === "StudioGit")).toEqual({ name: "StudioGit", "x-displayName": "Git" });
    expect(out.tags!.find((t) => t.name === "Tenants")).toEqual({ name: "Tenants" });
  });

  it("declares every tag once, in group order, and leaves the input alone", () => {
    expect(out.tags!.map((t) => t.name)).toEqual(["Identity", "Tenants", "AuthZ Resolver", "StudioGit", "SpecQuality"]);
    expect((doc.paths!["/authz-resolver/v1/evaluate"].post as { tags?: string[] }).tags).toBeUndefined();
    expect(out.paths!["/studio-git/v1/sources"].parameters).toEqual([]);
  });
});

describe("onlyComponent", () => {
  const doc: OpenApiDoc = {
    paths: {
      "/studio-tasks/v1/runs": { get: { tags: ["StudioTasks"] } },
      "/studio-git/v1/sources": { get: { tags: ["StudioGit"] } },
      "/api/file-storage/v1/files": { get: { tags: ["Files"] } },
    },
  };
  it("keeps the paths of one component only", () => {
    expect(Object.keys(onlyComponent(doc, "studio-tasks").paths ?? {})).toEqual(["/studio-tasks/v1/runs"]);
    expect(Object.keys(onlyComponent(doc, "file-storage").paths ?? {})).toEqual(["/api/file-storage/v1/files"]);
  });
  it("answers an empty document for a component that serves nothing", () => {
    expect(onlyComponent(doc, "nobody").paths).toEqual({});
  });
});
