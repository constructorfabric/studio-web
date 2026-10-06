import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  alignSessionHost,
  apiUrl,
  sessionOrigin,
  sameOriginFileStorageUrl,
  type Capability,
  type StudioSession,
  waitForStudioSessionReady,
  uploadProjectArtifact,
} from "./api";

describe("background work client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonMock(body: unknown, status = 200) {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
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

  it("asks a connection for its channels in the tenant being viewed", async () => {
    // Connections are inherited, so the tenant is not implied by the caller:
    // the page passes the project it is showing.
    const fetchMock = jsonMock({ items: [] });
    await api.notifyTargets("token", "c-1", "t-9");
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-connector/v1/connections/c-1/targets?tenant=t-9",
      expect.anything(),
    );
  });

  it("posts a chat message through the connection, not through the queue", async () => {
    const fetchMock = jsonMock({ connection_id: "c-1", provider: "slack", target: "C0" });
    await api.sendConnectorMessage("token", "c-1", "t-9", { target: "C0", text: "hi" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-connector/v1/connections/c-1/messages?tenant=t-9",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ target: "C0", text: "hi" }),
      }),
    );
  });

  it("queues a chat notification as a run", async () => {
    const fetchMock = jsonMock({ run_id: "r-1", poll: "/studio-tasks/v1/runs/r-1" }, 202);
    await expect(
      api.queueNotification("token", {
        connection_id: "c-1",
        target: "C0",
        text: "3 tests red",
      }),
    ).resolves.toEqual({ run_id: "r-1", poll: "/studio-tasks/v1/runs/r-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-notify/v1/messages",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ connection_id: "c-1", target: "C0", text: "3 tests red" });
  });

  it("makes a notification's retry safe with the Idempotency-Key header, not a body field", async () => {
    const fetchMock = jsonMock({ run_id: "r-1", poll: "/studio-tasks/v1/runs/r-1" }, 202);
    await api.queueNotification("token", { workspace_id: "w-1", text: "hi" }, "key-1");
    await api.queueNotification("token", { workspace_id: "w-1", text: "hi" });
    const first = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const second = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(first["Idempotency-Key"]).toBe("key-1");
    // A new action gets a key of its own.
    expect(second["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.idempotency_key).toBeUndefined();
  });

  it("queues an IDE notification against a workspace, with no connection", async () => {
    // The two destinations are exclusive server-side: naming both is a 400, so
    // the client must not smuggle a connection into an editor message.
    const fetchMock = jsonMock({ run_id: "r-2", poll: "/studio-tasks/v1/runs/r-2" });
    await api.queueNotification("token", {
      workspace_id: "w-1",
      level: "warn",
      text: "the import failed",
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ workspace_id: "w-1", level: "warn", text: "the import failed" });
    expect(body.connection_id).toBeUndefined();
  });

  it("reads a 204 as done, without a body to parse", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.presenceLeave("token")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-presence/v1/me",
      expect.objectContaining({ method: "DELETE" }),
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
    const fetchMock = jsonMock({ run_id: "r-2" }, 202);
    await expect(api.runScheduleNow("token", "s-1")).resolves.toEqual({ run_id: "r-2" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-scheduler/v1/schedules/s-1/run-now",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }),
      }),
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
    // The catalogue is paged now, and the client walks it: the first request
    // carries the page window, and an empty page ends the walk.
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-kits/v1/catalog?offset=0&limit=200",
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
      "/cf/studio-kits/v1/projects/project%2Fone/repositories?offset=0&limit=200",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
  });
});

describe("compose client", () => {
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

  const cap = (key: string, terms: string[]): Capability => ({
    key,
    label: key,
    terms,
    owner: "workspace",
  });

  it("sends the capabilities and the terms the workspace defined", async () => {
    const fetchMock = jsonMock({ items: [], total: 0 });
    await api.composePlan("token", ["chat"], [cap("chat", ["chat", "messaging"])]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/cf/studio-components-catalog/v1/compose",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ capabilities: ["chat"], terms: { chat: ["chat", "messaging"] } }),
      }),
    );
  });

  it("leaves a capability with no terms out of the map", async () => {
    // Absent means "match the key itself", which is what it meant before
    // vocabularies existed. An empty list would say something different.
    const fetchMock = jsonMock({ items: [], total: 0 });
    await api.composePlan("token", ["billing"], [cap("billing", [])]);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ capabilities: ["billing"], terms: {} });
  });

  it("returns the rows the server planned, unedited", async () => {
    jsonMock({
      items: [
        {
          capability: "chat",
          candidates: [{ name: "real-chat", kind: "gear", score: 2, why: ["chat"], built: "built" }],
          gap: false,
          unbuilt: false,
        },
      ],
      total: 1,
    });
    const plan = await api.composePlan("token", ["chat"], []);
    expect(plan.items[0].candidates[0].built).toBe("built");
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

  it("takes the backend's probe run as soon as it ends, and stops watching it", async () => {
    const starting = { ...session("starting"), ready_run_id: "run-1" };
    let followed = "";
    let aborted = false;
    const ready = await waitForStudioSessionReady(starting, async () => session("running"), {
      follow: async (runId, signal) => {
        followed = runId;
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return { state: "succeeded" };
      },
      // The poll runs alongside; it must never be the thing that answers here.
      sleep: async () => new Promise<void>(() => {}),
    });
    expect(followed).toBe("run-1");
    expect(ready.state).toBe("running");
    // The subscription is dropped rather than left to run out its own timeout.
    expect(aborted).toBe(true);
  });

  it("still becomes ready when the run's terminal event never arrives", async () => {
    // The subscription opens after the session was created, so a run that
    // finishes in between delivers nothing to it. Waiting on the stream alone
    // then sits out the follower's timeout — minutes for a launch that was
    // ready in seconds.
    const starting = { ...session("starting"), ready_run_id: "run-3" };
    let refreshes = 0;
    const ready = await waitForStudioSessionReady(
      starting,
      async () => {
        refreshes += 1;
        return session("running");
      },
      {
        follow: () => new Promise(() => {}), // never settles
        sleep: async () => undefined,
      },
    );
    expect(ready.state).toBe("running");
    expect(refreshes).toBe(1);
  });

  it("keeps asking when the run ends a moment before the record catches up", async () => {
    const starting = { ...session("starting"), ready_run_id: "run-4" };
    const states = ["starting", "running"] as const;
    let refreshes = 0;
    const ready = await waitForStudioSessionReady(
      starting,
      async () => session(states[Math.min(refreshes++, states.length - 1)]),
      {
        follow: async () => ({ state: "succeeded" }),
        sleep: async () => undefined,
      },
    );
    expect(ready.state).toBe("running");
  });

  it("reports a failed probe run rather than waiting for a state that is not coming", async () => {
    const starting = { ...session("starting"), ready_run_id: "run-2" };
    await expect(
      waitForStudioSessionReady(starting, async () => session("starting"), {
        follow: async () => ({ state: "failed", error: "image pull failed" }),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("image pull failed");
  });

  it("stops polling once the run has reported a failure", async () => {
    // The poll is the loser of a `Promise.race`, and a race settles only its
    // winner. Before the poll took the abort signal it kept asking for the rest
    // of the deadline — with the default 120s that is two minutes of requests
    // about a session the user has already been told is dead. This test is the
    // reason api.test.ts used to take 120 seconds to run.
    const starting = { ...session("starting"), ready_run_id: "run-5" };
    let refreshes = 0;
    let clock = 0;
    await expect(
      waitForStudioSessionReady(
        starting,
        async () => {
          refreshes += 1;
          return session("starting");
        },
        {
          follow: async () => ({ state: "failed", error: "image pull failed" }),
          // A real clock, so a poll that ignored the signal would have to burn
          // the whole deadline rather than skip it in fake time.
          now: () => clock,
          timeoutMs: 120_000,
          pollIntervalMs: 1_000,
          sleep: async (milliseconds) => {
            clock += milliseconds;
          },
        },
      ),
    ).rejects.toThrow("image pull failed");

    // Let anything still running have its turn before counting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The clock is the assertion that matters. Every poll iteration advances it
    // by one interval, so a loop that ignored the signal would run the deadline
    // out and leave it at 120_000. Stopping leaves it at a couple of ticks.
    expect(clock).toBeLessThan(5_000);
    // And the request count follows from that. Not "at most one": the race
    // rejects and the abort lands a few microtasks apart, so the loop can get
    // one more turn in between. The point is that it is a small constant and
    // not the ~120 it takes to sit out the deadline.
    expect(refreshes).toBeLessThanOrEqual(3);
  });

  it("polls when the deployment queued no probe run", async () => {
    let refreshes = 0;
    const ready = await waitForStudioSessionReady(
      session("starting"),
      async () => {
        refreshes += 1;
        return session("running");
      },
      { sleep: async () => undefined },
    );
    expect(ready.state).toBe("running");
    expect(refreshes).toBe(1);
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
