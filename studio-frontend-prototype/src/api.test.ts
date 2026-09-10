import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  alignSessionHost,
  apiUrl,
  sessionOrigin,
  sameOriginFileStorageUrl,
  type StudioSession,
  waitForStudioSessionReady,
  uploadProjectArtifact,
} from "./api";

describe("background work client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonMock(body: unknown) {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("asks for every run when nothing is filtered", async () => {
    const fetchMock = jsonMock({ items: [] });
    await api.taskRuns("token");
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-tasks/v1/runs",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
  });

  it("narrows the listing server-side rather than in the browser", async () => {
    // The filters exist so a busy deployment does not ship 10k rows to draw
    // five of them; an omitted filter must not appear as an empty parameter.
    const fetchMock = jsonMock({ items: [] });
    await api.taskRuns("token", { state: "failed", taskType: "notify.deliver", limit: 200 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-tasks/v1/runs?state=failed&task_type=notify.deliver&limit=200",
      expect.anything(),
    );
  });

  it("encodes a run id in the path rather than interpolating it raw", async () => {
    const fetchMock = jsonMock({ id: "r-1" });
    await api.cancelTaskRun("token", "r/1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-tasks/v1/runs/r%2F1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fires a schedule through the scheduler, not the task queue", async () => {
    // `run-now` is the only way a person starts background work: it runs a
    // task type and payload a schedule already validated.
    const fetchMock = jsonMock({ run_id: "r-2" });
    await expect(api.runScheduleNow("token", "s-1")).resolves.toEqual({ run_id: "r-2" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-scheduler/v1/schedules/s-1/run-now",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("kit registry client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the catalog through the shared /cf gateway", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.kits("token")).resolves.toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-kits/v1/catalog",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
  });

  it("creates a project-scoped, version-pinned install request", async () => {
    const installation = {
      kit_slug: "sdlc",
      version: "v1.2.3",
      source: "github",
      repository_url: "https://github.com/constructorfabric/studio-kit-sdlc",
      install_mode: "copy",
      status: "pending",
      requested_by: "user-1",
      requested_at: "2026-09-01T00:00:00Z",
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(installation), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.requestKitInstallation("token", "project/one", {
        kit_slug: "sdlc",
        version: "v1.2.3",
        install_mode: "copy",
      }),
    ).resolves.toEqual(installation);
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-kits/v1/projects/project%2Fone/installations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kit_slug: "sdlc",
          version: "v1.2.3",
          install_mode: "copy",
        }),
      }),
    );
  });

  it("materializes a pending kit through the backend-to-Theia bridge", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ kit_slug: "sdlc", status: "installed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.materializeKitInstallation("token", "project/one", "sdlc");
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-kits/v1/projects/project%2Fone/installations/sdlc/materialize",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("materializes into the repository the caller chose", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ kit_slug: "sdlc", status: "installed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.materializeKitInstallation("token", "project/one", "sdlc", "repo-app");
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-kits/v1/projects/project%2Fone/installations/sdlc/materialize",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ repository_id: "repo-app" }),
      }),
    );
  });

  it("reconciles a kit across the repositories its scope covers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ kit_slug: "sdlc", scope: "all-repositories" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.reconcileKitInstallation("token", "project/one", "sdlc");
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-kits/v1/projects/project%2Fone/installations/sdlc/reconcile",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("lists the repositories the project's IDE has mounted", async () => {
    const items = [
      { repository_id: "repo-project", label: "workspace", kind: "project" },
      { repository_id: "repo-app", label: "app", kind: "source" },
    ];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.projectRepositories("token", "project/one")).resolves.toEqual({ items });
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-kits/v1/projects/project%2Fone/repositories",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
  });
});

describe("apiUrl", () => {
  it("prefixes paths with /cf", () => {
    expect(apiUrl("/account-management/v1/me")).toBe("/cf/account-management/v1/me");
  });
  it("normalizes a missing leading slash", () => {
    expect(apiUrl("account-management/v1/me")).toBe("/cf/account-management/v1/me");
  });
});

describe("ApiError", () => {
  it("carries status and body", () => {
    const e = new ApiError(400, { title: "Failed Precondition" });
    expect(e.status).toBe(400);
    expect(e.message).toContain("400");
  });
});

describe("alignSessionHost", () => {
  // The tests run in vitest's default node environment, so `window` has to be
  // faked. Only `location.hostname` is read.
  const at = (hostname: string) => {
    (globalThis as { window?: unknown }).window = { location: { hostname } };
  };
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("moves a localhost session onto the host the portal is served from", () => {
    at("127.0.0.1");
    // Why this matters: the IDE's gate cookie is SameSite=Lax, and
    // 127.0.0.1 vs localhost are different sites — the cookie would be
    // dropped inside the iframe and the IDE would answer 403.
    expect(alignSessionHost("http://localhost:41000/")).toBe("http://127.0.0.1:41000/");
  });

  it("keeps the port and the token query intact", () => {
    at("127.0.0.1");
    expect(alignSessionHost("http://localhost:41007/?token=abc")).toBe(
      "http://127.0.0.1:41007/?token=abc",
    );
  });

  it("leaves a session already on the portal's host alone", () => {
    at("localhost");
    expect(alignSessionHost("http://localhost:41000/")).toBe("http://localhost:41000/");
  });

  it("never rewrites a real hostname — that is deliberate configuration", () => {
    at("127.0.0.1");
    expect(alignSessionHost("http://studio.example.com:41000/")).toBe(
      "http://studio.example.com:41000/",
    );
  });

  it("does not drag a remotely-served portal onto loopback", () => {
    at("studio.example.com");
    expect(alignSessionHost("http://localhost:41000/")).toBe("http://localhost:41000/");
  });

  it("hands back anything that is not a URL", () => {
    at("127.0.0.1");
    expect(alignSessionHost("")).toBe("");
  });
});

describe("sessionOrigin", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("resolves a relative Kubernetes session URL against the portal", () => {
    (globalThis as { window?: unknown }).window = {
      location: { href: "https://studio-dev-poc.cfabric.org/space/workspace-1" },
    };
    expect(sessionOrigin("/studio/session-1/?token=secret")).toBe(
      "https://studio-dev-poc.cfabric.org",
    );
  });

  it("keeps the origin of an absolute session URL", () => {
    (globalThis as { window?: unknown }).window = {
      location: { href: "https://studio-dev-poc.cfabric.org/" },
    };
    expect(sessionOrigin("http://127.0.0.1:41000/?token=secret")).toBe(
      "http://127.0.0.1:41000",
    );
  });
});

describe("sameOriginFileStorageUrl", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("keeps the signed data path but moves it onto the prototype origin", () => {
    (globalThis as { window?: unknown }).window = {
      location: {
        href: "https://studio-dev-poc.cfabric.org/artifacts",
        protocol: "https:",
        host: "studio-dev-poc.cfabric.org",
      },
    };
    expect(
      sameOriginFileStorageUrl(
        "https://studio-dev.cfabric.org/api/file-storage-data/v1/upload/signed-token",
      ),
    ).toBe(
      "https://studio-dev-poc.cfabric.org/api/file-storage-data/v1/upload/signed-token",
    );
  });

  it("does not rewrite unrelated signed URLs", () => {
    (globalThis as { window?: unknown }).window = {
      location: {
        href: "https://studio-dev-poc.cfabric.org/",
        protocol: "https:",
        host: "studio-dev-poc.cfabric.org",
      },
    };
    expect(sameOriginFileStorageUrl("https://storage.example/object")).toBe(
      "https://storage.example/object",
    );
  });
});

describe("waitForStudioSessionReady", () => {
  const session = (state: StudioSession["state"]): StudioSession => ({
    id: "session-1",
    workspace_id: "workspace-1",
    state,
    url: "/cf/studio-session/v1/ide/session-1/",
    created_at_epoch_secs: 1,
    sources: [],
  });

  it("does not refresh an already-running session", async () => {
    let refreshes = 0;
    const ready = await waitForStudioSessionReady(session("running"), async () => {
      refreshes += 1;
      return session("running");
    });
    expect(ready.state).toBe("running");
    expect(refreshes).toBe(0);
  });

  it("polls a starting Kubernetes session before returning its URL", async () => {
    const states: StudioSession["state"][] = ["starting", "running"];
    const ready = await waitForStudioSessionReady(
      session("starting"),
      async () => session(states.shift() ?? "running"),
      { sleep: async () => undefined },
    );
    expect(ready.state).toBe("running");
    expect(states).toHaveLength(0);
  });

  it("fails clearly when the runtime stops during startup", async () => {
    await expect(
      waitForStudioSessionReady(session("starting"), async () => session("stopped"), {
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("stopped before it became ready");
  });

  it("times out instead of polling forever", async () => {
    let clock = 0;
    await expect(
      waitForStudioSessionReady(session("starting"), async () => session("starting"), {
        timeoutMs: 10,
        pollIntervalMs: 10,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      }),
    ).rejects.toThrow("did not become ready");
  });
});

describe("uploadProjectArtifact", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads bytes through the signed URL and returns a durable object reference", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            file_id: "0198af9a-77bc-7e01-b620-bb237979866b",
            version_id: "0198af9a-77bc-7e01-b620-bb237979866c",
            upload_url: "https://storage.example/upload/signed",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              version_id: "0198af9a-77bc-7e01-b620-bb237979866c",
              mime_type: "application/pdf",
              size: 3,
              hash_algorithm: "sha256",
              hash: "abc123",
              status: "available",
              is_current: false,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ file_id: "0198af9a-77bc-7e01-b620-bb237979866b" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadProjectArtifact(
      "access-token",
      new File([new Uint8Array([1, 2, 3])], "architecture.pdf", {
        type: "application/pdf",
      }),
      {
        organization_id: "0198af9a-77bc-7e01-b620-bb2379798668",
        workspace_id: "0198af9a-77bc-7e01-b620-bb2379798669",
        project_id: "0198af9a-77bc-7e01-b620-bb237979866a",
      },
      "manual",
    );

    expect(result).toEqual({
      storage: "file-storage",
      file_id: "0198af9a-77bc-7e01-b620-bb237979866b",
      version_id: "0198af9a-77bc-7e01-b620-bb237979866c",
      name: "architecture.pdf",
      mime: "application/pdf",
      size: 3,
      checksum: "sha256:abc123",
    });
    const createBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(createBody.owner_id).toBe("0198af9a-77bc-7e01-b620-bb237979866a");
    expect(createBody.gts_file_type).toBe(
      "gts.cf.fstorage.file.type.v1~cf.studio.artifact.file.v1~",
    );
    expect(createBody.custom_metadata).toContainEqual({
      key: "studio.artifact_origin",
      value: "manual",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://storage.example/upload/signed");
  });
});
