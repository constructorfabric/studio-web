import { describe, expect, it } from "vitest";

import type { DeployEnvironment, ProjectImage } from "./api";
import {
  defaultMirrorName,
  groupImages,
  imageActions,
  imageRefusalText,
  importSourceProblem,
  mirrorNameProblem,
  mirrorPath,
  recordFor,
  retentionProblem,
  retentionSummary,
  shortDigest,
  sizeText,
  whereItRuns,
} from "./images";

const DIGEST = `sha256:${"ab".repeat(32)}`;

const image = (over: Partial<ProjectImage> = {}): ProjectImage => ({
  id: "i1",
  project_id: "p1",
  registry_connection_id: "r-dev",
  registry_host: "ghcr.io",
  repository: "acme/web/api",
  reference: `ghcr.io/acme/web/api@${DIGEST}`,
  tags: ["0.1.0"],
  digest: DIGEST,
  platforms: ["linux/amd64"],
  build_id: "b1",
  app: "api",
  pushed_at: "2026-11-01T10:00:00Z",
  kind: "image",
  state: "present",
  pinned: false,
  running_in: [],
  ...over,
});

const env = (over: Partial<DeployEnvironment> = {}): DeployEnvironment => ({
  id: "dev",
  name: "dev",
  description: "",
  connection_id: "c1",
  registry: "ghcr.io/acme",
  registry_connection_id: "r-dev",
  namespace_pattern: "{project}-{environment}",
  database: "none",
  protected: false,
  updated_by: "",
  updated_at: "",
  ...over,
});

const running = (environment_name: string, namespace = `web-${environment_name}`) => ({
  environment_id: environment_name,
  environment_name,
  deployment_id: `d-${namespace}`,
  namespace,
  deployed_at: "2026-11-02T10:00:00Z",
});

describe("grouping", () => {
  it("groups by app, images before charts, newest first in each", () => {
    const groups = groupImages([
      image({ id: "old", pushed_at: "2026-10-01T00:00:00Z" }),
      image({ id: "chart", kind: "chart", app: null, repository: "acme/web/charts/web" }),
      image({ id: "new", pushed_at: "2026-11-03T00:00:00Z" }),
      image({ id: "pg", app: null, repository: "acme/web/mirror/postgres" }),
    ]);
    expect(groups.map((g) => [g.kind, g.name, g.images.map((i) => i.id)])).toEqual([
      ["image", "api", ["new", "old"]],
      ["image", "postgres", ["pg"]],
      ["chart", "web", ["chart"]],
    ]);
  });
});

describe("where it runs", () => {
  it("names each environment once, with the namespace only when one has it twice", () => {
    expect(whereItRuns([])).toBe("Runs nowhere.");
    expect(whereItRuns([running("dev")])).toBe("Runs in dev.");
    expect(whereItRuns([running("dev"), running("stage"), running("prod")])).toBe("Runs in dev, stage and prod.");
    expect(whereItRuns([running("dev"), running("dev", "web-preview-1")])).toBe(
      "Runs in dev (web-dev) and dev (web-preview-1).",
    );
  });
});

describe("what may be done with an image", () => {
  const envs = [
    env(),
    env({ id: "prod", name: "prod", registry: "harbor.example.com/acme", registry_connection_id: "r-prod" }),
    env({ id: "ml", name: "ml", kind: "research", registry: "" }),
  ];

  it("deletes one that runs nowhere and is not pinned", () => {
    expect(imageActions(image(), envs).delete).toEqual({ allowed: true, reason: null });
  });

  it("refuses to delete one that runs, saying where, or one that is pinned", () => {
    expect(imageActions(image({ running_in: [running("dev")] }), envs).delete).toEqual({
      allowed: false,
      reason: "Runs in dev. Deploy something else there first.",
    });
    expect(imageActions(image({ pinned: true }), envs).delete.reason).toBe("It is pinned: unpin it first.");
    expect(imageActions(image({ pinned: true }), envs).pin).toBe("unpin");
  });

  it("promotes only to environments that pull from another registry", () => {
    const a = imageActions(image(), envs);
    expect(a.promoteTargets.map((e) => e.id)).toEqual(["prod"]);
    expect(a.promote.allowed).toBe(true);
    // Without a connection on the image, the host decides.
    const byHost = imageActions(image({ registry_connection_id: null, registry_host: "harbor.example.com" }), envs);
    expect(byHost.promoteTargets.map((e) => e.id)).toEqual(["dev"]);
    expect(imageActions(image(), [env()]).promote).toEqual({ allowed: false, reason: "No environment pulls from another registry." });
  });

  it("does nothing with an image the registry no longer has", () => {
    const a = imageActions(image({ state: "deleted" }), envs);
    expect([a.delete.allowed, a.promote.allowed, a.pin]).toEqual([false, false, null]);
  });
});

describe("retention", () => {
  it("says what is kept and whose setting it is", () => {
    expect(retentionSummary(null)).toBe("Every image is kept.");
    expect(retentionSummary({ scope: "project", inherited: false })).toBe("Every image is kept.");
    expect(retentionSummary({ scope: "project", keep_last: 10, keep_days: 30, inherited: false })).toBe(
      "Keeps the newest 10 of each app and anything pushed in the last 30 days. What runs somewhere and what is pinned is always kept.",
    );
    expect(retentionSummary({ scope: "organization", keep_days: 1, inherited: true })).toBe(
      "Keeps what was pushed in the last 1 day. What runs somewhere and what is pinned is always kept. This is the organization's setting.",
    );
  });

  it("takes an empty field as no limit and refuses a nonsense one", () => {
    expect(retentionProblem("", "")).toBeNull();
    expect(retentionProblem("10", "30")).toBeNull();
    expect(retentionProblem("0", "")).toMatch(/1 to 1000/);
    expect(retentionProblem("", "1.5")).toMatch(/3650/);
  });
});

describe("importing an external image", () => {
  it("takes a reference with its registry and a tag or a digest", () => {
    expect(importSourceProblem("docker.io/library/postgres:16")).toBeNull();
    expect(importSourceProblem(`quay.io/x/y@${DIGEST}`)).toBeNull();
    expect(importSourceProblem("ghcr.io/o/n:tag")).toBeNull();
    expect(importSourceProblem("localhost:5000/o/n:1")).toBeNull();
  });

  it("says what is wrong with anything else", () => {
    expect(importSourceProblem("")).toMatch(/Name the image/);
    expect(importSourceProblem("https://docker.io/library/postgres:16")).toMatch(/without a scheme/);
    expect(importSourceProblem("postgres:16")).toMatch(/registry too/);
    expect(importSourceProblem("library/postgres:16")).toMatch(/registry too/);
    expect(importSourceProblem("docker.io/library/postgres")).toMatch(/tag or a digest/);
    expect(importSourceProblem("docker.io/Library/postgres:16")).toMatch(/lowercase/);
    expect(importSourceProblem("quay.io/x/y@sha256:abc")).toMatch(/64/);
  });

  it("mirrors under the last segment of the path, without tag or digest", () => {
    expect(defaultMirrorName("docker.io/library/postgres:16")).toBe("postgres");
    expect(defaultMirrorName(`quay.io/x/y@${DIGEST}`)).toBe("y");
    expect(defaultMirrorName("localhost:5000/o/n:1")).toBe("n");
    expect(mirrorNameProblem("postgres")).toBeNull();
    expect(mirrorNameProblem("Postgres")).toMatch(/Lowercase/);
    expect(mirrorPath("ghcr.io/acme/", "web", "postgres")).toBe("ghcr.io/acme/web/mirror/postgres");
  });
});

describe("a build's images and their records", () => {
  const records = [image(), image({ id: "i2", app: "web", reference: "ghcr.io/acme/web/web:0.1.0", digest: "sha256:ff" })];
  it("matches by reference, then digest, then the build's app", () => {
    expect(recordFor({ app: "x", image: "ghcr.io/acme/web/web:0.1.0" }, records)?.id).toBe("i2");
    expect(recordFor({ app: "x", image: `other.example.com/api@${DIGEST}` }, records)?.id).toBe("i1");
    expect(recordFor({ app: "api", image: "ghcr.io/acme/web/api:0.1.0" }, records, "b1")?.id).toBe("i1");
    expect(recordFor({ app: "api", image: "ghcr.io/acme/web/api:0.1.0" }, records, "b2")).toBeNull();
  });
});

describe("words", () => {
  it("shortens a digest and says a size", () => {
    expect(shortDigest(DIGEST)).toBe("sha256:abababababab");
    expect(sizeText(null)).toBe("");
    expect(sizeText(512)).toBe("512 B");
    expect(sizeText(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(sizeText(300 * 1024 * 1024)).toBe("300 MiB");
  });

  it("reads a deletion's refusal from its violation", () => {
    const refused = { status: 409, problem: { context: { violations: [{ type: "IMAGE_PINNED", description: "pinned" }] } } };
    expect(imageRefusalText(refused)).toBe("It is pinned: unpin it first.");
    expect(imageRefusalText({ status: 409, body: { code: "IMAGE_RUNNING" } })).toMatch(/runs in an environment/);
    expect(imageRefusalText({ status: 500 })).toBeNull();
  });
});
