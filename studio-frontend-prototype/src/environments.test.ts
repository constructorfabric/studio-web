import { describe, expect, it } from "vitest";

import type { Connection, DeployEnvironment, Deployment } from "./api";
import {
  awaitingDecision,
  canReadStatus,
  clusterConnections,
  emptyEnvironment,
  environmentInput,
  environmentProblem,
  environmentProblems,
  environmentsByConnection,
  namespaceFor,
  registryConnections,
  researchConnections,
  readinessBadge,
  codedWarnings,
  PULL_USES_PUSH_LOGIN,
  registryHost,
  runningNow,
  slug,
} from "./environments";

const env = (over: Partial<DeployEnvironment> = {}): DeployEnvironment => ({
  id: "e1",
  name: "prod",
  description: "",
  connection_id: "c1",
  registry: "ghcr.io/acme",
  namespace_pattern: "{project}-{environment}",
  database: "none",
  protected: true,
  projects: null,
  updated_by: "",
  updated_at: "",
  ...over,
});

const deployment = (over: Partial<Deployment>): Deployment => ({
  id: "d",
  project_id: "p1",
  project_name: "Studio Web",
  environment_id: "e1",
  environment_name: "prod",
  profile: "prod",
  product: "studio-web",
  images: [],
  namespace: "studio-web-prod",
  chart_sha256: "",
  state: "succeeded",
  requested_by: "",
  requested_by_name: "",
  requested_at: "",
  ...over,
});

describe("namespaces", () => {
  it("are made of the project and environment names, as the server makes them", () => {
    expect(slug("Studio Web 2")).toBe("studio-web-2");
    expect(namespaceFor("{project}-{environment}", "Studio Web", "prod")).toBe("studio-web-prod");
    expect(namespaceFor("", "Studio Web", "prod")).toBe("studio-web-prod");
  });
});

describe("an environment form", () => {
  const ready = { ...emptyEnvironment(), name: "stage", connection_id: "c1" };

  it("is fine when named, with a cluster and the default pattern", () => {
    expect(environmentProblem(ready, [env()])).toBeNull();
  });

  it("says what is wrong", () => {
    expect(environmentProblem({ ...ready, name: "Stage" }, [])).toMatch(/lowercase/);
    expect(environmentProblem({ ...ready, name: "prod" }, [env()])).toMatch(/already has/);
    expect(environmentProblem({ ...ready, name: "prod" }, [env()], "e1")).toBeNull();
    expect(environmentProblem({ ...ready, connection_id: "" }, [])).toMatch(/cluster/);
    expect(environmentProblem({ ...ready, namespace_pattern: "{environment}" }, [])).toMatch(/\{project\}/);
    expect(environmentProblem({ ...ready, registry: "https://ghcr.io/acme" }, [])).toMatch(/scheme/);
    expect(environmentProblem({ ...ready, projects: [] }, [])).toMatch(/at least one project/);
  });

  it("takes previews only where nobody approves deploys, with a domain, a life and a limit that make sense", () => {
    const previews = { domain: "preview.example.com", ingress_class: null, ttl_hours: 72, max_live: 3 };
    expect(environmentProblem({ ...ready, previews }, [])).toBeNull();
    expect(environmentProblem({ ...ready, previews: { ...previews, domain: "" } }, [])).toBeNull();
    expect(environmentProblems({ ...ready, protected: true, previews }, []).previews).toMatch(/protected/);
    expect(environmentProblems({ ...ready, previews: { ...previews, domain: "not a domain" } }, []).previews).toMatch(/domain/);
    expect(environmentProblems({ ...ready, previews: { ...previews, ttl_hours: 0 } }, []).previews).toMatch(/336/);
    expect(environmentProblems({ ...ready, previews: { ...previews, max_live: 21 } }, []).previews).toMatch(/20/);
  });

  it("says everything wrong at once, by field", () => {
    // The form a person filled in on Dev: a capital, a literal namespace, no cluster.
    const p = environmentProblems({ ...ready, name: "Test", connection_id: "", namespace_pattern: "studio-web-dev" }, []);
    expect(Object.keys(p).sort()).toEqual(["connection_id", "name", "namespace_pattern"]);
    expect(p.namespace_pattern).toMatch(/\{project\}/);
  });
});

describe("which environments use a connection", () => {
  it("lists each connection's environments by name", () => {
    const m = environmentsByConnection([env(), env({ id: "e2", name: "dev" }), env({ id: "e3", name: "x", connection_id: "c2" })]);
    expect(m.get("c1")).toEqual(["prod", "dev"]);
    expect(m.get("c2")).toEqual(["x"]);
    expect(m.get("c3")).toBeUndefined();
  });
});

describe("clusters an environment can name", () => {
  it("are the organization's Kubernetes connections, not personal ones", () => {
    const c = (provider: string, scope: string): Connection => ({
      id: `${provider}-${scope}`,
      owner_tenant_id: "o",
      provider,
      label: "",
      account: "",
      base_url: "",
      scope,
      secret_ref: "",
      created_at_epoch_secs: 0,
    });
    expect(
      clusterConnections([c("kubernetes", "organization"), c("kubernetes", "personal"), c("github", "organization")]).map((x) => x.id),
    ).toEqual(["kubernetes-organization"]);
  });
});

describe("an environment's registry login (ADR-0048)", () => {
  const login: Connection = {
    id: "r1",
    owner_tenant_id: "o",
    provider: "registry",
    label: "org registry",
    account: "bot",
    base_url: "https://ghcr.io",
    scope: "organization",
    secret_ref: "",
    created_at_epoch_secs: 0,
  };
  const ready = { ...emptyEnvironment(), name: "stage", connection_id: "c1", registry_connection_id: "r1" };

  it("needs a prefix on the login's host", () => {
    expect(environmentProblems({ ...ready, registry: "" }, [], undefined, [login]).registry).toMatch(/where in the registry/);
    expect(environmentProblems({ ...ready, registry: "harbor.acme.example/acme" }, [], undefined, [login]).registry).toMatch(/not on ghcr.io/);
    expect(environmentProblems({ ...ready, registry: "ghcr.io.evil/acme" }, [], undefined, [login]).registry).toMatch(/not on ghcr.io/);
    expect(environmentProblem({ ...ready, registry: "ghcr.io/acme" }, [])).toBeNull();
    expect(environmentProblems({ ...ready, registry: "ghcr.io/acme" }, [], undefined, [login]).registry).toBeUndefined();
  });

  it("counts as a use of the registry connection", () => {
    expect(environmentsByConnection([env({ registry_connection_id: "r1" })]).get("r1")).toEqual(["prod"]);
  });

  it("is chosen from the organization's registries, by host", () => {
    expect(registryConnections([login, { ...login, id: "r2", scope: "personal" }, { ...login, id: "k", provider: "kubernetes" }]).map((c) => c.id)).toEqual(["r1"]);
    expect(registryHost("https://harbor.acme.example:8443/")).toBe("harbor.acme.example:8443");
    expect(registryHost("not a url")).toBe("");
  });
});

describe("what runs where", () => {
  it("is the newest succeeded deployment per project and environment", () => {
    const list = [
      deployment({ id: "new-failed", state: "failed" }),
      deployment({ id: "new" }),
      deployment({ id: "old" }),
      deployment({ id: "other-env", environment_id: "e2" }),
      deployment({ id: "waiting", state: "awaiting_approval" }),
    ];
    expect(runningNow(list).map((d) => d.id)).toEqual(["new", "other-env"]);
    expect(awaitingDecision(list).map((d) => d.id)).toEqual(["waiting"]);
  });

  it("is not a preview beside it, nor a release taken out since", () => {
    const preview = { name: "pr-1" } as Deployment["preview"];
    const list = [
      deployment({ id: "preview", preview }),
      deployment({ id: "taken-out", environment_id: "e2", action: "uninstall" }),
      deployment({ id: "before", environment_id: "e2" }),
      deployment({ id: "runs" }),
    ];
    expect(runningNow(list).map((d) => d.id)).toEqual(["runs"]);
  });
});

describe("cluster cards", () => {
  it("puts each environment and its deploys under its cluster, and keeps the unseen ones", async () => {
    const { clusterCards } = await import("./environments");
    const conn = (id: string, label: string) => ({ id, label, base_url: `https://${label}:6443`, provider: "kubernetes", scope: "organization" }) as never;
    const env = (id: string, name: string, connection_id: string) => ({ id, name, connection_id }) as never;
    const dep = (environment_id: string, requested_at: string, project_id = "p") =>
      ({ id: `${environment_id}-${requested_at}`, environment_id, requested_at, state: "succeeded", project_id }) as never;
    const cards = clusterCards(
      [conn("c1", "dev-cluster"), conn("c2", "prod-cluster")],
      [env("e1", "dev", "c1"), env("e2", "stage", "c1"), env("e3", "old", "gone")],
      [dep("e1", "2026-10-01T00:00:00Z"), dep("e2", "2026-10-05T00:00:00Z"), dep("e3", "2026-09-01T00:00:00Z")],
    );
    expect(cards.map((c) => [c.label, c.environments.length, c.deployments.length, c.lastDeploy])).toEqual([
      ["dev-cluster", 2, 2, "2026-10-05T00:00:00Z"],
      ["prod-cluster", 0, 0, null],
      ["A cluster this page cannot see", 1, 1, "2026-09-01T00:00:00Z"],
    ]);
    expect(cards[0].running).toHaveLength(2);
  });
});

describe("a Constructor Research environment (ADR-0049)", () => {
  const research = { ...emptyEnvironment(), name: "ml", kind: "research" as const, connection_id: "r1", research_project: "p1" };

  it("names its connection and project, and nothing of a cluster", () => {
    expect(environmentProblem(research, [])).toBeNull();
    expect(environmentProblems({ ...research, research_project: " " }, []).research_project).toMatch(/Research project/);
    expect(environmentProblems({ ...research, connection_id: "" }, []).connection_id).toMatch(/Research sign-in/);
    expect(environmentProblem({ ...research, namespace_pattern: "fixed" }, [])).toBeNull();
  });

  it("is chosen from Research sign-ins, a member's own among them", () => {
    const c = (id: string, provider: string, scope: string) => ({ id, provider, scope }) as Connection;
    expect(researchConnections([c("a", "research", "organization"), c("b", "research", "personal"), c("k", "kubernetes", "organization")]).map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("whose release the portal reads from its cluster", () => {
  it("an installed, a failed and an installing deploy's, not an uninstall or one not started", () => {
    expect(canReadStatus({ state: "succeeded", action: "install" })).toBe(true);
    expect(canReadStatus({ state: "failed", action: "install" })).toBe(true);
    expect(canReadStatus({ state: "running", action: "install" })).toBe(true);
    expect(canReadStatus({ state: "queued", action: "install" })).toBe(false);
    expect(canReadStatus({ state: "awaiting_approval", action: "install" })).toBe(false);
    expect(canReadStatus({ state: "succeeded", action: "uninstall" })).toBe(false);
  });
});

describe("how an environment's builds run", () => {
  const ready = { ...emptyEnvironment(), name: "stage", connection_id: "c1" };
  const pinned = `ghcr.io/acme/mirror/builder@sha256:${"a".repeat(64)}`;

  it("takes a builder only by digest, and namespaces that are namespaces", () => {
    expect(environmentProblems({ ...ready, builder_image: pinned }, []).builder_image).toBeUndefined();
    expect(environmentProblems({ ...ready, builder_image: "ghcr.io/acme/builder:1" }, []).builder_image).toMatch(/by digest/);
    expect(environmentProblems({ ...ready, build_namespace: "{project}-build" }, []).build_namespace).toBeUndefined();
    expect(environmentProblems({ ...ready, build_namespace: "Build_{project}" }, []).build_namespace).toMatch(/namespace/);
    expect(environmentProblems({ ...ready, namespaces: ["web-dev", "Web"] }, []).namespaces).toBe("'Web' is not a namespace.");
  });

  it("keeps what is stored, so a save does not clear it", () => {
    const stored = env({ builder_image: pinned, registry_pull_connection_id: "r-ro", namespaces: ["web-dev"], allow_broad_registry_token: true });
    const input = environmentInput(stored);
    expect([input.builder_image, input.registry_pull_connection_id, input.namespaces, input.allow_broad_registry_token]).toEqual([
      pinned,
      "r-ro",
      ["web-dev"],
      true,
    ]);
  });
});

describe("a cluster's readiness", () => {
  const base = { missing: [], namespaces: [], policy_enforced: true };
  it("is a badge in its own words", () => {
    expect(readinessBadge({ ...base, level: "bootstrapped", bootstrap_version: "3" })).toMatchObject({ label: "Bootstrapped", tone: "ok" });
    expect(readinessBadge({ ...base, level: "namespace_limited", namespaces: ["web-dev"] })).toMatchObject({
      label: "Namespaces given",
      title: "Studio may use only web-dev, the namespaces the cluster gives.",
    });
    expect(readinessBadge({ ...base, level: "partial", missing: ["create namespaces", "network policy"] }).label).toBe(
      "Partial: lacks create namespaces, network policy",
    );
    expect(readinessBadge({ ...base, level: "unreachable", detail: "connection refused" })).toEqual({
      label: "Unreachable",
      tone: "danger",
      title: "connection refused",
    });
  });

  it("says when a ready cluster pulls with the push login", () => {
    const badge = readinessBadge({
      ...base,
      level: "bootstrapped",
      warnings: ["the cluster gets a credential that can write"],
      warning_codes: [PULL_USES_PUSH_LOGIN],
    });
    expect(badge.tone).toBe("warn");
    expect(badge.label).toBe("Bootstrapped · pulls with the push login");
    expect(badge.title).toContain("PULL_USES_PUSH_LOGIN: the cluster gets a credential that can write");
  });

  it("pairs warnings with their codes by position", () => {
    expect(codedWarnings(["a", "b"], [PULL_USES_PUSH_LOGIN])).toEqual([
      { code: PULL_USES_PUSH_LOGIN, text: "a" },
      { code: null, text: "b" },
    ]);
    expect(codedWarnings(undefined, undefined)).toEqual([]);
  });
});
